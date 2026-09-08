import { gunzipSync } from "node:zlib";
import type {
  DataConnectorDefinition,
  DataOperationExecutionContext,
  DataOperationExecution,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  GDELT_WEB_NGRAMS_INPUT_SCHEMA,
  GDELT_WEB_NGRAMS_OUTPUT_SCHEMA,
} from "./gdelt-web-ngrams.schemas.js";

const BASE_URL = "https://data.gdeltproject.org";
const PREFIX = "/gdeltv5/weblegacy/ngrams/";
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const DOCUMENTATION =
  "https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/";
interface Input {
  fileTimestamp: string;
  phrases: string[];
  match?: "any" | "all";
  languages?: string[];
}
interface Article {
  fileTimestamp: string;
  documentId: number;
  url: string;
  title: string | null;
  language: string | null;
  date: string | null;
  imageReference: string | null;
}

export const gdeltWebNgramsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "gdelt.web-ngrams",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.61",
  provider: { providerId: "gdelt", name: "GDELT Project" },
  sourceCategory: "global-news-metadata",
  endpoints: [
    {
      endpointId: "gdelt-web-ngrams",
      baseUrl: BASE_URL,
      pathPrefixes: [PREFIX],
      allowedMethods: ["GET"],
      allowedContentTypes: [
        "application/json",
        "text/plain",
        "application/gzip",
        "application/x-gzip",
        "application/octet-stream",
      ],
    },
  ],
  license: {
    name: "GDELT Project data",
    url: "https://www.gdeltproject.org/about.html",
    restrictions: [
      "Non-consumptive quadgram histograms and link metadata, not article full text.",
      "Source-specific rights still apply when following or reusing linked content.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 20 * 1024 * 1024,
    maxPages: 2,
    maxRecords: 5_000,
    maxRetries: 2,
    maxRetryDelayMs: 60_000,
    maxRedirects: 2,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Explicit provider minute files; nominal publication lag and missing minutes do not establish continuous coverage.",
  },
  limitations: [
    "One explicit paired minute per call; at most 64 MiB decompressed per file. Missing or corrupt files are blocked, never an empty successful search.",
    "Literal 1–4-word phrases only. No DOC query-language equivalence, tone timeline, ranking, translation, or complete corpus guarantee.",
    "DOCIDs reset per minute; use fileTimestamp plus documentId. Repeated URLs across minutes are not silently deduplicated.",
  ],
  discovery: {
    source: {
      maintainedBy: "The GDELT Project",
      summary: "Web NGrams quadgram histograms and paired article tables of contents.",
      description:
        "A file-based keyword-search route recommended during legacy search infrastructure migration. The official paired files associate per-document quadgrams with URLs and titles without article bodies.",
      coverage: {
        geographic: "Monitored global web news with uneven source and language coverage.",
        temporal:
          "Explicit published UTC minutes. Legacy 15-minute processing can leave missing minutes; an arbitrary time range is not guaranteed covered.",
        granularity: "Per-minute, per-document quadgram presence joined to the same minute's TOC.",
      },
    },
    summary:
      "Find article links containing literal words or short phrases in one published minute.",
    description:
      "Fetch both official GZIP files, validate and join file-scoped document IDs, and scan every valid quadgram before returning bounded matching article metadata.",
    provides: [
      "Literal case-insensitive word/phrase matching with any/all document selection and optional TOC language filters.",
      "Matched phrases, file provenance, validation counts, and explicit omitted-result counts.",
    ],
    doesNotProvide: [
      "DOC operators, DOC sentiment/volume timelines, semantic search, or relevance ranking.",
      "Article bodies, reconstructed text, reliable phrase-frequency sums, or all-news coverage.",
    ],
    selectionHints: [
      "Choose for literal topic discovery when a published minute is known, including when DOC is load-shedding. It does not automatically replace a DOC query.",
      "Choose GKG for machine-coded themes/entities/tone, Events for coded events, and Mentions for event-document linkage. Join only when the research question needs those semantics.",
      "For ranges, the caller must explicitly enumerate intended minutes and report missing minutes; a successful single minute is not a complete range.",
    ],
    typicalUseCases: ["Find candidate article URLs containing a disease name in a known minute."],
    sourceDocumentation: [{ title: "Using the new Web NGrams dataset", url: DOCUMENTATION }],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.0",
      summary: "Search one explicit NGrams/TOC minute pair.",
      description:
        "Validate both files and join document-scoped literal matches to metadata; report malformed rows and output truncation separately from no matches.",
      inputSchema: GDELT_WEB_NGRAMS_INPUT_SCHEMA,
      outputSchema: GDELT_WEB_NGRAMS_OUTPUT_SCHEMA,
      execute: search,
    },
  ],
};

async function search(context: DataOperationExecutionContext): Promise<DataOperationExecution> {
  const input = context.input as Input;
  const parsedDate = new Date(input.fileTimestamp);
  const phrases = input.phrases.map((phrase) => phrase.trim().replace(/\s+/gu, " "));
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString() !== input.fileTimestamp.replace("Z", ".000Z") ||
    phrases.some(
      (phrase) => !phrase || phrase.split(" ").length > 4 || !/[\p{L}\p{N}]/u.test(phrase),
    ) ||
    new Set(phrases.map((phrase) => phrase.toLowerCase())).size !== phrases.length ||
    context.limits.maxPages < 2
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "Use an actual UTC minute, unique literal 1–4-word phrases, and a request budget for both files.",
    );
  }
  const stem = input.fileTimestamp.replace(/[-:TZ]/gu, "");
  const observations: DataSourceObservation[] = [];
  const files: Array<{
    kind: string;
    sourceUrl: string;
    compressedBytes: number;
    uncompressedBytes: number;
    responseDigest: string;
  }> = [];
  async function read(kind: "toc" | "ngrams") {
    const path = `${PREFIX}${stem}.${kind === "toc" ? "toc.json" : "ngrams.txt"}.gz`;
    const response = await context.http.request({
      endpointId: "gdelt-web-ngrams",
      method: "GET",
      path,
    });
    let bytes: Buffer;
    let content: string;
    try {
      bytes = gunzipSync(response.bytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DataRuntimeError(
        "provider-response-invalid",
        "GDELT minute file is not valid bounded UTF-8 GZIP data.",
        {
          details: {
            kind,
            fileTimestamp: input.fileTimestamp,
            maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
          },
        },
      );
    }
    observations.push(response.observation);
    files.push({
      kind,
      sourceUrl: BASE_URL + path,
      compressedBytes: response.bytes.byteLength,
      uncompressedBytes: bytes.byteLength,
      responseDigest: response.observation.responseDigest,
    });
    return content;
  }
  const statistics = {
    tocRows: 0,
    ngramRows: 0,
    invalidTocRows: 0,
    invalidNgramRows: 0,
    orphanNgramRows: 0,
    ambiguousDocumentCount: 0,
    duplicateTocRows: 0,
  };
  const articles = new Map<number, Article>();
  const ambiguous = new Set<number>();
  for (const line of lines(await read("toc"))) {
    statistics.tocRows++;
    const article = parseArticle(line, input.fileTimestamp);
    if (!article) {
      statistics.invalidTocRows++;
      continue;
    }
    if (ambiguous.has(article.documentId)) {
      statistics.duplicateTocRows++;
      continue;
    }
    const previous = articles.get(article.documentId);
    if (previous) {
      statistics.duplicateTocRows++;
      if (JSON.stringify(previous) !== JSON.stringify(article)) {
        articles.delete(article.documentId);
        ambiguous.add(article.documentId);
      }
    } else articles.set(article.documentId, article);
  }
  statistics.ambiguousDocumentCount = ambiguous.size;
  const patterns = phrases.map(
    (phrase) =>
      new RegExp(
        `(?<![\\p{L}\\p{M}\\p{N}_])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{M}\\p{N}_])`,
        "iu",
      ),
  );
  const matches = new Map<number, Set<number>>();
  for (const line of lines(await read("ngrams"))) {
    statistics.ngramRows++;
    const fields = line.split("\t");
    const id = Number(fields[0]);
    const count = Number(fields[2]);
    if (
      fields.length !== 3 ||
      !/^\d+$/u.test(fields[0]!) ||
      !Number.isSafeInteger(id) ||
      !fields[1]!.trim() ||
      !/^\d+$/u.test(fields[2]!) ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      statistics.invalidNgramRows++;
      continue;
    }
    const article = articles.get(id);
    if (!article) {
      statistics.orphanNgramRows++;
      continue;
    }
    if (input.languages && (!article.language || !input.languages.includes(article.language)))
      continue;
    const gram = fields[1]!.trim().replace(/\s+/gu, " ");
    patterns.forEach((pattern, index) => {
      if (pattern.test(gram)) {
        const found = matches.get(id) ?? new Set<number>();
        found.add(index);
        matches.set(id, found);
      }
    });
  }
  if (!statistics.tocRows || !statistics.ngramRows) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "A published GDELT pair contains an empty file; no searchable coverage is established.",
    );
  }
  const match = input.match ?? "any";
  const matched = [...matches.entries()]
    .filter(([, found]) => match === "any" || found.size === phrases.length)
    .sort(([a], [b]) => a - b);
  const records = matched.slice(0, context.limits.maxRecords).map(([id, found]) => ({
    ...articles.get(id)!,
    matchedPhrases: phrases.filter((_, index) => found.has(index)),
  }));
  const omittedRecordCount = matched.length - records.length;
  const invalid =
    statistics.invalidTocRows +
      statistics.invalidNgramRows +
      statistics.orphanNgramRows +
      statistics.ambiguousDocumentCount >
    0;
  const partial = invalid || omittedRecordCount > 0;
  return {
    status: partial ? "partial" : "success",
    data: {
      fileTimestamp: input.fileTimestamp,
      phrases,
      match,
      languages: input.languages ?? [],
      records,
      matchedDocumentCount: matched.length,
      omittedRecordCount,
      statistics,
      files,
      stopReason: omittedRecordCount
        ? "record-limit"
        : invalid
          ? "invalid-source-rows"
          : "file-complete",
    },
    summary: {
      recordCount: records.length,
      pageCount: 2,
      chunkCount: 1,
      truncated: omittedRecordCount > 0,
      completeness: partial ? "partial" : "complete",
      ...(partial
        ? {
            missing: [
              {
                kind: "range" as const,
                identifiers: [
                  ...(invalid
                    ? [`${input.fileTimestamp}:unvalidated-or-unlinked-source-rows`]
                    : []),
                  ...(omittedRecordCount
                    ? [
                        `${input.fileTimestamp}:matching-document-offsets:${records.length}-${matched.length - 1}`,
                      ]
                    : []),
                ],
              },
            ],
          }
        : {}),
    },
    warnings: [
      ...(invalid
        ? [
            "Invalid or ambiguously linked source rows prevent complete matching coverage; inspect statistics. Match counts refer only to valid linked rows.",
          ]
        : []),
      ...(omittedRecordCount
        ? [
            `The complete file scan found ${matched.length} matching documents; ${omittedRecordCount} are omitted by maxRecords. Rerun with a sufficient allowed record limit or explicitly partition the query.`,
          ]
        : []),
    ],
    errors: partial
      ? [
          {
            code: "partial-result",
            message:
              "GDELT matching coverage or returned records are incomplete; inspect statistics and omittedRecordCount.",
            retryable: false,
            userActionRequired: false,
            details: { ...statistics, omittedRecordCount },
          },
        ]
      : [],
    observations,
  };
}

function* lines(content: string): Generator<string> {
  for (const match of content.matchAll(/[^\r\n]+/gu)) if (match[0].trim()) yield match[0];
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseArticle(line: string, fileTimestamp: string): Article | null {
  try {
    const row = JSON.parse(line) as Record<string, unknown> | null;
    if (
      !row ||
      Array.isArray(row) ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.ID) ||
      (row.ID as number) < 0 ||
      !validUrl(row.url)
    )
      return null;
    for (const field of ["title", "lang", "date", "img"])
      if (row[field] != null && typeof row[field] !== "string") return null;
    if (
      typeof row.date === "string" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(row.date) ||
        !Number.isFinite(Date.parse(row.date)) ||
        new Date(row.date).toISOString() !== row.date.replace(/(?<!\.\d{3})Z$/u, ".000Z"))
    )
      return null;
    return {
      fileTimestamp,
      documentId: row.ID as number,
      url: row.url,
      title: (row.title as string | undefined) ?? null,
      language: (row.lang as string | undefined) ?? null,
      date: (row.date as string | undefined) ?? null,
      imageReference: (row.img as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

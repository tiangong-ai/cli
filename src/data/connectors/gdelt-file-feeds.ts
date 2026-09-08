import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  GDELT_EVENT_FIELDS,
  GDELT_EVENTS_OUTPUT_SCHEMA,
  GDELT_FILE_FEED_INPUT_SCHEMA,
  GDELT_GKG_FIELDS,
  GDELT_GKG_OUTPUT_SCHEMA,
  GDELT_MENTION_FIELDS,
  GDELT_MENTIONS_OUTPUT_SCHEMA,
} from "./gdelt-file-feeds.schemas.js";

const DATA_PATH = "/gdeltv2/";
const LAST_UPDATE_PATH = `${DATA_PATH}lastupdate.txt`;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const MAX_UNCOMPRESSED_BYTES = 64 * 1_024 * 1_024;
const MAX_FILES = 20;
const CRC32_TABLE = buildCrc32Table();

type FeedKind = "events" | "gkg" | "mentions";

interface FeedInput {
  mode: "latest" | "range";
  startDateTime?: string;
  endDateTime?: string;
  maxFiles?: number;
}

interface NormalizedFeedQuery {
  mode: "latest" | "range";
  startDateTime: string | null;
  endDateTime: string | null;
  maxFiles: number;
}

interface FeedDefinition {
  kind: FeedKind;
  capabilityId: `gdelt.${FeedKind}`;
  suffix: string;
  fields: readonly string[];
  outputSchema: Record<string, unknown>;
  summary: string;
  granularity: string;
  useCase: string;
  documentation: Array<{ title: string; url: string }>;
}

interface FeedCandidate {
  timestamp: string;
  fileName: string;
  expectedCompressedBytes: number | null;
  expectedMd5: string | null;
}

interface ParsedZip {
  content: Buffer;
  uncompressedBytes: number;
  crc32Verified: true;
}

interface ParsedRows {
  rows: Array<Record<string, string>>;
  totalRows: number;
  invalidRowCount: number;
  issues: string[];
}

const FEED_DEFINITIONS: Record<FeedKind, FeedDefinition> = {
  events: {
    kind: "events",
    capabilityId: "gdelt.events",
    suffix: ".export.CSV.zip",
    fields: GDELT_EVENT_FIELDS,
    outputSchema: GDELT_EVENTS_OUTPUT_SCHEMA,
    summary: "Fetch bounded GDELT 2.0 coded event records from 15-minute export files.",
    granularity: "One automatically coded event mention aggregation row in an export file.",
    useCase: "Inspect bounded event-code records and their source URLs for a short UTC interval.",
    documentation: [
      {
        title: "GDELT 2.0 Event Codebook",
        url: "https://data.gdeltproject.org/documentation/GDELT-Event_Codebook-V2.0.pdf",
      },
    ],
  },
  gkg: {
    kind: "gkg",
    capabilityId: "gdelt.gkg",
    suffix: ".gkg.csv.zip",
    fields: GDELT_GKG_FIELDS,
    outputSchema: GDELT_GKG_OUTPUT_SCHEMA,
    summary: "Fetch bounded GDELT 2.0 Global Knowledge Graph records from 15-minute files.",
    granularity:
      "One source-document knowledge-graph row with machine-extracted themes and entities.",
    useCase: "Inspect bounded GKG themes, entities, locations, and document identifiers.",
    documentation: [
      {
        title: "GDELT Global Knowledge Graph 2.1 Codebook",
        url: "https://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.1.pdf",
      },
    ],
  },
  mentions: {
    kind: "mentions",
    capabilityId: "gdelt.mentions",
    suffix: ".mentions.CSV.zip",
    fields: GDELT_MENTION_FIELDS,
    outputSchema: GDELT_MENTIONS_OUTPUT_SCHEMA,
    summary: "Fetch bounded GDELT 2.0 event-mention records from 15-minute files.",
    granularity: "One document-level mention of an automatically coded GDELT event.",
    useCase: "Trace bounded event records to document mentions and coding confidence metadata.",
    documentation: [
      {
        title: "GDELT 2.0 introduction",
        url: "https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/",
      },
    ],
  },
};

export const gdeltEventsConnector = createFeedConnector(FEED_DEFINITIONS.events);
export const gdeltGkgConnector = createFeedConnector(FEED_DEFINITIONS.gkg);
export const gdeltMentionsConnector = createFeedConnector(FEED_DEFINITIONS.mentions);

function createFeedConnector(definition: FeedDefinition): DataConnectorDefinition {
  return {
    schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
    capabilityId: definition.capabilityId,
    capabilityVersion: "1.0.0",
    minimumCliVersion: "0.0.55",
    provider: { providerId: "gdelt", name: "GDELT Project" },
    sourceCategory: "global-news-structured-feed",
    endpoints: [
      {
        endpointId: "gdelt-data",
        baseUrl: "https://data.gdeltproject.org",
        pathPrefixes: [DATA_PATH],
        allowedMethods: ["GET"],
        allowedContentTypes: ["text/plain", "application/zip", "application/octet-stream"],
      },
    ],
    license: {
      name: "GDELT Project data",
      url: "https://www.gdeltproject.org/about.html",
      restrictions: [
        "GDELT records are generated through automated monitoring and coding of source material.",
        "Source-specific rights still apply to linked content identified in GDELT records.",
        "This connector normalizes bounded rows in memory and does not persist downloaded source files.",
      ],
    },
    credentials: [],
    limits: {
      timeoutMs: 60_000,
      maxRequestBytes: 1_024,
      maxResponseBytes: 10_000_000,
      maxPages: MAX_FILES,
      maxRecords: 5_000,
      maxRetries: 4,
      maxRetryDelayMs: 120_000,
      maxRedirects: 2,
    },
    diagnostics: { static: true, live: false },
    freshness: {
      kind: "provider-current",
      description: "GDELT 2.0 publishes core feed files on an approximately 15-minute cadence.",
    },
    limitations: [
      "Events, entities, themes, locations, tone, and mention links are automatically coded and may be inaccurate.",
      "Monitored-source coverage varies across countries, languages, outlets, and time.",
      "A bounded range is generated from documented 15-minute paths and is not a completeness claim about the full archive.",
    ],
    discovery: {
      source: {
        maintainedBy: "The GDELT Project",
        summary: `GDELT 2.0 ${definition.kind} 15-minute structured data feed.`,
        description: `The GDELT Project publishes ${definition.kind} ZIP files as part of its automatically generated near-real-time global-news data feeds.`,
        coverage: {
          geographic: "Global monitored news sources, with uneven source and language coverage.",
          temporal:
            "GDELT 2.0 15-minute file timestamps; this operation accepts at most 20 files per run.",
          granularity: definition.granularity,
        },
      },
      summary: definition.summary,
      description:
        "Selects either the provider's latest feed entry or the first published 15-minute snapshots inside an explicit inclusive UTC range, verifies bounded single-member ZIP bytes, and emits closed named columns.",
      provides: [
        `Normalized ${definition.kind} rows with exact named fields from the published codebook layout.`,
        "Latest-file MD5 and compressed-size verification when the provider advertises them.",
        "ZIP member, size, CRC32, UTF-8, and column-count validation for every accepted file.",
      ],
      doesNotProvide: [
        "Article full text, article body retrieval, media bytes, or persisted downloaded files.",
        "A representative sample of all news, ground-truth facts, or complete global coverage.",
        "Causal interpretation or confirmation that automatically coded events and relationships occurred.",
      ],
      selectionHints: [
        `Choose this capability when the ${definition.kind} table is the intended GDELT schema.`,
        "Choose gdelt.web-ngrams for literal article discovery in known published minutes, or DOC for its query operators and aggregate timelines when available; neither is equivalent to coded table rows.",
        "GKG provides document annotations, Events provides coded events, and Mentions links events to documents. Select or join only the layers the question requires; no automatic three-table fallback.",
        "Use latest for the current provider file; range bounds may be unaligned, and selection starts at the first 15-minute snapshot at or after the lower bound.",
      ],
      typicalUseCases: [definition.useCase],
      sourceDocumentation: [
        ...definition.documentation,
        {
          title: "GDELT 2.0 data directory",
          url: "https://data.gdeltproject.org/gdeltv2/",
        },
      ],
    },
    operations: [
      {
        operationId: "fetch",
        operationVersion: "1.0.0",
        summary: `Fetch latest or bounded-range GDELT ${definition.kind} rows.`,
        description:
          "Uses only same-origin HTTPS feed paths, validates the ZIP and table layout, and stops before another request when the runtime record cap is reached.",
        inputSchema: GDELT_FILE_FEED_INPUT_SCHEMA,
        outputSchema: definition.outputSchema,
        execute: (context) => executeFeed(context, definition),
      },
    ],
  };
}

async function executeFeed(
  context: DataOperationExecutionContext,
  definition: FeedDefinition,
): Promise<DataOperationExecution> {
  const query = normalizeFeedQuery(context.input as FeedInput);
  const observations: DataSourceObservation[] = [];
  const effectiveFileLimit = Math.min(query.maxFiles, context.limits.maxPages);
  const plan =
    query.mode === "latest"
      ? {
          candidates: [await resolveLatestCandidate(context, definition, observations)],
          truncated: false,
        }
      : rangeCandidates(query, definition, effectiveFileLimit);
  const candidates = plan.candidates;
  const stoppedAtFileCap = plan.truncated;
  const files: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  const failures: Array<{ fileName: string; code: string; retryable: boolean }> = [];
  let firstFailure: unknown;
  let stoppedAtRecordCap = false;

  for (const candidate of candidates) {
    if (records.length >= context.limits.maxRecords) {
      stoppedAtRecordCap = true;
      break;
    }
    try {
      const response = await context.http.request({
        endpointId: "gdelt-data",
        method: "GET",
        path: `${DATA_PATH}${candidate.fileName}`,
      });
      observations.push({ ...response.observation, sourceId: `file:${candidate.fileName}` });
      const bytes = Buffer.from(response.bytes);
      verifyAdvertisedFile(bytes, candidate);
      const memberName = candidate.fileName.slice(0, -4);
      const parsed = parseSingleEntryZip(bytes, memberName);
      const parsedRows = parseRows(parsed.content, definition.fields, candidate.fileName);
      const remaining = context.limits.maxRecords - records.length;
      const emittedRows = parsedRows.rows.slice(0, remaining);
      for (const fields of emittedRows) {
        records.push({
          recordIndex: records.length,
          sourceFileTimestamp: candidate.timestamp,
          sourceFileName: candidate.fileName,
          fields,
        });
      }
      files.push({
        timestamp: candidate.timestamp,
        fileName: candidate.fileName,
        compressedBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        uncompressedBytes: parsed.uncompressedBytes,
        rowCount: parsedRows.totalRows,
        validRowCount: parsedRows.rows.length,
        invalidRowCount: parsedRows.invalidRowCount,
        validationIssues: parsedRows.issues,
        verifiedMd5: candidate.expectedMd5 === null ? null : true,
        crc32Verified: parsed.crc32Verified,
      });
      if (emittedRows.length < parsedRows.rows.length) {
        stoppedAtRecordCap = true;
        break;
      }
    } catch (error) {
      firstFailure ??= error;
      const normalized = normalizeFailure(error);
      failures.push({ fileName: candidate.fileName, ...normalized });
    }
  }

  if (files.length === 0 && firstFailure !== undefined) {
    throw firstFailure instanceof DataRuntimeError
      ? firstFailure
      : new DataRuntimeError(
          "provider-response-invalid",
          "No GDELT feed file could be retrieved and validated.",
        );
  }
  const invalidRowFiles = files
    .filter((file) => Number(file.invalidRowCount) > 0)
    .map((file) => `${String(file.fileName)}:invalid-rows`);
  const missing = [
    ...(failures.length > 0
      ? [{ kind: "file" as const, identifiers: failures.map((item) => item.fileName) }]
      : []),
    ...(invalidRowFiles.length > 0
      ? [{ kind: "field" as const, identifiers: invalidRowFiles }]
      : []),
  ];
  const partial = missing.length > 0;
  const truncated = stoppedAtRecordCap || stoppedAtFileCap;
  const stopReason = partial
    ? "partial"
    : truncated
      ? stoppedAtRecordCap
        ? "max-records"
        : "max-files"
      : records.length === 0
        ? "no-results"
        : "completed";
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            "One or more GDELT feed files or table rows could not be retrieved or validated.",
          retryable: failures.some((failure) => failure.retryable),
          userActionRequired: false,
          details: {
            missingFiles: failures.map((failure) => failure.fileName),
            ...(invalidRowFiles.length > 0 ? { invalidRowFiles } : {}),
          },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "gdelt",
        dataset: definition.kind,
        cadence: "15 minutes",
        metadataOnly: false,
      },
      query,
      files,
      records,
      failures,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: files.length,
      chunkCount: files.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing } : {}),
    },
    warnings: [
      "GDELT feed rows are automatically coded from uneven monitored-news coverage.",
      "Normalized records are not ground-truth facts or representative population measures.",
      ...(truncated
        ? [
            stoppedAtRecordCap
              ? "The operation stopped before another file after reaching the record limit."
              : "The operation stopped at the runtime file/page limit.",
          ]
        : []),
      ...(files.some((file) => Number(file.invalidRowCount) > 0)
        ? ["One or more source rows failed UTF-8 or column-count validation and were omitted."]
        : []),
    ],
    errors,
    observations,
  };
}

function normalizeFeedQuery(input: FeedInput): NormalizedFeedQuery {
  const maxFiles = input.maxFiles ?? 1;
  if (input.mode === "latest") {
    if (input.startDateTime !== undefined || input.endDateTime !== undefined) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT latest mode does not accept startDateTime or endDateTime.",
      );
    }
    return { mode: "latest", startDateTime: null, endDateTime: null, maxFiles };
  }
  if (input.startDateTime === undefined || input.endDateTime === undefined) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT range mode requires startDateTime and endDateTime.",
    );
  }
  const start = parseAlignedDateTime(input.startDateTime, "startDateTime");
  const end = parseAlignedDateTime(input.endDateTime, "endDateTime");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT startDateTime must not follow endDateTime.",
    );
  }
  return {
    mode: "range",
    startDateTime: canonicalDateTime(start),
    endDateTime: canonicalDateTime(end),
    maxFiles,
  };
}

async function resolveLatestCandidate(
  context: DataOperationExecutionContext,
  definition: FeedDefinition,
  observations: DataSourceObservation[],
): Promise<FeedCandidate> {
  const response = await context.http.request({
    endpointId: "gdelt-data",
    method: "GET",
    path: LAST_UPDATE_PATH,
  });
  observations.push({ ...response.observation, sourceId: "index:lastupdate" });
  for (const line of response.text().split(/\r?\n/)) {
    const match =
      /^(\d+)\s+([a-fA-F0-9]{32})\s+https?:\/\/data\.gdeltproject\.org\/gdeltv2\/(\d{14}[^\s/]+\.zip)$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const [, compressedBytesText, md5, fileName] = match;
    if (!compressedBytesText || !md5 || !fileName || !fileName.endsWith(definition.suffix))
      continue;
    const timestamp = fileName.slice(0, 14);
    if (fileName !== `${timestamp}${definition.suffix}`) continue;
    const expectedCompressedBytes = Number(compressedBytesText);
    if (!Number.isSafeInteger(expectedCompressedBytes) || expectedCompressedBytes <= 0) break;
    return {
      timestamp,
      fileName,
      expectedCompressedBytes,
      expectedMd5: md5.toLowerCase(),
    };
  }
  throw new DataRuntimeError(
    "provider-response-invalid",
    `GDELT lastupdate.txt did not contain a valid ${definition.kind} entry.`,
  );
}

function rangeCandidates(
  query: NormalizedFeedQuery,
  definition: FeedDefinition,
  limit: number,
): { candidates: FeedCandidate[]; truncated: boolean } {
  const start = new Date(query.startDateTime as string);
  const end = new Date(query.endDateTime as string);
  const firstTimestamp = Math.ceil(start.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const availableCount =
    firstTimestamp > end.getTime()
      ? 0
      : Math.floor((end.getTime() - firstTimestamp) / FIFTEEN_MINUTES_MS) + 1;
  const candidates: FeedCandidate[] = [];
  for (
    let time = firstTimestamp;
    time <= end.getTime() && candidates.length < limit;
    time += FIFTEEN_MINUTES_MS
  ) {
    const timestamp = gdeltTimestamp(new Date(time));
    candidates.push({
      timestamp,
      fileName: `${timestamp}${definition.suffix}`,
      expectedCompressedBytes: null,
      expectedMd5: null,
    });
  }
  return { candidates, truncated: availableCount > candidates.length };
}

function verifyAdvertisedFile(bytes: Buffer, candidate: FeedCandidate): void {
  if (
    candidate.expectedCompressedBytes !== null &&
    bytes.byteLength !== candidate.expectedCompressedBytes
  ) {
    throw providerInvalid(
      "GDELT feed bytes do not match the compressed size advertised by lastupdate.txt.",
    );
  }
  if (candidate.expectedMd5 !== null) {
    const digest = createHash("md5").update(bytes).digest("hex");
    if (digest !== candidate.expectedMd5) {
      throw providerInvalid("GDELT feed bytes do not match the MD5 advertised by lastupdate.txt.");
    }
  }
}

function parseSingleEntryZip(bytes: Buffer, expectedMemberName: string): ParsedZip {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0 || eocdOffset + 22 !== bytes.byteLength)
    throw providerInvalid("GDELT ZIP has an invalid end-of-central-directory record.");
  if (readU16(bytes, eocdOffset + 4) !== 0 || readU16(bytes, eocdOffset + 6) !== 0)
    throw providerInvalid("Multi-disk GDELT ZIP files are not supported.");
  if (readU16(bytes, eocdOffset + 8) !== 1 || readU16(bytes, eocdOffset + 10) !== 1)
    throw providerInvalid("GDELT ZIP must contain exactly one member.");
  if (readU16(bytes, eocdOffset + 20) !== 0)
    throw providerInvalid("GDELT ZIP comments are not accepted.");
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (centralOffset + centralSize !== eocdOffset || centralOffset + 46 > bytes.byteLength)
    throw providerInvalid("GDELT ZIP central directory is out of bounds.");
  if (readU32(bytes, centralOffset) !== 0x02014b50)
    throw providerInvalid("GDELT ZIP central directory signature is invalid.");
  const flags = readU16(bytes, centralOffset + 8);
  const method = readU16(bytes, centralOffset + 10);
  const expectedCrc = readU32(bytes, centralOffset + 16);
  const compressedSize = readU32(bytes, centralOffset + 20);
  const uncompressedSize = readU32(bytes, centralOffset + 24);
  const nameLength = readU16(bytes, centralOffset + 28);
  const extraLength = readU16(bytes, centralOffset + 30);
  const commentLength = readU16(bytes, centralOffset + 32);
  const diskStart = readU16(bytes, centralOffset + 34);
  const localOffset = readU32(bytes, centralOffset + 42);
  if ((flags & 0x0009) !== 0 || ![0, 8].includes(method))
    throw providerInvalid("GDELT ZIP encryption and data descriptors are not accepted.");
  if (diskStart !== 0 || extraLength > 4_096 || commentLength !== 0 || localOffset !== 0)
    throw providerInvalid("GDELT ZIP contains unsupported directory metadata.");
  if (
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    uncompressedSize > MAX_UNCOMPRESSED_BYTES
  )
    throw providerInvalid("GDELT ZIP size is unsupported or exceeds the decompression limit.");
  const centralNameStart = centralOffset + 46;
  const centralNameEnd = centralNameStart + nameLength;
  if (centralNameEnd + extraLength + commentLength !== eocdOffset)
    throw providerInvalid("GDELT ZIP central directory length is inconsistent.");
  const centralName = decodeUtf8(
    bytes.subarray(centralNameStart, centralNameEnd),
    "ZIP member name",
  );
  if (centralName !== expectedMemberName || !isSafeMemberName(centralName))
    throw providerInvalid(
      "GDELT ZIP member name is unsafe or does not match the selected feed file.",
    );
  if (readU32(bytes, 0) !== 0x04034b50)
    throw providerInvalid("GDELT ZIP local header signature is invalid.");
  const localFlags = readU16(bytes, 6);
  const localMethod = readU16(bytes, 8);
  const localCrc = readU32(bytes, 14);
  const localCompressedSize = readU32(bytes, 18);
  const localUncompressedSize = readU32(bytes, 22);
  const localNameLength = readU16(bytes, 26);
  const localExtraLength = readU16(bytes, 28);
  if (
    localFlags !== flags ||
    localMethod !== method ||
    localCrc !== expectedCrc ||
    localCompressedSize !== compressedSize ||
    localUncompressedSize !== uncompressedSize ||
    localExtraLength > 4_096
  )
    throw providerInvalid("GDELT ZIP local and central headers disagree.");
  const localNameStart = 30;
  const localNameEnd = localNameStart + localNameLength;
  if (
    decodeUtf8(bytes.subarray(localNameStart, localNameEnd), "ZIP local member name") !==
    centralName
  )
    throw providerInvalid("GDELT ZIP member names disagree.");
  const compressedStart = localNameEnd + localExtraLength;
  const compressedEnd = compressedStart + compressedSize;
  if (compressedEnd !== centralOffset)
    throw providerInvalid("GDELT ZIP compressed member bounds are inconsistent.");
  const compressed = bytes.subarray(compressedStart, compressedEnd);
  let content: Buffer;
  try {
    content =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw providerInvalid("GDELT ZIP member could not be decompressed within the declared limit.");
  }
  if (content.byteLength !== uncompressedSize || crc32(content) !== expectedCrc)
    throw providerInvalid("GDELT ZIP member size or CRC32 validation failed.");
  return {
    content,
    uncompressedBytes: content.byteLength,
    crc32Verified: true,
  };
}

function parseRows(content: Buffer, fields: readonly string[], fileName: string): ParsedRows {
  const rows: Array<Record<string, string>> = [];
  const issues: string[] = [];
  let totalRows = 0;
  let invalidRowCount = 0;
  let lineStart = 0;
  for (let offset = 0; offset <= content.length; offset += 1) {
    if (offset < content.length && content[offset] !== 0x0a) continue;
    let lineEnd = offset;
    if (lineEnd > lineStart && content[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineStart === content.length || (lineEnd === lineStart && offset === content.length)) break;
    totalRows += 1;
    const lineBytes = content.subarray(lineStart, lineEnd);
    lineStart = offset + 1;
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch {
      invalidRowCount += 1;
      addRowIssue(issues, `Row ${totalRows} is not valid UTF-8.`);
      continue;
    }
    if (!line || line.includes("\0")) {
      invalidRowCount += 1;
      addRowIssue(issues, `Row ${totalRows} is empty or contains a NUL byte.`);
      continue;
    }
    const values = line.split("\t");
    if (values.length !== fields.length) {
      invalidRowCount += 1;
      addRowIssue(
        issues,
        `Row ${totalRows} has ${values.length} columns; expected ${fields.length}.`,
      );
      continue;
    }
    rows.push(Object.fromEntries(fields.map((field, index) => [field, values[index] as string])));
  }
  return { rows, totalRows, invalidRowCount, issues };
}

function parseAlignedDateTime(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    throw new DataRuntimeError("invalid-request", `${field} must be a canonical UTC timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || canonicalDateTime(parsed) !== value) {
    throw new DataRuntimeError(
      "invalid-request",
      `${field} must be a valid canonical UTC timestamp.`,
    );
  }
  return parsed;
}

function addRowIssue(issues: string[], issue: string): void {
  if (issues.length < 20) issues.push(issue);
}

function canonicalDateTime(value: Date): string {
  return value.toISOString().replace(".000Z", "Z");
}

function gdeltTimestamp(value: Date): string {
  return canonicalDateTime(value).replace(/[-:TZ]/g, "");
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readU16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength)
    throw providerInvalid("GDELT ZIP structure is truncated.");
  return bytes.readUInt16LE(offset);
}

function readU32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength)
    throw providerInvalid("GDELT ZIP structure is truncated.");
  return bytes.readUInt32LE(offset);
}

function decodeUtf8(bytes: Uint8Array, field: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw providerInvalid(`${field} is not valid UTF-8.`);
  }
}

function isSafeMemberName(value: string): boolean {
  return (
    Boolean(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function normalizeFailure(error: unknown): { code: string; retryable: boolean } {
  return error instanceof DataRuntimeError
    ? { code: error.code, retryable: error.options.retryable ?? false }
    : { code: "provider-response-invalid", retryable: false };
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

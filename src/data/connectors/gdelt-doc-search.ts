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
  GDELT_DOC_SEARCH_INPUT_SCHEMA,
  GDELT_DOC_SEARCH_OUTPUT_SCHEMA,
} from "./gdelt-doc-search.schemas.js";

const DOC_PATH = "/api/v2/doc/doc";
const TIMELINE_MODES = new Set([
  "timelinevol",
  "timelinevolraw",
  "timelinetone",
  "timelinelang",
  "timelinesourcecountry",
]);
const RELATIVE_MAXIMUMS = {
  minutes: 527_040,
  hours: 8_784,
  days: 366,
  weeks: 52,
  months: 12,
  years: 1,
} as const;
const RELATIVE_SUFFIXES = {
  minutes: "min",
  hours: "h",
  days: "d",
  weeks: "w",
  months: "m",
  years: "y",
} as const;

type DocMode =
  | "artlist"
  | "tonechart"
  | "timelinevol"
  | "timelinevolraw"
  | "timelinetone"
  | "timelinelang"
  | "timelinesourcecountry";
type RelativeUnit = keyof typeof RELATIVE_MAXIMUMS;
type ArticleSort = "datedesc" | "dateasc" | "tonedesc" | "toneasc" | "hybridrel";

interface GdeltDocInput {
  query: string;
  mode: DocMode;
  relativeWindow?: { value: number; unit: RelativeUnit };
  absoluteWindow?: { from: string; to: string };
  maxRecords?: number;
  sort?: ArticleSort;
  timelineSmooth?: number;
  domains?: string[];
  exactDomains?: string[];
  continueOnQueryError?: boolean;
}

interface NormalizedDocQuery {
  query: string;
  mode: DocMode;
  relativeWindow: { value: number; unit: RelativeUnit } | null;
  absoluteWindow: { from: string; to: string } | null;
  maxRecords: number | null;
  sort: ArticleSort | null;
  timelineSmooth: number | null;
  domainFilters: string[];
  continueOnQueryError: boolean;
}

export const gdeltDocSearchConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "gdelt.doc-search",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "gdelt", name: "GDELT Project" },
  sourceCategory: "global-news-metadata",
  endpoints: [
    {
      endpointId: "gdelt-doc-api",
      baseUrl: "https://api.gdeltproject.org",
      pathPrefixes: ["/api/v2/doc/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
      minRequestIntervalMs: 5_000,
    },
  ],
  license: {
    name: "GDELT Project data",
    url: "https://www.gdeltproject.org/about.html",
    restrictions: [
      "GDELT derives signals automatically from monitored news and other open sources.",
      "Users remain responsible for source-specific rights when following or reusing linked content.",
      "This connector returns DOC metadata and aggregate timelines, not article bodies or media bytes.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 20_000_000,
    maxPages: 20,
    maxRecords: 5_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 2,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description: "DOC results reflect the provider's rolling index at request time.",
  },
  limitations: [
    "Non-timeline DOC modes only consider the final three months of a longer selected window under provider behavior.",
    "Language translation, entity extraction, tone, and topical coding are automated and can be wrong.",
    "Monitored-source coverage and reporting volume vary across countries, languages, and time.",
  ],
  discovery: {
    source: {
      maintainedBy: "The GDELT Project",
      summary: "GDELT DOC 2.0 global news search metadata and aggregate timelines.",
      description:
        "The GDELT DOC 2.0 API searches a rolling multilingual news index and exposes article-link metadata or aggregate timelines derived through automated processing.",
      coverage: {
        geographic: "Global monitored news sources, with uneven source and language coverage.",
        temporal:
          "Provider-searchable DOC holdings; non-timeline modes only consider the final three months of a longer selected window.",
        granularity:
          "One indexed article metadata item or one timestamped aggregate timeline point.",
      },
    },
    summary: "Search recent GDELT news metadata or bounded aggregate news timelines.",
    description:
      "Use a closed DOC 2.0 JSON surface with an optional rolling or absolute window; repeated domain filters are split into bounded requests and output is normalized under the common runtime.",
    provides: [
      "Article-link metadata for bounded recent-news queries.",
      "Volume, raw-volume, tone, language, or source-country timeline series.",
      "Tone-distribution histogram bins for tonechart mode.",
      "Local rejection of unsupported site:/inurl: syntax and unparenthesized boolean OR groups.",
      "Explicit query parameters and machine-verifiable source observations.",
    ],
    doesNotProvide: [
      "Article full text, article body downloads, image bytes, or archived source files.",
      "Representative samples of all news, population opinion, or ground-truth facts.",
      "Causal conclusions or validation that an automatically extracted claim or event occurred.",
    ],
    selectionHints: [
      "Choose DOC search for recent article discovery or aggregate attention/tone trends.",
      "During legacy search load-shedding, consider gdelt.web-ngrams for explicitly selected literal phrase-to-article discovery in known published minutes; it cannot reproduce DOC operators or aggregate timelines.",
      "Choose the Events, Mentions, or GKG file capability for structured 15-minute feed records.",
      "Treat returned links as candidates for separately governed source retrieval and verification.",
      "Use exactDomains for domainis: filters and domains for suffix-matching domain: filters; each value becomes a separate bounded query batch.",
    ],
    typicalUseCases: [
      "Find recent article metadata matching a topic and country filter.",
      "Compare the temporal shape of monitored-news attention within a bounded window.",
    ],
    sourceDocumentation: [
      {
        title: "Official file-based keyword-search alternative during migration",
        url: "https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/",
      },
      {
        title: "Dynamic API load shedding and infrastructure migration",
        url: "https://blog.gdeltproject.org/scaling-with-gcp-global-load-balancer-why-were-moving-to-gcps-global-load-balancing-infrastructure/",
      },
      {
        title: "GDELT DOC 2.0 API",
        url: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
      },
      { title: "About GDELT", url: "https://www.gdeltproject.org/about.html" },
    ],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.0",
      summary: "Search recent article metadata or one supported GDELT DOC timeline.",
      description:
        "Validates one bounded search window and mode-specific parameters, calls the JSON endpoint, and normalizes article metadata or timeline points without retrieving linked content.",
      inputSchema: GDELT_DOC_SEARCH_INPUT_SCHEMA,
      outputSchema: GDELT_DOC_SEARCH_OUTPUT_SCHEMA,
      execute: executeGdeltDocSearch,
    },
  ],
};

async function executeGdeltDocSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeQuery(context.input as GdeltDocInput);
  const effectiveQueries =
    query.domainFilters.length === 0
      ? [query.query]
      : query.domainFilters.map((filter) => composeDomainQuery(query.query, filter));
  if (effectiveQueries.length > context.limits.maxPages) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC split-domain queries exceed the effective request limit.",
      { details: { queryCount: effectiveQueries.length, maxQueries: context.limits.maxPages } },
    );
  }
  const batches: Array<{
    query: string;
    payload: Record<string, unknown>;
    observation: DataSourceObservation;
  }> = [];
  const failures: Array<{ query: string; code: string; error: unknown }> = [];
  for (const effectiveQuery of effectiveQueries) {
    try {
      const response = await context.http.request({
        endpointId: "gdelt-doc-api",
        method: "GET",
        path: DOC_PATH,
        query: buildProviderQuery(query, effectiveQuery),
      });
      const payload = requireObject(response.json(), "GDELT DOC response");
      validateModePayload(payload, query.mode);
      batches.push({ query: effectiveQuery, payload, observation: response.observation });
    } catch (error) {
      if (!query.continueOnQueryError) throw normalizeProviderFailure(error);
      const normalized = normalizeProviderFailure(error);
      failures.push({ query: effectiveQuery, code: normalized.code, error: normalized });
    }
  }
  if (batches.length === 0) {
    throw new DataRuntimeError("provider-response-invalid", "All GDELT DOC query batches failed.", {
      details: { failedQueries: failures.map((item) => item.query) },
    });
  }
  const partial = failures.length > 0;
  const queryDetails = normalizeQueryDetails(batches[0]!.payload.query_details);
  const batchQueries = batches.map((batch) => ({
    query: batch.query,
    queryDetails: normalizeQueryDetails(batch.payload.query_details),
  }));
  const queryErrors = failures.map(({ query: failedQuery, code }) => ({
    query: failedQuery,
    code,
  }));
  const observations = batches.map((batch, index) => ({
    ...batch.observation,
    sourceId: `doc:batch:${index + 1}`,
  }));
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "One or more split GDELT DOC query batches failed.",
          retryable: failures.some(
            ({ error }) => error instanceof DataRuntimeError && (error.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: { failedQueries: failures.map((item) => item.query) },
        },
      ]
    : [];
  if (query.mode === "artlist") {
    const cap = Math.min(context.limits.maxRecords, query.maxRecords ?? 75);
    const articles: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let availableArticleCount = 0;
    for (const batch of batches) {
      for (const value of requireArray(batch.payload.articles, "articles")) {
        const article = normalizeArticle(value, availableArticleCount, batch.query);
        if (!article) continue;
        const identity = articleIdentity(article);
        if (seen.has(identity)) continue;
        seen.add(identity);
        availableArticleCount += 1;
        if (articles.length < cap) articles.push(article);
      }
    }
    const truncated = availableArticleCount > articles.length;
    return {
      status: partial ? "partial" : "success",
      data: {
        source: { providerId: "gdelt", endpoint: DOC_PATH, metadataOnly: true },
        query,
        kind: "articles",
        queryDetails,
        batchQueries,
        queryErrors,
        articles,
        timelines: [],
        toneBins: [],
        stopReason: partial
          ? "partial"
          : articles.length === 0
            ? "no-results"
            : truncated
              ? "max-records"
              : "completed",
      },
      summary: {
        recordCount: articles.length,
        pageCount: batches.length,
        chunkCount: 0,
        truncated,
        completeness: partial ? "partial" : "complete",
        ...(partial
          ? {
              missing: [
                { kind: "range" as const, identifiers: failures.map((item) => item.query) },
              ],
            }
          : {}),
      },
      warnings: discoveryWarnings(truncated),
      errors,
      observations,
    };
  }

  if (query.mode === "tonechart") {
    const normalized = batches.map((batch, index) =>
      normalizeToneBins(batch.payload, batch.query, index),
    );
    const toneBins = normalized.flatMap((batch) => batch.records);
    const invalidBinCount = normalized.reduce((sum, batch) => sum + batch.invalidBinCount, 0);
    const invalidPaths = normalized.flatMap((batch) => batch.invalidPaths).slice(0, 20);
    const tonePartial = partial || invalidBinCount > 0;
    const missing = [
      ...(partial
        ? [{ kind: "range" as const, identifiers: failures.map((item) => item.query) }]
        : []),
      ...(invalidPaths.length > 0 ? [{ kind: "field" as const, identifiers: invalidPaths }] : []),
    ];
    if (invalidBinCount > 0) {
      errors.push({
        code: "partial-result",
        message:
          "One or more GDELT DOC tone bins could not be normalized; valid bins were retained.",
        retryable: false,
        userActionRequired: false,
        details: { invalidBinCount, invalidPaths },
      });
    }
    const capped = toneBins.slice(0, context.limits.maxRecords);
    const truncated = toneBins.length > capped.length;
    return {
      status: tonePartial ? "partial" : "success",
      data: {
        source: { providerId: "gdelt", endpoint: DOC_PATH, metadataOnly: true },
        query,
        kind: "tone-chart",
        queryDetails,
        batchQueries,
        queryErrors,
        articles: [],
        timelines: [],
        toneBins: capped,
        stopReason: tonePartial
          ? "partial"
          : capped.length === 0
            ? "no-results"
            : truncated
              ? "max-records"
              : "completed",
      },
      summary: {
        recordCount: capped.length,
        pageCount: batches.length,
        chunkCount: batches.length,
        truncated,
        completeness: tonePartial ? "partial" : "complete",
        ...(tonePartial ? { missing } : {}),
      },
      warnings: discoveryWarnings(truncated),
      errors,
      observations,
    };
  }

  let remaining = context.limits.maxRecords;
  let rawPointCount = 0;
  const timelines = batches.flatMap((batch) =>
    requireArray(batch.payload.timeline, "timeline").map((value, seriesIndex) => {
      const series = requireObject(value, `timeline[${seriesIndex}]`);
      const rawData = requireArray(series.data, `timeline[${seriesIndex}].data`);
      rawPointCount += rawData.length;
      const data = rawData
        .slice(0, remaining)
        .map((point, pointIndex) =>
          normalizeTimelinePoint(point, `timeline[${seriesIndex}].data[${pointIndex}]`),
        );
      remaining -= data.length;
      return {
        query: batch.query,
        series: requireNonBlankString(series.series, `timeline[${seriesIndex}].series`),
        data,
      };
    }),
  );
  const recordCount = context.limits.maxRecords - remaining;
  const truncated = rawPointCount > recordCount;
  return {
    status: partial ? "partial" : "success",
    data: {
      source: { providerId: "gdelt", endpoint: DOC_PATH, metadataOnly: true },
      query,
      kind: "timeline",
      queryDetails,
      batchQueries,
      queryErrors,
      articles: [],
      timelines,
      toneBins: [],
      stopReason: partial
        ? "partial"
        : recordCount === 0
          ? "no-results"
          : truncated
            ? "max-records"
            : "completed",
    },
    summary: {
      recordCount,
      pageCount: batches.length,
      chunkCount: timelines.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial
        ? {
            missing: [{ kind: "range" as const, identifiers: failures.map((item) => item.query) }],
          }
        : {}),
    },
    warnings: discoveryWarnings(truncated),
    errors,
    observations,
  };
}

function normalizeQuery(input: GdeltDocInput): NormalizedDocQuery {
  const query = input.query.trim().replace(/\s+/g, " ");
  if (!query || /[\u0000-\u001f\u007f]/.test(input.query)) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC query must be non-blank text without control characters.",
    );
  }
  const hasRelative = input.relativeWindow !== undefined;
  const hasAbsolute = input.absoluteWindow !== undefined;
  if (hasRelative && hasAbsolute) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC search accepts relativeWindow or absoluteWindow, not both.",
    );
  }
  let relativeWindow: NormalizedDocQuery["relativeWindow"] = null;
  let absoluteWindow: NormalizedDocQuery["absoluteWindow"] = null;
  if (input.relativeWindow) {
    if (input.relativeWindow.unit === "minutes" && input.relativeWindow.value < 15) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT DOC relativeWindow must span at least 15 minutes.",
      );
    }
    relativeWindow = { ...input.relativeWindow };
  }
  if (input.absoluteWindow) {
    const from = parseRfc3339(input.absoluteWindow.from, "absoluteWindow.from");
    const to = parseRfc3339(input.absoluteWindow.to, "absoluteWindow.to");
    if (from.getTime() > to.getTime()) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT DOC absoluteWindow.from must not follow absoluteWindow.to.",
      );
    }
    absoluteWindow = {
      from: from.toISOString().replace(".000Z", "Z"),
      to: to.toISOString().replace(".000Z", "Z"),
    };
  }
  const timeline = TIMELINE_MODES.has(input.mode);
  if (input.mode === "artlist" && input.timelineSmooth !== undefined) {
    throw new DataRuntimeError(
      "invalid-request",
      "timelineSmooth is accepted only for timeline modes.",
    );
  }
  if (input.mode !== "artlist" && (input.maxRecords !== undefined || input.sort !== undefined)) {
    throw new DataRuntimeError(
      "invalid-request",
      "maxRecords and sort are accepted only for artlist mode.",
    );
  }
  const domainFilters = [
    ...(input.domains ?? []).map((value) => `domain:${normalizeDomain(value, "domains")}`),
    ...(input.exactDomains ?? []).map(
      (value) => `domainis:${normalizeDomain(value, "exactDomains")}`,
    ),
  ];
  const effectiveQueries =
    domainFilters.length === 0
      ? [query]
      : domainFilters.map((filter) => composeDomainQuery(query, filter));
  for (const effectiveQuery of effectiveQueries) lintQuery(effectiveQuery);
  return {
    query,
    mode: input.mode,
    relativeWindow,
    absoluteWindow,
    maxRecords: input.mode === "artlist" ? (input.maxRecords ?? 75) : null,
    sort: input.mode === "artlist" ? (input.sort ?? "hybridrel") : null,
    timelineSmooth: timeline ? (input.timelineSmooth ?? 0) : null,
    domainFilters,
    continueOnQueryError: input.continueOnQueryError ?? false,
  };
}

function buildProviderQuery(
  query: NormalizedDocQuery,
  effectiveQuery: string,
): Record<string, string | number> {
  return {
    format: "json",
    mode: query.mode,
    query: effectiveQuery,
    ...(query.relativeWindow
      ? { TIMESPAN: `${query.relativeWindow.value}${RELATIVE_SUFFIXES[query.relativeWindow.unit]}` }
      : {}),
    ...(query.absoluteWindow
      ? {
          STARTDATETIME: gdeltDateTime(query.absoluteWindow.from),
          ENDDATETIME: gdeltDateTime(query.absoluteWindow.to),
        }
      : {}),
    ...(query.maxRecords === null ? {} : { MAXRECORDS: query.maxRecords }),
    ...(query.sort === null ? {} : { sort: query.sort }),
    ...(query.timelineSmooth === null ? {} : { TIMELINESMOOTH: query.timelineSmooth }),
  };
}

function normalizeArticle(
  value: unknown,
  index: number,
  sourceQuery: string,
): Record<string, unknown> | null {
  const article = objectOrNull(value);
  if (!article) return null;
  return {
    recordIndex: index,
    sourceQuery,
    url: looseNullableString(article.url),
    mobileUrl: looseNullableString(article.url_mobile),
    title: looseString(article.title),
    seenDateTime: optionalProviderDateTime(article.seendate),
    socialImageUrl: looseNullableString(article.socialimage),
    domain: looseString(article.domain),
    language: looseString(article.language),
    sourceCountry: looseString(article.sourcecountry),
  };
}

function articleIdentity(article: Record<string, unknown>): string {
  return String(article.url || article.title || JSON.stringify(article));
}

function normalizeToneBins(
  payload: Record<string, unknown>,
  sourceQuery: string,
  batchIndex: number,
): { records: Array<Record<string, unknown>>; invalidBinCount: number; invalidPaths: string[] } {
  const rawToneChart = payload.tonechart;
  const bins = Array.isArray(rawToneChart)
    ? rawToneChart
    : objectOrNull(rawToneChart) && Array.isArray(objectOrNull(rawToneChart)?.bins)
      ? (objectOrNull(rawToneChart)?.bins as unknown[])
      : [];
  let invalidBinCount = 0;
  const invalidPaths: string[] = [];
  const records = bins.flatMap((value, index) => {
    const invalid = (): [] => {
      invalidBinCount += 1;
      if (invalidPaths.length < 20) invalidPaths.push(`batches[${batchIndex}].tonechart[${index}]`);
      return [];
    };
    const bin = objectOrNull(value);
    if (!bin) return invalid();
    const rawTone = bin.bin ?? bin.tone ?? bin.label;
    const toneBin =
      typeof rawTone === "number" && Number.isFinite(rawTone)
        ? String(rawTone)
        : looseString(rawTone);
    const articleCount = finiteNumber(bin.count ?? bin.value);
    if (!toneBin || articleCount === null || articleCount < 0) return invalid();
    const rawArticles = bin.toparts ?? bin.articles;
    const representativeArticles = Array.isArray(rawArticles)
      ? rawArticles.flatMap((article, articleIndex) => {
          const normalized = normalizeArticle(article, articleIndex, sourceQuery);
          return normalized ? [normalized] : [];
        })
      : [];
    return [
      {
        recordIndex: index,
        sourceQuery,
        toneBin,
        articleCount,
        representativeArticles,
      },
    ];
  });
  return { records, invalidBinCount, invalidPaths };
}

function validateModePayload(payload: Record<string, unknown>, mode: DocMode): void {
  if (mode === "artlist") {
    requireArray(payload.articles, "articles");
    return;
  }
  if (mode === "tonechart") {
    const chart = payload.tonechart;
    if (
      !Array.isArray(chart) &&
      !(objectOrNull(chart) && Array.isArray(objectOrNull(chart)?.bins))
    ) {
      throw providerInvalid("GDELT DOC tonechart response must contain tonechart bins.");
    }
    return;
  }
  requireArray(payload.timeline, "timeline");
}

function normalizeTimelinePoint(value: unknown, field: string): Record<string, unknown> {
  const point = requireObject(value, field);
  return {
    dateTime: parseProviderDateTime(point.date, `${field}.date`),
    value: requireFiniteNumber(point.value, `${field}.value`),
    norm:
      point.norm === undefined || point.norm === null
        ? null
        : requireFiniteNumber(point.norm, `${field}.norm`),
  };
}

function normalizeQueryDetails(
  value: unknown,
): Record<string, string | number | boolean | null> | null {
  if (value === undefined || value === null) return null;
  const details = requireObject(value, "query_details");
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(details)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      normalized[key] = item;
    }
  }
  return normalized;
}

function parseProviderDateTime(value: unknown, field: string): string {
  if (typeof value !== "string") throw providerInvalid(`${field} must be a timestamp string.`);
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw providerInvalid(`${field} must use a GDELT UTC timestamp.`);
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== iso) {
    throw providerInvalid(`${field} must be a valid UTC timestamp.`);
  }
  return iso;
}

function parseRfc3339(value: string, field: string): Date {
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      `${field} must be an exact canonical UTC timestamp.`,
    );
  }
  return parsed;
}

function gdeltDateTime(value: string): string {
  return value.replace(/[-:TZ.]/g, "").slice(0, 14);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw providerInvalid(`${field} must be an array.`);
  return value;
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw providerInvalid(`${field} must be a non-empty string.`);
  return value.trim();
}

function looseString(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function looseNullableString(value: unknown): string | null {
  return looseString(value) || null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalProviderDateTime(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  try {
    return parseProviderDateTime(value, "article.seendate");
  } catch {
    return null;
  }
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw providerInvalid(`${field} must be a finite number.`);
  return value;
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  return error instanceof DataRuntimeError
    ? error
    : providerInvalid("The GDELT DOC response could not be retrieved or normalized.");
}

function normalizeDomain(value: string, field: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/", 1)[0]!;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) {
    throw new DataRuntimeError(
      "invalid-request",
      `GDELT DOC ${field} values must be bare DNS domains.`,
    );
  }
  return normalized;
}

function composeDomainQuery(query: string, domainFilter: string): string {
  const base = hasTopLevelOr(query) ? `(${query})` : query;
  return `${domainFilter} ${base}`;
}

function lintQuery(query: string): void {
  const unsupported = /(?:^|\s)(site|inurl):/i.exec(query);
  if (unsupported) {
    throw new DataRuntimeError(
      "invalid-request",
      `GDELT DOC does not support ${unsupported[1]!.toLowerCase()}:; use domainis: or domain: instead.`,
    );
  }
  if (hasTopLevelOr(query)) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC boolean OR groups must be enclosed in parentheses.",
    );
  }
}

function hasTopLevelOr(query: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      query.slice(index).match(/^OR\b/i) &&
      (index === 0 || /\s/.test(query[index - 1]!))
    ) {
      return true;
    }
  }
  return false;
}

function discoveryWarnings(truncated: boolean): string[] {
  return [
    "GDELT DOC signals are automatically extracted from uneven monitored-news coverage.",
    "Returned metadata and timelines are not ground-truth facts or representative population measures.",
    ...(truncated ? ["The normalized result stopped at the explicit record limit."] : []),
  ];
}

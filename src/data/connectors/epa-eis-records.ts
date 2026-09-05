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
  EPA_EIS_COMMON_SEARCHES,
  EPA_EIS_RECORDS_INPUT_SCHEMA,
  EPA_EIS_RECORDS_OUTPUT_SCHEMA,
} from "./epa-eis-records.schemas.js";

const PROVIDER_ORIGIN = "https://cdxapps.epa.gov";
const SEARCH_PATH = "/cdx-enepa-II/public/action/eis/search";
const COMMON_SEARCH_SET = new Set<string>(EPA_EIS_COMMON_SEARCHES);

type CommonSearch = (typeof EPA_EIS_COMMON_SEARCHES)[number];

interface EpaEisInput {
  commonSearches?: CommonSearch[];
  searchUrls?: string[];
}

interface PlannedSearch {
  sourceKind: "common-search" | "explicit-search-url";
  commonSearch: CommonSearch | null;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
}

interface EpaEisDownloadLink {
  url: string;
  text: string;
}

interface EpaEisRecord {
  recordId: string;
  title: string;
  ceqNumber: string | null;
  uniqueIdentificationNumber: string | null;
  documentType: string | null;
  epaCommentLetterDate: string | null;
  federalRegisterDate: string | null;
  leadAgency: string | null;
  federalCooperatingAgencies: string | null;
  state: string | null;
  detailUrl: string | null;
  downloadLinks: EpaEisDownloadLink[];
  downloadDocumentIds: string[];
  sourcePageUrl: string;
}

interface ParsedCell {
  text: string;
  links: EpaEisDownloadLink[];
  onclicks: string[];
}

interface ParsedEisPage {
  tableFound: boolean;
  pageBanner: string;
  providerResultCount: number | null;
  records: EpaEisRecord[];
  invalidRowCount: number;
}

interface HtmlState {
  tableFound: boolean;
  tableDepth: number;
  inTbody: boolean;
  inRow: boolean;
  inCell: boolean;
  inPageBanner: boolean;
  pageBannerParts: string[];
  rowCells: ParsedCell[];
  cellTextParts: string[];
  cellLinks: EpaEisDownloadLink[];
  cellOnclicks: string[];
  activeHref: string | null;
  activeLinkTextParts: string[];
  records: EpaEisRecord[];
  invalidRowCount: number;
}

export const epaEisRecordsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "epa.eis-records",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "epa-eis-database",
    name: "U.S. Environmental Protection Agency EIS Database",
  },
  sourceCategory: "environmental-review-governance-records",
  endpoints: [
    {
      endpointId: "epa-eis-database",
      baseUrl: PROVIDER_ORIGIN,
      pathPrefixes: ["/cdx-enepa-II/public/action/eis/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["text/html", "application/xhtml+xml"],
      sessionCookies: "same-origin-memory",
    },
  ],
  license: {
    name: "U.S. EPA public information",
    url: "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search",
    restrictions: [
      "Preserve EPA EIS Database provenance and links when reusing record metadata.",
      "Document availability cues do not establish that linked files were downloaded or reviewed.",
      "Database metadata does not itself determine NEPA adequacy, legal sufficiency, environmental effects, or policy responsibility.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 16_384,
    maxResponseBytes: 20_000_000,
    maxPages: 10,
    maxRecords: 500,
    maxRetries: 3,
    maxRetryDelayMs: 60_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Records reflect the selected EPA EIS Database result pages at request time and may change as EPA updates the database.",
  },
  limitations: [
    "The capability parses the current submissionsTable HTML surface rather than a versioned JSON API; provider markup changes fail closed.",
    "Common searches and explicit UI-created search URLs expose only the provider result surface, which can be sparse, stale, or capped at 500 records.",
    "An empty result is specific to the selected search page and is not proof that no EIS record exists.",
    "The capability returns metadata and document-availability cues but does not fetch or assess linked documents.",
  ],
  discovery: {
    source: {
      maintainedBy: "United States Environmental Protection Agency",
      summary:
        "Official EPA EIS Database result metadata for Environmental Impact Statement submissions.",
      description:
        "The EPA EIS Database publishes searchable NEPA/EIS submission rows including title, CEQ and provider identifiers, document type, dates, agencies, state, detail pages, and document availability cues.",
      coverage: {
        geographic:
          "United States federal Environmental Impact Statement records represented by EPA.",
        temporal:
          "Database-specific historical and current coverage exposed by the selected search.",
        granularity: "One row in the official EPA EIS Database submissions result table.",
      },
    },
    summary: "Retrieve bounded official EPA EIS Database result-table metadata.",
    description:
      "This capability retrieves one or more reviewed common-search or explicit official search pages, parses their submissions tables, deduplicates records, and preserves page-level provenance.",
    provides: [
      "Four official common-search routes: last week, open comment, last 60 days issued, and last 30 days published.",
      "Exact official EIS Database search URLs copied from the provider UI after strict origin and path validation.",
      "Title, CEQ number, unique ID, document type, EPA comment-letter and Federal Register dates, agencies, state, detail URL, and download cues.",
    ],
    doesNotProvide: [
      "EIS document bodies, download verification, document parsing, environmental-effects analysis, or cross-record synthesis.",
      "Legal sufficiency, NEPA adequacy, agency compliance, policy responsibility, causality, or report conclusions.",
      "Proof that a bounded or empty search is exhaustive of EPA, CEQ, agency, or real-world EIS records.",
    ],
    selectionHints: [
      "Use a common search for current provider-defined queues such as open-comment or recently published EIS records.",
      "Use an explicit search URL only after constructing a precise project or historical query in the official EPA EIS Database UI.",
      "Treat HTML-structure drift as a blocked fetch, and distinguish it from a provider page that explicitly reports zero items.",
      "Acquire and review linked documents in a separately governed artifact workflow before making substantive claims.",
    ],
    typicalUseCases: [
      "Inventory EIS records currently open for comment.",
      "Retrieve recent or UI-filtered project EIS metadata for an evidence-acquisition plan.",
    ],
    sourceDocumentation: [
      {
        title: "EPA Environmental Impact Statement Database",
        url: "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search",
      },
    ],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.1",
      summary: "Fetch and parse bounded official EPA EIS Database result pages.",
      description:
        "Retrieves caller-ordered common searches followed by explicit official search URLs, parses submissionsTable rows, deduplicates by official identifiers, and reports truncation or later-search failure explicitly.",
      inputSchema: EPA_EIS_RECORDS_INPUT_SCHEMA,
      outputSchema: EPA_EIS_RECORDS_OUTPUT_SCHEMA,
      execute: executeEpaEisSearch,
    },
  ],
};

async function executeEpaEisSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const plan = normalizeSearchPlan(context.input as EpaEisInput);
  const executablePlan = plan.slice(0, context.limits.maxPages);
  const records: EpaEisRecord[] = [];
  const recordIds = new Set<string>();
  const pages: Array<{
    searchNumber: number;
    sourceKind: PlannedSearch["sourceKind"];
    commonSearch: CommonSearch | null;
    requestedUrl: string;
    providerResultCount: number | null;
    recordCount: number;
    responseBytes: number;
    responseDigest: string;
  }> = [];
  const observations: DataSourceObservation[] = [];
  const warnings: string[] = [
    "EPA EIS Database rows are official metadata, not a determination of EIS adequacy, legal sufficiency, effects, or policy responsibility.",
  ];
  let stopReason: "completed" | "no-results" | "max-pages" | "max-records" | "partial" =
    "completed";
  let failedSearch: number | null = null;
  let failure: unknown;

  for (let index = 0; index < executablePlan.length; index += 1) {
    const planned = executablePlan[index];
    if (!planned) continue;
    try {
      const response = await context.http.request({
        endpointId: "epa-eis-database",
        method: "GET",
        path: planned.path,
        query: planned.query,
      });
      const parsed = parseEisHtml(response.text(), planned.url);
      validateParsedPage(parsed);
      observations.push({ ...response.observation, sourceId: `search:${index + 1}` });
      pages.push({
        searchNumber: index + 1,
        sourceKind: planned.sourceKind,
        commonSearch: planned.commonSearch,
        requestedUrl: planned.url,
        providerResultCount: parsed.providerResultCount,
        recordCount: parsed.records.length,
        responseBytes: response.observation.responseBytes,
        responseDigest: response.observation.responseDigest,
      });
      if (parsed.invalidRowCount > 0) {
        warnings.push(
          `EPA EIS search ${index + 1} skipped ${parsed.invalidRowCount} malformed table row(s).`,
        );
      }

      let capHitInsidePage = false;
      for (const record of parsed.records) {
        if (recordIds.has(record.recordId)) continue;
        if (records.length >= context.limits.maxRecords) {
          capHitInsidePage = true;
          break;
        }
        recordIds.add(record.recordId);
        records.push(record);
      }

      const laterSearchExists = index + 1 < plan.length;
      const providerSurfaceTruncated =
        parsed.providerResultCount !== null && parsed.providerResultCount > parsed.records.length;
      if (
        records.length >= context.limits.maxRecords &&
        (capHitInsidePage || laterSearchExists || providerSurfaceTruncated)
      ) {
        stopReason = "max-records";
        break;
      }
    } catch (error) {
      if (pages.length === 0) throw normalizeProviderFailure(error);
      failedSearch = index + 1;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (failedSearch === null && stopReason === "completed" && plan.length > executablePlan.length) {
    stopReason = "max-pages";
  }
  if (failedSearch === null && stopReason === "completed" && records.length === 0) {
    stopReason = "no-results";
  }

  const partial = failedSearch !== null;
  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  if (truncated) {
    warnings.push("The EPA EIS result stopped at an explicit search-page or record limit.");
  }
  if (records.length === 0 && !partial) {
    warnings.push(
      "The selected EPA EIS search pages returned no parsed records; this is not evidence that no EIS records exist.",
    );
  }
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "A later EPA EIS search page could not be retrieved or validated.",
          retryable:
            failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
          userActionRequired: false,
          details: {
            missingSearches: [`search:${failedSearch}`],
            causeCode:
              failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
            failureDiagnostics: safeFailureTelemetry(failure),
          },
        },
      ]
    : [];

  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "epa-eis-database",
        endpoint: SEARCH_PATH,
        interpretationBoundary:
          "Official EIS metadata and document cues only; no legal, environmental-effects, adequacy, or policy conclusion.",
      },
      query: {
        commonSearches: plan
          .filter((item) => item.sourceKind === "common-search")
          .map((item) => item.commonSearch),
        searchUrls: plan
          .filter((item) => item.sourceKind === "explicit-search-url")
          .map((item) => item.url),
      },
      pages,
      records,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: pages.length,
      chunkCount: 0,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial
        ? { missing: [{ kind: "page" as const, identifiers: [`search:${failedSearch}`] }] }
        : {}),
    },
    warnings,
    errors,
    observations,
  };
}

function safeFailureTelemetry(error: unknown): Record<string, boolean | number | string> {
  if (!(error instanceof DataRuntimeError)) return {};
  const result: Record<string, boolean | number | string> = {};
  for (const key of ["attempts", "phase", "redirects", "retries", "status"] as const) {
    const value = error.options.details?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeSearchPlan(input: EpaEisInput): PlannedSearch[] {
  const commonSearches = input.commonSearches ?? [];
  const searchUrls = input.searchUrls ?? [];
  if (commonSearches.length === 0 && searchUrls.length === 0) {
    throw new DataRuntimeError(
      "invalid-request",
      "EPA EIS search requires at least one common search or explicit official search URL.",
    );
  }
  const plan: PlannedSearch[] = [];
  for (const commonSearch of commonSearches) {
    if (!COMMON_SEARCH_SET.has(commonSearch)) {
      throw new DataRuntimeError(
        "invalid-request",
        `Unsupported EPA EIS common search: ${commonSearch}.`,
      );
    }
    const url = new URL(SEARCH_PATH, PROVIDER_ORIGIN);
    url.searchParams.append("search", "");
    url.searchParams.append("commonSearch", commonSearch);
    plan.push({
      sourceKind: "common-search",
      commonSearch,
      url: url.toString(),
      path: SEARCH_PATH,
      query: searchParamsToQuery(url.searchParams),
    });
  }
  for (const value of searchUrls) {
    plan.push(normalizeExplicitSearchUrl(value));
  }
  const seen = new Set<string>();
  return plan.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function normalizeExplicitSearchUrl(value: string): PlannedSearch {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DataRuntimeError("invalid-request", "EPA EIS searchUrls must contain valid URLs.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cdxapps.epa.gov" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== SEARCH_PATH ||
    url.hash !== ""
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      `EPA EIS explicit search URLs must use ${PROVIDER_ORIGIN}${SEARCH_PATH} without credentials, a custom port, or a fragment.`,
    );
  }
  return {
    sourceKind: "explicit-search-url",
    commonSearch: null,
    url: url.toString(),
    path: SEARCH_PATH,
    query: searchParamsToQuery(url.searchParams),
  };
}

function searchParamsToQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of searchParams) {
    const current = query[name];
    if (current === undefined) query[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else query[name] = [current, value];
  }
  return query;
}

function parseEisHtml(html: string, sourcePageUrl: string): ParsedEisPage {
  const state: HtmlState = {
    tableFound: false,
    tableDepth: 0,
    inTbody: false,
    inRow: false,
    inCell: false,
    inPageBanner: false,
    pageBannerParts: [],
    rowCells: [],
    cellTextParts: [],
    cellLinks: [],
    cellOnclicks: [],
    activeHref: null,
    activeLinkTextParts: [],
    records: [],
    invalidRowCount: 0,
  };
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      handleText(state, token);
      continue;
    }
    const tag = parseTag(token);
    if (!tag) continue;
    if (tag.closing) handleEndTag(state, tag.name, sourcePageUrl);
    else handleStartTag(state, tag.name, tag.attributes);
  }
  const pageBanner = normalizeText(state.pageBannerParts.join(" "));
  return {
    tableFound: state.tableFound,
    pageBanner,
    providerResultCount: resultCountFromBanner(pageBanner),
    records: state.records,
    invalidRowCount: state.invalidRowCount,
  };
}

function handleStartTag(state: HtmlState, name: string, attributes: Record<string, string>): void {
  if (name === "span" && classNames(attributes.class).includes("pagebanner")) {
    state.inPageBanner = true;
  }
  if (name === "table" && state.tableDepth === 0 && attributes.id === "submissionsTable") {
    state.tableFound = true;
    state.tableDepth = 1;
    return;
  }
  if (state.tableDepth === 0) return;
  if (name === "table") state.tableDepth += 1;
  else if (name === "tbody") state.inTbody = true;
  else if (name === "tr" && state.inTbody) {
    state.inRow = true;
    state.rowCells = [];
  } else if (name === "td" && state.inRow) {
    state.inCell = true;
    state.cellTextParts = [];
    state.cellLinks = [];
    state.cellOnclicks = [];
  } else if (name === "a" && state.inCell) {
    const href = attributes.href;
    if (href) {
      state.activeHref = href;
      state.activeLinkTextParts = [];
    }
    if (attributes.onclick) state.cellOnclicks.push(attributes.onclick);
  }
}

function handleEndTag(state: HtmlState, name: string, sourcePageUrl: string): void {
  if (name === "span" && state.inPageBanner) state.inPageBanner = false;
  if (name === "a" && state.activeHref !== null) {
    const url = resolveProviderLink(state.activeHref, sourcePageUrl);
    if (url) {
      state.cellLinks.push({
        url,
        text: normalizeText(state.activeLinkTextParts.join(" ")),
      });
    }
    state.activeHref = null;
    state.activeLinkTextParts = [];
  }
  if (state.tableDepth === 0) return;
  if (name === "td" && state.inCell) {
    state.rowCells.push({
      text: normalizeText(state.cellTextParts.join(" ")),
      links: state.cellLinks,
      onclicks: state.cellOnclicks,
    });
    state.inCell = false;
  } else if (name === "tr" && state.inRow) {
    const record = recordFromCells(state.rowCells, sourcePageUrl);
    if (record) state.records.push(record);
    else if (state.rowCells.length > 0) state.invalidRowCount += 1;
    state.inRow = false;
    state.rowCells = [];
  } else if (name === "tbody") state.inTbody = false;
  else if (name === "table") state.tableDepth -= 1;
}

function handleText(state: HtmlState, text: string): void {
  if (state.inPageBanner) state.pageBannerParts.push(text);
  if (state.inCell) state.cellTextParts.push(text);
  if (state.activeHref !== null) state.activeLinkTextParts.push(text);
}

function recordFromCells(cells: ParsedCell[], sourcePageUrl: string): EpaEisRecord | null {
  if (cells.length < 9) return null;
  const title = cells[0]?.text ?? "";
  const ceqNumber = nullableText(cells[1]?.text);
  const documentType = nullableText(cells[2]?.text);
  const epaCommentLetterDate = nullableText(cells[3]?.text);
  const federalRegisterDate = nullableText(cells[4]?.text);
  const uniqueIdentificationNumber = nullableText(cells[5]?.text);
  const leadAgency = nullableText(cells[6]?.text);
  const federalCooperatingAgencies = nullableText(cells[7]?.text);
  const state = nullableText(cells[8]?.text);
  const detailUrl = cells[0]?.links[0]?.url ?? null;
  const recordId = ceqNumber ?? uniqueIdentificationNumber ?? detailUrl ?? nullableText(title);
  if (!recordId) return null;
  const downloadCell = cells[9];
  return {
    recordId,
    title,
    ceqNumber,
    uniqueIdentificationNumber,
    documentType,
    epaCommentLetterDate,
    federalRegisterDate,
    leadAgency,
    federalCooperatingAgencies,
    state,
    detailUrl,
    downloadLinks: downloadCell?.links ?? [],
    downloadDocumentIds: downloadIds(downloadCell?.onclicks ?? []),
    sourcePageUrl,
  };
}

function validateParsedPage(page: ParsedEisPage): void {
  if (!page.tableFound) {
    throw providerInvalid("EPA EIS response did not contain the expected submissionsTable.");
  }
  if (
    page.providerResultCount !== null &&
    page.providerResultCount > 0 &&
    page.records.length === 0
  ) {
    throw providerInvalid(
      "EPA EIS response reported result rows but none could be parsed from submissionsTable.",
    );
  }
}

function parseTag(token: string): {
  name: string;
  closing: boolean;
  attributes: Record<string, string>;
} | null {
  const match = /^<\s*(\/?)\s*([^\s/>]+)/.exec(token);
  if (!match?.[2]) return null;
  const name = match[2].toLowerCase();
  const attributes: Record<string, string> = {};
  const attributeText = token.slice(match[0].length, token.length - 1);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const attribute of attributeText.matchAll(pattern)) {
    const key = attribute[1]?.toLowerCase();
    if (!key) continue;
    attributes[key] = decodeHtmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
  }
  return { name, closing: match[1] === "/", attributes };
}

function classNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resultCountFromBanner(value: string): number | null {
  const match = /(\d+)\s+items?\s+found/i.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function downloadIds(onclicks: string[]): string[] {
  const ids: string[] = [];
  for (const onclick of onclicks) {
    for (const match of onclick.matchAll(/'([0-9;]+)'/g)) {
      const value = match[1];
      if (!value?.includes(";")) continue;
      ids.push(...value.split(";").filter(Boolean));
    }
  }
  return [...new Set(ids)];
}

function resolveProviderLink(value: string, sourcePageUrl: string): string | null {
  try {
    if (value.trim() === "#") return sourcePageUrl.split("#", 1)[0] ?? sourcePageUrl;
    const url = new URL(value, sourcePageUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function nullableText(value: string | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  return normalized || null;
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return validCodePoint(point) ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return validCodePoint(point) ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The EPA EIS Database response could not be retrieved, parsed, or validated.",
  );
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { CsvParseError, parseCsvRows } from "../runtime/csv.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  NASA_FIRMS_FIRE_INPUT_SCHEMA,
  NASA_FIRMS_FIRE_OUTPUT_SCHEMA,
  NASA_FIRMS_SOURCES,
} from "./nasa-firms-fire.schemas.js";

const CREDENTIAL_PLACEHOLDER = "{map-key}" as const;
const MAX_WINDOW_DAYS = 31;
const MAX_CHUNK_DAYS = 5;
const MAX_BBOX_SQUARE_DEGREES = 3_600;
const MAX_ESTIMATED_TRANSACTIONS = 250;
const MAX_VALIDATION_ISSUES = 50;
const REQUIRED_COLUMNS = ["latitude", "longitude", "acq_date", "acq_time"] as const;

type FirmsSource = (typeof NASA_FIRMS_SOURCES)[number];

interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface NasaFirmsInput {
  source: FirmsSource;
  boundingBox: BoundingBox;
  startDate: string;
  endDate: string;
  checkAvailability: boolean;
}

interface ChunkPlan {
  chunkIndex: number;
  startDate: string;
  endDate: string;
  dayCount: number;
  estimatedTransactions: number;
}

interface NormalizedInput extends NasaFirmsInput {
  dayCount: number;
  chunkCount: number;
  estimatedTransactions: number;
  chunks: ChunkPlan[];
}

interface ValidationIssue {
  path: string;
  message: string;
}

interface Availability {
  source: FirmsSource;
  minDate: string;
  maxDate: string;
}

interface FireRecord {
  recordIndex: number;
  chunkIndex: number;
  source: FirmsSource;
  latitude: number;
  longitude: number;
  acquiredAtUtc: string;
  satellite: string | null;
  instrument: string | null;
  confidence: string | null;
  version: string | null;
  dayNight: "D" | "N" | null;
  fireRadiativePowerMw: number | null;
  scanKm: number | null;
  trackKm: number | null;
  brightnessKelvin: number | null;
  brightT31Kelvin: number | null;
  brightTi4Kelvin: number | null;
  brightTi5Kelvin: number | null;
}

interface ChunkSummary extends ChunkPlan {
  status: "failed" | "invalid" | "ok";
  responseBytes: number;
  inputRows: number;
  emittedRecords: number;
  issues: string[];
}

interface ParsedChunk {
  records: FireRecord[];
  inputRows: number;
  issues: string[];
  validHeader: boolean;
  header: string[];
}

class IssueCollector {
  count = 0;
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.count += 1;
    if (this.issues.length < MAX_VALIDATION_ISSUES) this.issues.push({ path, message });
  }
}

export const nasaFirmsFireConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "nasa-firms.active-fire",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "nasa-firms",
    name: "NASA Fire Information for Resource Management System",
  },
  sourceCategory: "satellite-active-fire-detections",
  endpoints: [
    {
      endpointId: "nasa-firms-api",
      baseUrl: "https://firms.modaps.eosdis.nasa.gov",
      pathPrefixes: ["/api/"],
      allowedMethods: ["GET"],
      allowedContentTypes: [
        "application/json",
        "application/octet-stream",
        "text/csv",
        "text/plain",
      ],
    },
  ],
  license: {
    name: "NASA ESDIS Data Use and Citation Guidance",
    url: "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy",
    restrictions: [
      "Acknowledge NASA FIRMS and cite the exact underlying active-fire dataset used in published work.",
      "Do not use NASA material in a way that suggests NASA endorsement of a product, service, or conclusion.",
      "Non-NASA data distributed through ESDIS remain subject to the sponsoring organization's license and attribution terms.",
    ],
  },
  credentials: [
    {
      credentialId: "map-key",
      environmentVariable: "NASA_FIRMS_MAP_KEY",
      required: true,
      endpointIds: ["nasa-firms-api"],
      injection: { kind: "path-segment", placeholder: CREDENTIAL_PLACEHOLDER },
    },
  ],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 2_048,
    maxResponseBytes: 30_000_000,
    maxPages: 7,
    maxRecords: 50_000,
    maxRetries: 3,
    maxRetryDelayMs: 300_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "source-dependent-near-real-time-or-standard-processing",
    description:
      "NRT products prioritize low latency and are later replaced by Standard Processing products; SP availability typically lags by months and varies by sensor.",
  },
  limitations: [
    "Active-fire points are satellite thermal-anomaly detections, not fire perimeters, burned-area estimates, incident identities, or proof of wildfire cause.",
    "Cloud, smoke, canopy, overpass timing, sensor resolution, saturation, and algorithm behavior can cause omissions, duplicates, or false positives.",
    "NRT records are provisional and replaced by science-quality Standard Processing records when available.",
    "Confidence encoding and available attributes differ between MODIS, VIIRS, and Landsat products.",
    "The MAP_KEY is subject to a provider quota of 5,000 transactions per 10-minute interval; large areas can consume multiple transactions.",
  ],
  discovery: {
    source: {
      maintainedBy: "NASA LANCE Fire Information for Resource Management System",
      summary:
        "Satellite-derived MODIS, VIIRS, and Landsat active-fire and thermal-anomaly point detections distributed by NASA FIRMS.",
      description:
        "FIRMS area products report sensor detections of thermal anomalies or hotspots at satellite overpass time. A point can indicate wildfire, agricultural burning, gas flaring, volcanic activity, or another heat source and does not delineate a fire event or perimeter.",
      coverage: {
        geographic:
          "Source-dependent: most MODIS and VIIRS products are global, while LANDSAT_NRT is limited to the United States and Canada.",
        temporal:
          "Source-dependent availability exposed by the provider; NRT and Standard Processing windows differ and evolve.",
        granularity:
          "One satellite active-fire detection point with UTC acquisition minute and sensor-specific attributes.",
      },
    },
    summary:
      "Retrieve bounded NASA FIRMS active-fire detections for one source, area, and UTC date window.",
    description:
      "This capability checks an optional source-availability window, splits at most 31 dates into provider-compliant five-day area requests, safely injects one logical MAP_KEY, and normalizes common MODIS, VIIRS, or Landsat detection fields with chunk-level partial coverage.",
    provides: [
      "Bounded active-fire point detections with coordinates, UTC acquisition minute, source, satellite, instrument, confidence, version, and day/night indicator.",
      "Common sensor measurements when present, including fire radiative power, footprint scan/track, and MODIS or VIIRS brightness fields.",
      "Optional source date-availability validation and explicit per-chunk request, row, issue, and transaction-estimate summaries.",
      "Partial results when a later chunk, row, required field, or sensor-specific optional value cannot be normalized safely.",
    ],
    doesNotProvide: [
      "Fire perimeters, burned area, incident polygons or names, containment, severity, alerts, evacuation guidance, or emergency response advice.",
      "Proof that a hotspot is a wildfire, ignition-cause attribution, smoke transport, emissions, air quality, weather, or hydrology context.",
      "Geocoding, country/world scans, antimeridian-crossing boxes, recurring monitoring, multi-source fusion, or duplicate-event resolution.",
      "A MAP_KEY, quota increase, automatic source substitution, or permission to ignore dataset-specific citation and license terms.",
    ],
    selectionHints: [
      "Choose an NRT source for recent situational awareness and preserve its provisional status; choose the matching SP source for a more consistent historical analysis when available.",
      "Prefer VIIRS for finer nominal active-fire spatial resolution and MODIS for its longer historical record; verify the exact source documentation for the selected product.",
      "Use checkAvailability for historical windows whose source coverage is uncertain, accepting the additional provider transaction.",
      "Confirm important detections with incident, perimeter, imagery, or local-authority sources before making operational or safety claims.",
    ],
    typicalUseCases: [
      "Retrieve active-fire hotspots for a known study area and short UTC date window.",
      "Collect candidate thermal-anomaly points for separately governed ecological or emissions verification.",
    ],
    sourceDocumentation: [
      {
        title: "NASA FIRMS Area API",
        url: "https://firms.modaps.eosdis.nasa.gov/api/area/",
      },
      {
        title: "NASA FIRMS API tutorial and MAP_KEY quotas",
        url: "https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
      },
      {
        title: "NASA Earthdata Data Use and Citation Guidance",
        url: "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy",
      },
    ],
  },
  operations: [
    {
      operationId: "fetch-area",
      operationVersion: "1.0.0",
      summary: "Fetch one bounded UTC window of NASA FIRMS area active-fire detections.",
      description:
        "Builds optional availability plus one to seven five-day-or-shorter CSV requests for a single reviewed source and bounded box, then normalizes common detection attributes under credential, byte, retry, transaction, chunk, and record limits.",
      inputSchema: NASA_FIRMS_FIRE_INPUT_SCHEMA,
      outputSchema: NASA_FIRMS_FIRE_OUTPUT_SCHEMA,
      execute: executeNasaFirmsFire,
    },
  ],
};

async function executeNasaFirmsFire(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as NasaFirmsInput, context.limits.maxPages);
  const observations: DataSourceObservation[] = [];
  let availability: Availability | null = null;
  if (input.checkAvailability) {
    const response = await context.http.request({
      endpointId: "nasa-firms-api",
      method: "GET",
      path: `/api/data_availability/csv/${CREDENTIAL_PLACEHOLDER}/${input.source}`,
      credentialId: "map-key",
    });
    observations.push({ ...response.observation, sourceId: `availability:${input.source}` });
    availability = parseAvailability(response.text(), input);
  }

  const collector = new IssueCollector();
  const chunks: ChunkSummary[] = [];
  const records: FireRecord[] = [];
  const missingChunks: string[] = [];
  const failures: unknown[] = [];
  let canonicalHeader: string[] | null = null;
  let truncated = false;

  for (const plan of input.chunks) {
    const range = `${plan.startDate}..${plan.endDate}`;
    try {
      const response = await context.http.request({
        endpointId: "nasa-firms-api",
        method: "GET",
        path: areaPath(input, plan),
        credentialId: "map-key",
      });
      observations.push({ ...response.observation, sourceId: `area:${range}` });
      const parsed = parseFireChunk(response.text(), input, plan, collector, records.length);
      const chunkIssues = [...parsed.issues];
      if (canonicalHeader === null && parsed.validHeader) canonicalHeader = parsed.header;
      if (
        canonicalHeader !== null &&
        parsed.validHeader &&
        !sameStrings(canonicalHeader, parsed.header)
      ) {
        const path = `chunks[${plan.chunkIndex}].header`;
        collector.add(path, "Chunk header differs from the first valid chunk header.");
        chunkIssues.push("Chunk header differs from the first valid chunk header.");
      }
      const remaining = Math.max(0, context.limits.maxRecords - records.length);
      const emitted = parsed.records.slice(0, remaining);
      records.push(...emitted);
      truncated ||= emitted.length < parsed.records.length;
      chunks.push({
        ...plan,
        status: parsed.validHeader ? "ok" : "invalid",
        responseBytes: response.observation.responseBytes,
        inputRows: parsed.inputRows,
        emittedRecords: emitted.length,
        issues: chunkIssues.slice(0, MAX_VALIDATION_ISSUES),
      });
      if (!parsed.validHeader) missingChunks.push(range);
      if (
        records.length >= context.limits.maxRecords &&
        plan.chunkIndex + 1 < input.chunks.length
      ) {
        truncated = true;
      }
      if (truncated || records.length >= context.limits.maxRecords) break;
    } catch (error) {
      if (
        error instanceof DataRuntimeError &&
        ["credential-invalid", "credential-missing", "provider-auth-blocked"].includes(error.code)
      ) {
        throw error;
      }
      failures.push(error);
      missingChunks.push(range);
      chunks.push({
        ...plan,
        status: "failed",
        responseBytes: 0,
        inputRows: 0,
        emittedRecords: 0,
        issues: ["The FIRMS area chunk could not be retrieved or normalized."],
      });
    }
  }

  const invalidPaths = collector.issues.map((issue) => issue.path);
  const partial = missingChunks.length > 0 || collector.count > 0;
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            "One or more NASA FIRMS chunks, rows, required fields, or sensor attributes could not be normalized.",
          retryable: failures.some(
            (failure) =>
              failure instanceof DataRuntimeError && (failure.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: { missingChunks, invalidPaths },
        },
      ]
    : [];
  const stopReason = partial
    ? "partial"
    : truncated
      ? "max-records"
      : records.length === 0
        ? "no-results"
        : "completed";
  const missing = [
    ...(missingChunks.length > 0 ? [{ kind: "chunk" as const, identifiers: missingChunks }] : []),
    ...(invalidPaths.length > 0 ? [{ kind: "field" as const, identifiers: invalidPaths }] : []),
  ];

  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "nasa-firms",
        service: "Fire Information for Resource Management System",
        endpoint: "/api/area/csv",
        activeFireDetections: true,
        timezone: "UTC",
      },
      request: requestProjection(input),
      availability,
      validation: { issueCount: collector.count, issues: collector.issues },
      chunks,
      records,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: input.checkAvailability ? 1 : 0,
      chunkCount: chunks.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(missing.length > 0 ? { missing } : {}),
    },
    warnings: [
      "NASA FIRMS points are satellite thermal-anomaly detections, not fire perimeters or confirmed incident identities.",
      input.source.endsWith("_NRT")
        ? "The selected NRT source is provisional and is replaced by Standard Processing data when available."
        : "The selected Standard Processing source is better calibrated but has a longer availability delay.",
      "Acknowledge NASA FIRMS and cite the exact underlying active-fire dataset used.",
      ...(truncated ? ["The normalized detection set reached the record limit."] : []),
    ],
    errors,
    observations,
  };
}

function normalizeInput(input: NasaFirmsInput, maxPages: number): NormalizedInput {
  const start = parseExactDate(input.startDate, "startDate");
  const end = parseExactDate(input.endDate, "endDate");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError("invalid-request", "startDate must not follow endDate.");
  }
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount > MAX_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The inclusive NASA FIRMS date window must not exceed ${MAX_WINDOW_DAYS} days.`,
      { details: { dayCount, maximumWindowDays: MAX_WINDOW_DAYS } },
    );
  }
  const boundingBox = { ...input.boundingBox };
  if (boundingBox.east <= boundingBox.west || boundingBox.north <= boundingBox.south) {
    throw new DataRuntimeError(
      "invalid-request",
      "NASA FIRMS bounding-box west/south values must be lower than east/north values.",
    );
  }
  const squareDegrees =
    (boundingBox.east - boundingBox.west) * (boundingBox.north - boundingBox.south);
  if (squareDegrees > MAX_BBOX_SQUARE_DEGREES) {
    throw new DataRuntimeError(
      "invalid-request",
      "NASA FIRMS world-scale or excessively broad bounding-box scans are not allowed.",
      { details: { squareDegrees, maximumSquareDegrees: MAX_BBOX_SQUARE_DEGREES } },
    );
  }
  const chunks = planChunks(start, end, input.source, boundingBox);
  if (chunks.length > Math.min(7, maxPages)) {
    throw new DataRuntimeError(
      "invalid-request",
      "The NASA FIRMS date window exceeds the effective chunk limit.",
      { details: { chunkCount: chunks.length, maximumChunks: Math.min(7, maxPages) } },
    );
  }
  const estimatedTransactions = chunks.reduce(
    (total, chunk) => total + chunk.estimatedTransactions,
    0,
  );
  if (estimatedTransactions > MAX_ESTIMATED_TRANSACTIONS) {
    throw new DataRuntimeError(
      "invalid-request",
      "The estimated NASA FIRMS transaction weight exceeds the per-run safety limit.",
      {
        details: {
          estimatedTransactions,
          maximumEstimatedTransactions: MAX_ESTIMATED_TRANSACTIONS,
        },
      },
    );
  }
  return {
    source: input.source,
    boundingBox,
    startDate: input.startDate,
    endDate: input.endDate,
    checkAvailability: input.checkAvailability,
    dayCount,
    chunkCount: chunks.length,
    estimatedTransactions,
    chunks,
  };
}

function parseExactDate(value: string, field: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DataRuntimeError("invalid-request", `${field} must be a real YYYY-MM-DD date.`);
  }
  return parsed;
}

function planChunks(
  start: Date,
  end: Date,
  source: FirmsSource,
  boundingBox: BoundingBox,
): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); ) {
    const endTime = Math.min(cursor + (MAX_CHUNK_DAYS - 1) * 86_400_000, end.getTime());
    const dayCount = Math.floor((endTime - cursor) / 86_400_000) + 1;
    chunks.push({
      chunkIndex: chunks.length,
      startDate: new Date(cursor).toISOString().slice(0, 10),
      endDate: new Date(endTime).toISOString().slice(0, 10),
      dayCount,
      estimatedTransactions: estimateTransactions(source, boundingBox, dayCount),
    });
    cursor = endTime + 86_400_000;
  }
  return chunks;
}

function estimateTransactions(
  source: FirmsSource,
  boundingBox: BoundingBox,
  dayCount: number,
): number {
  const sourceWeight = source.includes("VIIRS") ? 2 : 0.5;
  const longitudeTiles = Math.max(1, Math.ceil((boundingBox.east - boundingBox.west) / 60));
  const latitudeTiles = Math.max(1, Math.ceil((boundingBox.north - boundingBox.south) / 60));
  return Math.ceil(longitudeTiles * latitudeTiles * sourceWeight * dayCount);
}

function areaPath(input: NormalizedInput, chunk: ChunkPlan): string {
  const box = input.boundingBox;
  const area = [box.west, box.south, box.east, box.north].map(formatCoordinate).join(",");
  return `/api/area/csv/${CREDENTIAL_PLACEHOLDER}/${input.source}/${area}/${chunk.dayCount}/${chunk.startDate}`;
}

function formatCoordinate(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function parseAvailability(text: string, input: NormalizedInput): Availability {
  assertCredentialAccepted(text);
  const table = parseCsv(text, "NASA FIRMS availability");
  if (table.length === 0) {
    throw providerInvalid("NASA FIRMS availability response is empty.");
  }
  const header = normalizeHeader(table[0] as string[]);
  for (const required of ["data_id", "min_date", "max_date"]) {
    if (!header.includes(required)) {
      throw providerInvalid(`NASA FIRMS availability response is missing ${required}.`);
    }
  }
  const rows = table.slice(1).filter(nonEmptyRow);
  const matches = rows.filter((row) => row[header.indexOf("data_id")] === input.source);
  if (matches.length !== 1) {
    throw providerInvalid("NASA FIRMS availability response did not identify one selected source.");
  }
  const row = matches[0] as string[];
  const minDate = providerDate(row[header.indexOf("min_date")], "availability min_date");
  const maxDate = providerDate(row[header.indexOf("max_date")], "availability max_date");
  if (input.startDate < minDate || input.endDate > maxDate) {
    throw new DataRuntimeError(
      "invalid-request",
      "The requested NASA FIRMS window is outside the provider-advertised source availability.",
      { details: { source: input.source, minDate, maxDate } },
    );
  }
  return { source: input.source, minDate, maxDate };
}

function parseFireChunk(
  text: string,
  input: NormalizedInput,
  plan: ChunkPlan,
  collector: IssueCollector,
  recordOffset: number,
): ParsedChunk {
  assertCredentialAccepted(text);
  const table = parseCsv(text, "NASA FIRMS area response");
  if (table.length === 0) throw providerInvalid("NASA FIRMS area CSV is empty.");
  const header = normalizeHeader(table[0] as string[]);
  const missingHeaders = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missingHeaders.length > 0) {
    return {
      records: [],
      inputRows: Math.max(0, table.length - 1),
      issues: [`Required CSV columns are missing: ${missingHeaders.join(", ")}.`],
      validHeader: false,
      header,
    };
  }
  const issues: string[] = [];
  const duplicateHeaders = [
    ...new Set(header.filter((name, index) => header.indexOf(name) !== index)),
  ]
    .filter((name) => name.length > 0)
    .sort();
  if (duplicateHeaders.length > 0) {
    const message = `CSV header has duplicate columns: ${duplicateHeaders.join(", ")}.`;
    collector.add(`chunks[${plan.chunkIndex}].header`, message);
    addIssue(issues, message);
  }
  const records: FireRecord[] = [];
  const rows = table.slice(1).filter(nonEmptyRow);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex] as string[];
    const rowPath = `chunks[${plan.chunkIndex}].rows[${rowIndex}]`;
    if (values.length !== header.length) {
      const message = `CSV row has ${values.length} values for ${header.length} headers.`;
      collector.add(rowPath, message);
      addIssue(issues, message);
      continue;
    }
    const row = Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""]));
    const normalized = normalizeFireRow(
      row,
      rowPath,
      input,
      plan,
      recordOffset + records.length,
      collector,
      issues,
    );
    if (normalized) records.push(normalized);
  }
  return { records, inputRows: rows.length, issues, validHeader: true, header };
}

function assertCredentialAccepted(text: string): void {
  if (!/map[_ ]?key.*(?:invalid|required)|invalid.*map[_ ]?key/i.test(text.slice(0, 512))) return;
  throw new DataRuntimeError(
    "credential-invalid",
    "NASA FIRMS rejected the configured logical MAP_KEY credential.",
    { userActionRequired: true, details: { credentialId: "map-key" } },
  );
}

function normalizeFireRow(
  row: Record<string, string>,
  path: string,
  input: NormalizedInput,
  plan: ChunkPlan,
  recordIndex: number,
  collector: IssueCollector,
  issues: string[],
): FireRecord | null {
  const latitude = requiredProviderNumber(row.latitude);
  if (
    latitude === null ||
    latitude < input.boundingBox.south ||
    latitude > input.boundingBox.north
  ) {
    addFieldIssue(
      collector,
      issues,
      `${path}.latitude`,
      "Latitude is invalid or outside the requested bounding box.",
    );
    return null;
  }
  const longitude = requiredProviderNumber(row.longitude);
  if (
    longitude === null ||
    longitude < input.boundingBox.west ||
    longitude > input.boundingBox.east
  ) {
    addFieldIssue(
      collector,
      issues,
      `${path}.longitude`,
      "Longitude is invalid or outside the requested bounding box.",
    );
    return null;
  }
  const acquisitionDate = exactProviderDate(row.acq_date);
  if (
    acquisitionDate === null ||
    acquisitionDate < input.startDate ||
    acquisitionDate > input.endDate ||
    acquisitionDate < plan.startDate ||
    acquisitionDate > plan.endDate
  ) {
    addFieldIssue(
      collector,
      issues,
      `${path}.acq_date`,
      "Acquisition date is invalid or outside the requested chunk.",
    );
    return null;
  }
  const acquisitionTime = normalizeAcquisitionTime(row.acq_time);
  if (acquisitionTime === null) {
    addFieldIssue(
      collector,
      issues,
      `${path}.acq_time`,
      "Acquisition time must be a valid HHMM UTC minute.",
    );
    return null;
  }
  const optional = (field: string, label: string): number | null => {
    const value = optionalProviderNumber(row[field]);
    if (value === "invalid") {
      addFieldIssue(
        collector,
        issues,
        `${path}.${field}`,
        `${label} must be numeric when present.`,
      );
      return null;
    }
    return value;
  };
  const rawDayNight = cleanText(row.daynight);
  const dayNight = rawDayNight === "D" || rawDayNight === "N" ? rawDayNight : null;
  if (rawDayNight && dayNight === null) {
    addFieldIssue(collector, issues, `${path}.daynight`, "daynight must be D or N when present.");
  }
  return {
    recordIndex,
    chunkIndex: plan.chunkIndex,
    source: input.source,
    latitude,
    longitude,
    acquiredAtUtc: `${acquisitionDate}T${acquisitionTime.slice(0, 2)}:${acquisitionTime.slice(2)}:00Z`,
    satellite: nullableText(row.satellite),
    instrument: nullableText(row.instrument),
    confidence: nullableText(row.confidence),
    version: nullableText(row.version),
    dayNight,
    fireRadiativePowerMw: optional("frp", "Fire radiative power"),
    scanKm: optional("scan", "Scan footprint"),
    trackKm: optional("track", "Track footprint"),
    brightnessKelvin: optional("brightness", "MODIS brightness"),
    brightT31Kelvin: optional("bright_t31", "MODIS band-31 brightness"),
    brightTi4Kelvin: optional("bright_ti4", "VIIRS I4 brightness"),
    brightTi5Kelvin: optional("bright_ti5", "VIIRS I5 brightness"),
  };
}

function parseCsv(text: string, label: string): string[][] {
  try {
    return parseCsvRows(text);
  } catch (error) {
    throw providerInvalid(
      error instanceof CsvParseError
        ? `${label}: ${error.message}`
        : `${label} could not be parsed.`,
    );
  }
}

function normalizeHeader(values: string[]): string[] {
  return values.map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim().toLowerCase(),
  );
}

function nonEmptyRow(row: string[]): boolean {
  return row.some((value) => value.trim().length > 0);
}

function providerDate(value: string | undefined, label: string): string {
  const parsed = exactProviderDate(value);
  if (parsed === null) throw providerInvalid(`${label} must be a real YYYY-MM-DD date.`);
  return parsed;
}

function exactProviderDate(value: string | undefined): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function normalizeAcquisitionTime(value: string | undefined): string | null {
  const text = cleanText(value);
  if (!/^\d{1,4}$/.test(text)) return null;
  const padded = text.padStart(4, "0");
  const hour = Number(padded.slice(0, 2));
  const minute = Number(padded.slice(2));
  return hour <= 23 && minute <= 59 ? padded : null;
}

function requiredProviderNumber(value: string | undefined): number | null {
  const text = cleanText(value);
  const parsed = Number(text);
  return text.length > 0 && Number.isFinite(parsed) ? parsed : null;
}

function optionalProviderNumber(value: string | undefined): number | null | "invalid" {
  const text = cleanText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function nullableText(value: string | undefined): string | null {
  return cleanText(value) || null;
}

function cleanText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function addFieldIssue(
  collector: IssueCollector,
  chunkIssues: string[],
  path: string,
  message: string,
): void {
  collector.add(path, message);
  addIssue(chunkIssues, message);
}

function addIssue(issues: string[], message: string): void {
  if (issues.length < MAX_VALIDATION_ISSUES && !issues.includes(message)) issues.push(message);
}

function requestProjection(input: NormalizedInput): Omit<NormalizedInput, "chunks"> {
  const { chunks: _chunks, ...projection } = input;
  return projection;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

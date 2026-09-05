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
  AIRNOW_HOURLY_INPUT_SCHEMA,
  AIRNOW_HOURLY_OUTPUT_SCHEMA,
} from "./airnow-hourly-observations.schemas.js";

const MAX_HOURS = 168;
const AIRNOW_FETCH_CONCURRENCY = 3;
const OFFICIAL_HEADERS = [
  "AQSID",
  "SiteName",
  "Status",
  "EPARegion",
  "Latitude",
  "Longitude",
  "Elevation",
  "GMTOffset",
  "CountryCode",
  "StateName",
  "ValidDate",
  "ValidTime",
  "DataSource",
  "ReportingArea_PipeDelimited",
  "OZONE_AQI",
  "PM10_AQI",
  "PM25_AQI",
  "NO2_AQI",
  "OZONE_Measured",
  "PM10_Measured",
  "PM25_Measured",
  "NO2_Measured",
  "PM25",
  "PM25_Unit",
  "OZONE",
  "OZONE_Unit",
  "NO2",
  "NO2_Unit",
  "CO",
  "CO_Unit",
  "SO2",
  "SO2_Unit",
  "PM10",
  "PM10_Unit",
] as const;
const AQI_COLUMNS: Partial<Record<AirNowParameter, string>> = {
  OZONE: "OZONE_AQI",
  PM10: "PM10_AQI",
  PM25: "PM25_AQI",
  NO2: "NO2_AQI",
};
const MEASURED_COLUMNS: Partial<Record<AirNowParameter, string>> = {
  OZONE: "OZONE_Measured",
  PM10: "PM10_Measured",
  PM25: "PM25_Measured",
  NO2: "NO2_Measured",
};
const AQI_KINDS: Partial<Record<AirNowParameter, "hourly-aqi" | "nowcast-aqi">> = {
  OZONE: "nowcast-aqi",
  PM10: "nowcast-aqi",
  PM25: "nowcast-aqi",
  NO2: "hourly-aqi",
};

type AirNowParameter = "CO" | "NO2" | "OZONE" | "PM10" | "PM25" | "SO2";

interface AirNowInput {
  startDateTimeUtc: string;
  endDateTimeUtc: string;
  boundingBox: {
    minLongitude: number;
    minLatitude: number;
    maxLongitude: number;
    maxLatitude: number;
  };
  parameters: AirNowParameter[];
}

interface AirNowRecord {
  aqsid: string;
  siteName: string;
  status: string;
  epaRegion: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  stateName: string;
  observedAtUtc: string;
  dataSource: string;
  reportingAreas: string[];
  parameterName: AirNowParameter;
  aqiValue: number | null;
  aqiKind: "hourly-aqi" | "nowcast-aqi" | null;
  rawConcentration: number | null;
  unit: string | null;
  measured: boolean | null;
  sourceFile: string;
}

interface AirNowFileSummary {
  hourUtc: string;
  sourceFile: string;
  status: "failed" | "invalid" | "missing" | "ok";
  responseBytes: number;
  inputRows: number;
  emittedRecords: number;
  issues: string[];
  errorCode?: string;
}

class AirNowFileValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AirNowFileValidationError";
  }
}

export const airNowHourlyObservationsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "airnow.hourly-observations",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "airnow",
    name: "U.S. EPA AirNow",
  },
  sourceCategory: "environmental-observations",
  endpoints: [
    {
      endpointId: "airnow-files",
      baseUrl: "https://files.airnowtech.org",
      pathPrefixes: ["/airnow/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/octet-stream", "text/csv", "text/plain"],
    },
  ],
  license: {
    name: "AirNow Data Use Guidelines",
    url: "https://docs.airnowapi.org/faq",
    restrictions: [
      "AirNow observations are preliminary, not fully verified, and subject to change.",
      "Provide downstream users with the most current AirNow data available.",
      "Use official AQS or AirData records for regulatory decision making.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 1_024,
    maxResponseBytes: 20_000_000,
    maxPages: MAX_HOURS,
    maxRecords: 100_000,
    maxRetries: 3,
    maxRetryDelayMs: 120_000,
    maxRedirects: 2,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "hourly-revisable",
    description:
      "Files are updated hourly and recent hourly files may be revised for completeness and quality.",
  },
  limitations: [
    "AirNow file-product observations are not a regulatory-grade replacement for EPA AQS data.",
    "The connector does not geocode, interpret AQI health effects, or combine other sources.",
    "Not every monitoring site reports every pollutant in every hour.",
  ],
  discovery: {
    source: {
      maintainedBy: "U.S. Environmental Protection Agency with participating AirNow agencies",
      summary:
        "Preliminary hourly ambient-air observations distributed through official AirNow files.",
      description:
        "The HourlyAQObs product aggregates reporting-site observations into one UTC-hour file. Site and pollutant availability varies, and recent values may be revised.",
      coverage: {
        geographic:
          "Monitoring sites present in each official HourlyAQObs file; availability varies by location, hour, and pollutant.",
        temporal:
          "UTC-hour file products with recent observations subject to revision and occasional missing files.",
        granularity: "One monitoring-site, UTC-hour, and pollutant record.",
      },
    },
    summary:
      "Retrieve bounded AirNow monitoring-site observations by UTC hour, area, and pollutant.",
    description:
      "This capability selects a bounded inclusive UTC-hour window, fetches the corresponding HourlyAQObs files, validates them independently, and emits normalized observations with file lineage.",
    provides: [
      "Normalized site-hour records for CO, NO2, OZONE, PM10, PM25, and SO2.",
      "Available AQI and raw-concentration fields from the HourlyAQObs product.",
      "Per-file status and source-file lineage, including explicit partial coverage.",
    ],
    doesNotProvide: [
      "Air-quality forecasts, exposure estimates, health advice, or causal interpretation.",
      "Cross-source fusion, geocoding, interpolation, or coverage guarantees for every site and hour.",
      "Regulatory-grade AQS records suitable for compliance decisions.",
    ],
    selectionHints: [
      "Choose this capability for recent, site-level hourly monitoring observations when an explicit bounding box and pollutant list are available.",
      "Choose EPA AQS or AirData instead when verified regulatory records are required.",
      "Treat missing or invalid hourly files as partial coverage rather than as zero pollution.",
    ],
    typicalUseCases: [
      "Collect recent PM2.5 and ozone observations for a regional monitoring window.",
      "Audit which AirNow hourly source files contributed records to a downstream analysis.",
    ],
    sourceDocumentation: [
      {
        title: "AirNow Hourly Data Fact Sheet",
        url: "https://docs.airnowapi.org/docs/HourlyAQObsFactSheet.pdf",
      },
      {
        title: "AirNow FAQ and Data Use Guidelines",
        url: "https://docs.airnowapi.org/faq",
      },
    ],
  },
  operations: [
    {
      operationId: "fetch-hourly",
      operationVersion: "1.0.1",
      summary:
        "Fetch bounded AirNow HourlyAQObs files and normalize site-hour-pollutant observations.",
      description:
        "Plans one official HourlyAQObs file per inclusive UTC hour, validates each file, filters records by WGS84 bounding box and pollutant, and preserves usable records when another file is missing or invalid.",
      inputSchema: AIRNOW_HOURLY_INPUT_SCHEMA,
      outputSchema: AIRNOW_HOURLY_OUTPUT_SCHEMA,
      execute: executeAirNowHourly,
    },
  ],
};

async function executeAirNowHourly(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as AirNowInput, context.limits.maxPages);
  const hours = enumerateHours(input.startDateTimeUtc, input.endDateTimeUtc);
  const files: AirNowFileSummary[] = [];
  const records: AirNowRecord[] = [];
  const observations: DataSourceObservation[] = [];
  const missingFiles: string[] = [];
  const fetchFailures: Array<Record<string, boolean | number | string>> = [];
  let truncated = false;

  const fetched = await mapConcurrent(hours, AIRNOW_FETCH_CONCURRENCY, async (hourUtc) => {
    const sourceFile = sourceFileForHour(hourUtc);
    try {
      const response = await context.http.request({
        endpointId: "airnow-files",
        method: "GET",
        path: sourceFile,
      });
      return { hourUtc, sourceFile, response };
    } catch (error) {
      return { hourUtc, sourceFile, error };
    }
  });

  for (const item of fetched) {
    const { hourUtc, sourceFile } = item;
    if ("response" in item) {
      const response = item.response;
      observations.push({ ...response.observation, sourceId: sourceFile });
      try {
        const parsed = normalizeFile({
          text: response.text(),
          hourUtc,
          sourceFile,
          input,
          remainingRecords: Math.max(0, context.limits.maxRecords - records.length),
        });
        records.push(...parsed.records);
        truncated ||= parsed.truncated;
        files.push({
          hourUtc,
          sourceFile,
          status: "ok",
          responseBytes: response.observation.responseBytes,
          inputRows: parsed.inputRows,
          emittedRecords: parsed.records.length,
          issues: parsed.issues,
        });
      } catch (error) {
        const normalized =
          error instanceof AirNowFileValidationError
            ? error
            : new AirNowFileValidationError(
                "invalid-csv-value",
                "The AirNow file could not be normalized.",
              );
        files.push({
          hourUtc,
          sourceFile,
          status: "invalid",
          responseBytes: response.observation.responseBytes,
          inputRows: 0,
          emittedRecords: 0,
          issues: [normalized.message],
          errorCode: normalized.code,
        });
        missingFiles.push(sourceFile);
      }
    } else {
      const error = item.error;
      const missing = isMissingResponse(error);
      const code = error instanceof DataRuntimeError ? error.code : "network-failed";
      files.push({
        hourUtc,
        sourceFile,
        status: missing ? "missing" : "failed",
        responseBytes: 0,
        inputRows: 0,
        emittedRecords: 0,
        issues: [
          missing ? "The hourly source file was not available." : "The hourly fetch failed.",
        ],
        errorCode: missing ? "source-file-missing" : code,
      });
      missingFiles.push(sourceFile);
      fetchFailures.push({
        sourceId: sourceFile,
        code,
        ...safeFailureTelemetry(error),
      });
    }
  }

  const partial = missingFiles.length > 0;
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "One or more AirNow hourly files were unavailable or invalid.",
          retryable: files.some((file) => file.status === "failed" || file.status === "missing"),
          userActionRequired: false,
          details: { missingFiles, failures: fetchFailures },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "airnow",
        product: "HourlyAQObs",
        preliminary: true,
        regulatoryUse: false,
      },
      request: {
        ...input,
        hourCount: hours.length,
      },
      files,
      records,
    },
    summary: {
      recordCount: records.length,
      pageCount: 0,
      chunkCount: files.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "file" as const, identifiers: missingFiles }] } : {}),
    },
    warnings: [
      "AirNow observations are preliminary and must not be used as regulatory-grade AQS data.",
      ...(truncated ? ["The normalized record set reached the requested record limit."] : []),
    ],
    errors,
    observations,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await work(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

function normalizeInput(input: AirNowInput, maxHours: number): AirNowInput {
  const start = parseExactUtcHour(input.startDateTimeUtc, "startDateTimeUtc");
  const end = parseExactUtcHour(input.endDateTimeUtc, "endDateTimeUtc");
  if (end.getTime() < start.getTime()) {
    throw new DataRuntimeError(
      "invalid-request",
      "AirNow endDateTimeUtc must not precede startDateTimeUtc.",
    );
  }
  if (
    input.boundingBox.minLongitude >= input.boundingBox.maxLongitude ||
    input.boundingBox.minLatitude >= input.boundingBox.maxLatitude
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "AirNow bounding-box minimums must be lower than maximums.",
    );
  }
  const hourCount = Math.floor((end.getTime() - start.getTime()) / 3_600_000) + 1;
  if (hourCount > Math.min(MAX_HOURS, maxHours)) {
    throw new DataRuntimeError(
      "invalid-request",
      "The AirNow UTC window exceeds the effective hourly-file limit.",
      { details: { hourCount, maxHours: Math.min(MAX_HOURS, maxHours) } },
    );
  }
  return {
    startDateTimeUtc: start.toISOString().replace(".000Z", "Z"),
    endDateTimeUtc: end.toISOString().replace(".000Z", "Z"),
    boundingBox: { ...input.boundingBox },
    parameters: [...input.parameters].sort(codePointOrder),
  };
}

function parseExactUtcHour(value: string, field: string): Date {
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      `${field} must be an exact valid UTC hour in YYYY-MM-DDTHH:00:00Z form.`,
    );
  }
  return parsed;
}

function enumerateHours(start: string, end: string): string[] {
  const output: string[] = [];
  for (let time = Date.parse(start); time <= Date.parse(end); time += 3_600_000) {
    output.push(new Date(time).toISOString().replace(".000Z", "Z"));
  }
  return output;
}

function sourceFileForHour(hourUtc: string): string {
  const compact = hourUtc.replace(/[-:TZ]/g, "").slice(0, 10);
  return `/airnow/${compact.slice(0, 4)}/${compact.slice(0, 8)}/HourlyAQObs_${compact}.dat`;
}

function normalizeFile(input: {
  text: string;
  hourUtc: string;
  sourceFile: string;
  input: AirNowInput;
  remainingRecords: number;
}): { records: AirNowRecord[]; inputRows: number; issues: string[]; truncated: boolean } {
  let table: string[][];
  try {
    table = parseCsvRows(input.text);
  } catch (error) {
    throw new AirNowFileValidationError(
      "invalid-csv-value",
      error instanceof CsvParseError
        ? error.message.replace(/^The CSV/, "The AirNow CSV")
        : "The AirNow CSV could not be parsed.",
    );
  }
  if (table.length === 0) {
    throw new AirNowFileValidationError("invalid-csv-header", "The AirNow file is empty.");
  }
  const headers = table[0]!.map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim(),
  );
  const missingHeaders = OFFICIAL_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new AirNowFileValidationError(
      "invalid-csv-header",
      `The AirNow CSV is missing required headers: ${missingHeaders.join(", ")}.`,
    );
  }
  const issues: string[] = [];
  const records: AirNowRecord[] = [];
  let truncated = false;
  const rows = table.slice(1).filter((row) => row.length > 1 || row[0]?.trim());
  for (let index = 0; index < rows.length; index += 1) {
    const values = rows[index]!;
    if (values.length !== headers.length) {
      addIssue(
        issues,
        `Row ${index + 2} has ${values.length} values for ${headers.length} headers.`,
      );
      continue;
    }
    const row = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    const normalized = normalizeRow(row, index + 2, input);
    for (const issue of normalized.issues) addIssue(issues, issue);
    for (const record of normalized.records) {
      if (records.length >= input.remainingRecords) {
        truncated = true;
        continue;
      }
      records.push(record);
    }
  }
  return { records, inputRows: rows.length, issues, truncated };
}

function normalizeRow(
  row: Record<string, string>,
  line: number,
  file: {
    hourUtc: string;
    sourceFile: string;
    input: AirNowInput;
  },
): { records: AirNowRecord[]; issues: string[] } {
  const issues: string[] = [];
  const aqsid = cleanText(row.AQSID);
  let latitude: number;
  let longitude: number;
  try {
    latitude = requiredNumber(row.Latitude, "Latitude");
    longitude = requiredNumber(row.Longitude, "Longitude");
  } catch {
    return { records: [], issues: [`Row ${line} has invalid coordinates.`] };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { records: [], issues: [`Row ${line} has coordinates outside valid ranges.`] };
  }
  const box = file.input.boundingBox;
  if (
    longitude < box.minLongitude ||
    longitude > box.maxLongitude ||
    latitude < box.minLatitude ||
    latitude > box.maxLatitude
  ) {
    return { records: [], issues };
  }
  const parsedObservedAtUtc = parseAirNowDateTime(row.ValidDate, row.ValidTime);
  const observedAtUtc = parsedObservedAtUtc ?? file.hourUtc;
  if (!parsedObservedAtUtc) {
    issues.push(
      `Row ${line} has an invalid ValidDate or ValidTime; used the source-file hour ${file.hourUtc}.`,
    );
  }
  if (observedAtUtc < file.input.startDateTimeUtc || observedAtUtc > file.input.endDateTimeUtc) {
    return { records: [], issues };
  }

  const records: AirNowRecord[] = [];
  for (const parameter of file.input.parameters) {
    const rawConcentration = tolerantOptionalNumber(row[parameter], parameter, line, issues);
    const aqiColumn = AQI_COLUMNS[parameter];
    const measuredColumn = MEASURED_COLUMNS[parameter];
    const aqiValue = aqiColumn
      ? tolerantOptionalNumber(row[aqiColumn], aqiColumn, line, issues)
      : null;
    const measured = measuredColumn
      ? tolerantOptionalMeasured(row[measuredColumn], measuredColumn, line, issues)
      : null;
    if (rawConcentration === null && aqiValue === null && measured === null) continue;
    const unit = cleanText(row[`${parameter}_Unit`]) || null;
    records.push({
      aqsid,
      siteName: cleanText(row.SiteName),
      status: cleanText(row.Status),
      epaRegion: cleanText(row.EPARegion),
      latitude,
      longitude,
      countryCode: cleanText(row.CountryCode),
      stateName: cleanText(row.StateName),
      observedAtUtc,
      dataSource: cleanText(row.DataSource),
      reportingAreas: cleanText(row.ReportingArea_PipeDelimited)
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean),
      parameterName: parameter,
      aqiValue,
      aqiKind: AQI_KINDS[parameter] ?? null,
      rawConcentration,
      unit,
      measured,
      sourceFile: file.sourceFile,
    });
  }
  return { records, issues };
}

function parseAirNowDateTime(
  dateValue: string | undefined,
  timeValue: string | undefined,
): string | null {
  const dateMatch = cleanText(dateValue).match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  const timeMatch = cleanText(timeValue).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;
  const yearRaw = Number(dateMatch[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? 0);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    minute !== 0 ||
    second !== 0
  ) {
    return null;
  }
  return parsed.toISOString().replace(".000Z", "Z");
}

function requiredNumber(value: string | undefined, field: string): number {
  const parsed = optionalNumber(value, field);
  if (parsed === null) throw new Error(`${field} is required.`);
  return parsed;
}

function optionalNumber(value: string | undefined, field: string): number | null {
  const text = cleanText(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric.`);
  return parsed;
}

function optionalMeasured(value: string | undefined, field: string): boolean | null {
  const text = cleanText(value);
  if (!text) return null;
  if (text === "0") return false;
  if (text === "1") return true;
  throw new Error(`${field} must be 0 or 1.`);
}

function tolerantOptionalNumber(
  value: string | undefined,
  field: string,
  line: number,
  issues: string[],
): number | null {
  try {
    return optionalNumber(value, field);
  } catch {
    addIssue(issues, `Row ${line} has an invalid ${field} value; treated it as missing.`);
    return null;
  }
}

function tolerantOptionalMeasured(
  value: string | undefined,
  field: string,
  line: number,
  issues: string[],
): boolean | null {
  try {
    return optionalMeasured(value, field);
  } catch {
    addIssue(issues, `Row ${line} has an invalid ${field} value; treated it as missing.`);
    return null;
  }
}

function cleanText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function addIssue(issues: string[], issue: string): void {
  if (issues.length < 100) issues.push(issue);
}

function isMissingResponse(error: unknown): boolean {
  return error instanceof DataRuntimeError && error.options.details?.status === 404;
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA,
  OPEN_METEO_AIR_QUALITY_OUTPUT_SCHEMA,
  OPEN_METEO_AIR_QUALITY_VARIABLES,
} from "./open-meteo-air-quality.schemas.js";

const ENDPOINT_PATH = "/v1/air-quality";
const MAX_WINDOW_DAYS = 92;
const MAX_VALIDATION_ISSUES = 50;

type AirQualityVariable = (typeof OPEN_METEO_AIR_QUALITY_VARIABLES)[number];
type Domain = "auto" | "cams_europe" | "cams_global";
type CellSelection = "land" | "nearest" | "sea";

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface OpenMeteoAirQualityInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  hourlyVariables: AirQualityVariable[];
  domain?: Domain;
  cellSelection?: CellSelection;
}

interface NormalizedInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  hourlyVariables: AirQualityVariable[];
  domain: Domain;
  cellSelection: CellSelection;
  timezone: "GMT";
}

type ValidationIssueCode =
  | "response-count-mismatch"
  | "coordinate-response-invalid"
  | "provider-error"
  | "grid-location-missing"
  | "section-missing"
  | "timezone-missing"
  | "timezone-invalid"
  | "utc-offset-missing"
  | "utc-offset-invalid"
  | "time-axis-length-mismatch"
  | "time-axis-invalid"
  | "series-missing"
  | "series-length-mismatch"
  | "series-unit-missing"
  | "series-value-invalid"
  | "series-all-null";

interface ValidationIssue {
  code: ValidationIssueCode;
  path: string;
  message: string;
}

interface NormalizedVariable {
  variable: AirQualityVariable;
  unit: string;
  values: Array<number | null>;
}

interface NormalizedLocation {
  requestedLocationIndex: number;
  requestedLocation: Coordinate;
  gridLocation: Coordinate;
  elevation: number | null;
  timezone: string;
  timezoneAbbreviation: string;
  utcOffsetSeconds: number;
  timesUtc: string[];
  variables: NormalizedVariable[];
}

interface NormalizedPayload {
  locations: NormalizedLocation[];
  issues: ValidationIssue[];
  issueCount: number;
  recordCount: number;
  truncated: boolean;
}

class IssueCollector {
  count = 0;
  readonly issues: ValidationIssue[] = [];

  add(code: ValidationIssueCode, path: string, message: string): void {
    this.count += 1;
    if (this.issues.length < MAX_VALIDATION_ISSUES) this.issues.push({ code, path, message });
  }
}

export const openMeteoAirQualityConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "open-meteo.air-quality",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "open-meteo",
    name: "Open-Meteo Air Quality API",
  },
  sourceCategory: "modeled-air-quality",
  endpoints: [
    {
      endpointId: "open-meteo-air-quality-public",
      baseUrl: "https://air-quality-api.open-meteo.com",
      pathPrefixes: ["/v1/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "CC BY 4.0",
    url: "https://open-meteo.com/en/license",
    restrictions: [
      "Attribution to Open-Meteo and the underlying CAMS data provider is required.",
      "The public free API endpoint is for non-commercial use; commercial use requires a separately governed customer endpoint and API key.",
      "Provider model values and availability may change when CAMS models or Open-Meteo processing are updated.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 25_000_000,
    maxPages: 1,
    maxRecords: 25_000,
    maxRetries: 3,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "forecast-and-reanalysis-model",
    description:
      "Hourly modeled values combine current forecasts with provider model history; updates and horizons depend on the selected CAMS domain and variable.",
  },
  limitations: [
    "Values describe an atmospheric model grid cell, not a measurement taken at the requested coordinate.",
    "CAMS Europe and CAMS Global have different spatial resolution, forecast horizon, update cadence, and variable coverage.",
    "Pollen variables and some constituent fields are limited to specific domains or geographic coverage.",
    "The public endpoint is restricted to non-commercial use and is subject to Open-Meteo free-tier request limits.",
    "This connector fixes timestamps to GMT and does not interpret exposure, health effects, compliance, or causal mechanisms.",
  ],
  discovery: {
    source: {
      maintainedBy: "Open-Meteo using Copernicus Atmosphere Monitoring Service data",
      summary:
        "Global and European hourly modeled air-quality, aerosol, pollen, UV, and AQI fields exposed by Open-Meteo.",
      description:
        "The Air Quality API maps coordinates to CAMS model grid cells and returns hourly background concentrations and derived indices. It is modeled environmental context rather than station-level observation data.",
      coverage: {
        geographic:
          "CAMS Global coverage worldwide and higher-resolution CAMS Europe coverage in its supported European domain; pollen and individual variables have narrower availability.",
        temporal:
          "Hourly forecast and recent model-history windows supported by Open-Meteo, bounded here to an explicit inclusive window of at most 92 dates.",
        granularity: "One selected model grid cell, GMT hour, and requested variable value.",
      },
    },
    summary:
      "Retrieve bounded hourly modeled air-quality variables for up to ten explicit coordinates.",
    description:
      "This capability sends one deterministic GMT request to the public Open-Meteo Air Quality endpoint, preserves requested coordinate order, and emits aligned columnar time series with grid-cell metadata and explicit partial validation.",
    provides: [
      "Hourly PM, gas, aerosol, pollen, UV, European AQI, and US AQI model variables from the official public endpoint.",
      "Grid latitude, longitude, elevation, timezone metadata, units, timestamps, nullable values, and request lineage.",
      "Explicit domain and grid-cell-selection controls with bounded locations, variables, dates, response size, and records.",
      "Partial results when an individual coordinate or requested variable cannot be normalized safely.",
    ],
    doesNotProvide: [
      "Ground-station observations, sensor identity, regulatory monitoring records, or measurement-quality flags.",
      "Health advice, personal exposure, compliance decisions, forecasts beyond provider availability, or causal interpretation.",
      "Geocoding, place search, automatic source comparison, or interpolation beyond the provider-selected model grid cell.",
      "Commercial API access or customer-endpoint API-key handling.",
    ],
    selectionHints: [
      "Choose this capability for spatially continuous modeled background context at known coordinates.",
      "Choose a station-observation capability such as AirNow when the question requires actual monitoring-site measurements.",
      "Use cams_europe when its geographic and variable coverage fits and higher regional resolution matters; otherwise retain auto.",
      "Treat nulls and partial status as unavailable model cells or fields, not as zero concentration.",
    ],
    typicalUseCases: [
      "Compare modeled PM2.5 and ozone time series for a small set of known coordinates.",
      "Retrieve a bounded pollen or AQI context window for a non-commercial research workflow.",
    ],
    sourceDocumentation: [
      {
        title: "Open-Meteo Air Quality API documentation",
        url: "https://open-meteo.com/en/docs/air-quality-api",
      },
      {
        title: "Open-Meteo data license",
        url: "https://open-meteo.com/en/license",
      },
      {
        title: "Open-Meteo API terms",
        url: "https://open-meteo.com/en/terms",
      },
    ],
  },
  operations: [
    {
      operationId: "fetch-hourly",
      operationVersion: "1.0.1",
      features: ["open-meteo.series-all-null"],
      summary: "Fetch one bounded GMT window of Open-Meteo modeled hourly air-quality variables.",
      description:
        "Builds one stable public-endpoint query for up to ten coordinates and sixteen documented variables, validates aligned hourly arrays independently, and applies the shared byte, retry, timeout, and record limits.",
      inputSchema: OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA,
      outputSchema: OPEN_METEO_AIR_QUALITY_OUTPUT_SCHEMA,
      execute: executeOpenMeteoAirQuality,
    },
  ],
};

async function executeOpenMeteoAirQuality(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as OpenMeteoAirQualityInput);
  const response = await context.http.request({
    endpointId: "open-meteo-air-quality-public",
    method: "GET",
    path: ENDPOINT_PATH,
    query: {
      latitude: input.locations.map((location) => location.latitude).join(","),
      longitude: input.locations.map((location) => location.longitude).join(","),
      start_date: input.startDate,
      end_date: input.endDate,
      hourly: input.hourlyVariables.join(","),
      timezone: input.timezone,
      domains: input.domain,
      cell_selection: input.cellSelection,
    },
  });
  const normalized = normalizePayload(response.json(), input, context.limits.maxRecords);
  const partial = normalized.issueCount > 0;
  const invalidPaths = normalized.issues.map((issue) => issue.path);
  const issueCodes = [...new Set(normalized.issues.map((issue) => issue.code))];
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            "One or more Open-Meteo locations, timestamps, or variables could not be normalized.",
          retryable: false,
          userActionRequired: false,
          details: { issueCount: normalized.issueCount, issueCodes, invalidPaths },
        },
      ]
    : [];

  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "open-meteo",
        service: "Air Quality API",
        endpoint: ENDPOINT_PATH,
        modeled: true,
        timezone: "GMT",
      },
      request: input,
      validation: { issueCount: normalized.issueCount, issues: normalized.issues },
      locations: normalized.locations,
      stopReason: partial ? "partial" : normalized.truncated ? "max-records" : "completed",
    },
    summary: {
      recordCount: normalized.recordCount,
      pageCount: 1,
      chunkCount: 1,
      truncated: normalized.truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "field" as const, identifiers: invalidPaths }] } : {}),
    },
    warnings: [
      "Open-Meteo air-quality values are modeled grid-cell estimates, not station observations.",
      "Attribute Open-Meteo and the underlying CAMS data provider when using these data.",
      "The configured public endpoint is for non-commercial use.",
      ...(normalized.truncated ? ["The normalized hourly series reached the record limit."] : []),
    ],
    errors,
    observations: [{ ...response.observation, sourceId: "hourly-model" }],
  };
}

function normalizeInput(input: OpenMeteoAirQualityInput): NormalizedInput {
  const start = parseDate(input.startDate, "startDate");
  const end = parseDate(input.endDate, "endDate");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError("invalid-request", "startDate must not follow endDate.");
  }
  const windowDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (windowDays > MAX_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The inclusive Open-Meteo date window must not exceed ${MAX_WINDOW_DAYS} days.`,
      { details: { windowDays, maximumWindowDays: MAX_WINDOW_DAYS } },
    );
  }
  return {
    locations: input.locations.map((location) => ({ ...location })),
    startDate: input.startDate,
    endDate: input.endDate,
    hourlyVariables: [...input.hourlyVariables].sort(codePointOrder),
    domain: input.domain ?? "auto",
    cellSelection: input.cellSelection ?? "nearest",
    timezone: "GMT",
  };
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DataRuntimeError("invalid-request", `${field} must be a real YYYY-MM-DD date.`);
  }
  return parsed;
}

function normalizePayload(
  payload: unknown,
  input: NormalizedInput,
  maxRecords: number,
): NormalizedPayload {
  const providerError = recordValue(payload);
  if (providerError?.error === true) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "Open-Meteo returned an explicit provider error response.",
      {
        details: {
          reason:
            typeof providerError.reason === "string" ? providerError.reason : "Unspecified error",
        },
      },
    );
  }

  const responses = input.locations.length === 1 && !Array.isArray(payload) ? [payload] : payload;
  if (!Array.isArray(responses)) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "Open-Meteo must return one object for one coordinate or an array for multiple coordinates.",
    );
  }

  const collector = new IssueCollector();
  if (responses.length !== input.locations.length) {
    collector.add(
      "response-count-mismatch",
      "$",
      `Expected ${input.locations.length} coordinate responses but received ${responses.length}.`,
    );
  }

  const candidates: NormalizedLocation[] = [];
  for (let index = 0; index < input.locations.length; index += 1) {
    const normalized = normalizeLocation(
      responses[index],
      index,
      input.locations[index] as Coordinate,
      input,
      collector,
    );
    if (normalized) candidates.push(normalized);
  }

  const totalAvailable = candidates.reduce(
    (total, location) => total + location.timesUtc.length,
    0,
  );
  const truncated = totalAvailable > maxRecords;
  let remaining = maxRecords;
  const locations: NormalizedLocation[] = [];
  for (const location of candidates) {
    if (remaining <= 0) break;
    const length = Math.min(location.timesUtc.length, remaining);
    locations.push({
      ...location,
      timesUtc: location.timesUtc.slice(0, length),
      variables: location.variables.map((variable) => ({
        ...variable,
        values: variable.values.slice(0, length),
      })),
    });
    remaining -= length;
  }
  const recordCount = locations.reduce((total, location) => total + location.timesUtc.length, 0);
  return {
    locations,
    issues: collector.issues,
    issueCount: collector.count,
    recordCount,
    truncated,
  };
}

function normalizeLocation(
  value: unknown,
  index: number,
  requestedLocation: Coordinate,
  input: NormalizedInput,
  collector: IssueCollector,
): NormalizedLocation | null {
  const path = `$[${index}]`;
  const item = recordValue(value);
  if (!item) {
    collector.add("coordinate-response-invalid", path, "Coordinate response must be an object.");
    return null;
  }
  if (item.error === true) {
    collector.add(
      "provider-error",
      path,
      "Coordinate response contains an explicit provider error.",
    );
    return null;
  }
  const latitude = finiteNumber(item.latitude);
  const longitude = finiteNumber(item.longitude);
  if (latitude === null || longitude === null) {
    collector.add(
      "grid-location-missing",
      path,
      "Coordinate response is missing numeric grid latitude or longitude.",
    );
    return null;
  }
  const hourly = recordValue(item.hourly);
  const units = recordValue(item.hourly_units);
  if (!hourly || !units || !Array.isArray(hourly.time)) {
    collector.add(
      "section-missing",
      path,
      "Coordinate response must contain hourly, hourly.time, and hourly_units.",
    );
    return null;
  }

  const timesUtc: string[] = [];
  let previousTime: string | null = null;
  for (let timeIndex = 0; timeIndex < hourly.time.length; timeIndex += 1) {
    const normalizedTime = normalizeProviderTime(hourly.time[timeIndex], input);
    if (normalizedTime === null) {
      collector.add(
        "time-axis-invalid",
        `${path}.hourly.time[${timeIndex}]`,
        "Invalid or out-of-window GMT timestamp.",
      );
      continue;
    }
    if (previousTime !== null && normalizedTime <= previousTime) {
      collector.add(
        "time-axis-invalid",
        `${path}.hourly.time[${timeIndex}]`,
        "GMT timestamps must be strictly ascending.",
      );
    }
    timesUtc.push(normalizedTime);
    previousTime = normalizedTime;
  }
  if (timesUtc.length !== hourly.time.length) {
    collector.add(
      "time-axis-invalid",
      `${path}.hourly.time`,
      "One or more invalid timestamps prevent safe alignment for this coordinate.",
    );
    return null;
  }
  const expectedHourCount = inclusiveDayCount(input.startDate, input.endDate) * 24;
  if (timesUtc.length !== expectedHourCount) {
    collector.add(
      "time-axis-length-mismatch",
      `${path}.hourly.time`,
      `Expected ${expectedHourCount} GMT hours for the inclusive date window but received ${timesUtc.length}.`,
    );
  }

  const variables: NormalizedVariable[] = [];
  for (const variable of input.hourlyVariables) {
    const variablePath = `${path}.hourly.${variable}`;
    const rawValues = hourly[variable];
    const unit = units[variable];
    if (!Array.isArray(rawValues)) {
      collector.add(
        "series-missing",
        variablePath,
        "Requested variable is missing or is not an array.",
      );
      continue;
    }
    if (rawValues.length !== timesUtc.length) {
      collector.add(
        "series-length-mismatch",
        variablePath,
        "Requested variable length does not match hourly.time.",
      );
      continue;
    }
    if (typeof unit !== "string" || unit.length === 0) {
      collector.add(
        "series-unit-missing",
        `${path}.hourly_units.${variable}`,
        "Requested variable unit is missing.",
      );
      continue;
    }
    const values = rawValues.map((rawValue, valueIndex): number | null => {
      if (rawValue === null) return null;
      const number = finiteNumber(rawValue);
      if (number === null) {
        collector.add(
          "series-value-invalid",
          `${variablePath}[${valueIndex}]`,
          "Value must be numeric or null.",
        );
        return null;
      }
      return number;
    });
    if (rawValues.every((rawValue) => rawValue === null)) {
      collector.add(
        "series-all-null",
        variablePath,
        "Requested air-quality series was returned but contains no usable numeric values.",
      );
    }
    variables.push({ variable, unit, values });
  }

  const hasTimezone = typeof item.timezone === "string" && item.timezone.length > 0;
  const timezone = hasTimezone ? (item.timezone as string) : "GMT";
  if (!hasTimezone) {
    collector.add("timezone-missing", `${path}.timezone`, "Provider timezone metadata is missing.");
  } else if (!["GMT", "UTC", "Etc/UTC"].includes(timezone)) {
    collector.add(
      "timezone-invalid",
      `${path}.timezone`,
      "Provider timezone must remain GMT/UTC for this operation.",
    );
  }
  const hasUtcOffset =
    typeof item.utc_offset_seconds === "number" && Number.isInteger(item.utc_offset_seconds);
  const utcOffsetSeconds = hasUtcOffset ? (item.utc_offset_seconds as number) : 0;
  if (!hasUtcOffset) {
    collector.add(
      "utc-offset-missing",
      `${path}.utc_offset_seconds`,
      "Provider UTC offset metadata must be an integer.",
    );
  } else if (utcOffsetSeconds !== 0) {
    collector.add(
      "utc-offset-invalid",
      `${path}.utc_offset_seconds`,
      "Provider UTC offset must be zero in GMT mode.",
    );
  }
  return {
    requestedLocationIndex: index,
    requestedLocation,
    gridLocation: { latitude, longitude },
    elevation: finiteNumber(item.elevation),
    timezone,
    timezoneAbbreviation:
      typeof item.timezone_abbreviation === "string" && item.timezone_abbreviation
        ? item.timezone_abbreviation
        : "GMT",
    utcOffsetSeconds,
    timesUtc,
    variables,
  };
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  return (
    Math.floor(
      (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

function normalizeProviderTime(value: unknown, input: NormalizedInput): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value)
    return null;
  const date = value.slice(0, 10);
  if (date < input.startDate || date > input.endDate) return null;
  return `${value}:00Z`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

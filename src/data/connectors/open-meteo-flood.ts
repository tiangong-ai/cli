import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  OPEN_METEO_FLOOD_INPUT_SCHEMA,
  OPEN_METEO_FLOOD_OUTPUT_SCHEMA,
  OPEN_METEO_FLOOD_VARIABLES,
} from "./open-meteo-flood.schemas.js";

const ENDPOINT_PATH = "/v1/flood";
const MAX_WINDOW_DAYS = 366;
const MAX_VALIDATION_ISSUES = 50;
const ENSEMBLE_MEMBER_PATTERN = /^river_discharge_member(\d+)$/;

type FloodVariable = (typeof OPEN_METEO_FLOOD_VARIABLES)[number];
type CellSelection = "land" | "nearest" | "sea";

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface OpenMeteoFloodInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  dailyVariables: FloodVariable[];
  includeEnsembleMembers?: boolean;
  cellSelection?: CellSelection;
}

interface NormalizedInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  dailyVariables: FloodVariable[];
  includeEnsembleMembers: boolean;
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

interface NormalizedSeries {
  variable: FloodVariable;
  unit: string;
  values: Array<number | null>;
}

interface NormalizedEnsembleMember {
  member: number;
  sourceField: string;
  unit: string;
  values: Array<number | null>;
}

interface NormalizedLocation {
  requestedLocationIndex: number;
  requestedLocation: Coordinate;
  riverGridLocation: Coordinate;
  elevation: number | null;
  timezone: string;
  timezoneAbbreviation: string;
  utcOffsetSeconds: number;
  dates: string[];
  variables: NormalizedSeries[];
  ensembleMembers: NormalizedEnsembleMember[];
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

export const openMeteoFloodConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "open-meteo.flood",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "open-meteo",
    name: "Open-Meteo Flood API",
  },
  sourceCategory: "modeled-river-discharge",
  endpoints: [
    {
      endpointId: "open-meteo-flood-public",
      baseUrl: "https://flood-api.open-meteo.com",
      pathPrefixes: ["/v1/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "CC BY 4.0",
    url: "https://open-meteo.com/en/license",
    restrictions: [
      "Attribution to Open-Meteo and the underlying Global Flood Awareness System (GloFAS) data provider is required.",
      "The public free API endpoint is for non-commercial use; commercial use requires a separately governed customer endpoint and API key.",
      "GloFAS and Open-Meteo modeled values are provided without accuracy, completeness, availability, or fitness guarantees.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 40_000_000,
    maxPages: 1,
    maxRecords: 20_000,
    maxRetries: 3,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "daily-reanalysis-and-forecast-model",
    description:
      "GloFAS v4 seamless data combine historical consolidated or reanalysis periods with daily and seasonal forecast products whose update cadence and horizon differ.",
  },
  limitations: [
    "Values are simulated river discharge at an approximately 5 km grid resolution, not gauge measurements.",
    "The endpoint selects the largest represented river near the coordinate; the selected river can be unsuitable or several kilometres from the request.",
    "Ensemble statistical variables are forecast-only and can be absent for consolidated historical dates.",
    "Ensemble-member mode can substantially increase response size and does not itself define flood probability or severity.",
    "The public endpoint is restricted to non-commercial use and is subject to Open-Meteo free-tier request limits.",
  ],
  discovery: {
    source: {
      maintainedBy: "Open-Meteo using Global Flood Awareness System (GloFAS) data",
      summary:
        "Global daily simulated river-discharge reanalysis and forecasts from the GloFAS hydrological model.",
      description:
        "The Flood API returns simulated discharge for the largest river represented in roughly a 5 km area around each coordinate. GloFAS v4 seamless data combine historical and forecast products; they are model guidance, not river-gauge observations.",
      coverage: {
        geographic:
          "Global GloFAS river grid at approximately 0.05 degrees or 5 km, subject to represented-river and grid-cell selection.",
        temporal:
          "Daily data from 1984 through the provider's available forecast horizon; forecast, seasonal, and consolidated historical components have different availability.",
        granularity:
          "One selected river-model grid cell, calendar date, and discharge series value.",
      },
    },
    summary:
      "Retrieve bounded daily GloFAS simulated river-discharge series for up to ten coordinates.",
    description:
      "This capability sends one deterministic GMT request to the public Open-Meteo Flood endpoint, preserves requested coordinate order, and emits aligned discharge, forecast-statistic, and optional ensemble-member columns with explicit partial validation.",
    provides: [
      "Daily river_discharge plus forecast mean, median, maximum, minimum, p25, and p75 fields when the provider makes them available.",
      "Optional provider ensemble-member discharge series with member identity, units, dates, and selected river-grid coordinates.",
      "Bounded multi-coordinate, explicit-date, variable, cell-selection, byte, retry, timeout, and record behavior.",
      "Partial results when an individual coordinate, date axis, requested variable, or ensemble field cannot be normalized safely.",
    ],
    doesNotProvide: [
      "River-gauge or station observations, station identifiers, basin topology, named-river lookup, or field-measurement quality flags.",
      "Flood alerts, severity classification, warning thresholds, return periods, inundation maps, evacuation advice, or emergency guidance.",
      "Geocoding, automatic coordinate adjustment, causal attribution, or fusion with rainfall, soil, reservoir, or local authority data.",
      "Commercial API access or customer-endpoint API-key handling.",
    ],
    selectionHints: [
      "Choose this capability for broad modeled river-discharge context at already-known coordinates, especially where gauge coverage is unavailable.",
      "Choose an official gauge or local hydrology source when observed river level or discharge is required.",
      "Inspect returned riverGridLocation and external river maps before assuming that the selected largest river represents the intended channel.",
      "Use ensemble members only for downstream probabilistic analysis that explicitly preserves model uncertainty; this capability does not classify risk.",
    ],
    typicalUseCases: [
      "Retrieve a bounded simulated discharge window for environmental context at known coordinates.",
      "Collect aligned provider ensemble-member series for a separately governed uncertainty analysis.",
    ],
    sourceDocumentation: [
      {
        title: "Open-Meteo Flood API documentation",
        url: "https://open-meteo.com/en/docs/flood-api",
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
      operationId: "fetch-daily",
      operationVersion: "1.0.1",
      features: ["open-meteo.series-all-null"],
      summary: "Fetch one bounded GMT window of Open-Meteo daily simulated river discharge.",
      description:
        "Builds one stable public-endpoint query for up to ten coordinates, seven documented discharge variables, and optional ensemble members, then validates aligned daily arrays under shared byte, retry, timeout, and record limits.",
      inputSchema: OPEN_METEO_FLOOD_INPUT_SCHEMA,
      outputSchema: OPEN_METEO_FLOOD_OUTPUT_SCHEMA,
      execute: executeOpenMeteoFlood,
    },
  ],
};

async function executeOpenMeteoFlood(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as OpenMeteoFloodInput);
  const query: Record<string, boolean | string> = {
    latitude: input.locations.map((location) => location.latitude).join(","),
    longitude: input.locations.map((location) => location.longitude).join(","),
    start_date: input.startDate,
    end_date: input.endDate,
    daily: input.dailyVariables.join(","),
    timezone: input.timezone,
    timeformat: "iso8601",
    cell_selection: input.cellSelection,
  };
  if (input.includeEnsembleMembers) query.ensemble = true;
  const response = await context.http.request({
    endpointId: "open-meteo-flood-public",
    method: "GET",
    path: ENDPOINT_PATH,
    query,
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
            "One or more Open-Meteo Flood locations, dates, variables, or ensemble members could not be normalized.",
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
        service: "Flood API",
        endpoint: ENDPOINT_PATH,
        model: "GloFAS v4 Seamless",
        simulated: true,
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
      "Open-Meteo Flood values are GloFAS simulated river-grid discharge, not gauge observations.",
      "The provider selects the largest represented river near each coordinate; verify the returned river-grid location.",
      "Attribute Open-Meteo and the underlying GloFAS data provider; the configured public endpoint is non-commercial.",
      ...(input.includeEnsembleMembers
        ? [
            "Ensemble members are model realizations and do not directly define flood severity or probability.",
          ]
        : []),
      ...(normalized.truncated ? ["The normalized daily series reached the record limit."] : []),
    ],
    errors,
    observations: [{ ...response.observation, sourceId: "daily-river-discharge-model" }],
  };
}

function normalizeInput(input: OpenMeteoFloodInput): NormalizedInput {
  const start = parseDate(input.startDate, "startDate");
  const end = parseDate(input.endDate, "endDate");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError("invalid-request", "startDate must not follow endDate.");
  }
  const windowDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (windowDays > MAX_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The inclusive Open-Meteo Flood date window must not exceed ${MAX_WINDOW_DAYS} days.`,
      { details: { windowDays, maximumWindowDays: MAX_WINDOW_DAYS } },
    );
  }
  const dailyVariables = [...input.dailyVariables].sort(codePointOrder);
  const includeEnsembleMembers = input.includeEnsembleMembers ?? false;
  if (includeEnsembleMembers && !dailyVariables.includes("river_discharge")) {
    throw new DataRuntimeError(
      "invalid-request",
      "includeEnsembleMembers requires river_discharge in dailyVariables.",
    );
  }
  return {
    locations: input.locations.map((location) => ({ ...location })),
    startDate: input.startDate,
    endDate: input.endDate,
    dailyVariables,
    includeEnsembleMembers,
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
      "Open-Meteo Flood returned an explicit provider error response.",
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
      "Open-Meteo Flood must return one object for one coordinate or an array for multiple coordinates.",
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
    const location = normalizeLocation(
      responses[index],
      index,
      input.locations[index] as Coordinate,
      input,
      collector,
    );
    if (location) candidates.push(location);
  }

  const totalAvailable = candidates.reduce((total, location) => total + location.dates.length, 0);
  const truncated = totalAvailable > maxRecords;
  let remaining = maxRecords;
  const locations: NormalizedLocation[] = [];
  for (const location of candidates) {
    if (remaining <= 0) break;
    const length = Math.min(location.dates.length, remaining);
    locations.push({
      ...location,
      dates: location.dates.slice(0, length),
      variables: location.variables.map((variable) => ({
        ...variable,
        values: variable.values.slice(0, length),
      })),
      ensembleMembers: location.ensembleMembers.map((member) => ({
        ...member,
        values: member.values.slice(0, length),
      })),
    });
    remaining -= length;
  }
  const recordCount = locations.reduce((total, location) => total + location.dates.length, 0);
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
      "Coordinate response is missing numeric river-grid latitude or longitude.",
    );
    return null;
  }
  const daily = recordValue(item.daily);
  const units = recordValue(item.daily_units);
  if (!daily || !units || !Array.isArray(daily.time)) {
    collector.add(
      "section-missing",
      path,
      "Coordinate response must contain daily, daily.time, and daily_units.",
    );
    return null;
  }
  const dates = normalizeDates(daily.time, path, input, collector);
  if (dates === null) return null;

  const variables: NormalizedSeries[] = [];
  for (const variable of input.dailyVariables) {
    const normalized = normalizeSeries(
      daily[variable],
      units[variable],
      `${path}.daily.${variable}`,
      `${path}.daily_units.${variable}`,
      dates.length,
      collector,
    );
    if (normalized) variables.push({ variable, ...normalized });
  }

  const ensembleMembers: NormalizedEnsembleMember[] = [];
  if (input.includeEnsembleMembers) {
    const fields: Array<{ field: string; member: number }> = [];
    for (const field of Object.keys(daily)) {
      const match = ENSEMBLE_MEMBER_PATTERN.exec(field);
      if (!match) continue;
      const member = Number(match[1]);
      if (!Number.isSafeInteger(member)) {
        collector.add(
          "series-value-invalid",
          `${path}.daily.${field}`,
          "Ensemble member suffix is not a safe integer.",
        );
        continue;
      }
      fields.push({ field, member });
    }
    fields.sort(
      (left, right) => left.member - right.member || codePointOrder(left.field, right.field),
    );
    if (fields.length === 0) {
      collector.add(
        "series-missing",
        `${path}.daily.river_discharge_memberNN`,
        "Ensemble members were requested but none were returned.",
      );
    }
    for (const { field, member } of fields) {
      const normalized = normalizeSeries(
        daily[field],
        units[field],
        `${path}.daily.${field}`,
        `${path}.daily_units.${field}`,
        dates.length,
        collector,
      );
      if (normalized) {
        ensembleMembers.push({
          member,
          sourceField: field,
          ...normalized,
        });
      }
    }
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
    riverGridLocation: { latitude, longitude },
    elevation: finiteNumber(item.elevation),
    timezone,
    timezoneAbbreviation:
      typeof item.timezone_abbreviation === "string" && item.timezone_abbreviation
        ? item.timezone_abbreviation
        : "GMT",
    utcOffsetSeconds,
    dates,
    variables,
    ensembleMembers,
  };
}

function normalizeDates(
  values: unknown[],
  path: string,
  input: NormalizedInput,
  collector: IssueCollector,
): string[] | null {
  const expected =
    Math.floor(
      (new Date(`${input.endDate}T00:00:00Z`).getTime() -
        new Date(`${input.startDate}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  if (values.length !== expected) {
    collector.add(
      "time-axis-length-mismatch",
      `${path}.daily.time`,
      `Expected ${expected} daily dates but received ${values.length}.`,
    );
  }
  const dates: string[] = [];
  let previous = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      collector.add(
        "time-axis-invalid",
        `${path}.daily.time[${index}]`,
        "Daily time must be a YYYY-MM-DD string.",
      );
      return null;
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value ||
      value < input.startDate ||
      value > input.endDate ||
      (previous !== "" && value <= previous)
    ) {
      collector.add(
        "time-axis-invalid",
        `${path}.daily.time[${index}]`,
        "Daily time must be a real, in-window, strictly ascending date.",
      );
      return null;
    }
    dates.push(value);
    previous = value;
  }
  return dates;
}

function normalizeSeries(
  rawValues: unknown,
  rawUnit: unknown,
  valuePath: string,
  unitPath: string,
  expectedLength: number,
  collector: IssueCollector,
): { unit: string; values: Array<number | null> } | null {
  if (!Array.isArray(rawValues)) {
    collector.add(
      "series-missing",
      valuePath,
      "Requested discharge series is missing or is not an array.",
    );
    return null;
  }
  if (rawValues.length !== expectedLength) {
    collector.add(
      "series-length-mismatch",
      valuePath,
      "Discharge series length does not match daily.time.",
    );
    return null;
  }
  if (typeof rawUnit !== "string" || rawUnit.length === 0) {
    collector.add("series-unit-missing", unitPath, "Discharge series unit is missing.");
    return null;
  }
  const values = rawValues.map((value, index): number | null => {
    if (value === null) return null;
    const number = finiteNumber(value);
    if (number === null) {
      collector.add(
        "series-value-invalid",
        `${valuePath}[${index}]`,
        "Discharge value must be numeric or null.",
      );
      return null;
    }
    return number;
  });
  if (rawValues.every((value) => value === null)) {
    collector.add(
      "series-all-null",
      valuePath,
      "Requested discharge series was returned but contains no usable numeric values.",
    );
  }
  return { unit: rawUnit, values };
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

import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  OPEN_METEO_HISTORICAL_DAILY_VARIABLES,
  OPEN_METEO_HISTORICAL_HOURLY_VARIABLES,
  OPEN_METEO_HISTORICAL_MODELS,
  OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA,
  OPEN_METEO_HISTORICAL_WEATHER_OUTPUT_SCHEMA,
} from "./open-meteo-historical-weather.schemas.js";

const ENDPOINT_PATH = "/v1/archive";
const MAX_WINDOW_DAYS = 366;
const MAX_VALIDATION_ISSUES = 50;

type HourlyVariable = (typeof OPEN_METEO_HISTORICAL_HOURLY_VARIABLES)[number];
type DailyVariable = (typeof OPEN_METEO_HISTORICAL_DAILY_VARIABLES)[number];
type HistoricalModel = (typeof OPEN_METEO_HISTORICAL_MODELS)[number];
type CellSelection = "land" | "nearest" | "sea";

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface OpenMeteoHistoricalWeatherInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  hourlyVariables?: HourlyVariable[];
  dailyVariables?: DailyVariable[];
  model?: HistoricalModel;
  cellSelection?: CellSelection;
}

interface NormalizedInput {
  locations: Coordinate[];
  startDate: string;
  endDate: string;
  hourlyVariables: HourlyVariable[];
  dailyVariables: DailyVariable[];
  model: HistoricalModel;
  cellSelection: CellSelection;
  timezone: "GMT";
  temperatureUnit: "celsius";
  windSpeedUnit: "kmh";
  precipitationUnit: "mm";
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

interface NormalizedSeries<TVariable extends string> {
  variable: TVariable;
  unit: string;
  values: Array<number | null>;
}

interface NormalizedSection<TVariable extends string> {
  times: string[];
  variables: Array<NormalizedSeries<TVariable>>;
}

interface NormalizedLocation {
  requestedLocationIndex: number;
  requestedLocation: Coordinate;
  gridLocation: Coordinate;
  elevation: number | null;
  timezone: string;
  timezoneAbbreviation: string;
  utcOffsetSeconds: number;
  hourly: NormalizedSection<HourlyVariable> | null;
  daily: NormalizedSection<DailyVariable> | null;
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

export const openMeteoHistoricalWeatherConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "open-meteo.historical-weather",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "open-meteo",
    name: "Open-Meteo Historical Weather API",
  },
  sourceCategory: "weather-reanalysis",
  endpoints: [
    {
      endpointId: "open-meteo-historical-weather-public",
      baseUrl: "https://archive-api.open-meteo.com",
      pathPrefixes: ["/v1/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "CC BY 4.0",
    url: "https://open-meteo.com/en/license",
    restrictions: [
      "Attribution to Open-Meteo and the underlying weather-data providers is required.",
      "The public free API endpoint is for non-commercial use; commercial use requires a separately governed customer endpoint and API key.",
      "Reanalysis and model-derived values are provided without accuracy, completeness, availability, or fitness guarantees.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 8_192,
    maxResponseBytes: 50_000_000,
    maxPages: 1,
    maxRecords: 100_000,
    maxRetries: 3,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "model-dependent-reanalysis",
    description:
      "ERA5 and ERA5-Land generally update daily after a provider delay, while IFS and other models have different availability and update schedules.",
  },
  limitations: [
    "Historical values are reanalysis or model-grid estimates, not raw observations from a named weather station.",
    "The selected grid coordinate and elevation can differ from the requested coordinate, especially around coasts and complex terrain.",
    "Best Match combines model families and upgrades; this can introduce discontinuities into multi-decade trend analysis.",
    "Model coverage, native time resolution, variable availability, spatial resolution, and update delay differ.",
    "The public endpoint is restricted to non-commercial use and is subject to Open-Meteo free-tier request limits.",
  ],
  discovery: {
    source: {
      maintainedBy: "Open-Meteo using ECMWF and Copernicus reanalysis and model datasets",
      summary:
        "Global historical weather reanalysis and model-grid time series assembled by Open-Meteo.",
      description:
        "The Historical Weather API combines observations with numerical weather models to produce gap-filled reanalysis fields. It returns model-grid estimates for requested coordinates rather than measurements from identifiable stations.",
      coverage: {
        geographic:
          "Global for ERA5, ERA5-Land, ERA5-Ensemble, and IFS families; CERRA is limited to Europe.",
        temporal:
          "Model-dependent historical coverage: ERA5 families extend back to 1940 or 1950, while IFS and CERRA cover shorter periods.",
        granularity:
          "Hourly or model-native time steps and daily aggregates at the selected weather-model grid cell.",
      },
    },
    summary:
      "Retrieve bounded historical weather reanalysis series for up to ten known coordinates.",
    description:
      "This capability sends one deterministic GMT request to the public Open-Meteo archive endpoint, selects one documented model, and emits aligned numeric hourly and daily series with explicit partial validation.",
    provides: [
      "Curated hourly temperature, humidity, precipitation, pressure, cloud, wind, radiation, and shallow-soil variables.",
      "Curated numeric daily weather summaries including extrema, precipitation, sunshine, wind, weather code, and reference evapotranspiration.",
      "Explicit model selection, returned model-grid coordinates, elevation, units, and bounded multi-coordinate date windows.",
      "Partial results when an individual coordinate, section, time axis, requested variable, or unit cannot be normalized safely.",
    ],
    doesNotProvide: [
      "Raw weather-station observations, station identifiers, observation quality flags, or exact on-site measurements.",
      "Weather forecasts, live current conditions, forecast skill evaluation, or archived individual forecast runs.",
      "Climate projections, future emissions scenarios, causal climate attribution, or trend significance tests.",
      "Geocoding, elevation overrides, commercial endpoint credentials, sunrise or sunset string fields, or arbitrary provider variables.",
    ],
    selectionHints: [
      "Choose this capability for gap-filled historical weather context at already-known coordinates.",
      "Select ERA5 or ERA5-Land for multi-decade trend inputs where model consistency matters; Best Match favors locally available detail but changes model families over time.",
      "Choose a station-observation source when instrument provenance, local measurement quality, or regulatory-grade observations are required.",
      "Check the selected model's temporal, regional, variable, and spatial coverage before comparing locations or periods.",
    ],
    typicalUseCases: [
      "Retrieve aligned historical temperature and precipitation context for an environmental assessment.",
      "Build a bounded ERA5 or ERA5-Land input series for a separately governed long-term analysis.",
    ],
    sourceDocumentation: [
      {
        title: "Open-Meteo Historical Weather API documentation",
        url: "https://open-meteo.com/en/docs/historical-weather-api",
      },
      {
        title: "Open-Meteo Historical Weather OpenAPI specification",
        url: "https://github.com/open-meteo/open-meteo/blob/main/openapi/historical-weather.yml",
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
      operationId: "fetch",
      operationVersion: "1.0.1",
      features: ["open-meteo.series-all-null"],
      summary: "Fetch one bounded GMT window of Open-Meteo historical weather reanalysis.",
      description:
        "Builds one stable public-endpoint query for up to ten coordinates, one model, and curated hourly or daily variables, then validates aligned numeric arrays under shared byte, retry, timeout, and time-row limits.",
      inputSchema: OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA,
      outputSchema: OPEN_METEO_HISTORICAL_WEATHER_OUTPUT_SCHEMA,
      execute: executeOpenMeteoHistoricalWeather,
    },
  ],
};

async function executeOpenMeteoHistoricalWeather(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as OpenMeteoHistoricalWeatherInput);
  const query: Record<string, string> = {
    latitude: input.locations.map((location) => location.latitude).join(","),
    longitude: input.locations.map((location) => location.longitude).join(","),
    start_date: input.startDate,
    end_date: input.endDate,
    models: input.model,
    timezone: input.timezone,
    timeformat: "iso8601",
    temperature_unit: input.temperatureUnit,
    wind_speed_unit: input.windSpeedUnit,
    precipitation_unit: input.precipitationUnit,
    cell_selection: input.cellSelection,
  };
  if (input.hourlyVariables.length > 0) query.hourly = input.hourlyVariables.join(",");
  if (input.dailyVariables.length > 0) query.daily = input.dailyVariables.join(",");
  const response = await context.http.request({
    endpointId: "open-meteo-historical-weather-public",
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
            "One or more Open-Meteo historical locations, sections, timestamps, variables, or units could not be normalized.",
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
        service: "Historical Weather API",
        endpoint: ENDPOINT_PATH,
        model: input.model,
        reanalysis: true,
        timezone: "GMT",
      },
      request: input,
      validation: { issueCount: normalized.issueCount, issues: normalized.issues },
      locations: normalized.locations.map(toOutputLocation),
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
      "Open-Meteo Historical Weather values are reanalysis or model-grid estimates, not station observations.",
      "Inspect the returned grid coordinate and elevation before treating values as representative of the requested site.",
      "Attribute Open-Meteo and the underlying data providers; the configured public endpoint is non-commercial.",
      ...(input.model === "best_match"
        ? [
            "Best Match changes source models over time; select ERA5 or ERA5-Land when long-term model consistency matters.",
          ]
        : []),
      ...(normalized.truncated ? ["The normalized time rows reached the record limit."] : []),
    ],
    errors,
    observations: [{ ...response.observation, sourceId: "historical-weather-reanalysis" }],
  };
}

function normalizeInput(input: OpenMeteoHistoricalWeatherInput): NormalizedInput {
  const start = parseDate(input.startDate, "startDate");
  const end = parseDate(input.endDate, "endDate");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError("invalid-request", "startDate must not follow endDate.");
  }
  const windowDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (windowDays > MAX_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The inclusive Open-Meteo historical-weather window must not exceed ${MAX_WINDOW_DAYS} days.`,
      { details: { windowDays, maximumWindowDays: MAX_WINDOW_DAYS } },
    );
  }
  const hourlyVariables = [...(input.hourlyVariables ?? [])].sort(codePointOrder);
  const dailyVariables = [...(input.dailyVariables ?? [])].sort(codePointOrder);
  if (hourlyVariables.length === 0 && dailyVariables.length === 0) {
    throw new DataRuntimeError(
      "invalid-request",
      "Specify at least one hourlyVariables or dailyVariables item.",
    );
  }
  return {
    locations: input.locations.map((location) => ({ ...location })),
    startDate: input.startDate,
    endDate: input.endDate,
    hourlyVariables,
    dailyVariables,
    model: input.model ?? "best_match",
    cellSelection: input.cellSelection ?? "land",
    timezone: "GMT",
    temperatureUnit: "celsius",
    windSpeedUnit: "kmh",
    precipitationUnit: "mm",
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
      "Open-Meteo Historical Weather returned an explicit provider error response.",
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
      "Open-Meteo Historical Weather must return one object for one coordinate or an array for multiple coordinates.",
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

  const totalAvailable = candidates.reduce(
    (total, location) =>
      total + (location.hourly?.times.length ?? 0) + (location.daily?.times.length ?? 0),
    0,
  );
  const truncated = totalAvailable > maxRecords;
  let remaining = maxRecords;
  const locations: NormalizedLocation[] = [];
  for (const location of candidates) {
    if (remaining <= 0) break;
    const hourlyLength = Math.min(location.hourly?.times.length ?? 0, remaining);
    const hourly = sliceSection(location.hourly, hourlyLength);
    remaining -= hourlyLength;
    const dailyLength = Math.min(location.daily?.times.length ?? 0, remaining);
    const daily = sliceSection(location.daily, dailyLength);
    remaining -= dailyLength;
    locations.push({ ...location, hourly, daily });
  }
  const recordCount = locations.reduce(
    (total, location) =>
      total + (location.hourly?.times.length ?? 0) + (location.daily?.times.length ?? 0),
    0,
  );
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
      "Coordinate response is missing numeric model-grid latitude or longitude.",
    );
    return null;
  }

  const hourly =
    input.hourlyVariables.length > 0
      ? normalizeSection(
          item.hourly,
          item.hourly_units,
          `${path}.hourly`,
          input.hourlyVariables,
          input,
          "hourly",
          collector,
        )
      : null;
  const daily =
    input.dailyVariables.length > 0
      ? normalizeSection(
          item.daily,
          item.daily_units,
          `${path}.daily`,
          input.dailyVariables,
          input,
          "daily",
          collector,
        )
      : null;

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
    hourly,
    daily,
  };
}

function normalizeSection<TVariable extends HourlyVariable | DailyVariable>(
  rawSection: unknown,
  rawUnits: unknown,
  path: string,
  variables: TVariable[],
  input: NormalizedInput,
  kind: "daily" | "hourly",
  collector: IssueCollector,
): NormalizedSection<TVariable> | null {
  const section = recordValue(rawSection);
  const units = recordValue(rawUnits);
  if (!section || !units || !Array.isArray(section.time)) {
    collector.add(
      "section-missing",
      path,
      `Response must contain ${kind}, ${kind}.time, and ${kind}_units.`,
    );
    return null;
  }
  const times = normalizeTimes(section.time, path, input, kind, collector);
  if (times === null) return null;
  const normalizedVariables: Array<NormalizedSeries<TVariable>> = [];
  for (const variable of variables) {
    const normalized = normalizeSeries(
      section[variable],
      units[variable],
      `${path}.${variable}`,
      `${path.slice(0, path.lastIndexOf("."))}.${kind}_units.${variable}`,
      times.length,
      collector,
    );
    if (normalized) normalizedVariables.push({ variable, ...normalized });
  }
  return { times, variables: normalizedVariables };
}

function normalizeTimes(
  values: unknown[],
  path: string,
  input: NormalizedInput,
  kind: "daily" | "hourly",
  collector: IssueCollector,
): string[] | null {
  const expectedDailyCount =
    Math.floor(
      (new Date(`${input.endDate}T00:00:00Z`).getTime() -
        new Date(`${input.startDate}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  if (kind === "daily" && values.length !== expectedDailyCount) {
    collector.add(
      "time-axis-length-mismatch",
      `${path}.time`,
      `Expected ${expectedDailyCount} daily dates but received ${values.length}.`,
    );
  }
  if (kind === "hourly" && values.length !== expectedDailyCount * 24) {
    collector.add(
      "time-axis-length-mismatch",
      `${path}.time`,
      `Expected ${expectedDailyCount * 24} GMT hours but received ${values.length}.`,
    );
  }
  const times: string[] = [];
  let previous = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const validShape =
      typeof value === "string" &&
      (kind === "daily"
        ? /^\d{4}-\d{2}-\d{2}$/.test(value)
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value));
    const datePart = typeof value === "string" ? value.slice(0, 10) : "";
    const parsed =
      typeof value === "string"
        ? new Date(kind === "daily" ? `${value}T00:00:00Z` : `${value}:00Z`)
        : new Date(Number.NaN);
    const normalizedValue = Number.isFinite(parsed.getTime())
      ? parsed.toISOString().slice(0, kind === "daily" ? 10 : 16)
      : "";
    if (
      !validShape ||
      !Number.isFinite(parsed.getTime()) ||
      normalizedValue !== value ||
      datePart < input.startDate ||
      datePart > input.endDate ||
      (previous !== "" && (value as string) <= previous)
    ) {
      collector.add(
        "time-axis-invalid",
        `${path}.time[${index}]`,
        `${kind === "daily" ? "Daily date" : "Hourly timestamp"} must be real, in-window, and strictly ascending in GMT.`,
      );
      return null;
    }
    times.push(value as string);
    previous = value as string;
  }
  return times;
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
      "Requested historical-weather series is missing or is not an array.",
    );
    return null;
  }
  if (rawValues.length !== expectedLength) {
    collector.add(
      "series-length-mismatch",
      valuePath,
      "Historical-weather series length does not match its time axis.",
    );
    return null;
  }
  if (typeof rawUnit !== "string" || rawUnit.length === 0) {
    collector.add("series-unit-missing", unitPath, "Historical-weather series unit is missing.");
    return null;
  }
  const values = rawValues.map((value, index): number | null => {
    if (value === null) return null;
    const number = finiteNumber(value);
    if (number === null) {
      collector.add(
        "series-value-invalid",
        `${valuePath}[${index}]`,
        "Historical-weather value must be numeric or null.",
      );
      return null;
    }
    return number;
  });
  if (rawValues.every((value) => value === null)) {
    collector.add(
      "series-all-null",
      valuePath,
      "Requested historical-weather series was returned but contains no usable numeric values.",
    );
  }
  return { unit: rawUnit, values };
}

function sliceSection<TVariable extends string>(
  section: NormalizedSection<TVariable> | null,
  length: number,
): NormalizedSection<TVariable> | null {
  if (!section || length <= 0) return null;
  return {
    times: section.times.slice(0, length),
    variables: section.variables.map((variable) => ({
      ...variable,
      values: variable.values.slice(0, length),
    })),
  };
}

function toOutputLocation(location: NormalizedLocation): Record<string, unknown> {
  return {
    requestedLocationIndex: location.requestedLocationIndex,
    requestedLocation: location.requestedLocation,
    gridLocation: location.gridLocation,
    elevation: location.elevation,
    timezone: location.timezone,
    timezoneAbbreviation: location.timezoneAbbreviation,
    utcOffsetSeconds: location.utcOffsetSeconds,
    hourly: location.hourly
      ? { timesUtc: location.hourly.times, variables: location.hourly.variables }
      : null,
    daily: location.daily
      ? { dates: location.daily.times, variables: location.daily.variables }
      : null,
  };
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

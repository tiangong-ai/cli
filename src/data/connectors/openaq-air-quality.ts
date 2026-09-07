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
  OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA,
  OPENAQ_LOCATION_SEARCH_OUTPUT_SCHEMA,
  OPENAQ_MEASUREMENT_INPUT_SCHEMA,
  OPENAQ_MEASUREMENT_OUTPUT_SCHEMA,
} from "./openaq-air-quality.schemas.js";

const API_PATH_PREFIX = "/v3/";
const MAX_MEASUREMENT_WINDOW_DAYS = 366;
const MAX_BBOX_SQUARE_DEGREES = 3_600;

interface Center {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface LocationSearchInput {
  countryCode?: string;
  countryIds?: number[];
  providerIds?: number[];
  parameterIds?: number[];
  licenseIds?: number[];
  monitor?: boolean;
  mobile?: boolean;
  center?: Center;
  boundingBox?: BoundingBox;
  pageSize?: number;
  sortOrder?: "asc" | "desc";
}

interface NormalizedLocationQuery {
  countryCode: string | null;
  countryIds: number[];
  providerIds: number[];
  parameterIds: number[];
  licenseIds: number[];
  monitor: boolean | null;
  mobile: boolean | null;
  center: Center | null;
  boundingBox: BoundingBox | null;
  pageSize: number;
  sortOrder: "asc" | "desc";
}

interface MeasurementInput {
  sensorId: number;
  granularity: "raw" | "hourly" | "daily";
  startDateTime: string;
  endDateTime: string;
  pageSize?: number;
}

interface NormalizedMeasurementQuery {
  sensorId: number;
  granularity: "raw" | "hourly" | "daily";
  startDateTime: string;
  endDateTime: string;
  pageSize: number;
}

interface ProviderMeta {
  name: "openaq-api";
  website: string;
  found: number | string | null;
}

interface ParsedPage<RecordType> {
  meta: ProviderMeta;
  rawRecordCount: number;
  records: RecordType[];
}

interface PageSummary {
  pageNumber: number;
  inputRecords: number;
  emittedRecords: number;
}

interface LocationRecord {
  recordIndex: number;
  sourcePageNumber: number;
  locationId: number;
  name: string | null;
  locality: string | null;
  timezone: string;
  country: { id: number | null; code: string; name: string };
  owner: Entity;
  provider: Entity;
  isMobile: boolean;
  isMonitor: boolean;
  coordinates: Coordinates | null;
  bounds: [number, number, number, number];
  distanceMeters: number | null;
  datetimeFirstUtc: string | null;
  datetimeLastUtc: string | null;
  instruments: Entity[];
  sensors: Array<{ id: number; name: string; parameter: Parameter }>;
  licenses: Array<{
    id: number;
    name: string;
    attributionName: string;
    attributionUrl: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  }>;
}

interface Entity {
  id: number;
  name: string;
}

interface Parameter extends Entity {
  units: string;
  displayName: string | null;
}

interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

interface MeasurementRecord {
  recordIndex: number;
  sourcePageNumber: number;
  sensorId: number;
  granularity: "raw" | "hourly" | "daily";
  value: number | null;
  flagInfo: { hasFlags: boolean };
  parameter: Parameter;
  period: {
    label: string;
    interval: string;
    datetimeFromUtc: string | null;
    datetimeToUtc: string | null;
  } | null;
  coordinates: Coordinates | null;
  summary: {
    min: number | null;
    q02: number | null;
    q25: number | null;
    median: number | null;
    q75: number | null;
    q98: number | null;
    max: number | null;
    average: number | null;
    standardDeviation: number | null;
  } | null;
  coverage: {
    expectedCount: number;
    expectedInterval: string;
    observedCount: number;
    observedInterval: string;
    percentComplete: number;
    percentCoverage: number;
    datetimeFromUtc: string | null;
    datetimeToUtc: string | null;
  } | null;
}

type StopReason = "completed" | "no-results" | "max-pages" | "max-records" | "partial";

export const openAqAirQualityConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "openaq.air-quality",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "openaq", name: "OpenAQ" },
  sourceCategory: "air-quality-observations",
  endpoints: [
    {
      endpointId: "openaq-api",
      baseUrl: "https://api.openaq.org",
      pathPrefixes: [API_PATH_PREFIX],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "OpenAQ Terms and source-specific data licenses",
    url: "https://docs.openaq.org/about/terms",
    restrictions: [
      "Attribute OpenAQ and preserve the attribution and license requirements of each original data provider.",
      "OpenAQ data are provided as-is; users must assess source-specific accuracy, quality, and fitness for purpose.",
      "Do not use the hosted API for abusive, perpetual, or bulk-replication requests that duplicate OpenAQ's core service.",
    ],
  },
  credentials: [
    {
      credentialId: "api-key",
      environmentVariable: "OPENAQ_API_KEY",
      required: true,
      endpointIds: ["openaq-api"],
      injection: { kind: "header", name: "X-API-Key", prefix: "" },
    },
  ],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 2_048,
    maxResponseBytes: 20_000_000,
    maxPages: 10,
    maxRecords: 10_000,
    maxRetries: 2,
    maxRetryDelayMs: 60_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-and-source-dependent",
    description:
      "OpenAQ update latency and historical completeness vary by original provider; public S3 archive objects are typically delayed relative to the API.",
  },
  limitations: [
    "OpenAQ aggregates heterogeneous provider measurements whose calibration, validation, coverage, and reporting latency differ by source.",
    "The hosted API is rate limited to the provider's published per-minute and per-hour quotas and may change or be discontinued.",
    "Location metadata and sensor availability can change; a discovered sensor ID is not proof of continuous coverage for the requested window.",
    "OpenAQ daily records are precomputed using the sensor location's local-day boundaries; use returned period and coverage metadata rather than assuming UTC calendar days.",
    "This connector does not calculate an AQI, make health or regulatory determinations, or establish compliance with an air-quality standard.",
  ],
  discovery: {
    source: {
      maintainedBy: "OpenAQ",
      summary:
        "Open, harmonized air-quality location, sensor, and measurement data aggregated from many original providers.",
      description:
        "OpenAQ's v3 API exposes metadata and measurements from government, research, community, and other provider networks. OpenAQ standardizes access, while provenance, license, instrument method, quality, and coverage remain source specific.",
      coverage: {
        geographic:
          "Global but uneven, limited to locations and providers represented in OpenAQ at request time.",
        temporal:
          "Provider-dependent historical and near-current coverage; bounded measurement requests are limited here to 366 days.",
        granularity:
          "Location and sensor metadata plus raw, hourly, or daily records for one explicit sensor.",
      },
    },
    summary:
      "Discover bounded OpenAQ monitoring locations and retrieve bounded measurements for one known sensor.",
    description:
      "This capability provides closed, credentialed OpenAQ v3 operations for filtered location discovery and one-sensor measurement retrieval. It validates pagination and provider metadata, preserves attribution, and rejects unbounded scans.",
    provides: [
      "Filtered location metadata including provider, owner, coordinates, sensor IDs, parameter metadata, time coverage, and per-location licenses.",
      "Raw, hourly, or daily measurements for one sensor and one explicit RFC3339 window, including provider coverage and aggregate summaries when supplied.",
      "OpenAQ measurement flags and explicit nulls for unavailable values, periods, coordinates, summaries, or coverage.",
      "Bounded pagination with stable normalized queries, explicit truncation, and later-page partial-result reporting.",
    ],
    doesNotProvide: [
      "OpenAQ S3 archive listing, bulk archive download, CSV file transfer, or arbitrary API-path execution.",
      "Standalone global catalogs of every OpenAQ country, provider, owner, parameter, license, manufacturer, instrument, or sensor; this operation discovers their metadata only through bounded location results.",
      "Regulatory compliance, official monitoring-network status, health advice, AQI calculation, forecasting, or pollutant-source attribution.",
      "Cross-sensor aggregation, spatial interpolation, unit conversion, deduplication, calibration correction, or guaranteed source completeness.",
      "An API key, quota increase, recurring monitoring, or permission to ignore OpenAQ and original-provider attribution terms.",
    ],
    selectionHints: [
      "Use search-locations first when the relevant OpenAQ sensor ID is unknown, and inspect provider, monitor classification, parameter, license, and coverage metadata before selection.",
      "Choose raw for upstream-reported observations and hourly or daily for OpenAQ's preferred precomputed aggregates; do not mix granularities without an explicit analytical method.",
      "Interpret daily records against the selected location's timezone and the returned period; do not relabel them as UTC calendar-day averages.",
      "Use a separately governed content-download workflow for the delayed public S3 archive or other bulk files.",
      "Verify sensitive environmental, health, or compliance conclusions against the original provider and applicable official authority.",
      "Preserve null values and flagInfo.hasFlags: OpenAQ can return structurally valid records whose measurement, period, summary, coordinates, or coverage is unavailable.",
    ],
    typicalUseCases: [
      "Find PM2.5 sensors for a known country, provider, or bounded study area.",
      "Retrieve a short, explicit raw or aggregate time series for a previously selected sensor.",
    ],
    sourceDocumentation: [
      { title: "OpenAQ API documentation", url: "https://docs.openaq.org/" },
      { title: "OpenAQ locations resource", url: "https://docs.openaq.org/resources/locations" },
      {
        title: "OpenAQ measurements resource",
        url: "https://docs.openaq.org/resources/measurements",
      },
      { title: "OpenAQ API rate limits", url: "https://docs.openaq.org/using-the-api/rate-limits" },
      { title: "OpenAQ terms", url: "https://docs.openaq.org/about/terms" },
      { title: "OpenAQ public archive", url: "https://docs.openaq.org/aws/about" },
    ],
  },
  operations: [
    {
      operationId: "search-locations",
      operationVersion: "1.0.0",
      summary: "Search bounded OpenAQ v3 location and sensor metadata.",
      description:
        "Requires at least one country, provider, parameter, license, monitor, mobile, center-radius, or bounding-box filter and returns normalized location, sensor, coverage, and attribution metadata.",
      inputSchema: OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA,
      outputSchema: OPENAQ_LOCATION_SEARCH_OUTPUT_SCHEMA,
      execute: executeLocationSearch,
    },
    {
      operationId: "fetch-sensor-measurements",
      operationVersion: "1.0.1",
      summary: "Fetch bounded raw, hourly, or daily measurements for one OpenAQ sensor.",
      description:
        "Retrieves at most 366 days for one explicit sensor and granularity, validates provider pagination, and normalizes parameter, period, coordinate, summary, and coverage fields.",
      inputSchema: OPENAQ_MEASUREMENT_INPUT_SCHEMA,
      outputSchema: OPENAQ_MEASUREMENT_OUTPUT_SCHEMA,
      execute: executeSensorMeasurements,
    },
  ],
};

async function executeLocationSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeLocationQuery(context.input as LocationSearchInput);
  return executePaged<LocationRecord, NormalizedLocationQuery>({
    context,
    query,
    path: "/v3/locations",
    queryParameters: (pageNumber) => buildLocationParameters(query, pageNumber),
    normalizeRecord: (value, pageNumber, recordIndex) =>
      normalizeLocation(value, pageNumber, recordIndex),
    sourceId: (pageNumber) => `locations:page:${pageNumber}`,
    source: {
      providerId: "openaq",
      service: "OpenAQ API",
      apiVersion: "v3",
      sourceSpecificTerms: true,
    },
    warnings: [
      "Attribute OpenAQ and preserve each original provider's attribution and license requirements returned with location metadata.",
      "Location, sensor, and monitor classifications are provider-dependent metadata and do not establish regulatory status or measurement quality.",
    ],
  });
}

async function executeSensorMeasurements(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeMeasurementQuery(context.input as MeasurementInput);
  const execution = await executePaged<MeasurementRecord, NormalizedMeasurementQuery>({
    context,
    query,
    path: measurementPath(query),
    queryParameters: (pageNumber) => buildMeasurementParameters(query, pageNumber),
    normalizeRecord: (value, pageNumber, recordIndex) =>
      normalizeMeasurement(value, query, pageNumber, recordIndex),
    sourceId: (pageNumber) => `sensor:${query.sensorId}:${query.granularity}:page:${pageNumber}`,
    source: {
      providerId: "openaq",
      service: "OpenAQ API",
      apiVersion: "v3",
      sourceSpecificTerms: true,
    },
    warnings: [
      "Attribute OpenAQ and the original data provider identified through the selected sensor's location metadata.",
      query.granularity === "raw"
        ? "Raw records reflect upstream reporting and must not be treated as quality-controlled OpenAQ aggregates."
        : `${query.granularity === "hourly" ? "Hourly" : "Daily"} records are OpenAQ precomputed aggregates; preserve the returned coverage fields when interpreting them.`,
      ...(query.granularity === "daily"
        ? [
            "OpenAQ daily aggregates use the sensor location's local-day boundaries; preserve returned periods and do not relabel them as UTC calendar days.",
          ]
        : []),
      "Measurements are provided as-is and do not constitute an AQI, health assessment, or regulatory determination.",
    ],
  });
  const records = (execution.data as { records: MeasurementRecord[] }).records;
  const invalidPaths: string[] = [];
  let affectedRecordCount = 0;
  for (const [index, record] of records.entries()) {
    if (!record.coverage) continue;
    const invalidFields = (["percentComplete", "percentCoverage"] as const).filter(
      (field) => record.coverage![field] < 0 || record.coverage![field] > 100,
    );
    if (invalidFields.length === 0) continue;
    affectedRecordCount += 1;
    for (const field of invalidFields) {
      if (invalidPaths.length < 20) invalidPaths.push(`records[${index}].coverage.${field}`);
    }
  }
  if (affectedRecordCount === 0) return execution;
  return {
    ...execution,
    status: "partial",
    data: { ...(execution.data as Record<string, unknown>), stopReason: "partial" },
    summary: {
      ...execution.summary,
      completeness: "partial",
      missing: [...(execution.summary.missing ?? []), { kind: "field", identifiers: invalidPaths }],
    },
    warnings: [
      ...execution.warnings,
      "Provider coverage percentages outside 0–100 were preserved, not clamped. Measurements were retrieved but these coverage fields do not establish valid quality or temporal completeness.",
    ],
    errors: [
      ...execution.errors,
      {
        code: "partial-result",
        message:
          "OpenAQ supplied anomalous coverage percentages; measurement rows and original coverage values were retained for review.",
        retryable: false,
        userActionRequired: false,
        details: {
          issueCode: "coverage-percentage-out-of-range",
          affectedRecordCount,
          invalidPaths,
        },
      },
    ],
  };
}

async function executePaged<RecordType, QueryType>(options: {
  context: DataOperationExecutionContext;
  query: QueryType;
  path: string;
  queryParameters: (
    pageNumber: number,
  ) => Record<string, boolean | number | string | Array<boolean | number | string>>;
  normalizeRecord: (value: unknown, pageNumber: number, recordIndex: number) => RecordType;
  sourceId: (pageNumber: number) => string;
  source: Record<string, unknown>;
  warnings: string[];
}): Promise<DataOperationExecution> {
  const { context } = options;
  const pageSize = requireQueryPageSize(options.query);
  const records: RecordType[] = [];
  const pages: PageSummary[] = [];
  const observations: DataSourceObservation[] = [];
  let provider: ProviderMeta | null = null;
  let stopReason: StopReason = "completed";
  let failedPage: number | null = null;
  let failure: unknown;

  for (let pageNumber = 1; pageNumber <= context.limits.maxPages; pageNumber += 1) {
    try {
      const response = await context.http.request({
        endpointId: "openaq-api",
        method: "GET",
        path: options.path,
        query: options.queryParameters(pageNumber),
        credentialId: "api-key",
      });
      const remaining = Math.max(0, context.limits.maxRecords - records.length);
      const parsed = parseProviderPage(
        response.json(),
        pageNumber,
        pageSize,
        remaining,
        records.length,
        options.normalizeRecord,
      );
      validateProviderConsistency(provider, parsed.meta);
      provider ??= parsed.meta;
      observations.push({ ...response.observation, sourceId: options.sourceId(pageNumber) });
      records.push(...parsed.records);
      pages.push({
        pageNumber,
        inputRecords: parsed.rawRecordCount,
        emittedRecords: parsed.records.length,
      });

      const hasMore = providerHasMore(
        parsed.meta.found,
        pageNumber,
        pageSize,
        parsed.rawRecordCount,
      );
      if (
        records.length >= context.limits.maxRecords &&
        (hasMore || parsed.rawRecordCount > parsed.records.length)
      ) {
        stopReason = "max-records";
        break;
      }
      if (!hasMore) {
        stopReason = pageNumber === 1 && parsed.rawRecordCount === 0 ? "no-results" : "completed";
        break;
      }
      if (pageNumber >= context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (isCredentialFailure(error)) throw error;
      if (pages.length === 0) throw normalizeProviderFailure(error);
      failedPage = pageNumber;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (!provider) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "OpenAQ pagination completed without provider metadata.",
    );
  }
  const partial = failedPage !== null;
  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "A later OpenAQ result page could not be retrieved or validated.",
          retryable:
            failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
          userActionRequired: false,
          details: {
            missingPages: [failedPage],
            causeCode:
              failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
          },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: options.source,
      query: options.query,
      provider,
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
        ? { missing: [{ kind: "page" as const, identifiers: [String(failedPage)] }] }
        : {}),
    },
    warnings: [
      ...options.warnings,
      ...(truncated ? ["The OpenAQ result stopped at an explicit page or record limit."] : []),
    ],
    errors,
    observations,
  };
}

function normalizeLocationQuery(input: LocationSearchInput): NormalizedLocationQuery {
  const countryIds = normalizeIds(input.countryIds);
  const providerIds = normalizeIds(input.providerIds);
  const parameterIds = normalizeIds(input.parameterIds);
  const licenseIds = normalizeIds(input.licenseIds);
  const center = input.center ? { ...input.center } : null;
  const boundingBox = input.boundingBox ? { ...input.boundingBox } : null;
  if (center && boundingBox) {
    throw new DataRuntimeError(
      "invalid-request",
      "OpenAQ location search cannot combine center and boundingBox.",
    );
  }
  if (boundingBox) {
    if (boundingBox.east <= boundingBox.west || boundingBox.north <= boundingBox.south) {
      throw new DataRuntimeError(
        "invalid-request",
        "OpenAQ boundingBox west/south values must be lower than east/north values.",
      );
    }
    const squareDegrees =
      (boundingBox.east - boundingBox.west) * (boundingBox.north - boundingBox.south);
    if (squareDegrees > MAX_BBOX_SQUARE_DEGREES) {
      throw new DataRuntimeError(
        "invalid-request",
        "OpenAQ world-scale or excessively broad bounding-box scans are not allowed.",
        { details: { squareDegrees, maximumSquareDegrees: MAX_BBOX_SQUARE_DEGREES } },
      );
    }
  }
  const countryCode = input.countryCode ?? null;
  const monitor = input.monitor ?? null;
  const mobile = input.mobile ?? null;
  if (
    !countryCode &&
    countryIds.length === 0 &&
    providerIds.length === 0 &&
    parameterIds.length === 0 &&
    licenseIds.length === 0 &&
    monitor === null &&
    mobile === null &&
    !center &&
    !boundingBox
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "OpenAQ location search requires at least one narrowing filter.",
    );
  }
  return {
    countryCode,
    countryIds,
    providerIds,
    parameterIds,
    licenseIds,
    monitor,
    mobile,
    center,
    boundingBox,
    pageSize: input.pageSize ?? 1000,
    sortOrder: input.sortOrder ?? "asc",
  };
}

function normalizeMeasurementQuery(input: MeasurementInput): NormalizedMeasurementQuery {
  const start = parseRfc3339(input.startDateTime, "startDateTime");
  const end = parseRfc3339(input.endDateTime, "endDateTime");
  if (start > end) {
    throw new DataRuntimeError("invalid-request", "startDateTime must not follow endDateTime.");
  }
  const windowDays = (end - start) / 86_400_000;
  if (windowDays > MAX_MEASUREMENT_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The OpenAQ measurement window must not exceed ${MAX_MEASUREMENT_WINDOW_DAYS} days.`,
      { details: { windowDays, maximumWindowDays: MAX_MEASUREMENT_WINDOW_DAYS } },
    );
  }
  return {
    sensorId: input.sensorId,
    granularity: input.granularity,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    pageSize: input.pageSize ?? 1000,
  };
}

function buildLocationParameters(
  query: NormalizedLocationQuery,
  pageNumber: number,
): Record<string, boolean | number | string> {
  return {
    ...(query.boundingBox
      ? {
          bbox: [
            query.boundingBox.west,
            query.boundingBox.south,
            query.boundingBox.east,
            query.boundingBox.north,
          ].join(","),
        }
      : {}),
    ...(query.center
      ? {
          coordinates: `${query.center.latitude},${query.center.longitude}`,
          radius: query.center.radiusMeters,
        }
      : {}),
    ...(query.countryIds.length > 0 ? { countries_id: query.countryIds.join(",") } : {}),
    ...(query.countryCode ? { iso: query.countryCode } : {}),
    ...(query.licenseIds.length > 0 ? { licenses_id: query.licenseIds.join(",") } : {}),
    ...(query.mobile !== null ? { mobile: query.mobile } : {}),
    ...(query.monitor !== null ? { monitor: query.monitor } : {}),
    limit: query.pageSize,
    order_by: "id",
    page: pageNumber,
    ...(query.parameterIds.length > 0 ? { parameters_id: query.parameterIds.join(",") } : {}),
    ...(query.providerIds.length > 0 ? { providers_id: query.providerIds.join(",") } : {}),
    sort_order: query.sortOrder,
  };
}

function measurementPath(query: NormalizedMeasurementQuery): string {
  const suffix =
    query.granularity === "raw"
      ? "measurements"
      : query.granularity === "hourly"
        ? "hours"
        : "days";
  return `/v3/sensors/${query.sensorId}/${suffix}`;
}

function buildMeasurementParameters(
  query: NormalizedMeasurementQuery,
  pageNumber: number,
): Record<string, number | string> {
  const bounds =
    query.granularity === "daily"
      ? { date_from: query.startDateTime, date_to: query.endDateTime }
      : { datetime_from: query.startDateTime, datetime_to: query.endDateTime };
  return { ...bounds, limit: query.pageSize, page: pageNumber };
}

function parseProviderPage<RecordType>(
  value: unknown,
  pageNumber: number,
  pageSize: number,
  remainingRecords: number,
  recordOffset: number,
  normalizeRecord: (value: unknown, pageNumber: number, recordIndex: number) => RecordType,
): ParsedPage<RecordType> {
  const payload = requireObject(value, "OpenAQ response");
  const metaValue = requireObject(payload.meta, "meta");
  const name = requireString(metaValue.name, "meta.name");
  if (name !== "openaq-api") throw providerInvalid("meta.name must identify openaq-api.");
  const website = requireString(metaValue.website, "meta.website", true);
  const providerPage = requirePositiveInteger(metaValue.page, "meta.page");
  const providerLimit = requirePositiveInteger(metaValue.limit, "meta.limit");
  if (providerPage !== pageNumber || providerLimit !== pageSize) {
    throw providerInvalid(
      "OpenAQ pagination metadata does not match the requested page and limit.",
    );
  }
  const found = parseFound(metaValue.found);
  const results = requireArray(payload.results, "results");
  if (results.length > pageSize) {
    throw providerInvalid("OpenAQ page records exceed the requested page limit.");
  }
  const records = results
    .slice(0, remainingRecords)
    .map((record, index) => normalizeRecord(record, pageNumber, recordOffset + index));
  return {
    meta: { name: "openaq-api", website, found },
    rawRecordCount: results.length,
    records,
  };
}

function normalizeLocation(
  value: unknown,
  pageNumber: number,
  recordIndex: number,
): LocationRecord {
  const record = requireObject(value, `results[${recordIndex}]`);
  const country = requireObject(record.country, "country");
  const instruments = requireArray(record.instruments, "instruments").map((item, index) =>
    normalizeEntity(item, `instruments[${index}]`),
  );
  const sensors = requireArray(record.sensors, "sensors").map((item, index) => {
    const sensor = requireObject(item, `sensors[${index}]`);
    return {
      id: requirePositiveInteger(sensor.id, `sensors[${index}].id`),
      name: requireString(sensor.name, `sensors[${index}].name`),
      parameter: normalizeParameter(sensor.parameter, `sensors[${index}].parameter`),
    };
  });
  const licenses =
    record.licenses === null || record.licenses === undefined
      ? []
      : requireArray(record.licenses, "licenses").map((item, index) => {
          const license = requireObject(item, `licenses[${index}]`);
          const attribution = requireObject(license.attribution, `licenses[${index}].attribution`);
          return {
            id: requirePositiveInteger(license.id, `licenses[${index}].id`),
            name: requireString(license.name, `licenses[${index}].name`),
            attributionName: requireString(attribution.name, `licenses[${index}].attribution.name`),
            attributionUrl: nullableString(attribution.url, `licenses[${index}].attribution.url`),
            dateFrom: nullableDate(license.dateFrom, `licenses[${index}].dateFrom`),
            dateTo: nullableDate(license.dateTo, `licenses[${index}].dateTo`),
          };
        });
  return {
    recordIndex,
    sourcePageNumber: pageNumber,
    locationId: requirePositiveInteger(record.id, "id"),
    name: nullableString(record.name, "name"),
    locality: nullableString(record.locality, "locality"),
    timezone: requireString(record.timezone, "timezone"),
    country: {
      id:
        country.id === null || country.id === undefined
          ? null
          : requirePositiveInteger(country.id, "country.id"),
      code: requireString(country.code, "country.code"),
      name: requireString(country.name, "country.name"),
    },
    owner: normalizeEntity(record.owner, "owner"),
    provider: normalizeEntity(record.provider, "provider"),
    isMobile: requireBoolean(record.isMobile, "isMobile"),
    isMonitor: requireBoolean(record.isMonitor, "isMonitor"),
    coordinates: normalizeNullableCoordinates(record.coordinates, "coordinates"),
    bounds: normalizeBounds(record.bounds),
    distanceMeters: nullableNonNegativeNumber(record.distance, "distance"),
    datetimeFirstUtc: nullableDateTimeObject(record.datetimeFirst, "datetimeFirst"),
    datetimeLastUtc: nullableDateTimeObject(record.datetimeLast, "datetimeLast"),
    instruments,
    sensors,
    licenses,
  };
}

function normalizeMeasurement(
  value: unknown,
  query: NormalizedMeasurementQuery,
  pageNumber: number,
  recordIndex: number,
): MeasurementRecord {
  const record = requireObject(value, `results[${recordIndex}]`);
  const flagInfo = requireObject(record.flagInfo, "flagInfo");
  const period = normalizeNullablePeriod(record.period);
  const summaryValue =
    record.summary === null || record.summary === undefined
      ? null
      : requireObject(record.summary, "summary");
  const coverage = normalizeNullableCoverage(record.coverage);
  return {
    recordIndex,
    sourcePageNumber: pageNumber,
    sensorId: query.sensorId,
    granularity: query.granularity,
    value: nullableFiniteNumber(record.value, "value"),
    flagInfo: { hasFlags: requireBoolean(flagInfo.hasFlags, "flagInfo.hasFlags") },
    parameter: normalizeParameter(record.parameter, "parameter"),
    period,
    coordinates: normalizeNullableCoordinates(record.coordinates, "coordinates"),
    summary: summaryValue
      ? {
          min: nullableFiniteNumber(summaryValue.min, "summary.min"),
          q02: nullableFiniteNumber(summaryValue.q02, "summary.q02"),
          q25: nullableFiniteNumber(summaryValue.q25, "summary.q25"),
          median: nullableFiniteNumber(summaryValue.median, "summary.median"),
          q75: nullableFiniteNumber(summaryValue.q75, "summary.q75"),
          q98: nullableFiniteNumber(summaryValue.q98, "summary.q98"),
          max: nullableFiniteNumber(summaryValue.max, "summary.max"),
          average: nullableFiniteNumber(summaryValue.avg, "summary.avg"),
          standardDeviation: nullableFiniteNumber(summaryValue.sd, "summary.sd"),
        }
      : null,
    coverage,
  };
}

function normalizeNullablePeriod(value: unknown): MeasurementRecord["period"] {
  if (value === null || value === undefined) return null;
  const period = requireObject(value, "period");
  return {
    label: requireString(period.label, "period.label"),
    interval: requireString(period.interval, "period.interval"),
    datetimeFromUtc: nullableDateTimeObject(period.datetimeFrom, "period.datetimeFrom"),
    datetimeToUtc: nullableDateTimeObject(period.datetimeTo, "period.datetimeTo"),
  };
}

function normalizeNullableCoverage(value: unknown): MeasurementRecord["coverage"] {
  if (value === null || value === undefined) return null;
  const coverage = requireObject(value, "coverage");
  return {
    expectedCount: requireNonNegativeInteger(coverage.expectedCount, "coverage.expectedCount"),
    expectedInterval: requireString(coverage.expectedInterval, "coverage.expectedInterval"),
    observedCount: requireNonNegativeInteger(coverage.observedCount, "coverage.observedCount"),
    observedInterval: requireString(coverage.observedInterval, "coverage.observedInterval"),
    percentComplete: requireFiniteNumber(coverage.percentComplete, "coverage.percentComplete"),
    percentCoverage: requireFiniteNumber(coverage.percentCoverage, "coverage.percentCoverage"),
    datetimeFromUtc: nullableDateTimeObject(coverage.datetimeFrom, "coverage.datetimeFrom"),
    datetimeToUtc: nullableDateTimeObject(coverage.datetimeTo, "coverage.datetimeTo"),
  };
}

function normalizeEntity(value: unknown, field: string): Entity {
  const entity = requireObject(value, field);
  return {
    id: requirePositiveInteger(entity.id, `${field}.id`),
    name: requireString(entity.name, `${field}.name`),
  };
}

function normalizeParameter(value: unknown, field: string): Parameter {
  const parameter = requireObject(value, field);
  return {
    id: requirePositiveInteger(parameter.id, `${field}.id`),
    name: requireString(parameter.name, `${field}.name`),
    units: requireString(parameter.units, `${field}.units`),
    displayName: nullableString(parameter.displayName, `${field}.displayName`),
  };
}

function normalizeNullableCoordinates(value: unknown, field: string): Coordinates | null {
  if (value === null || value === undefined) return null;
  const coordinates = requireObject(value, field);
  const latitude = nullableFiniteNumber(coordinates.latitude, `${field}.latitude`);
  const longitude = nullableFiniteNumber(coordinates.longitude, `${field}.longitude`);
  if (
    (latitude !== null && (latitude < -90 || latitude > 90)) ||
    (longitude !== null && (longitude < -180 || longitude > 180))
  ) {
    throw providerInvalid(`${field} falls outside WGS84 coordinate bounds.`);
  }
  return { latitude, longitude };
}

function normalizeBounds(value: unknown): [number, number, number, number] {
  const values = requireArray(value, "bounds");
  if (values.length !== 4) throw providerInvalid("bounds must contain exactly four numbers.");
  return [
    requireFiniteNumber(values[0], "bounds[0]"),
    requireFiniteNumber(values[1], "bounds[1]"),
    requireFiniteNumber(values[2], "bounds[2]"),
    requireFiniteNumber(values[3], "bounds[3]"),
  ];
}

function requireDateTimeObject(value: unknown, field: string): string {
  const datetime = requireObject(value, field);
  const utc = requireString(datetime.utc, `${field}.utc`);
  parseProviderRfc3339(utc, `${field}.utc`);
  return utc;
}

function nullableDateTimeObject(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireDateTimeObject(value, field);
}

function normalizeIds(values: number[] | undefined): number[] {
  if (!values) return [];
  return [...new Set(values)].sort((left, right) => left - right);
}

function requireQueryPageSize(value: unknown): number {
  if (!value || typeof value !== "object" || !("pageSize" in value)) {
    throw new DataRuntimeError("internal-error", "OpenAQ normalized query lacks pageSize.");
  }
  const pageSize = (value as { pageSize?: unknown }).pageSize;
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1) {
    throw new DataRuntimeError("internal-error", "OpenAQ normalized pageSize is invalid.");
  }
  return pageSize as number;
}

function validateProviderConsistency(current: ProviderMeta | null, next: ProviderMeta): void {
  if (!current) return;
  if (
    current.name !== next.name ||
    current.website !== next.website ||
    JSON.stringify(current.found) !== JSON.stringify(next.found)
  ) {
    throw providerInvalid("OpenAQ pagination metadata changed between pages.");
  }
}

function providerHasMore(
  found: number | string | null,
  pageNumber: number,
  pageSize: number,
  rawRecordCount: number,
): boolean {
  const numericFound =
    typeof found === "number"
      ? found
      : typeof found === "string" && /^\d+$/.test(found)
        ? Number(found)
        : null;
  return numericFound === null ? rawRecordCount >= pageSize : pageNumber * pageSize < numericFound;
}

function parseFound(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw providerInvalid("meta.found must be a non-negative safe integer.");
    }
    return value;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  throw providerInvalid("meta.found must be a number, non-empty string, or null.");
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw providerInvalid(`${field} must be an array.`);
  return value;
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw providerInvalid(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, true) || null;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw providerInvalid(`${field} must be a finite number.`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireFiniteNumber(value, field);
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const number = requireFiniteNumber(value, field);
  if (number < 0) throw providerInvalid(`${field} must not be negative.`);
  return number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw providerInvalid(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw providerInvalid(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw providerInvalid(`${field} must be a boolean.`);
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const date = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw providerInvalid(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw providerInvalid(`${field} must be a valid calendar date.`);
  }
  return date;
}

function parseRfc3339(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DataRuntimeError("invalid-request", `${field} must be a valid RFC3339 timestamp.`);
  }
  return parsed;
}

function parseProviderRfc3339(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw providerInvalid(`${field} must be a valid RFC3339 timestamp.`);
  }
}

function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof DataRuntimeError &&
    ["credential-invalid", "credential-missing", "provider-auth-blocked"].includes(error.code)
  );
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The OpenAQ response could not be retrieved, parsed, or validated.",
  );
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

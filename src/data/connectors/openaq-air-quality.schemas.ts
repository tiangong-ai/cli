import type { JsonSchema } from "../contracts.js";

const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const POSITIVE_ID_ARRAY = {
  type: "array",
  minItems: 1,
  maxItems: 25,
  uniqueItems: true,
  items: { type: "integer", minimum: 1 },
} as const;

const OUTPUT_ID_ARRAY = {
  ...POSITIVE_ID_ARRAY,
  minItems: 0,
} as const;

const CENTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latitude", "longitude", "radiusMeters"],
  description:
    "One WGS84 center and radius search. Do not combine it with boundingBox; OpenAQ limits the radius to 25 km.",
  examples: [{ latitude: 52.37, longitude: 4.9, radiusMeters: 5000 }],
  properties: {
    latitude: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Center latitude in WGS84 decimal degrees.",
      examples: [52.37],
    },
    longitude: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Center longitude in WGS84 decimal degrees.",
      examples: [4.9],
    },
    radiusMeters: {
      type: "integer",
      minimum: 1,
      maximum: 25000,
      description: "Search radius in meters, capped by OpenAQ at 25,000.",
      examples: [5000],
    },
  },
} as const;

const BOUNDING_BOX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["west", "south", "east", "north"],
  description:
    "One non-antimeridian WGS84 bounding box. Do not combine it with center; the CLI rejects world-scale scans.",
  examples: [{ west: 4.7, south: 52.25, east: 5.05, north: 52.5 }],
  properties: {
    west: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Western longitude; it must be lower than east.",
      examples: [4.7],
    },
    south: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Southern latitude; it must be lower than north.",
      examples: [52.25],
    },
    east: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Eastern longitude; it must be greater than west.",
      examples: [5.05],
    },
    north: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Northern latitude; it must be greater than south.",
      examples: [52.5],
    },
  },
} as const;

export const OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/openaq/location-search-input.v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    countryCode: {
      type: "string",
      pattern: "^[A-Z]{2}$",
      description: "One ISO 3166-1 alpha-2 country code used to narrow locations.",
      examples: ["NL"],
    },
    countryIds: {
      ...POSITIVE_ID_ARRAY,
      description: "One or more OpenAQ country IDs, normalized into ascending order.",
      examples: [[7]],
    },
    providerIds: {
      ...POSITIVE_ID_ARRAY,
      description: "One or more OpenAQ data-provider IDs, normalized into ascending order.",
      examples: [[51, 52]],
    },
    parameterIds: {
      ...POSITIVE_ID_ARRAY,
      description: "One or more OpenAQ pollutant or parameter IDs measured at the location.",
      examples: [[1, 2]],
    },
    licenseIds: {
      ...POSITIVE_ID_ARRAY,
      description: "One or more OpenAQ license IDs used to filter location data terms.",
      examples: [[81]],
    },
    monitor: {
      type: "boolean",
      description: "Filter by OpenAQ's reference-monitor classification.",
      examples: [true],
    },
    mobile: {
      type: "boolean",
      description: "Filter mobile or stationary OpenAQ locations.",
      examples: [false],
    },
    center: CENTER_SCHEMA,
    boundingBox: BOUNDING_BOX_SCHEMA,
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description:
        "Provider records requested per page; runtime page and record limits still bound the operation.",
      examples: [250],
    },
    sortOrder: {
      enum: ["asc", "desc"],
      description: "Stable OpenAQ location-ID sort direction; defaults to ascending.",
      examples: ["asc"],
    },
  },
} as const satisfies JsonSchema;

export const OPENAQ_MEASUREMENT_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/openaq/sensor-measurements-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["sensorId", "granularity", "startDateTime", "endDateTime"],
  properties: {
    sensorId: {
      type: "integer",
      minimum: 1,
      description:
        "One OpenAQ sensor ID obtained from search-locations or another trusted OpenAQ metadata lookup.",
      examples: [1001],
    },
    granularity: {
      enum: ["raw", "hourly", "daily"],
      description:
        "raw returns upstream-reported measurements; hourly and daily use OpenAQ's preferred precomputed aggregates.",
      examples: ["hourly"],
    },
    startDateTime: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description:
        "Inclusive RFC3339 lower time bound. Together with endDateTime, the window may not exceed 366 days.",
      examples: ["2026-03-01T00:00:00Z"],
    },
    endDateTime: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description: "Inclusive RFC3339 upper time bound. It must not precede startDateTime.",
      examples: ["2026-03-07T23:59:59Z"],
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description:
        "Provider records requested per page; runtime page and record limits still bound the operation.",
      examples: [1000],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const NULLABLE_NUMBER = { anyOf: [{ type: "number" }, { type: "null" }] } as const;
const ENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
  },
} as const;
const PARAMETER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "units", "displayName"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
    units: { type: "string", minLength: 1 },
    displayName: NULLABLE_STRING,
  },
} as const;
const COORDINATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latitude", "longitude"],
  properties: {
    latitude: {
      anyOf: [{ type: "number", minimum: -90, maximum: 90 }, { type: "null" }],
    },
    longitude: {
      anyOf: [{ type: "number", minimum: -180, maximum: 180 }, { type: "null" }],
    },
  },
} as const;
const PROVIDER_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "website", "found"],
  properties: {
    name: { const: "openaq-api" },
    website: { type: "string" },
    found: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "string" }, { type: "null" }],
    },
  },
} as const;
const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pageNumber", "inputRecords", "emittedRecords"],
  properties: {
    pageNumber: { type: "integer", minimum: 1 },
    inputRecords: { type: "integer", minimum: 0 },
    emittedRecords: { type: "integer", minimum: 0 },
  },
} as const;
const STOP_REASON_SCHEMA = {
  enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
} as const;
const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "service", "apiVersion", "sourceSpecificTerms"],
  properties: {
    providerId: { const: "openaq" },
    service: { const: "OpenAQ API" },
    apiVersion: { const: "v3" },
    sourceSpecificTerms: { const: true },
  },
} as const;

const LOCATION_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordIndex",
    "sourcePageNumber",
    "locationId",
    "name",
    "locality",
    "timezone",
    "country",
    "owner",
    "provider",
    "isMobile",
    "isMonitor",
    "coordinates",
    "bounds",
    "distanceMeters",
    "datetimeFirstUtc",
    "datetimeLastUtc",
    "instruments",
    "sensors",
    "licenses",
  ],
  properties: {
    recordIndex: { type: "integer", minimum: 0 },
    sourcePageNumber: { type: "integer", minimum: 1 },
    locationId: { type: "integer", minimum: 1 },
    name: NULLABLE_STRING,
    locality: NULLABLE_STRING,
    timezone: { type: "string", minLength: 1 },
    country: {
      type: "object",
      additionalProperties: false,
      required: ["id", "code", "name"],
      properties: {
        id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        code: { type: "string", minLength: 2 },
        name: { type: "string", minLength: 1 },
      },
    },
    owner: ENTITY_SCHEMA,
    provider: ENTITY_SCHEMA,
    isMobile: { type: "boolean" },
    isMonitor: { type: "boolean" },
    coordinates: { anyOf: [COORDINATES_SCHEMA, { type: "null" }] },
    bounds: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "number" },
    },
    distanceMeters: NULLABLE_NUMBER,
    datetimeFirstUtc: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    datetimeLastUtc: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    instruments: { type: "array", items: ENTITY_SCHEMA },
    sensors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "parameter"],
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1 },
          parameter: PARAMETER_SCHEMA,
        },
      },
    },
    licenses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "attributionName", "attributionUrl", "dateFrom", "dateTo"],
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1 },
          attributionName: { type: "string", minLength: 1 },
          attributionUrl: NULLABLE_STRING,
          dateFrom: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
          dateTo: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
        },
      },
    },
  },
} as const;

export const OPENAQ_LOCATION_SEARCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/openaq/location-search-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "provider", "pages", "records", "stopReason"],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "countryCode",
        "countryIds",
        "providerIds",
        "parameterIds",
        "licenseIds",
        "monitor",
        "mobile",
        "center",
        "boundingBox",
        "pageSize",
        "sortOrder",
      ],
      properties: {
        countryCode: NULLABLE_STRING,
        countryIds: OUTPUT_ID_ARRAY,
        providerIds: OUTPUT_ID_ARRAY,
        parameterIds: OUTPUT_ID_ARRAY,
        licenseIds: OUTPUT_ID_ARRAY,
        monitor: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        mobile: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        center: { anyOf: [CENTER_SCHEMA, { type: "null" }] },
        boundingBox: { anyOf: [BOUNDING_BOX_SCHEMA, { type: "null" }] },
        pageSize: { type: "integer", minimum: 1, maximum: 1000 },
        sortOrder: { enum: ["asc", "desc"] },
      },
    },
    provider: PROVIDER_META_SCHEMA,
    pages: { type: "array", maxItems: 10, items: PAGE_SCHEMA },
    records: { type: "array", maxItems: 10000, items: LOCATION_RECORD_SCHEMA },
    stopReason: STOP_REASON_SCHEMA,
  },
} as const satisfies JsonSchema;

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["min", "q02", "q25", "median", "q75", "q98", "max", "average", "standardDeviation"],
  properties: {
    min: NULLABLE_NUMBER,
    q02: NULLABLE_NUMBER,
    q25: NULLABLE_NUMBER,
    median: NULLABLE_NUMBER,
    q75: NULLABLE_NUMBER,
    q98: NULLABLE_NUMBER,
    max: NULLABLE_NUMBER,
    average: NULLABLE_NUMBER,
    standardDeviation: NULLABLE_NUMBER,
  },
} as const;
const MEASUREMENT_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordIndex",
    "sourcePageNumber",
    "sensorId",
    "granularity",
    "value",
    "flagInfo",
    "parameter",
    "period",
    "coordinates",
    "summary",
    "coverage",
  ],
  properties: {
    recordIndex: { type: "integer", minimum: 0 },
    sourcePageNumber: { type: "integer", minimum: 1 },
    sensorId: { type: "integer", minimum: 1 },
    granularity: { enum: ["raw", "hourly", "daily"] },
    value: NULLABLE_NUMBER,
    flagInfo: {
      type: "object",
      additionalProperties: false,
      required: ["hasFlags"],
      properties: { hasFlags: { type: "boolean" } },
    },
    parameter: PARAMETER_SCHEMA,
    period: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["label", "interval", "datetimeFromUtc", "datetimeToUtc"],
          properties: {
            label: { type: "string", minLength: 1 },
            interval: { type: "string", minLength: 1 },
            datetimeFromUtc: {
              anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
            },
            datetimeToUtc: {
              anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
            },
          },
        },
        { type: "null" },
      ],
    },
    coordinates: { anyOf: [COORDINATES_SCHEMA, { type: "null" }] },
    summary: { anyOf: [SUMMARY_SCHEMA, { type: "null" }] },
    coverage: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "expectedCount",
            "expectedInterval",
            "observedCount",
            "observedInterval",
            "percentComplete",
            "percentCoverage",
            "datetimeFromUtc",
            "datetimeToUtc",
          ],
          properties: {
            expectedCount: { type: "integer", minimum: 0 },
            expectedInterval: { type: "string", minLength: 1 },
            observedCount: { type: "integer", minimum: 0 },
            observedInterval: { type: "string", minLength: 1 },
            percentComplete: { type: "number" },
            percentCoverage: { type: "number" },
            datetimeFromUtc: {
              anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
            },
            datetimeToUtc: {
              anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
            },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

export const OPENAQ_MEASUREMENT_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/openaq/sensor-measurements-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "provider", "pages", "records", "stopReason"],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: ["sensorId", "granularity", "startDateTime", "endDateTime", "pageSize"],
      properties: {
        sensorId: { type: "integer", minimum: 1 },
        granularity: { enum: ["raw", "hourly", "daily"] },
        startDateTime: { type: "string", pattern: RFC3339_PATTERN },
        endDateTime: { type: "string", pattern: RFC3339_PATTERN },
        pageSize: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
    provider: PROVIDER_META_SCHEMA,
    pages: { type: "array", maxItems: 10, items: PAGE_SCHEMA },
    records: { type: "array", maxItems: 10000, items: MEASUREMENT_RECORD_SCHEMA },
    stopReason: STOP_REASON_SCHEMA,
  },
} as const satisfies JsonSchema;

import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const UTC_MINUTE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z$";

export const OPEN_METEO_AIR_QUALITY_VARIABLES = [
  "aerosol_optical_depth",
  "alder_pollen",
  "ammonia",
  "birch_pollen",
  "carbon_dioxide",
  "carbon_monoxide",
  "dust",
  "european_aqi",
  "european_aqi_nitrogen_dioxide",
  "european_aqi_ozone",
  "european_aqi_pm10",
  "european_aqi_pm2_5",
  "european_aqi_sulphur_dioxide",
  "grass_pollen",
  "methane",
  "mugwort_pollen",
  "nitrogen_dioxide",
  "olive_pollen",
  "ozone",
  "pm10",
  "pm2_5",
  "ragweed_pollen",
  "sulphur_dioxide",
  "us_aqi",
  "us_aqi_carbon_monoxide",
  "us_aqi_nitrogen_dioxide",
  "us_aqi_ozone",
  "us_aqi_pm10",
  "us_aqi_pm2_5",
  "us_aqi_sulphur_dioxide",
  "uv_index",
  "uv_index_clear_sky",
] as const;

const LOCATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latitude", "longitude"],
  description:
    "One WGS84 coordinate whose containing or selected model grid cell will be returned.",
  examples: [{ latitude: 52.52, longitude: 13.41 }],
  properties: {
    latitude: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Requested WGS84 latitude in decimal degrees.",
      examples: [52.52],
    },
    longitude: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Requested WGS84 longitude in decimal degrees.",
      examples: [13.41],
    },
  },
} as const;

const VARIABLES_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 16,
  uniqueItems: true,
  description:
    "Open-Meteo hourly air-quality, pollen, UV, or AQI variable codes. Returned variables are sorted for a stable request contract.",
  examples: [["pm10", "pm2_5"]],
  items: {
    enum: OPEN_METEO_AIR_QUALITY_VARIABLES,
    description: "One variable code documented by the Open-Meteo Air Quality API.",
    examples: ["pm2_5"],
  },
} as const;

export const OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/air-quality-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["locations", "startDate", "endDate", "hourlyVariables"],
  properties: {
    locations: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        "One to ten coordinates. The result preserves this order even though variables are normalized separately.",
      examples: [[{ latitude: 52.52, longitude: 13.41 }]],
      items: LOCATION_SCHEMA,
    },
    startDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive first model date in YYYY-MM-DD form. Together with endDate, the window may contain at most 92 dates.",
      examples: ["2026-03-17"],
    },
    endDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description: "Inclusive last model date in YYYY-MM-DD form. It must not precede startDate.",
      examples: ["2026-03-18"],
    },
    hourlyVariables: VARIABLES_SCHEMA,
    domain: {
      enum: ["auto", "cams_europe", "cams_global"],
      description:
        "Open-Meteo model-domain selection. auto is the provider-recommended default; Europe and global may differ in coverage and resolution.",
      examples: ["auto"],
    },
    cellSelection: {
      enum: ["nearest", "land", "sea"],
      description:
        "Grid-cell preference around each coordinate. nearest is the provider default; land or sea can avoid an unsuitable adjacent cell.",
      examples: ["nearest"],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_NUMBER = { type: ["number", "null"] } as const;

export const OPEN_METEO_AIR_QUALITY_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/air-quality-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "validation", "locations", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "service", "endpoint", "modeled", "timezone"],
      properties: {
        providerId: { const: "open-meteo" },
        service: { const: "Air Quality API" },
        endpoint: { const: "/v1/air-quality" },
        modeled: { const: true },
        timezone: { const: "GMT" },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: [
        "locations",
        "startDate",
        "endDate",
        "hourlyVariables",
        "domain",
        "cellSelection",
        "timezone",
      ],
      properties: {
        locations: OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA.properties.locations,
        startDate: OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA.properties.startDate,
        endDate: OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA.properties.endDate,
        hourlyVariables: VARIABLES_SCHEMA,
        domain: { enum: ["auto", "cams_europe", "cams_global"] },
        cellSelection: { enum: ["nearest", "land", "sea"] },
        timezone: { const: "GMT" },
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["issueCount", "issues"],
      properties: {
        issueCount: { type: "integer", minimum: 0 },
        issues: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "path", "message"],
            properties: {
              code: {
                enum: [
                  "response-count-mismatch",
                  "coordinate-response-invalid",
                  "provider-error",
                  "grid-location-missing",
                  "section-missing",
                  "timezone-missing",
                  "timezone-invalid",
                  "utc-offset-missing",
                  "utc-offset-invalid",
                  "time-axis-length-mismatch",
                  "time-axis-invalid",
                  "series-missing",
                  "series-length-mismatch",
                  "series-unit-missing",
                  "series-value-invalid",
                  "series-all-null",
                ],
              },
              path: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    locations: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "requestedLocationIndex",
          "requestedLocation",
          "gridLocation",
          "elevation",
          "timezone",
          "timezoneAbbreviation",
          "utcOffsetSeconds",
          "timesUtc",
          "variables",
        ],
        properties: {
          requestedLocationIndex: { type: "integer", minimum: 0, maximum: 9 },
          requestedLocation: LOCATION_SCHEMA,
          gridLocation: LOCATION_SCHEMA,
          elevation: NULLABLE_NUMBER,
          timezone: { type: "string", minLength: 1 },
          timezoneAbbreviation: { type: "string", minLength: 1 },
          utcOffsetSeconds: { type: "integer" },
          timesUtc: {
            type: "array",
            items: { type: "string", pattern: UTC_MINUTE_PATTERN },
          },
          variables: {
            type: "array",
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["variable", "unit", "values"],
              properties: {
                variable: { enum: OPEN_METEO_AIR_QUALITY_VARIABLES },
                unit: { type: "string", minLength: 1 },
                values: { type: "array", items: NULLABLE_NUMBER },
              },
            },
          },
        },
      },
    },
    stopReason: { enum: ["completed", "max-records", "partial"] },
  },
} as const satisfies JsonSchema;

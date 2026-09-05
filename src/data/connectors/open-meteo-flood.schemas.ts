import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

export const OPEN_METEO_FLOOD_VARIABLES = [
  "river_discharge",
  "river_discharge_max",
  "river_discharge_mean",
  "river_discharge_median",
  "river_discharge_min",
  "river_discharge_p25",
  "river_discharge_p75",
] as const;

const LOCATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latitude", "longitude"],
  description:
    "One WGS84 coordinate used to select the largest represented river in the nearby model grid.",
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
  maxItems: 7,
  uniqueItems: true,
  description:
    "Open-Meteo daily river-discharge variable codes. Ensemble statistics are forecast-only and may be absent for consolidated historical data.",
  examples: [["river_discharge", "river_discharge_p75"]],
  items: {
    enum: OPEN_METEO_FLOOD_VARIABLES,
    description: "One documented Open-Meteo Flood daily variable code.",
    examples: ["river_discharge"],
  },
} as const;

export const OPEN_METEO_FLOOD_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/flood-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["locations", "startDate", "endDate", "dailyVariables"],
  properties: {
    locations: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        "One to ten coordinates. The result preserves this request order and reports the selected river-grid coordinate separately.",
      examples: [[{ latitude: 52.52, longitude: 13.41 }]],
      items: LOCATION_SCHEMA,
    },
    startDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive first date in YYYY-MM-DD form. Together with endDate, the window may contain at most 366 dates.",
      examples: ["2026-03-01"],
    },
    endDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description: "Inclusive last date in YYYY-MM-DD form. It must not precede startDate.",
      examples: ["2026-03-03"],
    },
    dailyVariables: VARIABLES_SCHEMA,
    includeEnsembleMembers: {
      type: "boolean",
      description:
        "Request provider river_discharge_memberNN forecast series. This requires river_discharge in dailyVariables and can materially increase response size.",
      examples: [false],
    },
    cellSelection: {
      enum: ["nearest", "land", "sea"],
      description:
        "Grid-cell preference around each coordinate. nearest preserves the prior Skill default; land or sea can force a surface preference.",
      examples: ["nearest"],
    },
  },
  allOf: [
    {
      if: {
        required: ["includeEnsembleMembers"],
        properties: { includeEnsembleMembers: { const: true } },
      },
      then: {
        properties: {
          dailyVariables: { type: "array", contains: { const: "river_discharge" } },
        },
      },
    },
  ],
} as const satisfies JsonSchema;

const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const SERIES_VALUES = { type: "array", items: NULLABLE_NUMBER } as const;

export const OPEN_METEO_FLOOD_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/flood-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "validation", "locations", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "service", "endpoint", "model", "simulated", "timezone"],
      properties: {
        providerId: { const: "open-meteo" },
        service: { const: "Flood API" },
        endpoint: { const: "/v1/flood" },
        model: { const: "GloFAS v4 Seamless" },
        simulated: { const: true },
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
        "dailyVariables",
        "includeEnsembleMembers",
        "cellSelection",
        "timezone",
      ],
      properties: {
        locations: OPEN_METEO_FLOOD_INPUT_SCHEMA.properties.locations,
        startDate: OPEN_METEO_FLOOD_INPUT_SCHEMA.properties.startDate,
        endDate: OPEN_METEO_FLOOD_INPUT_SCHEMA.properties.endDate,
        dailyVariables: VARIABLES_SCHEMA,
        includeEnsembleMembers: { type: "boolean" },
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
          "riverGridLocation",
          "elevation",
          "timezone",
          "timezoneAbbreviation",
          "utcOffsetSeconds",
          "dates",
          "variables",
          "ensembleMembers",
        ],
        properties: {
          requestedLocationIndex: { type: "integer", minimum: 0, maximum: 9 },
          requestedLocation: LOCATION_SCHEMA,
          riverGridLocation: LOCATION_SCHEMA,
          elevation: NULLABLE_NUMBER,
          timezone: { type: "string", minLength: 1 },
          timezoneAbbreviation: { type: "string", minLength: 1 },
          utcOffsetSeconds: { type: "integer" },
          dates: { type: "array", items: { type: "string", pattern: DATE_PATTERN } },
          variables: {
            type: "array",
            maxItems: 7,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["variable", "unit", "values"],
              properties: {
                variable: { enum: OPEN_METEO_FLOOD_VARIABLES },
                unit: { type: "string", minLength: 1 },
                values: SERIES_VALUES,
              },
            },
          },
          ensembleMembers: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["member", "sourceField", "unit", "values"],
              properties: {
                member: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                sourceField: { type: "string", pattern: "^river_discharge_member\\d+$" },
                unit: { type: "string", minLength: 1 },
                values: SERIES_VALUES,
              },
            },
          },
        },
      },
    },
    stopReason: { enum: ["completed", "max-records", "partial"] },
  },
} as const satisfies JsonSchema;

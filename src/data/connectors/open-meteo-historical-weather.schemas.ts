import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const HOURLY_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$";

export const OPEN_METEO_HISTORICAL_HOURLY_VARIABLES = [
  "cloud_cover",
  "precipitation",
  "pressure_msl",
  "rain",
  "relative_humidity_2m",
  "shortwave_radiation",
  "snowfall",
  "soil_moisture_0_to_7cm",
  "soil_temperature_0_to_7cm",
  "temperature_2m",
  "wind_direction_10m",
  "wind_speed_10m",
] as const;

export const OPEN_METEO_HISTORICAL_DAILY_VARIABLES = [
  "apparent_temperature_max",
  "apparent_temperature_min",
  "et0_fao_evapotranspiration",
  "precipitation_hours",
  "precipitation_sum",
  "rain_sum",
  "snowfall_sum",
  "sunshine_duration",
  "temperature_2m_max",
  "temperature_2m_min",
  "weather_code",
  "wind_speed_10m_max",
] as const;

export const OPEN_METEO_HISTORICAL_MODELS = [
  "best_match",
  "cerra",
  "ecmwf_ifs",
  "ecmwf_ifs_analysis_long_window",
  "era5",
  "era5_ensemble",
  "era5_land",
  "era5_seamless",
] as const;

const LOCATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latitude", "longitude"],
  description: "One WGS84 coordinate for historical weather reanalysis grid selection.",
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

const HOURLY_VARIABLES_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  uniqueItems: true,
  description:
    "Zero to twelve curated Open-Meteo hourly historical-weather variable codes. Use an empty array for daily-only retrieval.",
  examples: [["temperature_2m", "precipitation"]],
  items: {
    enum: OPEN_METEO_HISTORICAL_HOURLY_VARIABLES,
    description: "One documented hourly historical-weather variable code.",
    examples: ["temperature_2m"],
  },
} as const;

const DAILY_VARIABLES_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  uniqueItems: true,
  description:
    "Zero to twelve curated numeric Open-Meteo daily historical-weather variable codes. Use an empty array for hourly-only retrieval.",
  examples: [["temperature_2m_max", "precipitation_sum"]],
  items: {
    enum: OPEN_METEO_HISTORICAL_DAILY_VARIABLES,
    description: "One documented numeric daily historical-weather variable code.",
    examples: ["temperature_2m_max"],
  },
} as const;

export const OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/historical-weather-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["locations", "startDate", "endDate", "hourlyVariables", "dailyVariables"],
  properties: {
    locations: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        "One to ten coordinates. Results preserve request order and separately report the selected model-grid coordinate.",
      examples: [[{ latitude: 52.52, longitude: 13.41 }]],
      items: LOCATION_SCHEMA,
    },
    startDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive first historical date in YYYY-MM-DD form. Together with endDate, the window may contain at most 366 dates.",
      examples: ["2024-01-01"],
    },
    endDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive last historical date in YYYY-MM-DD form; it must not precede startDate.",
      examples: ["2024-01-31"],
    },
    hourlyVariables: { ...HOURLY_VARIABLES_SCHEMA, minItems: 0 },
    dailyVariables: { ...DAILY_VARIABLES_SCHEMA, minItems: 0 },
    model: {
      enum: OPEN_METEO_HISTORICAL_MODELS,
      description:
        "One provider model. best_match favors current local detail; use ERA5 or ERA5-Land for a consistent multi-decade series.",
      examples: ["era5"],
    },
    cellSelection: {
      enum: ["land", "nearest", "sea"],
      description:
        "Grid-cell preference around each coordinate. land is the deterministic default; nearest or sea may select a different grid cell.",
      examples: ["land"],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const SERIES_VALUES = { type: "array", items: NULLABLE_NUMBER } as const;

const VALIDATION_SCHEMA = {
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
} as const;

const HOURLY_SECTION_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["timesUtc", "variables"],
  properties: {
    timesUtc: { type: "array", items: { type: "string", pattern: HOURLY_TIME_PATTERN } },
    variables: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["variable", "unit", "values"],
        properties: {
          variable: { enum: OPEN_METEO_HISTORICAL_HOURLY_VARIABLES },
          unit: { type: "string", minLength: 1 },
          values: SERIES_VALUES,
        },
      },
    },
  },
} as const;

const DAILY_SECTION_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["dates", "variables"],
  properties: {
    dates: { type: "array", items: { type: "string", pattern: DATE_PATTERN } },
    variables: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["variable", "unit", "values"],
        properties: {
          variable: { enum: OPEN_METEO_HISTORICAL_DAILY_VARIABLES },
          unit: { type: "string", minLength: 1 },
          values: SERIES_VALUES,
        },
      },
    },
  },
} as const;

export const OPEN_METEO_HISTORICAL_WEATHER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/open-meteo/historical-weather-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "validation", "locations", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "service", "endpoint", "model", "reanalysis", "timezone"],
      properties: {
        providerId: { const: "open-meteo" },
        service: { const: "Historical Weather API" },
        endpoint: { const: "/v1/archive" },
        model: { enum: OPEN_METEO_HISTORICAL_MODELS },
        reanalysis: { const: true },
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
        "dailyVariables",
        "model",
        "cellSelection",
        "timezone",
        "temperatureUnit",
        "windSpeedUnit",
        "precipitationUnit",
      ],
      properties: {
        locations: OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA.properties.locations,
        startDate: OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA.properties.startDate,
        endDate: OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA.properties.endDate,
        hourlyVariables: { ...HOURLY_VARIABLES_SCHEMA, minItems: 0 },
        dailyVariables: { ...DAILY_VARIABLES_SCHEMA, minItems: 0 },
        model: { enum: OPEN_METEO_HISTORICAL_MODELS },
        cellSelection: { enum: ["land", "nearest", "sea"] },
        timezone: { const: "GMT" },
        temperatureUnit: { const: "celsius" },
        windSpeedUnit: { const: "kmh" },
        precipitationUnit: { const: "mm" },
      },
    },
    validation: VALIDATION_SCHEMA,
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
          "hourly",
          "daily",
        ],
        properties: {
          requestedLocationIndex: { type: "integer", minimum: 0, maximum: 9 },
          requestedLocation: LOCATION_SCHEMA,
          gridLocation: LOCATION_SCHEMA,
          elevation: NULLABLE_NUMBER,
          timezone: { type: "string", minLength: 1 },
          timezoneAbbreviation: { type: "string", minLength: 1 },
          utcOffsetSeconds: { type: "integer" },
          hourly: HOURLY_SECTION_SCHEMA,
          daily: DAILY_SECTION_SCHEMA,
        },
      },
    },
    stopReason: { enum: ["completed", "max-records", "partial"] },
  },
} as const satisfies JsonSchema;

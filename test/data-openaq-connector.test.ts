import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { openAqAirQualityConnector } from "../src/data/connectors/openaq-air-quality.js";
import {
  OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA,
  OPENAQ_MEASUREMENT_INPUT_SCHEMA,
} from "../src/data/connectors/openaq-air-quality.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/openaq/", import.meta.url);
const API_KEY = "openaq-test-key-that-must-not-escape";

function locationRequest(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "openaq.air-quality",
    capabilityVersion: "1.0.1",
    operationId: "search-locations",
    operationVersion: "1.0.0",
    input: {
      countryCode: "NL",
      providerIds: [52, 51],
      pageSize: 2,
      sortOrder: "asc",
      ...inputOverrides,
    },
  };
}

function measurementRequest(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "openaq.air-quality",
    capabilityVersion: "1.0.1",
    operationId: "fetch-sensor-measurements",
    operationVersion: "1.0.1",
    input: {
      sensorId: 1001,
      granularity: "hourly",
      startDateTime: "2026-03-01T00:00:00Z",
      endDateTime: "2026-03-02T00:00:00Z",
      pageSize: 2,
      ...inputOverrides,
    },
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

function jsonResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function successfulFetch(target: string | URL | Request): Promise<Response> {
  const url = new URL(String(target));
  const page = url.searchParams.get("page");
  if (url.pathname === "/v3/locations") {
    return jsonResponse(await fixture(`locations-page-${page}.json`));
  }
  if (url.pathname === "/v3/sensors/1001/hours") {
    return jsonResponse(await fixture(`measurements-page-${page}.json`));
  }
  throw new Error(`Unexpected fixture URL: ${url.pathname}${url.search}`);
}

describe("OpenAQ air-quality connector", () => {
  it("preserves anomalous provider coverage values and measurements with an explicit quality issue", async () => {
    const payload = JSON.parse(await fixture("measurements-page-1.json"));
    payload.meta.found = payload.results.length;
    payload.results[0].coverage.percentCoverage = 2400;
    const result = await executeDataRun(measurementRequest(), {
      registry: createDataRegistry([openAqAirQualityConnector]),
      environment: { OPENAQ_API_KEY: API_KEY },
      fetchImpl: (async () => jsonResponse(JSON.stringify(payload))) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, payload.results.length);
    assert.equal(result.summary.completeness, "partial");
    assert.equal(
      (result.data as { records: Array<{ coverage: { percentCoverage: number } }> }).records[0]
        ?.coverage.percentCoverage,
      2400,
    );
    assert.equal(result.errors[0]?.details?.issueCode, "coverage-percentage-out-of-range");
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["records[0].coverage.percentCoverage"] },
    ]);
  });

  it("documents every operation input field and spatial coordinate", () => {
    for (const schema of [OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA, OPENAQ_MEASUREMENT_INPUT_SCHEMA]) {
      for (const [name, field] of Object.entries(schema.properties)) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
    for (const property of ["center", "boundingBox"] as const) {
      for (const [name, field] of Object.entries(
        OPENAQ_LOCATION_SEARCH_INPUT_SCHEMA.properties[property].properties,
      )) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
  });

  it("blocks both operations before network access when the logical API key is missing", async () => {
    for (const runRequest of [locationRequest(), measurementRequest()]) {
      let fetched = false;
      const result = await executeDataRun(runRequest, {
        registry: createDataRegistry([openAqAirQualityConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "credential-missing");
      assert.equal(fetched, false);
      assert.doesNotMatch(JSON.stringify(result), /OPENAQ_API_KEY|openaq-test-key/);
    }
  });

  it("searches bounded locations, sorts filters, and preserves attribution metadata", async () => {
    const requested: string[] = [];
    const result = await executeDataRun(locationRequest({ monitor: true, mobile: false }), {
      registry: createDataRegistry([openAqAirQualityConnector]),
      environment: { OPENAQ_API_KEY: API_KEY },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        requested.push(`${url.pathname}?${url.searchParams.toString()}`);
        assert.equal(new Headers(init?.headers).get("X-API-Key"), API_KEY);
        return successfulFetch(target);
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.pageCount, 2);
    assert.deepEqual(requested, [
      "/v3/locations?iso=NL&limit=2&mobile=false&monitor=true&order_by=id&page=1&providers_id=51%2C52&sort_order=asc",
      "/v3/locations?iso=NL&limit=2&mobile=false&monitor=true&order_by=id&page=2&providers_id=51%2C52&sort_order=asc",
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    const data = result.data as {
      records: Array<Record<string, unknown>>;
      stopReason: string;
    };
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.records[0], {
      recordIndex: 0,
      sourcePageNumber: 1,
      locationId: 101,
      name: "Harbor North",
      locality: "Example City",
      timezone: "Europe/Amsterdam",
      country: { id: 7, code: "NL", name: "Netherlands" },
      owner: { id: 41, name: "Example Environment Agency" },
      provider: { id: 51, name: "Example Provider" },
      isMobile: false,
      isMonitor: true,
      coordinates: { latitude: 52.371, longitude: 4.899 },
      bounds: [4.899, 52.371, 4.899, 52.371],
      distanceMeters: 320.5,
      datetimeFirstUtc: "2020-01-01T00:00:00Z",
      datetimeLastUtc: "2026-03-07T23:00:00Z",
      instruments: [{ id: 61, name: "Reference Analyzer" }],
      sensors: [
        {
          id: 1001,
          name: "pm25 µg/m³",
          parameter: { id: 2, name: "pm25", units: "µg/m³", displayName: "PM2.5" },
        },
      ],
      licenses: [
        {
          id: 81,
          name: "Example Attribution License",
          attributionName: "Example Environment Agency",
          attributionUrl: "https://example.invalid/attribution",
          dateFrom: "2020-01-01",
          dateTo: null,
        },
      ],
    });
  });

  it("fetches paged hourly sensor measurements with coverage and summary", async () => {
    const requested: string[] = [];
    const result = await executeDataRun(measurementRequest(), {
      registry: createDataRegistry([openAqAirQualityConnector]),
      environment: { OPENAQ_API_KEY: API_KEY },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requested.push(`${url.pathname}?${url.searchParams.toString()}`);
        return successfulFetch(target);
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 3);
    assert.deepEqual(requested, [
      "/v3/sensors/1001/hours?datetime_from=2026-03-01T00%3A00%3A00Z&datetime_to=2026-03-02T00%3A00%3A00Z&limit=2&page=1",
      "/v3/sensors/1001/hours?datetime_from=2026-03-01T00%3A00%3A00Z&datetime_to=2026-03-02T00%3A00%3A00Z&limit=2&page=2",
    ]);
    const data = result.data as { records: Array<Record<string, unknown>> };
    assert.deepEqual(data.records[0], {
      recordIndex: 0,
      sourcePageNumber: 1,
      sensorId: 1001,
      granularity: "hourly",
      value: 12.5,
      flagInfo: { hasFlags: false },
      parameter: { id: 2, name: "pm25", units: "µg/m³", displayName: "PM2.5" },
      period: {
        label: "hour",
        interval: "01:00:00",
        datetimeFromUtc: "2026-03-01T00:00:00Z",
        datetimeToUtc: "2026-03-01T01:00:00Z",
      },
      coordinates: null,
      summary: {
        min: 10,
        q02: 10.1,
        q25: 11,
        median: 12,
        q75: 13,
        q98: 14.8,
        max: 15,
        average: 12.5,
        standardDeviation: 1.2,
      },
      coverage: {
        expectedCount: 12,
        expectedInterval: "01:00:00",
        observedCount: 10,
        observedInterval: "00:50:00",
        percentComplete: 83.33,
        percentCoverage: 83.33,
        datetimeFromUtc: "2026-03-01T00:00:00Z",
        datetimeToUtc: "2026-03-01T01:00:00Z",
      },
    });
  });

  it("selects the closed raw, hourly, and daily sensor routes without arbitrary paths", async () => {
    const cases = [
      {
        granularity: "raw",
        path: "/v3/sensors/1001/measurements",
        expectedBounds:
          "datetime_from=2026-03-01T00%3A00%3A00Z&datetime_to=2026-03-02T00%3A00%3A00Z",
      },
      {
        granularity: "hourly",
        path: "/v3/sensors/1001/hours",
        expectedBounds:
          "datetime_from=2026-03-01T00%3A00%3A00Z&datetime_to=2026-03-02T00%3A00%3A00Z",
      },
      {
        granularity: "daily",
        path: "/v3/sensors/1001/days",
        expectedBounds: "date_from=2026-03-01T00%3A00%3A00Z&date_to=2026-03-02T00%3A00%3A00Z",
      },
    ] as const;

    for (const item of cases) {
      let requested = "";
      const result = await executeDataRun(measurementRequest({ granularity: item.granularity }), {
        registry: createDataRegistry([openAqAirQualityConnector]),
        environment: { OPENAQ_API_KEY: API_KEY },
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requested = `${url.pathname}?${url.searchParams.toString()}`;
          return jsonResponse(
            JSON.stringify({
              meta: { name: "openaq-api", website: "/", page: 1, limit: 2, found: 0 },
              results: [],
            }),
          );
        }) as typeof fetch,
      });
      assert.equal(result.status, "success");
      assert.equal(result.summary.recordCount, 0);
      assert.equal(requested, `${item.path}?${item.expectedBounds}&limit=2&page=1`);
    }
  });

  it("preserves valid nullable measurement fields, flags, and sparse provider summaries", async () => {
    const result = await executeDataRun(measurementRequest({ granularity: "raw", pageSize: 1 }), {
      registry: createDataRegistry([openAqAirQualityConnector]),
      environment: { OPENAQ_API_KEY: API_KEY },
      fetchImpl: (async () =>
        jsonResponse(
          JSON.stringify({
            meta: { name: "openaq-api", website: "/", page: 1, limit: 1, found: 1 },
            results: [
              {
                value: null,
                flagInfo: { hasFlags: true },
                parameter: {
                  id: 2,
                  name: "pm25",
                  units: "µg/m³",
                  displayName: null,
                },
                period: null,
                coordinates: { latitude: null, longitude: null },
                summary: {},
                coverage: null,
              },
            ],
          }),
        )) as typeof fetch,
    });

    assert.equal(result.status, "success");
    const record = (result.data as { records: Array<Record<string, unknown>> }).records[0];
    assert.equal(record?.value, null);
    assert.deepEqual(record?.flagInfo, { hasFlags: true });
    assert.equal(record?.period, null);
    assert.deepEqual(record?.coordinates, { latitude: null, longitude: null });
    assert.deepEqual(record?.summary, {
      min: null,
      q02: null,
      q25: null,
      median: null,
      q75: null,
      q98: null,
      max: null,
      average: null,
      standardDeviation: null,
    });
    assert.equal(record?.coverage, null);
  });

  it("rejects unbounded, conflicting, and oversized requests before fetching", async () => {
    const requests = [
      locationRequest({ countryCode: undefined, providerIds: undefined }),
      locationRequest({
        boundingBox: { west: 4.8, south: 52.3, east: 5, north: 52.5 },
        center: { latitude: 52.37, longitude: 4.9, radiusMeters: 1000 },
      }),
      measurementRequest({
        startDateTime: "2026-03-02T00:00:00Z",
        endDateTime: "2026-03-01T00:00:00Z",
      }),
      measurementRequest({
        startDateTime: "2025-01-01T00:00:00Z",
        endDateTime: "2026-03-02T00:00:00Z",
      }),
    ];
    for (const runRequest of requests) {
      let fetched = false;
      const result = await executeDataRun(runRequest, {
        registry: createDataRegistry([openAqAirQualityConnector]),
        environment: { OPENAQ_API_KEY: API_KEY },
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    }
  });

  it("stops at a record cap before spending another API request", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      { ...locationRequest(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([openAqAirQualityConnector]),
        environment: { OPENAQ_API_KEY: API_KEY },
        fetchImpl: (async () => {
          fetchCount += 1;
          return jsonResponse(await fixture("locations-page-1.json"));
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal(fetchCount, 1);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
  });

  it("preserves earlier records when a later measurement page fails", async () => {
    const result = await executeDataRun(measurementRequest(), {
      registry: createDataRegistry([openAqAirQualityConnector]),
      environment: { OPENAQ_API_KEY: API_KEY },
      fetchImpl: (async (target) => {
        const page = new URL(String(target)).searchParams.get("page");
        return page === "1"
          ? jsonResponse(await fixture("measurements-page-1.json"))
          : jsonResponse('{"message":"temporary"}', 503);
      }) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 2);
    assert.deepEqual(result.summary.missing, [{ kind: "page", identifiers: ["2"] }]);
  });

  it("publishes attribution, quality, aggregation, and archive-download boundaries", () => {
    const discovery = createDataRegistry([openAqAirQualityConnector]).discovery(
      "openaq.air-quality",
    );
    assert.ok(discovery);
    assert.ok(discovery.license.restrictions.some((item) => /OpenAQ|attribution/i.test(item)));
    assert.ok(discovery.limitations.some((item) => /accuracy|quality|as-is/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /S3|archive|download/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /regulatory|health|AQI/i.test(item)));
    assert.ok(discovery.selectionHints.some((item) => /raw|hourly|daily/i.test(item)));
    assert.ok(discovery.selectionHints.some((item) => /flagInfo|hasFlags/i.test(item)));
  });

  it("conforms for both credentialed public operations", async () => {
    for (const runRequest of [locationRequest(), measurementRequest()]) {
      await assertDataConnectorConformance({
        connector: openAqAirQualityConnector,
        request: runRequest,
        environment: { OPENAQ_API_KEY: API_KEY },
        fetchImpl: successfulFetch as typeof fetch,
      });
    }
  });
});

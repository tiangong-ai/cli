import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { openMeteoHistoricalWeatherConnector } from "../src/data/connectors/open-meteo-historical-weather.js";
import { OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA } from "../src/data/connectors/open-meteo-historical-weather.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/open-meteo-historical/", import.meta.url);

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "open-meteo.historical-weather",
    capabilityVersion: "1.0.1",
    operationId: "fetch",
    operationVersion: "1.0.1",
    input: {
      locations: [{ latitude: 52.52, longitude: 13.41 }],
      startDate: "2024-01-01",
      endDate: "2024-01-01",
      hourlyVariables: ["temperature_2m", "precipitation"],
      dailyVariables: ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"],
      ...inputOverrides,
    },
  };
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("weather.json", FIXTURE_ROOT), "utf8")) as Record<
    string,
    unknown
  >;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

describe("Open-Meteo historical weather connector", () => {
  it("documents every input field and coordinate for agent request construction", () => {
    for (const [name, schema] of Object.entries(
      OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      OPEN_METEO_HISTORICAL_WEATHER_INPUT_SCHEMA.properties.locations.items.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("uses the public GMT archive endpoint and normalizes aligned hourly and daily reanalysis", async () => {
    let requestedUrl = "";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: { OPEN_METEO_API_KEY: "must-not-be-read" },
      fetchImpl: (async (target) => {
        requestedUrl = String(target);
        return jsonResponse(await fixture());
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 25);
    const url = new URL(requestedUrl);
    assert.equal(url.origin, "https://archive-api.open-meteo.com");
    assert.equal(url.pathname, "/v1/archive");
    assert.equal(url.searchParams.get("latitude"), "52.52");
    assert.equal(url.searchParams.get("longitude"), "13.41");
    assert.equal(url.searchParams.get("start_date"), "2024-01-01");
    assert.equal(url.searchParams.get("end_date"), "2024-01-01");
    assert.equal(url.searchParams.get("hourly"), "precipitation,temperature_2m");
    assert.equal(
      url.searchParams.get("daily"),
      "precipitation_sum,temperature_2m_max,temperature_2m_min",
    );
    assert.equal(url.searchParams.get("models"), "best_match");
    assert.equal(url.searchParams.get("timezone"), "GMT");
    assert.equal(url.searchParams.get("timeformat"), "iso8601");
    assert.equal(url.searchParams.get("temperature_unit"), "celsius");
    assert.equal(url.searchParams.get("wind_speed_unit"), "kmh");
    assert.equal(url.searchParams.get("precipitation_unit"), "mm");
    assert.equal(url.searchParams.get("cell_selection"), "land");
    assert.equal(url.searchParams.has("apikey"), false);

    assert.deepEqual((result.data as { locations: unknown[] }).locations, [
      {
        requestedLocationIndex: 0,
        requestedLocation: { latitude: 52.52, longitude: 13.41 },
        gridLocation: { latitude: 52.52, longitude: 13.419998 },
        elevation: 38,
        timezone: "GMT",
        timezoneAbbreviation: "GMT",
        utcOffsetSeconds: 0,
        hourly: {
          timesUtc: ((await fixture().then((item) => item.hourly)) as { time: string[] }).time,
          variables: [
            {
              variable: "precipitation",
              unit: "mm",
              values: (
                (await fixture().then((item) => item.hourly)) as {
                  precipitation: number[];
                }
              ).precipitation,
            },
            {
              variable: "temperature_2m",
              unit: "°C",
              values: (
                (await fixture().then((item) => item.hourly)) as {
                  temperature_2m: number[];
                }
              ).temperature_2m,
            },
          ],
        },
        daily: {
          dates: ["2024-01-01"],
          variables: [
            { variable: "precipitation_sum", unit: "mm", values: [0.4] },
            { variable: "temperature_2m_max", unit: "°C", values: [4.1] },
            { variable: "temperature_2m_min", unit: "°C", values: [-2.1] },
          ],
        },
      },
    ]);
  });

  it("preserves coordinate order and sends one controlled model and cell selection", async () => {
    const first = await fixture();
    const second = structuredClone(first);
    second.latitude = 48.85;
    second.longitude = 2.4;
    let requestedUrl = "";
    const result = await executeDataRun(
      request({
        locations: [
          { latitude: 52.52, longitude: 13.41 },
          { latitude: 48.85, longitude: 2.35 },
        ],
        model: "era5",
        cellSelection: "nearest",
      }),
      {
        registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requestedUrl = String(target);
          return jsonResponse([first, second]);
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 50);
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("latitude"), "52.52,48.85");
    assert.equal(url.searchParams.get("longitude"), "13.41,2.35");
    assert.equal(url.searchParams.get("models"), "era5");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
    assert.deepEqual(
      (result.data as { locations: Array<{ requestedLocationIndex: number }> }).locations.map(
        (location) => location.requestedLocationIndex,
      ),
      [0, 1],
    );
  });

  it("rejects inverted, invalid, or oversized date windows before fetch", async () => {
    for (const input of [
      { startDate: "2024-01-02", endDate: "2024-01-01" },
      { startDate: "2024-02-30", endDate: "2024-03-01" },
      { startDate: "2023-01-01", endDate: "2024-01-02" },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(input), {
        registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
        environment: {},
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

  it("preserves a valid daily section and marks a missing hourly variable as partial", async () => {
    const payload = await fixture();
    delete (payload.hourly as Record<string, unknown>).precipitation;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 25);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.precipitation"] },
    ]);
    assert.deepEqual(
      (result.data as { validation: { issues: Array<{ code: string }> } }).validation.issues.map(
        (issue) => issue.code,
      ),
      ["series-missing"],
    );
    const location = (
      result.data as {
        locations: Array<{
          hourly: { variables: Array<{ variable: string }> };
          daily: { variables: Array<{ variable: string }> };
        }>;
      }
    ).locations[0];
    assert.deepEqual(
      location?.hourly.variables.map((variable) => variable.variable),
      ["temperature_2m"],
    );
    assert.equal(location?.daily.variables.length, 3);
  });

  it("marks requested series with no usable numeric values as partial", async () => {
    const payload = await fixture();
    (payload.hourly as Record<string, unknown>).precipitation = Array.from(
      { length: 24 },
      () => null,
    );
    (payload.daily as Record<string, unknown>).precipitation_sum = [null];
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.completeness, "partial");
    assert.deepEqual(result.summary.missing, [
      {
        kind: "field",
        identifiers: ["$[0].hourly.precipitation", "$[0].daily.precipitation_sum"],
      },
    ]);
    assert.deepEqual(
      (result.data as { validation: { issues: Array<{ code: string }> } }).validation.issues.map(
        (issue) => issue.code,
      ),
      ["series-all-null", "series-all-null"],
    );
    const location = (
      result.data as {
        locations: Array<{
          hourly: { variables: Array<{ variable: string; values: Array<number | null> }> };
          daily: { variables: Array<{ variable: string; values: Array<number | null> }> };
        }>;
      }
    ).locations[0];
    assert.ok(
      location?.hourly.variables
        .find((variable) => variable.variable === "precipitation")
        ?.values.every((value) => value === null),
    );
    assert.deepEqual(
      location?.daily.variables.find((variable) => variable.variable === "precipitation_sum")
        ?.values,
      [null],
    );
  });

  it("marks an incomplete GMT hourly axis as partial while preserving daily data", async () => {
    const payload = await fixture();
    const hourly = payload.hourly as Record<string, unknown[]>;
    for (const field of ["time", "temperature_2m", "precipitation"]) hourly[field]?.pop();
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 24);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.time"] },
    ]);
    assert.deepEqual(
      (
        result.data as {
          locations: Array<{ hourly: { timesUtc: string[] }; daily: { dates: string[] } }>;
        }
      ).locations[0]?.daily.dates,
      ["2024-01-01"],
    );
  });

  it("reports provider timezone drift instead of silently treating it as GMT", async () => {
    const payload = await fixture();
    payload.timezone = "Europe/Berlin";
    payload.utc_offset_seconds = 3600;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(result.summary.missing, [
      {
        kind: "field",
        identifiers: ["$[0].timezone", "$[0].utc_offset_seconds"],
      },
    ]);
  });

  it("rejects a normalized-but-impossible provider timestamp without discarding daily data", async () => {
    const payload = await fixture();
    (payload.hourly as { time: string[] }).time[23] = "2024-01-01T24:00";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.time[23]"] },
    ]);
    const location = (
      result.data as {
        locations: Array<{ hourly: null; daily: { dates: string[] } }>;
      }
    ).locations[0];
    assert.equal(location?.hourly, null);
    assert.deepEqual(location?.daily.dates, ["2024-01-01"]);
  });

  it("blocks explicit provider error objects", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
      environment: {},
      fetchImpl: (async () =>
        jsonResponse({ error: true, reason: "synthetic failure" })) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  });

  it("applies one shared time-row record limit while keeping every series aligned", async () => {
    const result = await executeDataRun(
      {
        ...request({
          locations: [
            { latitude: 52.52, longitude: 13.41 },
            { latitude: 48.85, longitude: 2.35 },
          ],
        }),
        limits: { maxRecords: 26 },
      },
      {
        registry: createDataRegistry([openMeteoHistoricalWeatherConnector]),
        environment: {},
        fetchImpl: (async () => jsonResponse([await fixture(), await fixture()])) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 26);
    assert.equal(result.summary.truncated, true);
    const locations = (
      result.data as {
        stopReason: string;
        locations: Array<{
          hourly: { timesUtc: string[]; variables: Array<{ values: unknown[] }> } | null;
          daily: { dates: string[]; variables: Array<{ values: unknown[] }> } | null;
        }>;
      }
    ).locations;
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
    assert.equal(locations[0]?.hourly?.timesUtc.length, 24);
    assert.equal(locations[0]?.daily?.dates.length, 1);
    assert.equal(locations[1]?.hourly?.timesUtc.length, 1);
    assert.equal(locations[1]?.daily, null);
    for (const location of locations) {
      if (location.hourly) {
        assert.ok(
          location.hourly.variables.every(
            (variable) => variable.values.length === location.hourly?.timesUtc.length,
          ),
        );
      }
      if (location.daily) {
        assert.ok(
          location.daily.variables.every(
            (variable) => variable.values.length === location.daily?.dates.length,
          ),
        );
      }
    }
  });

  it("publishes reanalysis, model-consistency, and non-observation discovery boundaries", () => {
    const discovery = createDataRegistry([openMeteoHistoricalWeatherConnector]).discovery(
      "open-meteo.historical-weather",
    );
    assert.ok(discovery);
    assert.match(discovery.source.description, /reanalysis/i);
    assert.ok(discovery.selectionHints.some((item) => /ERA5|ERA5-Land/.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /station|observation/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /forecast/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /attribution/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /non-commercial/i.test(item)));
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: openMeteoHistoricalWeatherConnector,
      request: request(),
      fetchImpl: (async () => jsonResponse(await fixture())) as typeof fetch,
    });
  });
});

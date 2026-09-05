import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { openMeteoAirQualityConnector } from "../src/data/connectors/open-meteo-air-quality.js";
import { OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA } from "../src/data/connectors/open-meteo-air-quality.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/open-meteo-air-quality/", import.meta.url);

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "open-meteo.air-quality",
    capabilityVersion: "1.0.1",
    operationId: "fetch-hourly",
    operationVersion: "1.0.1",
    input: {
      locations: [{ latitude: 52.52, longitude: 13.41 }],
      startDate: "2026-03-17",
      endDate: "2026-03-17",
      hourlyVariables: ["pm10", "pm2_5"],
      ...inputOverrides,
    },
  };
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("hourly.json", FIXTURE_ROOT), "utf8")) as Record<
    string,
    unknown
  >;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

describe("Open-Meteo air-quality connector", () => {
  it("documents every input field and coordinate for agent request construction", () => {
    for (const [name, schema] of Object.entries(OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      OPEN_METEO_AIR_QUALITY_INPUT_SCHEMA.properties.locations.items.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("uses the public GMT endpoint and normalizes one aligned hourly model series", async () => {
    let requestedUrl = "";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: { OPEN_METEO_AIR_QUALITY_API_KEY: "must-not-be-read" },
      fetchImpl: (async (target) => {
        requestedUrl = String(target);
        return jsonResponse(await fixture());
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 24);
    const url = new URL(requestedUrl);
    assert.equal(url.origin, "https://air-quality-api.open-meteo.com");
    assert.equal(url.pathname, "/v1/air-quality");
    assert.equal(url.searchParams.get("latitude"), "52.52");
    assert.equal(url.searchParams.get("longitude"), "13.41");
    assert.equal(url.searchParams.get("start_date"), "2026-03-17");
    assert.equal(url.searchParams.get("end_date"), "2026-03-17");
    assert.equal(url.searchParams.get("hourly"), "pm10,pm2_5");
    assert.equal(url.searchParams.get("timezone"), "GMT");
    assert.equal(url.searchParams.get("domains"), "auto");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
    assert.equal(url.searchParams.has("apikey"), false);

    const data = result.data as {
      stopReason: string;
      locations: Array<Record<string, unknown>>;
    };
    assert.equal(data.stopReason, "completed");
    const location = data.locations[0] as {
      requestedLocationIndex: number;
      requestedLocation: { latitude: number; longitude: number };
      gridLocation: { latitude: number; longitude: number };
      timezone: string;
      utcOffsetSeconds: number;
      timesUtc: string[];
      variables: Array<{ variable: string; unit: string; values: Array<number | null> }>;
    };
    assert.equal(location.requestedLocationIndex, 0);
    assert.deepEqual(location.requestedLocation, { latitude: 52.52, longitude: 13.41 });
    assert.deepEqual(location.gridLocation, { latitude: 52.52, longitude: 13.419 });
    assert.equal(location.timezone, "GMT");
    assert.equal(location.utcOffsetSeconds, 0);
    assert.equal(location.timesUtc.length, 24);
    assert.deepEqual(location.timesUtc.slice(0, 3), [
      "2026-03-17T00:00:00Z",
      "2026-03-17T01:00:00Z",
      "2026-03-17T02:00:00Z",
    ]);
    assert.equal(location.timesUtc.at(-1), "2026-03-17T23:00:00Z");
    assert.deepEqual(
      location.variables.map((variable) => ({
        variable: variable.variable,
        unit: variable.unit,
        firstValues: variable.values.slice(0, 3),
        length: variable.values.length,
      })),
      [
        { variable: "pm10", unit: "μg/m³", firstValues: [20, 21.5, 22], length: 24 },
        { variable: "pm2_5", unit: "μg/m³", firstValues: [10.5, null, 12.25], length: 24 },
      ],
    );
  });

  it("preserves request order for multiple coordinates while sorting variables", async () => {
    const first = await fixture();
    const second = structuredClone(first);
    second.latitude = 48.85;
    second.longitude = 2.35;
    let requestedUrl = "";
    const result = await executeDataRun(
      request({
        locations: [
          { latitude: 52.52, longitude: 13.41 },
          { latitude: 48.85, longitude: 2.35 },
        ],
        hourlyVariables: ["pm2_5", "pm10"],
        domain: "cams_europe",
        cellSelection: "land",
      }),
      {
        registry: createDataRegistry([openMeteoAirQualityConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requestedUrl = String(target);
          return jsonResponse([first, second]);
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 48);
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("latitude"), "52.52,48.85");
    assert.equal(url.searchParams.get("longitude"), "13.41,2.35");
    assert.equal(url.searchParams.get("hourly"), "pm10,pm2_5");
    assert.equal(url.searchParams.get("domains"), "cams_europe");
    assert.equal(url.searchParams.get("cell_selection"), "land");
    assert.deepEqual(
      (result.data as { locations: Array<{ requestedLocationIndex: number }> }).locations.map(
        (location) => location.requestedLocationIndex,
      ),
      [0, 1],
    );
  });

  it("rejects inverted or oversized date windows before network access", async () => {
    for (const dates of [
      { startDate: "2026-03-18", endDate: "2026-03-17" },
      { startDate: "2026-01-01", endDate: "2026-04-03" },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(dates), {
        registry: createDataRegistry([openMeteoAirQualityConnector]),
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

  it("preserves valid variables and marks a missing requested variable as partial", async () => {
    const payload = await fixture();
    delete (payload.hourly as Record<string, unknown>).pm10;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 24);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.errors[0]?.details?.issueCodes, ["series-missing"]);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.pm10"] },
    ]);
    assert.deepEqual(
      (
        result.data as {
          locations: Array<{ variables: Array<{ variable: string }> }>;
        }
      ).locations[0]?.variables.map((variable) => variable.variable),
      ["pm2_5"],
    );
  });

  it("preserves a returned all-null series and distinguishes it from a missing series", async () => {
    const payload = await fixture();
    const hourly = payload.hourly as Record<string, unknown>;
    hourly.pm10 = new Array((hourly.time as unknown[]).length).fill(null);
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(result.errors[0]?.details?.issueCodes, ["series-all-null"]);
    const data = result.data as {
      validation: { issues: Array<{ code: string; path: string }> };
      locations: Array<{ variables: Array<{ variable: string; values: unknown[] }> }>;
    };
    assert.deepEqual(data.validation.issues, [
      {
        code: "series-all-null",
        path: "$[0].hourly.pm10",
        message: "Requested air-quality series was returned but contains no usable numeric values.",
      },
    ]);
    assert.ok(
      data.locations[0]?.variables
        .find((variable) => variable.variable === "pm10")
        ?.values.every((value) => value === null),
    );
  });

  it("marks incomplete or nonascending GMT time axes as partial", async () => {
    const shortened = await fixture();
    const shortenedHourly = shortened.hourly as Record<string, unknown[]>;
    for (const field of ["time", "pm2_5", "pm10"]) shortenedHourly[field]?.pop();
    const shortResult = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(shortened)) as typeof fetch,
    });
    assert.equal(shortResult.status, "partial");
    assert.equal(shortResult.summary.recordCount, 23);
    assert.deepEqual(shortResult.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.time"] },
    ]);

    const unordered = await fixture();
    const times = (unordered.hourly as { time: string[] }).time;
    [times[1], times[2]] = [times[2] as string, times[1] as string];
    const unorderedResult = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(unordered)) as typeof fetch,
    });
    assert.equal(unorderedResult.status, "partial");
    assert.equal(unorderedResult.summary.recordCount, 24);
    assert.deepEqual(unorderedResult.summary.missing, [
      { kind: "field", identifiers: ["$[0].hourly.time[2]"] },
    ]);
  });

  it("reports provider timezone drift instead of silently treating it as GMT", async () => {
    const payload = await fixture();
    payload.timezone = "Europe/Berlin";
    payload.utc_offset_seconds = 3600;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
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

  it("blocks explicit provider error objects", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoAirQualityConnector]),
      environment: {},
      fetchImpl: (async () =>
        jsonResponse({ error: true, reason: "synthetic failure" })) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  });

  it("applies a timestamp record limit while keeping variable arrays aligned", async () => {
    const result = await executeDataRun(
      { ...request(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([openMeteoAirQualityConnector]),
        environment: {},
        fetchImpl: (async () => jsonResponse(await fixture())) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    const data = result.data as {
      stopReason: string;
      locations: Array<{ timesUtc: string[]; variables: Array<{ values: unknown[] }> }>;
    };
    assert.equal(data.stopReason, "max-records");
    assert.equal(data.locations[0]?.timesUtc.length, 1);
    assert.deepEqual(
      data.locations[0]?.variables.map((variable) => variable.values.length),
      [1, 1],
    );
  });

  it("publishes modeled-background and attribution discovery boundaries", () => {
    const registry = createDataRegistry([openMeteoAirQualityConnector]);
    const discovery = registry.discovery("open-meteo.air-quality");
    assert.ok(discovery);
    assert.match(discovery.source.description, /model/i);
    assert.ok(discovery.doesNotProvide.some((item) => /station/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /attribution/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /non-commercial/i.test(item)));
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: openMeteoAirQualityConnector,
      request: request(),
      fetchImpl: (async () => jsonResponse(await fixture())) as typeof fetch,
    });
  });
});

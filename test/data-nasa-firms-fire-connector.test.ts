import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { nasaFirmsFireConnector } from "../src/data/connectors/nasa-firms-fire.js";
import { NASA_FIRMS_FIRE_INPUT_SCHEMA } from "../src/data/connectors/nasa-firms-fire.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/nasa-firms-fire/", import.meta.url);
const MAP_KEY = "abcdef0123456789abcdef0123456789";

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "nasa-firms.active-fire",
    capabilityVersion: "1.0.0",
    operationId: "fetch-area",
    operationVersion: "1.0.0",
    input: {
      source: "VIIRS_NOAA20_NRT",
      boundingBox: { west: 115.8, south: -8.9, east: 116.3, north: -8.3 },
      startDate: "2026-03-01",
      endDate: "2026-03-07",
      checkAvailability: true,
      ...inputOverrides,
    },
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

function csvResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/csv; charset=utf-8" } });
}

async function successfulFetch(target: string | URL | Request): Promise<Response> {
  const url = new URL(String(target));
  if (url.pathname.includes("/data_availability/")) {
    return csvResponse(await fixture("availability.csv"));
  }
  if (url.pathname.endsWith("/5/2026-03-01")) {
    return csvResponse(await fixture("chunk-1.csv"));
  }
  if (url.pathname.endsWith("/2/2026-03-06")) {
    return csvResponse(await fixture("chunk-2.csv"));
  }
  throw new Error(`Unexpected fixture URL: ${url.pathname}`);
}

describe("NASA FIRMS active-fire connector", () => {
  it("documents every input field and bounding-box coordinate for agent construction", () => {
    for (const [name, schema] of Object.entries(NASA_FIRMS_FIRE_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      NASA_FIRMS_FIRE_INPUT_SCHEMA.properties.boundingBox.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("blocks before network access when the logical MAP_KEY is missing", async () => {
    let fetched = false;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([nasaFirmsFireConnector]),
      environment: {},
      fetchImpl: (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "credential-missing");
    assert.equal(fetched, false);
    assert.doesNotMatch(JSON.stringify(result), /NASA_FIRMS_MAP_KEY|abcdef/);
  });

  it("classifies a rejected MAP_KEY before parsing an availability response", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([nasaFirmsFireConnector]),
      environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
      fetchImpl: (async () => csvResponse("Invalid MAP_KEY")) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "credential-invalid");
    assert.equal(result.errors[0]?.userActionRequired, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(MAP_KEY));
  });

  it("checks availability, chunks five-day requests, and normalizes VIIRS detections", async () => {
    const requestedPaths: string[] = [];
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([nasaFirmsFireConnector]),
      environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requestedPaths.push(url.pathname);
        assert.match(url.pathname, new RegExp(`/${MAP_KEY}/`));
        return successfulFetch(target);
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 5);
    assert.equal(result.summary.chunkCount, 2);
    assert.equal(result.summary.pageCount, 1);
    assert.deepEqual(requestedPaths, [
      `/api/data_availability/csv/${MAP_KEY}/VIIRS_NOAA20_NRT`,
      `/api/area/csv/${MAP_KEY}/VIIRS_NOAA20_NRT/115.8,-8.9,116.3,-8.3/5/2026-03-01`,
      `/api/area/csv/${MAP_KEY}/VIIRS_NOAA20_NRT/115.8,-8.9,116.3,-8.3/2/2026-03-06`,
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(MAP_KEY));
    const data = result.data as {
      availability: { source: string; minDate: string; maxDate: string };
      chunks: Array<{ dayCount: number; estimatedTransactions: number; status: string }>;
      records: Array<Record<string, unknown>>;
      stopReason: string;
    };
    assert.deepEqual(data.availability, {
      source: "VIIRS_NOAA20_NRT",
      minDate: "2026-01-01",
      maxDate: "2026-03-31",
    });
    assert.deepEqual(
      data.chunks.map((chunk) => ({
        dayCount: chunk.dayCount,
        estimatedTransactions: chunk.estimatedTransactions,
        status: chunk.status,
      })),
      [
        { dayCount: 5, estimatedTransactions: 10, status: "ok" },
        { dayCount: 2, estimatedTransactions: 4, status: "ok" },
      ],
    );
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.records[0], {
      recordIndex: 0,
      chunkIndex: 0,
      source: "VIIRS_NOAA20_NRT",
      latitude: -8.65,
      longitude: 116.01,
      acquiredAtUtc: "2026-03-01T00:31:00Z",
      satellite: "N20",
      instrument: "VIIRS",
      confidence: "n",
      version: "2.0NRT",
      dayNight: "N",
      fireRadiativePowerMw: 4.52,
      scanKm: 0.42,
      trackKm: 0.38,
      brightnessKelvin: null,
      brightT31Kelvin: null,
      brightTi4Kelvin: 334.21,
      brightTi5Kelvin: 292.14,
    });
  });

  it("rejects invalid windows and broad-area scans before fetching", async () => {
    for (const input of [
      { startDate: "2026-03-08", endDate: "2026-03-07" },
      { startDate: "2026-02-30", endDate: "2026-03-01" },
      { startDate: "2026-01-01", endDate: "2026-02-01" },
      { boundingBox: { west: 116.3, south: -8.9, east: 115.8, north: -8.3 } },
      { boundingBox: { west: -180, south: -90, east: 180, north: 90 } },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(input), {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
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

  it("keeps earlier detections and marks a later chunk failure as partial", async () => {
    const result = await executeDataRun(request({ checkAvailability: false }), {
      registry: createDataRegistry([nasaFirmsFireConnector]),
      environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        return url.pathname.endsWith("/5/2026-03-01")
          ? csvResponse(await fixture("chunk-1.csv"))
          : csvResponse("temporarily unavailable", 503);
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 3);
    assert.deepEqual(result.summary.missing, [
      { kind: "chunk", identifiers: ["2026-03-06..2026-03-07"] },
    ]);
  });

  it("drops an invalid row, preserves valid rows, and reports its exact path", async () => {
    const invalid = (await fixture("chunk-1.csv")).replace("-8.61000,116.05000", "-8.61000,117");
    const result = await executeDataRun(
      request({ endDate: "2026-03-05", checkAvailability: false }),
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => csvResponse(invalid)) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 2);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["chunks[0].rows[1].longitude"] },
    ]);
  });

  it("reports a duplicate provider header without discarding otherwise valid detections", async () => {
    const lines = (await fixture("chunk-1.csv")).trimEnd().split("\n");
    const duplicated = [
      `${lines[0]},frp`,
      ...lines.slice(1).map((line) => `${line},4.52`),
      "",
    ].join("\n");
    const result = await executeDataRun(
      request({ endDate: "2026-03-05", checkAvailability: false }),
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => csvResponse(duplicated)) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 3);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["chunks[0].header"] },
    ]);
    assert.match(
      String(
        (result.data as { validation: { issues: Array<{ message: string }> } }).validation.issues[0]
          ?.message,
      ),
      /duplicate columns: frp/,
    );
  });

  it("treats a header-only CSV as a complete no-results response", async () => {
    const header = (await fixture("chunk-1.csv")).split("\n", 1)[0] as string;
    const result = await executeDataRun(
      request({ endDate: "2026-03-01", checkAvailability: false }),
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => csvResponse(`${header}\n`)) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 0);
    assert.equal((result.data as { stopReason: string }).stopReason, "no-results");
  });

  it("stops after a record cap without spending transactions on later chunks", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      { ...request({ checkAvailability: false }), limits: { maxRecords: 2 } },
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => {
          fetchCount += 1;
          return csvResponse(await fixture("chunk-1.csv"));
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 2);
    assert.equal(result.summary.truncated, true);
    assert.equal(fetchCount, 1);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
  });

  it("discloses unvisited chunks when a complete chunk exactly fills the record budget", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      { ...request({ checkAvailability: false }), limits: { maxRecords: 3 } },
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => {
          fetchCount += 1;
          return csvResponse(await fixture("chunk-1.csv"));
        }) as typeof fetch,
      },
    );
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.truncated, true);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
    assert.equal(fetchCount, 1);
  });

  it("does not claim truncation when the final complete chunk exactly fills the record budget", async () => {
    const result = await executeDataRun(
      {
        ...request({ endDate: "2026-03-05", checkAvailability: false }),
        limits: { maxRecords: 3 },
      },
      {
        registry: createDataRegistry([nasaFirmsFireConnector]),
        environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
        fetchImpl: (async () => csvResponse(await fixture("chunk-1.csv"))) as typeof fetch,
      },
    );
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.truncated, false);
    assert.equal((result.data as { stopReason: string }).stopReason, "completed");
  });

  it("publishes hotspot, NRT/SP, and non-perimeter discovery boundaries", () => {
    const discovery = createDataRegistry([nasaFirmsFireConnector]).discovery(
      "nasa-firms.active-fire",
    );
    assert.ok(discovery);
    assert.match(discovery.source.description, /thermal|hotspot/i);
    assert.ok(discovery.selectionHints.some((item) => /NRT|SP/.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /perimeter|burned area/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /severity|alert/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /cite|acknowledge/i.test(item)));
  });

  it("conforms to the credentialed public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: nasaFirmsFireConnector,
      request: request(),
      environment: { NASA_FIRMS_MAP_KEY: MAP_KEY },
      fetchImpl: successfulFetch as typeof fetch,
    });
  });
});

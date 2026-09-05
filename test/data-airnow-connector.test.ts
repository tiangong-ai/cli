import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { airNowHourlyObservationsConnector } from "../src/data/connectors/airnow-hourly-observations.js";
import { AIRNOW_HOURLY_INPUT_SCHEMA } from "../src/data/connectors/airnow-hourly-observations.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

const FIXTURE_ROOT = new URL("./fixtures/data/airnow/", import.meta.url);

function request(
  input: Record<string, unknown> = {
    startDateTimeUtc: "2026-03-22T00:00:00Z",
    endDateTimeUtc: "2026-03-22T01:00:00Z",
    boundingBox: {
      minLongitude: -123.5,
      minLatitude: 37,
      maxLongitude: -121.5,
      maxLatitude: 38.8,
    },
    parameters: ["PM25", "OZONE"],
  },
): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "airnow.hourly-observations",
    capabilityVersion: "1.0.1",
    operationId: "fetch-hourly",
    operationVersion: "1.0.1",
    input,
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

describe("AirNow hourly observations connector", () => {
  it("documents every input field for agent selection and request construction", () => {
    for (const [name, schema] of Object.entries(AIRNOW_HOURLY_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      AIRNOW_HOURLY_INPUT_SCHEMA.properties.boundingBox.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("plans multiple UTC files and filters rows by bbox, time, and parameter", async () => {
    const requestedPaths: string[] = [];
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([airNowHourlyObservationsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requestedPaths.push(url.pathname);
        return new Response(await fixture(basename(url.pathname)), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.deepEqual(requestedPaths, [
      "/airnow/2026/20260322/HourlyAQObs_2026032200.dat",
      "/airnow/2026/20260322/HourlyAQObs_2026032201.dat",
    ]);
    assert.equal(result.summary.chunkCount, 2);
    assert.equal(result.summary.recordCount, 4);
    const data = result.data as {
      source: { preliminary: boolean; regulatoryUse: boolean };
      files: Array<{ status: string; sourceFile: string }>;
      records: Array<{
        aqsid: string;
        siteName: string;
        parameterName: string;
        rawConcentration: number | null;
        sourceFile: string;
      }>;
    };
    assert.deepEqual(data.source, {
      providerId: "airnow",
      product: "HourlyAQObs",
      preliminary: true,
      regulatoryUse: false,
    });
    assert.deepEqual(
      data.records.map((record) => [record.parameterName, record.rawConcentration]),
      [
        ["OZONE", 31],
        ["PM25", 7.1],
        ["OZONE", 29],
        ["PM25", -1.2],
      ],
    );
    assert.equal(
      data.records.every((record) => record.aqsid === "060750001"),
      true,
    );
    assert.equal(
      data.records.every((record) => record.siteName === "Bay, Test Site"),
      true,
    );
    assert.equal(
      data.files.every((file) => file.status === "ok"),
      true,
    );
    assert.equal(
      data.records.every((record) => record.sourceFile.startsWith("/airnow/")),
      true,
    );
  });

  it("fetches independent hourly files with bounded concurrency and preserves hour order", async () => {
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T00:00:00Z",
        endDateTimeUtc: "2026-03-22T03:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) =>
            setTimeout(resolve, url.pathname.endsWith("00.dat") ? 20 : 5),
          );
          active -= 1;
          completed.push(url.pathname);
          return new Response(await fixture("HourlyAQObs_2026032200.dat"), {
            headers: { "content-type": "text/plain" },
          });
        }) as typeof fetch,
      },
    );

    assert.ok(peak >= 2);
    assert.notDeepEqual(completed, [...completed].sort());
    assert.deepEqual(
      (result.data as { files: Array<{ hourUtc: string }> }).files.map((file) => file.hourUtc),
      [
        "2026-03-22T00:00:00Z",
        "2026-03-22T01:00:00Z",
        "2026-03-22T02:00:00Z",
        "2026-03-22T03:00:00Z",
      ],
    );
  });

  it("returns explicit partial coverage when an hourly file is missing", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([airNowHourlyObservationsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.pathname.endsWith("01.dat")) return new Response("missing", { status: 404 });
        return new Response(await fixture(basename(url.pathname)), {
          headers: { "content-type": "text/plain" },
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.errors[0]?.details?.failures, [
      {
        attempts: 1,
        code: "provider-response-invalid",
        phase: "response",
        redirects: 0,
        retries: 0,
        sourceId: "/airnow/2026/20260322/HourlyAQObs_2026032201.dat",
        status: 404,
      },
    ]);
    assert.deepEqual(result.summary.missing, [
      {
        kind: "file",
        identifiers: ["/airnow/2026/20260322/HourlyAQObs_2026032201.dat"],
      },
    ]);
    assert.equal(result.summary.recordCount, 2);
  });

  it("isolates a file whose required CSV headers are invalid", async () => {
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T00:00:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async () =>
          new Response(await fixture("invalid-header.dat"), {
            headers: { "content-type": "text/csv" },
          })) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 0);
    const data = result.data as { files: Array<{ status: string; errorCode?: string }> };
    assert.deepEqual(
      data.files.map(({ status, errorCode }) => ({ status, errorCode })),
      [{ status: "invalid", errorCode: "invalid-csv-header" }],
    );
  });

  it("preserves source rows when timestamps, AQSID, or individual values are malformed", async () => {
    const source = await fixture("HourlyAQObs_2026032200.dat");
    const malformed = source
      .replace("060750001,", ",")
      .replace(",03/22/26,00:00,", ",not-a-date,not-a-time,")
      .replace(",7.1,UG/M3,31.0,PPB,", ",not-a-number,UG/M3,31.0,PPB,");
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T00:00:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25", "OZONE"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async () =>
          new Response(malformed, { headers: { "content-type": "text/plain" } })) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    const data = result.data as {
      files: Array<{ issues: string[] }>;
      records: Array<{
        aqsid: string;
        observedAtUtc: string;
        parameterName: string;
        rawConcentration: number | null;
        aqiValue: number | null;
      }>;
    };
    assert.equal(data.records.length, 2);
    assert.equal(
      data.records.every((record) => record.aqsid === ""),
      true,
    );
    assert.equal(
      data.records.every((record) => record.observedAtUtc === "2026-03-22T00:00:00Z"),
      true,
    );
    const pm25 = data.records.find((record) => record.parameterName === "PM25");
    assert.equal(pm25?.rawConcentration, null);
    assert.equal(pm25?.aqiValue, 18);
    assert.equal(
      data.files[0]?.issues.some((issue) => issue.includes("used the source-file hour")),
      true,
    );
    assert.equal(
      data.files[0]?.issues.some((issue) => issue.includes("treated it as missing")),
      true,
    );
  });

  it("rejects non-hour boundaries and inverted windows before network access", async () => {
    let fetched = false;
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T01:30:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.equal(fetched, false);
  });

  it("publishes the preliminary-data and regulatory-use restrictions", () => {
    const registry = createDataRegistry([airNowHourlyObservationsConnector]);
    const discovery = (
      registry as unknown as {
        discovery(
          id: string,
        ): { license: { url: string; restrictions: string[] }; limitations: string[] } | undefined;
      }
    ).discovery("airnow.hourly-observations");
    assert.equal(discovery?.license.url, "https://docs.airnowapi.org/faq");
    assert.equal(
      discovery?.license.restrictions.some((item) => item.includes("preliminary")),
      true,
    );
    assert.equal(
      discovery?.limitations.some((item) => item.includes("regulatory")),
      true,
    );
  });
});

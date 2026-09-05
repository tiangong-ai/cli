import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { openMeteoFloodConnector } from "../src/data/connectors/open-meteo-flood.js";
import { OPEN_METEO_FLOOD_INPUT_SCHEMA } from "../src/data/connectors/open-meteo-flood.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/open-meteo-flood/", import.meta.url);

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "open-meteo.flood",
    capabilityVersion: "1.0.1",
    operationId: "fetch-daily",
    operationVersion: "1.0.1",
    input: {
      locations: [{ latitude: 52.52, longitude: 13.41 }],
      startDate: "2026-03-01",
      endDate: "2026-03-03",
      dailyVariables: ["river_discharge", "river_discharge_p75"],
      ...inputOverrides,
    },
  };
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("daily.json", FIXTURE_ROOT), "utf8")) as Record<
    string,
    unknown
  >;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

describe("Open-Meteo flood connector", () => {
  it("documents every input field and coordinate for agent request construction", () => {
    for (const [name, schema] of Object.entries(OPEN_METEO_FLOOD_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      OPEN_METEO_FLOOD_INPUT_SCHEMA.properties.locations.items.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("uses the public GMT endpoint and normalizes aligned daily simulated discharge", async () => {
    let requestedUrl = "";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoFloodConnector]),
      environment: { OPEN_METEO_FLOOD_API_KEY: "must-not-be-read" },
      fetchImpl: (async (target) => {
        requestedUrl = String(target);
        return jsonResponse(await fixture());
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 3);
    const url = new URL(requestedUrl);
    assert.equal(url.origin, "https://flood-api.open-meteo.com");
    assert.equal(url.pathname, "/v1/flood");
    assert.equal(url.searchParams.get("latitude"), "52.52");
    assert.equal(url.searchParams.get("longitude"), "13.41");
    assert.equal(url.searchParams.get("start_date"), "2026-03-01");
    assert.equal(url.searchParams.get("end_date"), "2026-03-03");
    assert.equal(url.searchParams.get("daily"), "river_discharge,river_discharge_p75");
    assert.equal(url.searchParams.get("timezone"), "GMT");
    assert.equal(url.searchParams.get("timeformat"), "iso8601");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
    assert.equal(url.searchParams.has("ensemble"), false);
    assert.equal(url.searchParams.has("apikey"), false);

    assert.deepEqual((result.data as { locations: unknown[] }).locations, [
      {
        requestedLocationIndex: 0,
        requestedLocation: { latitude: 52.52, longitude: 13.41 },
        riverGridLocation: { latitude: 52.52, longitude: 13.45 },
        elevation: 34,
        timezone: "GMT",
        timezoneAbbreviation: "GMT",
        utcOffsetSeconds: 0,
        dates: ["2026-03-01", "2026-03-02", "2026-03-03"],
        variables: [
          { variable: "river_discharge", unit: "m³/s", values: [8.25, 8.75, null] },
          { variable: "river_discharge_p75", unit: "m³/s", values: [9.5, 10.1, 10.8] },
        ],
        ensembleMembers: [],
      },
    ]);
  });

  it("preserves coordinate order, sorts variables, and normalizes ensemble members", async () => {
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
        dailyVariables: ["river_discharge_p75", "river_discharge"],
        includeEnsembleMembers: true,
        cellSelection: "land",
      }),
      {
        registry: createDataRegistry([openMeteoFloodConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requestedUrl = String(target);
          return jsonResponse([first, second]);
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 6);
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("latitude"), "52.52,48.85");
    assert.equal(url.searchParams.get("longitude"), "13.41,2.35");
    assert.equal(url.searchParams.get("daily"), "river_discharge,river_discharge_p75");
    assert.equal(url.searchParams.get("ensemble"), "true");
    assert.equal(url.searchParams.get("cell_selection"), "land");
    const locations = (
      result.data as {
        locations: Array<{
          requestedLocationIndex: number;
          ensembleMembers: Array<{ member: number }>;
        }>;
      }
    ).locations;
    assert.deepEqual(
      locations.map((location) => location.requestedLocationIndex),
      [0, 1],
    );
    assert.deepEqual(
      locations[0]?.ensembleMembers.map((member) => member.member),
      [1, 2],
    );
  });

  it("accepts source-compatible variable-width ensemble member suffixes", async () => {
    const payload = await fixture();
    const daily = payload.daily as Record<string, unknown>;
    const units = payload.daily_units as Record<string, unknown>;
    daily.river_discharge_member1 = daily.river_discharge_member01;
    units.river_discharge_member1 = units.river_discharge_member01;
    delete daily.river_discharge_member01;
    delete units.river_discharge_member01;
    const result = await executeDataRun(
      request({ includeEnsembleMembers: true, dailyVariables: ["river_discharge"] }),
      {
        registry: createDataRegistry([openMeteoFloodConnector]),
        environment: {},
        fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.deepEqual(
      (
        result.data as {
          locations: Array<{ ensembleMembers: Array<{ member: number; sourceField: string }> }>;
        }
      ).locations[0]?.ensembleMembers.map(({ member, sourceField }) => ({ member, sourceField })),
      [
        { member: 1, sourceField: "river_discharge_member1" },
        { member: 2, sourceField: "river_discharge_member02" },
      ],
    );
  });

  it("reports provider timezone drift instead of silently treating it as GMT", async () => {
    const payload = await fixture();
    payload.timezone = "Europe/Berlin";
    payload.utc_offset_seconds = 3600;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoFloodConnector]),
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

  it("rejects inverted, oversized, or semantically invalid requests before fetch", async () => {
    for (const input of [
      { startDate: "2026-03-04", endDate: "2026-03-03" },
      { startDate: "2025-01-01", endDate: "2026-01-02" },
      { dailyVariables: ["river_discharge_p75"], includeEnsembleMembers: true },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(input), {
        registry: createDataRegistry([openMeteoFloodConnector]),
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
    delete (payload.daily as Record<string, unknown>).river_discharge_p75;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoFloodConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 3);
    assert.deepEqual(result.errors[0]?.details?.issueCodes, ["series-missing"]);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].daily.river_discharge_p75"] },
    ]);
    assert.deepEqual(
      (
        result.data as {
          locations: Array<{ variables: Array<{ variable: string }> }>;
        }
      ).locations[0]?.variables.map((variable) => variable.variable),
      ["river_discharge"],
    );
  });

  it("preserves a returned all-null series and distinguishes it from a missing series", async () => {
    const payload = await fixture();
    const daily = payload.daily as Record<string, unknown>;
    daily.river_discharge_p75 = new Array((daily.time as unknown[]).length).fill(null);
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoFloodConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(result.errors[0]?.details?.issueCodes, ["series-all-null"]);
    const data = result.data as {
      validation: { issues: Array<{ code: string; path: string; message: string }> };
      locations: Array<{ variables: Array<{ variable: string; values: unknown[] }> }>;
    };
    assert.deepEqual(data.validation.issues, [
      {
        code: "series-all-null",
        path: "$[0].daily.river_discharge_p75",
        message: "Requested discharge series was returned but contains no usable numeric values.",
      },
    ]);
    assert.ok(
      data.locations[0]?.variables
        .find((variable) => variable.variable === "river_discharge_p75")
        ?.values.every((value) => value === null),
    );
  });

  it("marks requested ensemble coverage as partial when no members are returned", async () => {
    const payload = await fixture();
    for (const section of [payload.daily, payload.daily_units]) {
      delete (section as Record<string, unknown>).river_discharge_member01;
      delete (section as Record<string, unknown>).river_discharge_member02;
    }
    const result = await executeDataRun(request({ includeEnsembleMembers: true }), {
      registry: createDataRegistry([openMeteoFloodConnector]),
      environment: {},
      fetchImpl: (async () => jsonResponse(payload)) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["$[0].daily.river_discharge_memberNN"] },
    ]);
  });

  it("blocks explicit provider error objects", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([openMeteoFloodConnector]),
      environment: {},
      fetchImpl: (async () =>
        jsonResponse({ error: true, reason: "synthetic failure" })) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  });

  it("applies a location-day record limit while keeping every series aligned", async () => {
    const result = await executeDataRun(
      { ...request({ includeEnsembleMembers: true }), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([openMeteoFloodConnector]),
        environment: {},
        fetchImpl: (async () => jsonResponse(await fixture())) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    const location = (
      result.data as {
        stopReason: string;
        locations: Array<{
          dates: string[];
          variables: Array<{ values: unknown[] }>;
          ensembleMembers: Array<{ values: unknown[] }>;
        }>;
      }
    ).locations[0];
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
    assert.equal(location?.dates.length, 1);
    assert.ok(location?.variables.every((variable) => variable.values.length === 1));
    assert.ok(location?.ensembleMembers.every((member) => member.values.length === 1));
  });

  it("publishes simulated-river selection and non-alert discovery boundaries", () => {
    const discovery = createDataRegistry([openMeteoFloodConnector]).discovery("open-meteo.flood");
    assert.ok(discovery);
    assert.match(discovery.source.description, /simulat/i);
    assert.match(discovery.source.description, /largest river/i);
    assert.ok(discovery.doesNotProvide.some((item) => /gauge|station/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /alert|severity/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /attribution/i.test(item)));
    assert.ok(discovery.license.restrictions.some((item) => /non-commercial/i.test(item)));
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: openMeteoFloodConnector,
      request: request(),
      fetchImpl: (async () => jsonResponse(await fixture())) as typeof fetch,
    });
  });
});

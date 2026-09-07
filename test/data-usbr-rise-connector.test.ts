import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { usbrRiseConnector } from "../src/data/connectors/usbr-rise.js";
import {
  USBR_RISE_DISCOVER_ITEMS_INPUT_SCHEMA,
  USBR_RISE_FETCH_RESULTS_INPUT_SCHEMA,
} from "../src/data/connectors/usbr-rise.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

function request(operationId: "discover-items" | "fetch-results", input: unknown): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "usbr.rise",
    capabilityVersion: "1.0.0",
    operationId,
    operationVersion: "1.0.0",
    input,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/ld+json" },
  });
}

const MATCHING_ITEM = {
  id: "10835",
  "@id": "/rise/api/catalog-item/10835",
  itemTitle: "Lake Powell release",
  itemDescription: "Synthetic catalog metadata for contract testing.",
  locationId: "2001",
  locationName: "Glen Canyon Dam",
  parameterId: "3001",
  parameterName: "Release",
  parameterUnit: "cfs",
  parameterGroup: "Hydrology",
  parameterTimestep: "hourly",
  parameterTransformation: "instantaneous",
  sourceCode: "UC",
  temporalStartDate: "2020-01-01T00:00:00Z",
  temporalEndDate: "2026-01-01T00:00:00Z",
  "dcat:landingPage": "https://data.usbr.gov/rise/catalog-item/10835",
  "dcat:spatial": { type: "Point", coordinates: [-111.49, 36.94] },
};

describe("USBR RISE connector", () => {
  it("identifies a 200 HTML gateway block without exposing its body", async () => {
    const result = await executeDataRun(request("discover-items", { pageSize: 1 }), {
      registry: createDataRegistry([usbrRiseConnector]),
      environment: {},
      fetchImpl: (async () =>
        new Response(
          "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: synthetic-support-id</body></html>",
          { headers: { "content-type": "text/html; charset=iso-8859-1" } },
        )) as typeof fetch,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.details?.reasonCode, "provider-request-rejected");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-support-id/);
  });

  it("documents every operation input field for agent request construction", () => {
    for (const schema of [
      USBR_RISE_DISCOVER_ITEMS_INPUT_SCHEMA,
      USBR_RISE_FETCH_RESULTS_INPUT_SCHEMA,
    ]) {
      for (const [name, property] of Object.entries(schema.properties)) {
        assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
      }
    }
  });

  it("discovers catalog candidates in provider scan order with client-side filters", async () => {
    const requestedPages: number[] = [];
    const result = await executeDataRun(
      request("discover-items", {
        queryTerms: ["lake", "powell", "release"],
        locationNameContains: "glen canyon",
        pageSize: 100,
        startPage: 1,
      }),
      {
        registry: createDataRegistry([usbrRiseConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          assert.equal(url.origin, "https://data.usbr.gov");
          assert.equal(url.pathname, "/rise/api/catalog-item");
          assert.equal(url.searchParams.get("itemsPerPage"), "100");
          const page = Number(url.searchParams.get("page"));
          requestedPages.push(page);
          if (page === 1) {
            return jsonResponse({
              totalItems: 2,
              member: [
                {
                  ...MATCHING_ITEM,
                  id: "not-a-match",
                  itemTitle: "Unrelated synthetic item",
                },
              ],
              view: { next: "/rise/api/catalog-item?page=2" },
            });
          }
          return jsonResponse({ totalItems: 2, member: [MATCHING_ITEM], view: {} });
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(result.summary.recordCount, 1);
    const data = result.data as {
      candidateItemIds: string[];
      listSemantics: string;
      records: Array<Record<string, unknown>>;
      stopReason: string;
    };
    assert.deepEqual(data.candidateItemIds, ["10835"]);
    assert.match(data.listSemantics, /provider scan order/i);
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.records[0], {
      itemId: "10835",
      itemApiPath: "/rise/api/catalog-item/10835",
      itemTitle: "Lake Powell release",
      itemDescription: "Synthetic catalog metadata for contract testing.",
      locationId: "2001",
      locationName: "Glen Canyon Dam",
      locationSourceCode: null,
      parameterId: "3001",
      parameterName: "Release",
      parameterUnit: "cfs",
      parameterGroup: "Hydrology",
      parameterTimestep: "hourly",
      parameterTransformation: "instantaneous",
      sourceCode: "UC",
      temporalStartDate: "2020-01-01T00:00:00Z",
      temporalEndDate: "2026-01-01T00:00:00Z",
      landingPage: "https://data.usbr.gov/rise/catalog-item/10835",
      spatial: { type: "Point", coordinates: [-111.49, 36.94] },
      sourcePageNumber: 2,
    });
  });

  it("fetches explicit item results and optional catalog metadata", async () => {
    const requestedPaths: string[] = [];
    const result = await executeDataRun(
      request("fetch-results", {
        itemIds: ["10835"],
        afterUtc: "2025-01-01T00:00:00Z",
        beforeUtc: "2025-01-02T00:00:00Z",
        orderDateTime: "asc",
        includeItemMetadata: true,
        pageSize: 100,
        startPage: 1,
      }),
      {
        registry: createDataRegistry([usbrRiseConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requestedPaths.push(`${url.pathname}?${url.searchParams.toString()}`);
          if (url.pathname.endsWith("/catalog-item/10835")) return jsonResponse(MATCHING_ITEM);
          assert.equal(url.pathname, "/rise/api/result");
          assert.equal(url.searchParams.get("itemId"), "10835");
          assert.equal(url.searchParams.get("dateTime[after]"), "2025-01-01T00:00:00Z");
          assert.equal(url.searchParams.get("dateTime[before]"), "2025-01-02T00:00:00Z");
          assert.equal(url.searchParams.get("order[dateTime]"), "asc");
          return jsonResponse({
            totalItems: 1,
            member: [
              {
                id: "result-1",
                itemId: "10835",
                locationId: "2001",
                parameterId: "3001",
                sourceCode: "UC",
                dateTime: "2025-01-01T01:00:00Z",
                result: 12345.5,
                status: "published",
                lastUpdate: "2025-01-02T00:00:00Z",
                createDate: "2025-01-01T02:00:00Z",
                updateDate: "2025-01-02T00:00:00Z",
              },
            ],
            view: {},
          });
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(requestedPaths.length, 2);
    const data = result.data as {
      records: Array<Record<string, unknown>>;
      itemMetadata: Record<string, Record<string, unknown>>;
    };
    assert.equal(data.itemMetadata["10835"]?.parameterUnit, "cfs");
    assert.deepEqual(data.records[0], {
      recordId: "result-1",
      itemId: "10835",
      locationId: "2001",
      locationName: "Glen Canyon Dam",
      parameterId: "3001",
      parameterName: "Release",
      parameterUnit: "cfs",
      parameterGroup: "Hydrology",
      parameterTimestep: "hourly",
      parameterTransformation: "instantaneous",
      sourceCode: "UC",
      observedAtUtc: "2025-01-01T01:00:00Z",
      value: 12345.5,
      status: "published",
      lastUpdate: "2025-01-02T00:00:00Z",
      createDate: "2025-01-01T02:00:00Z",
      updateDate: "2025-01-02T00:00:00Z",
      latitude: 36.94,
      longitude: -111.49,
      itemTitle: "Lake Powell release",
      itemDescription: "Synthetic catalog metadata for contract testing.",
      landingPage: "https://data.usbr.gov/rise/catalog-item/10835",
      providerDisclaimer: null,
      sourcePageNumber: 1,
    });
  });

  it("preserves earlier item results when a later item request fails", async () => {
    const result = await executeDataRun(
      request("fetch-results", {
        itemIds: ["10835", "99999"],
        includeItemMetadata: false,
      }),
      {
        registry: createDataRegistry([usbrRiseConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          if (url.searchParams.get("itemId") === "99999") throw new Error("synthetic failure");
          return jsonResponse({
            totalItems: 1,
            member: [
              {
                id: "result-1",
                itemId: "10835",
                dateTime: "2025-01-01T01:00:00Z",
                result: 10,
              },
            ],
            view: {},
          });
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: ["item:99999"] }]);
  });

  it("rejects missing item IDs and reversed date windows before network access", async () => {
    for (const input of [
      {},
      {
        itemIds: ["10835"],
        afterUtc: "2025-01-02T00:00:00Z",
        beforeUtc: "2025-01-01T00:00:00Z",
      },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request("fetch-results", input), {
        registry: createDataRegistry([usbrRiseConnector]),
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

  it("conforms to the public connector contract for both operations", async () => {
    await assertDataConnectorConformance({
      connector: usbrRiseConnector,
      request: request("discover-items", { queryTerms: ["lake"] }),
      fetchImpl: (async () =>
        jsonResponse({ totalItems: 1, member: [MATCHING_ITEM], view: {} })) as typeof fetch,
    });
    await assertDataConnectorConformance({
      connector: usbrRiseConnector,
      request: request("fetch-results", { itemIds: ["10835"] }),
      fetchImpl: (async () =>
        jsonResponse({
          totalItems: 1,
          member: [
            { id: "result-1", itemId: "10835", dateTime: "2025-01-01T00:00:00Z", result: 1 },
          ],
          view: {},
        })) as typeof fetch,
    });
  });
});

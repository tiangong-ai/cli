import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DataExecutionSummary, DataRunResult } from "../src/data/contracts.js";
import {
  boundedResearchDataContext,
  buildResearchDataCommunication,
  inferResearchDataResultShape,
} from "../src/research/workspace/data-evidence-view.js";

function result(data: unknown, summary: DataExecutionSummary): DataRunResult {
  return {
    schemaVersion: "tiangong.data.run-result.v1",
    status: summary.completeness === "partial" ? "partial" : "success",
    requestId: null,
    contract: {
      cliVersion: "0.0.57",
      capabilityId: "test.view",
      capabilityVersion: "1.0.0",
      operationId: "fetch",
      operationVersion: "1.0.0",
      manifestDigest: "a".repeat(64),
      inputSchema: { schemaId: "test-input", digest: "b".repeat(64) },
      outputSchema: { schemaId: "test-output", digest: "c".repeat(64) },
    },
    data,
    summary,
    warnings: [],
    errors: [],
    receipt: {
      schemaVersion: "tiangong.data.core-receipt.v1",
      cliVersion: "0.0.57",
      capabilityId: "test.view",
      capabilityVersion: "1.0.0",
      operationId: "fetch",
      operationVersion: "1.0.0",
      requestDigest: "d".repeat(64),
      manifestDigest: "a".repeat(64),
      inputSchemaDigest: "b".repeat(64),
      outputSchemaDigest: "c".repeat(64),
      inputDigest: "e".repeat(64),
      aggregateResponseDigest: "f".repeat(64),
      normalizedDataDigest: "0".repeat(64),
      observations: [],
      completionStatus: summary.completeness === "partial" ? "partial" : "success",
      summary,
      generatedAt: "2026-09-02T00:00:00.000Z",
      receiptDigest: "1".repeat(64),
    },
  };
}

function summary(recordCount: number): DataExecutionSummary {
  return {
    recordCount,
    pageCount: 1,
    chunkCount: 1,
    truncated: false,
    completeness: "complete",
  };
}

describe("Research data evidence views", () => {
  it("pages a non-empty diagnostic collection when records is empty", () => {
    const diagnosticResult = result(
      {
        records: [],
        filteredOut: Array.from({ length: 5 }, (_, id) => ({ id, reason: "filtered" })),
        failures: [{ id: "failed-1", reason: "provider" }],
        stopReason: "completed",
      },
      summary(0),
    );
    const first = boundedResearchDataContext(diagnosticResult, 1_000_000, 2);
    const firstWithCollection = first as typeof first & { collection?: string };

    assert.equal(firstWithCollection.collection, "filteredOut");
    assert.equal(first.totalItems, 5);
    assert.equal(first.itemCount, 2);
    assert.equal(first.nextOffset, 2);
    const firstPage = JSON.parse(Buffer.from(first.bytes).toString("utf8")) as {
      data: { value: { filteredOut: Array<{ id: number }> } };
    };
    assert.deepEqual(
      firstPage.data.value.filteredOut.map((item) => item.id),
      [0, 1],
    );

    const second = boundedResearchDataContext(diagnosticResult, 1_000_000, 2, 2);
    const secondWithCollection = second as typeof second & { collection?: string };
    assert.equal(secondWithCollection.collection, "filteredOut");
    assert.equal(second.totalItems, 5);
    assert.equal(second.itemCount, 2);
    assert.equal(second.nextOffset, 4);
  });

  it("keeps every location and slices aligned time-series chunks to the context item budget", () => {
    const times = Array.from(
      { length: 48 },
      (_, hour) =>
        `2026-09-${String(Math.floor(hour / 24) + 1).padStart(2, "0")}T${String(hour % 24).padStart(2, "0")}:00:00Z`,
    );
    const locations = Array.from({ length: 3 }, (_, requestedLocationIndex) => ({
      requestedLocationIndex,
      hourly: {
        timesUtc: times,
        variables: [
          {
            variable: "temperature_2m",
            unit: "°C",
            values: times.map((_, index) => requestedLocationIndex * 100 + index),
          },
        ],
      },
      daily: null,
    }));

    const context = boundedResearchDataContext(
      result({ source: {}, locations, stopReason: "completed" }, summary(144)),
      1_000_000,
      100,
    );

    assert.equal(context.status, "projected");
    assert.equal(context.strategy, "timeseries-chunks");
    assert.equal(context.itemCount, 100);
    const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
      data: {
        value: {
          locations: Array<{
            hourly: { timesUtc: string[]; variables: Array<{ values: number[] }> };
          }>;
        };
      };
    };
    const projectedLocations = parsed.data.value.locations;
    assert.equal(projectedLocations.length, 3);
    assert.equal(
      projectedLocations.reduce((total, location) => total + location.hourly.timesUtc.length, 0),
      100,
    );
    assert.ok(
      projectedLocations.every(
        (location) =>
          location.hourly.variables[0]?.values.length === location.hourly.timesUtc.length,
      ),
    );
  });

  it("keeps complete thread groups where possible before projecting a partial group", () => {
    const records = [
      { id: "a-root", threadId: "a", parentId: null },
      { id: "a-reply", threadId: "a", parentId: "a-root" },
      { id: "b-root", threadId: "b", parentId: null },
      { id: "b-reply", threadId: "b", parentId: "b-root" },
    ];

    const context = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(4)),
      1_000_000,
      3,
    );

    assert.equal(context.strategy, "record-groups");
    const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
      data: { value: { records: Array<{ id: string }> } };
    };
    assert.deepEqual(
      parsed.data.value.records.map((record) => record.id),
      ["a-root", "a-reply", "b-root"],
    );
  });

  it("continues a projected record result without refetching or losing rows", () => {
    const records = Array.from({ length: 7 }, (_, id) => ({ id, value: `record-${id}` }));
    const first = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(records.length)),
      1_000_000,
      3,
    );
    const second = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(records.length)),
      1_000_000,
      3,
      first.nextOffset ?? 0,
    );
    const third = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(records.length)),
      1_000_000,
      3,
      second.nextOffset ?? 0,
    );

    const ids = [first, second, third].flatMap((context) => {
      const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
        data: { value: { records: Array<{ id: number }> } };
      };
      return parsed.data.value.records.map((record) => record.id);
    });
    assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(first.nextOffset, 3);
    assert.equal(second.nextOffset, 6);
    assert.equal(third.nextOffset, null);
    assert.equal(third.remainingItems, 0);
  });

  it("continues grouped records without duplicating a thread root", () => {
    const records = [
      { id: "a-root", threadId: "a", parentId: null },
      { id: "a-reply", threadId: "a", parentId: "a-root" },
      { id: "b-root", threadId: "b", parentId: null },
      { id: "b-reply", threadId: "b", parentId: "b-root" },
    ];
    const first = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(records.length)),
      1_000_000,
      3,
    );
    const second = boundedResearchDataContext(
      result({ records, stopReason: "completed" }, summary(records.length)),
      1_000_000,
      3,
      first.nextOffset ?? 0,
    );

    const ids = [first, second].flatMap((context) => {
      const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
        data: { value: { records: Array<{ id: string }> } };
      };
      return parsed.data.value.records.map((record) => record.id);
    });
    assert.deepEqual(ids, ["a-root", "a-reply", "b-root", "b-reply"]);
    assert.equal(second.nextOffset, null);
  });

  it("continues aligned time-series without duplicating or omitting values", () => {
    const locations = Array.from({ length: 2 }, (_, locationIndex) => ({
      locationIndex,
      hourly: {
        timesUtc: Array.from({ length: 4 }, (_, index) => `2026-09-01T0${index}:00:00Z`),
        values: Array.from({ length: 4 }, (_, index) => locationIndex * 100 + index),
      },
    }));
    const dataResult = result({ locations, stopReason: "completed" }, summary(8));
    const pages: ReturnType<typeof boundedResearchDataContext>[] = [];
    let offset = 0;
    do {
      const page = boundedResearchDataContext(dataResult, 1_000_000, 3, offset);
      pages.push(page);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);

    const values = pages.flatMap((context) => {
      const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
        data: { value: { locations: Array<{ hourly: { values: number[] } }> } };
      };
      return parsed.data.value.locations.flatMap((location) => location.hourly.values);
    });
    assert.deepEqual(
      values.toSorted((left, right) => left - right),
      [0, 1, 2, 3, 100, 101, 102, 103],
    );
    assert.equal(new Set(values).size, 8);
    assert.equal(pages.at(-1)?.nextOffset, null);
  });

  it("reports provider gaps and explicit limits as independent coverage dimensions", () => {
    const partialAndBounded = result(
      { records: [{ id: 1 }], stopReason: "partial" },
      {
        recordCount: 1,
        pageCount: 1,
        chunkCount: 1,
        truncated: true,
        completeness: "partial",
        missing: [{ kind: "page", identifiers: ["page:2"] }],
      },
    );
    const context = boundedResearchDataContext(partialAndBounded, 1_000_000, 100);
    const communication = buildResearchDataCommunication(partialAndBounded, context, {
      maxBytes: 1_000_000,
      maxItems: 100,
    });

    assert.equal(communication.providerCoverage.status, "partial");
    assert.equal(communication.limitCoverage.status, "bounded");
    assert.deepEqual(communication.limitCoverage.limitsHit, ["runtime-limit"]);
    assert.equal(communication.requestCoverage.status, "partial");
  });

  it("projects artifact manifests without changing the persisted acquisition result", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({ relativePath: `file-${index}.pdf` }));
    const context = boundedResearchDataContext(
      result(
        {
          comments: Array.from({ length: 5 }, (_, index) => ({ commentId: `c-${index}` })),
          attachments: Array.from({ length: 5 }, (_, index) => ({ attachmentId: `a-${index}` })),
          files,
          stopReason: "completed",
        },
        summary(5),
      ),
      1_000_000,
      2,
    );

    assert.equal(context.strategy, "artifact-manifest");
    const parsed = JSON.parse(Buffer.from(context.bytes).toString("utf8")) as {
      data: { value: { files: unknown[]; comments: unknown[]; attachments: unknown[] } };
    };
    assert.equal(parsed.data.value.files.length, 2);
    assert.equal(parsed.data.value.comments.length, 2);
    assert.equal(parsed.data.value.attachments.length, 2);
    assert.equal(inferResearchDataResultShape({ properties: {} }, true), "artifact");
  });
});

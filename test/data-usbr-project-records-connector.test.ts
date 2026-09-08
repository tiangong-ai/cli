import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { usbrProjectRecordsConnector } from "../src/data/connectors/usbr-project-records.js";
import { USBR_PROJECT_RECORDS_INPUT_SCHEMA } from "../src/data/connectors/usbr-project-records.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const PAGE_URL = "https://www.usbr.gov/project/page.html?view=1";

function request(input: unknown, limits?: DataRunRequest["limits"]): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "usbr.project-records",
    capabilityVersion: "1.0.0",
    operationId: "fetch",
    operationVersion: "1.0.0",
    input,
    ...(limits ? { limits } : {}),
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      etag: '"synthetic-etag"',
      "last-modified": "Mon, 31 Aug 2026 00:00:00 GMT",
    },
  });
}

function projectHtml() {
  return `<!doctype html><html><head>
    <title>Colorado River &amp; Project Records</title>
    <meta name="description" content="Synthetic official project inventory page.">
  </head><body>
    <a href="docs/report.pdf#section">Final Report</a>
    <a href="/project/notice.html">Public Notice</a>
    <a href="https://www.usbr.gov/project/data.xlsx">Data Workbook</a>
    <a href="docs/report.pdf">Duplicate Report</a>
    <a href="https://data.usbr.gov/rise">Other USBR host</a>
    <a href="https://example.com/external.pdf">External</a>
    <a href="mailto:records@example.gov">Email</a>
  </body></html>`;
}

describe("USBR project records connector", () => {
  it("blocks an HTTP 200 request-rejected gateway page instead of promoting it to a project record", async () => {
    const result = await executeDataRun(request({ urls: [PAGE_URL] }), {
      registry: createDataRegistry([usbrProjectRecordsConnector]),
      environment: {},
      fetchImpl: (async () =>
        htmlResponse(
          "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br>Your support ID is: synthetic-support-id</body></html>",
        )) as typeof fetch,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.data, null);
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
    assert.equal(result.errors[0]?.details?.reasonCode, "provider-request-rejected");
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic-support-id|consult with your administrator/,
    );
  });

  it("does not mistake an ordinary project page mentioning request rejection for a gateway block", async () => {
    const result = await executeDataRun(request({ urls: [PAGE_URL] }), {
      registry: createDataRegistry([usbrProjectRecordsConnector]),
      environment: {},
      fetchImpl: (async () =>
        htmlResponse(
          projectHtml().replace(
            "</body>",
            "<p>The requested URL was rejected during a previous test.</p></body>",
          ),
        )) as typeof fetch,
    });
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 4);
  });

  it("documents every input field for agent request construction", () => {
    for (const [name, property] of Object.entries(USBR_PROJECT_RECORDS_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
    }
  });

  it("inventories a supplied official page and same-host linked records", async () => {
    const result = await executeDataRun(
      request({ urls: [PAGE_URL], maxLinkedRecordsPerPage: 50 }),
      {
        registry: createDataRegistry([usbrProjectRecordsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          assert.equal(url.origin, "https://www.usbr.gov");
          assert.equal(url.pathname, "/project/page.html");
          assert.equal(url.searchParams.get("view"), "1");
          return htmlResponse(projectHtml());
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 4);
    const data = result.data as {
      pages: Array<Record<string, unknown>>;
      records: Array<Record<string, unknown>>;
      stopReason: string;
    };
    assert.equal(data.stopReason, "completed");
    assert.equal(data.pages[0]?.linkCount, 3);
    assert.deepEqual(
      data.records.map((record) => record.recordType),
      ["project-page", "linked-document", "linked-document", "linked-document"],
    );
    assert.deepEqual(data.records[0], {
      recordId: PAGE_URL,
      recordType: "project-page",
      title: "Colorado River & Project Records",
      summary: "Synthetic official project inventory page.",
      url: PAGE_URL,
      documentUrl: PAGE_URL,
      documentType: "html",
      sourcePageUrl: null,
      linkIndex: null,
      links: [
        { url: "https://www.usbr.gov/project/docs/report.pdf", text: "Final Report" },
        { url: "https://www.usbr.gov/project/notice.html", text: "Public Notice" },
        { url: "https://www.usbr.gov/project/data.xlsx", text: "Data Workbook" },
      ],
      contentSha256: result.receipt.observations[0]?.responseDigest,
      contentByteLength: result.receipt.observations[0]?.responseBytes,
      contentType: "text/html; charset=utf-8",
      lastModified: "Mon, 31 Aug 2026 00:00:00 GMT",
      etag: '"synthetic-etag"',
    });
    assert.equal(data.records[1]?.documentType, "pdf");
    assert.equal(data.records[2]?.documentType, "html");
    assert.equal(data.records[3]?.documentType, "xlsx");
  });

  it("rejects noncanonical, non-HTTPS, credentialed, and fragmented URLs before fetch", async () => {
    for (const input of [
      {},
      { urls: ["http://www.usbr.gov/project/page.html"] },
      { urls: ["https://data.usbr.gov/rise"] },
      { urls: ["https://user@example.com@www.usbr.gov/project/page.html"] },
      { urls: ["https://www.usbr.gov/project/page.html#records"] },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(input), {
        registry: createDataRegistry([usbrProjectRecordsConnector]),
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

  it("applies the record cap before requesting another supplied page", async () => {
    let calls = 0;
    const result = await executeDataRun(
      request(
        {
          urls: [PAGE_URL, "https://www.usbr.gov/project/second.html"],
          maxLinkedRecordsPerPage: 50,
        },
        { maxRecords: 2 },
      ),
      {
        registry: createDataRegistry([usbrProjectRecordsConnector]),
        environment: {},
        fetchImpl: (async () => {
          calls += 1;
          return htmlResponse(projectHtml());
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 2);
    assert.equal(result.summary.truncated, true);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
    assert.equal(calls, 1);
  });

  it("preserves an earlier page when a later supplied page fails", async () => {
    let calls = 0;
    const result = await executeDataRun(
      request({
        urls: [PAGE_URL, "https://www.usbr.gov/project/second.html"],
        maxLinkedRecordsPerPage: 0,
      }),
      {
        registry: createDataRegistry([usbrProjectRecordsConnector]),
        environment: {},
        fetchImpl: (async () => {
          calls += 1;
          if (calls === 2) throw new Error("synthetic later-page failure");
          return htmlResponse(projectHtml());
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "page", identifiers: ["url:2"] }]);
    assert.equal(result.errors[0]?.code, "partial-result");
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: usbrProjectRecordsConnector,
      request: request({ urls: [PAGE_URL], maxLinkedRecordsPerPage: 1 }),
      fetchImpl: (async () => htmlResponse(projectHtml())) as typeof fetch,
    });
  });
});

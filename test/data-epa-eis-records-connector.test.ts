import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { epaEisRecordsConnector } from "../src/data/connectors/epa-eis-records.js";
import { EPA_EIS_RECORDS_INPUT_SCHEMA } from "../src/data/connectors/epa-eis-records.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

function request(input: unknown, limits?: DataRunRequest["limits"]): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "epa.eis-records",
    capabilityVersion: "1.0.1",
    operationId: "search",
    operationVersion: "1.0.1",
    input,
    ...(limits ? { limits } : {}),
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function resultHtml(options: { title?: string; ceqNumber?: string; uniqueId?: string } = {}) {
  const title = options.title ?? "Synthetic Dam &amp; Reservoir EIS";
  const ceqNumber = options.ceqNumber ?? "EISX-001";
  const uniqueId = options.uniqueId ?? "EPA-EIS-001";
  return `<!doctype html>
    <html><body>
      <span class="pagebanner">1 item found</span>
      <table id="submissionsTable"><thead><tr><th>Title</th></tr></thead><tbody>
        <tr>
          <td><a href="/cdx-enepa-II/public/action/eis/details?submissionId=1">${title}</a></td>
          <td>${ceqNumber}</td>
          <td>Final</td>
          <td>08/01/2026</td>
          <td>08/07/2026</td>
          <td>${uniqueId}</td>
          <td>Bureau of Reclamation</td>
          <td>U.S. Fish &amp; Wildlife Service</td>
          <td>CO</td>
          <td>
            <a href="/cdx-enepa-II/public/action/eis/download?documentId=100">Environmental Impact Statement</a>
            <a href="#" onclick="downloadDocuments('100;101')">Download</a>
          </td>
        </tr>
      </tbody></table>
    </body></html>`;
}

describe("EPA EIS records connector", () => {
  it("documents every input field for agent request construction", () => {
    for (const [name, property] of Object.entries(EPA_EIS_RECORDS_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
    }
  });

  it("fetches a common official search and parses the submissions table", async () => {
    const result = await executeDataRun(request({ commonSearches: ["openComment"] }), {
      registry: createDataRegistry([epaEisRecordsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        assert.equal(url.origin, "https://cdxapps.epa.gov");
        assert.equal(url.pathname, "/cdx-enepa-II/public/action/eis/search");
        assert.equal(url.searchParams.get("commonSearch"), "openComment");
        assert.equal(url.searchParams.get("search"), "");
        return htmlResponse(resultHtml());
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    const data = result.data as {
      pages: Array<Record<string, unknown>>;
      records: Array<Record<string, unknown>>;
      stopReason: string;
    };
    assert.equal(data.stopReason, "completed");
    assert.equal(data.pages[0]?.providerResultCount, 1);
    assert.deepEqual(data.records[0], {
      recordId: "EISX-001",
      title: "Synthetic Dam & Reservoir EIS",
      ceqNumber: "EISX-001",
      uniqueIdentificationNumber: "EPA-EIS-001",
      documentType: "Final",
      epaCommentLetterDate: "08/01/2026",
      federalRegisterDate: "08/07/2026",
      leadAgency: "Bureau of Reclamation",
      federalCooperatingAgencies: "U.S. Fish & Wildlife Service",
      state: "CO",
      detailUrl: "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/details?submissionId=1",
      downloadLinks: [
        {
          url: "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/download?documentId=100",
          text: "Environmental Impact Statement",
        },
        {
          url: "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search?search=&commonSearch=openComment",
          text: "Download",
        },
      ],
      downloadDocumentIds: ["100", "101"],
      sourcePageUrl:
        "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search?search=&commonSearch=openComment",
    });
  });

  it("follows the provider session redirect with memory-only same-origin cookies", async () => {
    const cookies: Array<string | null> = [];
    const result = await executeDataRun(request({ commonSearches: ["openComment"] }), {
      registry: createDataRegistry([epaEisRecordsConnector]),
      environment: {},
      fetchImpl: (async (_target, init) => {
        cookies.push(new Headers(init?.headers).get("cookie"));
        if (cookies.length === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "/cdx-enepa-II/public/action/eis/search?search=&commonSearch=openComment&__fsk=synthetic",
              "set-cookie": "JSESSIONID=synthetic-session; Path=/cdx-enepa-II; HttpOnly; Secure",
            },
          });
        }
        return htmlResponse(resultHtml());
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(cookies, [null, "JSESSIONID=synthetic-session"]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-session/);
  });

  it("accepts only explicit official HTTPS search URLs and preserves their query", async () => {
    const searchUrl =
      "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search?search=Glen+Canyon&state=CO";
    const result = await executeDataRun(request({ searchUrls: [searchUrl] }), {
      registry: createDataRegistry([epaEisRecordsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        assert.equal(url.searchParams.get("search"), "Glen Canyon");
        assert.equal(url.searchParams.get("state"), "CO");
        return htmlResponse(resultHtml());
      }) as typeof fetch,
    });
    assert.equal(result.status, "success");

    for (const invalidInput of [
      {},
      { searchUrls: ["http://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search"] },
      { searchUrls: ["https://example.com/cdx-enepa-II/public/action/eis/search"] },
      { searchUrls: ["https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/details?id=1"] },
    ]) {
      let fetched = false;
      const blocked = await executeDataRun(request(invalidInput), {
        registry: createDataRegistry([epaEisRecordsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    }
  });

  it("deduplicates records, respects the record cap, and avoids another request", async () => {
    let calls = 0;
    const result = await executeDataRun(
      request({ commonSearches: ["openComment", "last30Published"] }, { maxRecords: 1 }),
      {
        registry: createDataRegistry([epaEisRecordsConnector]),
        environment: {},
        fetchImpl: (async () => {
          calls += 1;
          return htmlResponse(resultHtml());
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal(calls, 1);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
  });

  it("preserves earlier records when a later official search fails", async () => {
    let calls = 0;
    const result = await executeDataRun(
      request({ commonSearches: ["openComment", "last30Published"] }),
      {
        registry: createDataRegistry([epaEisRecordsConnector]),
        environment: {},
        fetchImpl: (async () => {
          calls += 1;
          if (calls === 2) throw new Error("synthetic later-search failure");
          return htmlResponse(resultHtml());
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "page", identifiers: ["search:2"] }]);
    assert.equal(result.errors[0]?.code, "partial-result");
  });

  it("distinguishes an empty official result from an unrecognized provider page", async () => {
    const empty = await executeDataRun(request({ commonSearches: ["lastWeek"] }), {
      registry: createDataRegistry([epaEisRecordsConnector]),
      environment: {},
      fetchImpl: (async () =>
        htmlResponse(
          '<span class="pagebanner">0 items found</span><table id="submissionsTable"><tbody></tbody></table>',
        )) as typeof fetch,
    });
    assert.equal(empty.status, "success");
    assert.equal(empty.summary.recordCount, 0);
    assert.equal((empty.data as { stopReason: string }).stopReason, "no-results");

    const malformed = await executeDataRun(request({ commonSearches: ["lastWeek"] }), {
      registry: createDataRegistry([epaEisRecordsConnector]),
      environment: {},
      fetchImpl: (async () =>
        htmlResponse("<html><body>changed provider page</body></html>")) as typeof fetch,
    });
    assert.equal(malformed.status, "blocked");
    assert.equal(malformed.errors[0]?.code, "provider-response-invalid");
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: epaEisRecordsConnector,
      request: request({ commonSearches: ["openComment"] }),
      fetchImpl: (async () => htmlResponse(resultHtml())) as typeof fetch,
    });
  });
});

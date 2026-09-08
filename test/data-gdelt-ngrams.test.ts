import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { it } from "node:test";
import { builtInDataRegistry } from "../src/data/builtins.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { gdeltWebNgramsConnector } from "../src/data/connectors/gdelt-web-ngrams.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const timestamp = "2026-06-30T20:16:00Z";
const request = (input: Record<string, unknown> = {}): DataRunRequest => ({
  schemaVersion: "tiangong.data.run-request.v1",
  capabilityId: "gdelt.web-ngrams",
  capabilityVersion: "1.0.0",
  operationId: "search",
  operationVersion: "1.0.0",
  input: { fileTimestamp: timestamp, phrases: ["climate change"], ...input },
});
const toc = [
  {
    ID: 0,
    date: timestamp,
    lang: "en",
    title: "Synthetic climate",
    url: "https://example.invalid/a",
  },
  {
    ID: 1,
    date: timestamp,
    lang: "fr",
    title: "Synthetic second",
    url: "https://example.invalid/b",
  },
];
function fixture(
  grams = "0\tClimate change is real\t2\n0\tchange is real today\t2\n1\tclimate change affects everyone\t1\n",
  metadata = toc.map((v) => JSON.stringify(v)).join("\n"),
) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (target) => {
    const url = new URL(String(target));
    urls.push(url.toString());
    assert.equal(url.origin, "https://data.gdeltproject.org");
    assert.match(
      url.pathname,
      /^\/gdeltv5\/weblegacy\/ngrams\/20260630201600\.(toc\.json|ngrams\.txt)\.gz$/,
    );
    return new Response(
      new Uint8Array(gzipSync(url.pathname.includes(".toc.") ? metadata : grams)),
      {
        headers: {
          "content-type": url.pathname.includes(".toc.") ? "application/json" : "text/plain",
        },
      },
    );
  };
  return { fetchImpl, urls };
}
async function run(input: Record<string, unknown> = {}, mock = fixture(), limits = {}) {
  return executeDataRun(
    { ...request(input), limits },
    { registry: builtInDataRegistry, environment: {}, fetchImpl: mock.fetchImpl },
  );
}

it("searches the official paired files without DOC and binds document IDs to the file", async () => {
  const mock = fixture();
  const result = await run({}, mock);
  assert.equal(result.status, "success", JSON.stringify(result.errors));
  assert.equal(result.summary.recordCount, 2);
  assert.equal(result.summary.truncated, false);
  const data = result.data as {
    records: Array<{ documentId: number; matchedPhrases: string[]; fileTimestamp: string }>;
    matchedDocumentCount: number;
  };
  assert.equal(data.matchedDocumentCount, 2);
  assert.equal(data.records[0]!.documentId, 0);
  assert.deepEqual(data.records[0]!.matchedPhrases, ["climate change"]);
  assert.equal(data.records[0]!.fileTimestamp, timestamp);
  assert.equal(mock.urls.length, 2);
  assert.equal(result.receipt.observations.length, 2);
});

function payload(result: Awaited<ReturnType<typeof run>>) {
  return result.data as {
    records: Array<{ documentId: number; matchedPhrases: string[] }>;
    matchedDocumentCount: number;
    omittedRecordCount: number;
    statistics: Record<string, number>;
  };
}

it("matches all phrases within a document across grams, with exact language filtering", async () => {
  const result = await run({
    phrases: ["  CLIMATE   change  ", "today"],
    match: "all",
    languages: ["en"],
  });
  assert.equal(result.status, "success");
  assert.equal(result.summary.recordCount, 1);
  assert.deepEqual(payload(result).records[0]?.matchedPhrases, ["CLIMATE change", "today"]);
  assert.equal((await run({ languages: ["de"] })).summary.recordCount, 0);
});

it("does not match substrings, execute regex or DOC syntax, or sum overlapping counts", async () => {
  const grams = "0\tUndiseased crops are here\t999\n1\tDiseases, disease risk rises\t3\n";
  const result = await run({ phrases: ["disease"] }, fixture(grams));
  assert.equal(result.status, "success");
  assert.deepEqual(
    payload(result).records.map((record) => record.documentId),
    [1],
  );
  const absent = await run({ phrases: ["climate.*", "site:example.invalid"] });
  assert.equal(absent.status, "success");
  assert.equal(absent.summary.recordCount, 0);
  assert.equal(absent.summary.completeness, "complete");
});

it("reports omitted matches after scanning the whole pair, but accepts an exact record cap", async () => {
  const capped = await run({}, fixture(), { maxRecords: 1 });
  assert.equal(capped.status, "partial", JSON.stringify(capped.errors));
  assert.equal(capped.summary.truncated, true);
  assert.equal(payload(capped).matchedDocumentCount, 2);
  assert.equal(payload(capped).omittedRecordCount, 1);
  assert.equal((await run({}, fixture(), { maxRecords: 2 })).status, "success");
});

it("rejects ambiguous input and insufficient file budgets before HTTP", async () => {
  for (const input of [
    { fileTimestamp: "2026-02-30T12:00:00Z" },
    { fileTimestamp: "2026-06-30T20:16:01Z" },
    { phrases: ["one two three four five"] },
    { phrases: [" "] },
    { phrases: ["climate", "CLIMATE"] },
    { phrases: [".*"] },
    { fileTimestamp: "../toc.json" },
  ]) {
    const mock = fixture();
    assert.equal((await run(input, mock)).status, "blocked");
    assert.equal(mock.urls.length, 0);
  }
  const mock = fixture();
  assert.equal((await run({}, mock, { maxPages: 1 })).status, "blocked");
  assert.equal(mock.urls.length, 0);
});

it("retains valid matches while reporting bad rows and orphan DOCIDs as partial", async () => {
  const result = await run(
    {},
    fixture(
      "0\tClimate change is real\t1\n42\tClimate change is real\t2\nbad\n1\tclimate change is real\t0\n",
      toc.map((v) => JSON.stringify(v)).join("\n") + "\n{invalid\n",
    ),
  );
  assert.equal(result.status, "partial", JSON.stringify(result.errors));
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.recordCount, 1);
  assert.equal(payload(result).statistics.invalidTocRows, 1);
  assert.equal(payload(result).statistics.invalidNgramRows, 2);
  assert.equal(payload(result).statistics.orphanNgramRows, 1);
  const onlyBad = await run({}, fixture("not a valid row"));
  assert.equal(onlyBad.status, "partial");
  assert.equal(onlyBad.summary.completeness, "partial");
});

it("does not silently select a conflicting TOC ID or accept malformed known metadata", async () => {
  const metadata = [
    ...toc,
    toc[0],
    { ...toc[0], url: "https://example.invalid/conflict" },
    toc[0],
    { ID: 2, url: "javascript:alert(1)" },
    { ID: 3, url: "https://example.invalid/c", date: "2026-02-30T00:00:00Z" },
    { ID: 4, url: "https://example.invalid/d", title: 23 },
    { ID: 5, url: "https://user:password@example.invalid/e" },
    { ID: 6, url: "https://example.invalid/f", img: "not a URL" },
    null,
  ];
  const result = await run(
    {},
    fixture(undefined, metadata.map((v) => JSON.stringify(v)).join("\n")),
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(
    payload(result).records.map((record) => record.documentId),
    [1],
  );
  assert.equal(payload(result).statistics.ambiguousDocumentCount, 1);
  assert.equal(payload(result).statistics.invalidTocRows, 5);
  assert.equal(payload(result).statistics.duplicateTocRows, 3);
});

it("preserves malformed optional image-reference text without discarding searchable articles", async () => {
  const result = await run(
    {},
    fixture(
      undefined,
      toc
        .map((row) => JSON.stringify({ ...row, img: "http://broken%22%20provider-image/" }))
        .join("\n"),
    ),
  );
  assert.equal(result.status, "success");
  assert.equal(result.summary.recordCount, 2);
  assert.equal(
    (result.data as { records: Array<{ imageReference: string }> }).records[0]?.imageReference,
    "http://broken%22%20provider-image/",
  );
});

it("blocks missing files, bad GZIP/CRC/UTF-8, empty files and decompression bombs", async () => {
  const damaged = new Uint8Array(gzipSync("source"));
  damaged[damaged.length - 8] = damaged[damaged.length - 8]! ^ 1;
  for (const body of [
    new Uint8Array([1, 2, 3]),
    damaged,
    new Uint8Array(gzipSync(new Uint8Array([255]))),
    new Uint8Array(gzipSync(" ")),
    new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 65))),
  ]) {
    const result = await run(
      {},
      {
        urls: [],
        fetchImpl: async () =>
          new Response(body, { headers: { "content-type": "application/gzip" } }),
      },
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  }
  let calls = 0;
  const missing = await run(
    {},
    {
      urls: [],
      fetchImpl: async (target) => {
        calls++;
        return String(target).includes("toc.json")
          ? fixture().fetchImpl(target)
          : new Response("missing", { status: 404 });
      },
    },
  );
  assert.equal(missing.status, "blocked");
  assert.equal(missing.data, null);
  assert.equal(calls, 2);
});

it("conforms to catalog, manifest, execution, and receipt contracts", async () => {
  await assertDataConnectorConformance({
    connector: gdeltWebNgramsConnector,
    request: request(),
    fetchImpl: fixture().fetchImpl,
  });
  for (const schema of Object.values(
    gdeltWebNgramsConnector.operations[0]!.inputSchema.properties as Record<
      string,
      { description: string; examples: unknown[] }
    >,
  )) {
    assert.ok(schema.description.length > 0);
    assert.ok(schema.examples.length > 0);
  }
});

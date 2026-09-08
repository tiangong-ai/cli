import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Explicitly opt-in. Never run in the offline suite. Raw live data stays in the
// caller-selected output directory, not in fixtures or source control.
assert.equal(
  process.versions.node.split(".")[0],
  "24",
  "Use supported Node 24 for harness AND CLI",
);
assert.equal(
  process.argv[2],
  "--output-dir",
  "Usage: node scripts/test-gdelt-live.mjs --output-dir <new-directory>",
);
assert.ok(process.argv[3]);
const directory = resolve(process.argv[3]);
mkdirSync(directory); // Refuse overwrite/reuse of historical evidence.
const root = fileURLToPath(new URL("../", import.meta.url));
const qualificationRunner = resolve(root, "scripts/run-gdelt-doc-qualification.mjs");
const version = JSON.parse(readFileSync(resolve(root, "package.json"))).version;
if (process.argv[4] !== undefined) {
  assert.equal(process.argv[4], "--case");
  assert.ok(
    ["articles", "timeline"].includes(process.argv[5]),
    "--case must be articles or timeline",
  );
}
const cases = [
  {
    name: "articles",
    input: {
      query: "wildfire sourcelang:english",
      mode: "artlist",
      relativeWindow: { value: 24, unit: "hours" },
      maxRecords: 10,
      sort: "datedesc",
    },
  },
  {
    name: "timeline",
    input: {
      query: "wildfire sourcelang:english",
      mode: "timelinevolraw",
      relativeWindow: { value: 24, unit: "hours" },
    },
  },
].filter((item) => process.argv[5] === undefined || item.name === process.argv[5]);
const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  executable: process.execPath,
  cliVersion: version,
  gitHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  transportSourceSha256: createHash("sha256")
    .update(readFileSync(resolve(root, "src/data/runtime/bounded-http.ts")))
    .digest("hex"),
  scope:
    "GDELT DOC maintainer qualification only; public catalog/doctor/run remain suspended; no Auto Research, file feeds, or Regulations.gov",
  throughputDefinition:
    "Decoded provider bytes / complete CLI wall seconds (includes connection, pacing and retries); NOT wire transfer rate or provider capacity",
  runs: [],
};
let passed = true;
for (const item of cases) {
  const request = {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "gdelt.doc-search",
    capabilityVersion: "1.0.0",
    operationId: "search",
    operationVersion: "1.0.0",
    input: item.input,
  };
  const inputPath = resolve(directory, `${item.name}.input.json`);
  writeFileSync(inputPath, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      resolve(root, "scripts/gdelt-live-http-observer.mjs"),
      qualificationRunner,
      "--input",
      inputPath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 420_000,
      maxBuffer: 30_000_000,
      env: {
        ...process.env,
        TIANGONG_GDELT_HTTP_OBSERVATIONS: resolve(directory, `${item.name}.http.json`),
      },
    },
  );
  const elapsedMs = performance.now() - started;
  writeFileSync(resolve(directory, `${item.name}.output.json`), child.stdout ?? "", { flag: "wx" });
  writeFileSync(resolve(directory, `${item.name}.stderr.txt`), child.stderr ?? "", { flag: "wx" });
  let result;
  let parseError;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    parseError = "CLI output is not JSON";
  }
  let validationError;
  try {
    assert.equal(child.status, 0, "qualification runner must exit successfully");
    assert.equal(result?.status, "success");
    assert.equal(result?.summary?.completeness, "complete");
    assert.ok(result.summary.recordCount > 0, "A no-results response does not prove positive E2E");
    assert.ok(result.receipt.observations.length > 0);
    assert.ok(result.receipt.observations.every((observation) => observation.status === 200));
    if (item.name === "articles") {
      assert.ok(result.data.articles.length > 0);
      for (const article of result.data.articles) {
        assert.ok(article.title.trim());
        assert.ok(["http:", "https:"].includes(new URL(article.url).protocol));
      }
    } else {
      assert.ok(
        result.data.timelines.some((series) => series.data.some((point) => point.value > 0)),
      );
    }
  } catch (error) {
    validationError = error.message;
    passed = false;
  }
  const observations = result?.receipt?.observations ?? [];
  const providerBytes = observations.reduce(
    (total, observation) => total + observation.responseBytes,
    0,
  );
  const run = {
    name: item.name,
    startedAt,
    elapsedMs: Math.round(elapsedMs),
    exitCode: child.status,
    acceptance: validationError ? "failed" : "positive-data-passed",
    status: result?.status ?? null,
    records: result?.summary?.recordCount ?? null,
    decodedProviderBytes: observations.length ? providerBytes : null,
    attempts: observations.length
      ? observations.reduce((total, observation) => total + observation.attempts, 0)
      : (result?.errors?.[0]?.details?.attempts ?? null),
    decodedBytesPerWallSecond: observations.length
      ? Math.round((providerBytes * 1000) / elapsedMs)
      : null,
    outputBytes: Buffer.byteLength(child.stdout ?? ""),
    errors: result?.errors ?? [],
    ...(parseError ? { parseError } : {}),
    ...(validationError ? { validationError } : {}),
    ...(child.error ? { processError: child.error.code } : {}),
  };
  summary.runs.push(run);
  writeFileSync(resolve(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(run));
  if (!passed) break; // Do not multiply traffic after a provider block.
  if (item !== cases.at(-1)) await delay(5_000);
}
process.exitCode = passed && summary.runs.length === cases.length ? 0 : 1;

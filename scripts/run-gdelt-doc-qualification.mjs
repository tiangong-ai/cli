import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDataRegistry } from "../dist/data/catalog.js";
import { gdeltDocSearchConnector } from "../dist/data/connectors/gdelt-doc-search.js";
import { executeDataRun } from "../dist/data/runtime/execute.js";
import { dataErrorExitCode } from "../dist/data/runtime/errors.js";

// Maintainer-only recovery probe. The public built-in registry remains
// suspended; this runner deliberately registers only the underlying connector
// so a live qualification can determine whether its resume criteria now pass.
assert.equal(
  process.argv[2],
  "--input",
  "Usage: node scripts/run-gdelt-doc-qualification.mjs --input <request.json>",
);
assert.ok(process.argv[3]);
assert.equal(process.argv.length, 4);

const request = JSON.parse(readFileSync(process.argv[3], "utf8"));
assert.equal(request.capabilityId, "gdelt.doc-search");
assert.equal(request.operationId, "search");

const result = await executeDataRun(request, {
  registry: createDataRegistry([gdeltDocSearchConnector]),
  environment: {},
});
process.stdout.write(`${JSON.stringify(result)}\n`);

if (result.status === "success") process.exitCode = 0;
else if (result.status === "partial") process.exitCode = 4;
else process.exitCode = dataErrorExitCode(result.errors[0]?.code ?? "internal-error");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { it } from "node:test";

import { builtInDataRegistry } from "../src/data/builtins.js";

it("keeps public DOC execution suspended while the maintainer runner reaches connector validation", () => {
  const manifest = builtInDataRegistry.describe("gdelt.doc-search");
  assert.ok(manifest?.availability);
  assert.equal(manifest.availability.status, "suspended");
  const operation = manifest.operations.find((item) => item.operationId === "search");
  assert.ok(operation);

  const directory = mkdtempSync(resolve(tmpdir(), "gdelt-doc-qualification-"));
  try {
    const inputPath = resolve(directory, "request.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        schemaVersion: "tiangong.data.run-request.v1",
        capabilityId: "gdelt.doc-search",
        capabilityVersion: manifest.capabilityVersion,
        operationId: "search",
        operationVersion: operation.operationVersion,
        input: {
          query: "wildfire sourcelang:english",
          mode: "artlist",
          maxRecords: 0,
        },
      }),
    );
    const child = spawnSync(
      process.execPath,
      ["scripts/run-gdelt-doc-qualification.mjs", "--input", inputPath],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
    );
    assert.equal(child.status, 2, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.notEqual(result.errors[0]?.code, "capability-unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

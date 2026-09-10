import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquiredFixture, cli } from "./helpers/task-fixture.js";
import { regularTreeFiles, sha256File, workspacePaths } from "../src/research/workspace/storage.js";

async function controlFiles(root: string) {
  return Promise.all(
    (await regularTreeFiles(workspacePaths(root).control))
      .sort()
      .map(async (path) => [path, await sha256File(path)]),
  );
}

describe("bounded native investigations", () => {
  it("plans fixed-input numerical options without execution, then binds one exact authorization", async () => {
    const fx = await acquiredFixture("computation");
    try {
      const budget = await cli([
        "research",
        "project",
        "budget",
        "set",
        "task-project",
        "--max-cost-usd",
        "10",
        "--confirm-budget",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(budget.exitCode, 0, budget.stderr);
      const scriptPath = join(fx.files, "diagnose.mjs");
      const environmentLockPath = join(fx.files, "environment.json");
      await writeFile(
        scriptPath,
        "import {readFile,writeFile} from 'node:fs/promises';\nconst bytes=await readFile(process.argv[2]);\nawait writeFile(process.argv[3],JSON.stringify({inputBytes:bytes.length,variant:Number(process.argv[4])}));\n",
      );
      await writeFile(
        environmentLockPath,
        JSON.stringify({ node: process.version, dependencies: [] }),
      );
      const input = {
        schemaVersion: 1,
        investigationId: "solver-diagnosis",
        requirementId: fx.rows[0]!.id,
        requirementSha256: fx.rows[0]!.requirementSha256,
        objective: "Find a valid bounded configuration for the declared synthetic calculation.",
        canonicalInputs: [
          { id: "source", artifactId: fx.artifact.artifactId, sha256: fx.artifact.sha256 },
        ],
        programs: [
          {
            id: "solver-a",
            runtime: { kind: "node", path: process.execPath },
            scriptPath,
            environmentLockPath,
            arguments: ["{input:source}", "{output:diagnostic}", "{option:variant}"],
            outputs: [
              { id: "diagnostic", fileName: "diagnostic.json", mediaType: "application/json" },
            ],
            diagnosticOutputId: "diagnostic",
          },
        ],
        options: [{ id: "variant", kind: "integer", minimum: 0, maximum: 3 }],
        limits: {
          maxRuns: 5,
          maxWallSeconds: 7200,
          maxRunSeconds: 30,
          maxCostUsd: 1,
          maxRunCostUsd: 0.2,
        },
        deniedEffects: ["network", "dependency-install", "holdout", "external-write"],
      };
      const inputPath = join(fx.files, "investigation-input.json");
      await writeFile(inputPath, JSON.stringify(input));
      const command = (operation: string, extra: string[] = []) =>
        cli([
          "research",
          "project",
          "investigation",
          operation,
          "task-project",
          ...extra,
          "--workspace",
          fx.root,
          "--json",
        ]);
      const before = await controlFiles(fx.root);
      const planned = await command("plan", ["--input", inputPath]);
      assert.equal(planned.exitCode, 0, planned.stderr);
      const plan = JSON.parse(planned.stdout);
      assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
      assert.equal(plan.limits.maxRuns, 5);
      assert.equal(plan.canonicalInputs[0].sha256, fx.artifact.sha256);
      assert.equal(plan.programs[0].scriptSha256, await sha256File(scriptPath));
      assert.deepEqual(await controlFiles(fx.root), before);
      const unapproved = await command("approve", ["--input", inputPath]);
      assert.notEqual(unapproved.exitCode, 0);
      assert.deepEqual(await controlFiles(fx.root), before);
      const source = join(fx.files, "owner-confirmation.txt");
      await writeFile(
        source,
        "Synthetic owner approval of this exact five-run diagnostic envelope.",
      );
      const approvalArgs = [
        "--input",
        inputPath,
        "--confirm",
        plan.planSha256,
        "--authorization-source",
        source,
      ];
      const approved = await command("approve", approvalArgs);
      assert.equal(approved.exitCode, 0, approved.stderr);
      const record = JSON.parse(approved.stdout);
      assert.equal(record.scopeAuthorization.planSha256, plan.planSha256);
      assert.equal(record.scopeAuthorization.sourceSha256, await sha256File(source));
      const journal = await readFile(workspacePaths(fx.root).journal, "utf8");
      const repeated = await command("approve", approvalArgs);
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.deepEqual(JSON.parse(repeated.stdout), record);
      assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), journal);
      const status = await command("status", ["--investigation", "solver-diagnosis"]);
      assert.equal(status.exitCode, 0, status.stderr);
      const view = JSON.parse(status.stdout);
      assert.equal(view.status, "authorized");
      assert.equal(view.remaining.runs, 5);
      assert.equal(view.remaining.wallSeconds, 7200);
      assert.equal(view.actualCostUsd, null);
      assert.deepEqual(view.attempts, []);
    } finally {
      await fx.cleanup();
    }
  });
});

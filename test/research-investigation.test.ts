import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  it("binds one exact envelope, accounts four diagnostic stages and replays attempts without execution", async () => {
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
        `import {readFile,writeFile} from 'node:fs/promises';
const bytes=await readFile(process.argv[2]);const variant=Number(process.argv[4]);
if(variant===0){console.error('synthetic harness initialization failed');process.exit(2);}
await writeFile(process.argv[3],JSON.stringify({schemaVersion:1,solverReached:variant>1,feasible:variant===3,metrics:{inputBytes:bytes.length,residual:variant===3?0:1,iterations:variant>1?1:0},statuses:variant===4?{}:{runStatus:'completed',modelStatus:variant===3?'feasible':'not-feasible'},conclusion:variant===1?'Synthetic solver was not reached':variant===2?'Synthetic numerical constraint failed':'Synthetic bounded candidate found'}));
`,
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
            telemetry: {
              requiredMetrics: ["iterations", "residual"],
              requiredStatuses: ["runStatus", "modelStatus"],
            },
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
      input.programs.push({
        ...input.programs[0]!,
        id: "solver-missing-diagnostics",
        arguments: ["{input:source}", "{output:diagnostic}", "4"],
      });
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
      if (process.platform === "win32") {
        const path = join(fx.files, "unsupported-attempt.json");
        await writeFile(
          path,
          JSON.stringify({
            schemaVersion: 1,
            investigationId: "solver-diagnosis",
            attemptId: "unsupported",
            programId: "solver-a",
            hypothesis: "Refuse unsupported execution before starting a program",
            configuration: { variant: 3 },
            nativeSessionId: null,
            workingDirectory: fx.files,
          }),
        );
        const result = await command("attempt", ["--input", path]);
        assert.notEqual(result.exitCode, 0);
        assert.equal(
          (await readFile(workspacePaths(fx.root).journal, "utf8")).includes(
            "investigation.attempt.started",
          ),
          false,
        );
        return;
      }
      const outcomes = [
        "harness-failure",
        "solver-not-reached",
        "numerical-failure",
        "feasible-candidate",
      ];
      let observedWall = 0;
      let previousAttemptHash: string | null = null;
      for (const [variant, outcome] of outcomes.entries()) {
        const attemptPath = join(fx.files, `attempt-${variant}.json`);
        await writeFile(
          attemptPath,
          JSON.stringify({
            schemaVersion: 1,
            investigationId: "solver-diagnosis",
            attemptId: `attempt-${variant}`,
            programId: "solver-a",
            hypothesis: `Test predeclared synthetic configuration ${variant}`,
            configuration: { variant },
            nativeSessionId: null,
            workingDirectory: fx.files,
          }),
        );
        const attempt = await command("attempt", ["--input", attemptPath]);
        assert.equal(attempt.exitCode, 0, attempt.stderr);
        const result = JSON.parse(attempt.stdout);
        assert.equal(result.record.outcome, outcome);
        assert.equal(result.record.purpose, "diagnostic-candidate-only");
        assert.equal(result.record.actualCostUsd, null);
        assert.equal(result.record.runtime.version, process.version);
        assert.equal(result.record.parentAttemptSha256, previousAttemptHash);
        assert.deepEqual(result.record.changes.configuration, [
          { id: "variant", before: variant === 0 ? null : variant - 1, after: variant },
        ]);
        previousAttemptHash = result.record.recordSha256;

        assert.ok(result.record.process.wallSeconds >= 0);
        observedWall += result.record.process.wallSeconds;
        if (variant === 0) {
          const log = await readFile(
            join(workspacePaths(fx.root).projects, "task-project", result.record.logs.stderr.path),
            "utf8",
          );
          assert.match(log, /synthetic harness initialization failed/);
        }
        const afterAttempt = await readFile(workspacePaths(fx.root).journal, "utf8");
        const replay = await command("attempt", ["--input", attemptPath]);
        assert.equal(replay.exitCode, 0, replay.stderr);
        assert.deepEqual(JSON.parse(replay.stdout).record, result.record);
        assert.equal(JSON.parse(replay.stdout).replayed, true);
        assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), afterAttempt);
      }
      const finalStatus = JSON.parse(
        (await command("status", ["--investigation", "solver-diagnosis"])).stdout,
      );
      assert.equal(finalStatus.remaining.runs, 1);
      assert.ok(Math.abs(finalStatus.remaining.wallSeconds - (7200 - observedWall)) < 1e-6);
      assert.ok(Math.abs(finalStatus.remaining.costUpperBoundUsd - 0.2) < 1e-9);
      assert.equal(finalStatus.attempts.length, 4);
      assert.equal(finalStatus.actualCostUsd, null);
      const outsidePath = join(fx.files, "outside-attempt.json");
      await writeFile(
        outsidePath,
        JSON.stringify({
          schemaVersion: 1,
          investigationId: "solver-diagnosis",
          attemptId: "outside",
          programId: "solver-a",
          hypothesis: "Attempt an unauthorized numerical scope expansion",
          configuration: { variant: 4 },
          nativeSessionId: null,
          workingDirectory: fx.files,
        }),
      );
      const unchanged = await controlFiles(fx.root);
      const outside = await command("attempt", ["--input", outsidePath]);
      assert.notEqual(outside.exitCode, 0);
      assert.deepEqual(await controlFiles(fx.root), unchanged);
      const contenders = await Promise.all(
        ["last-a", "last-b"].map(async (attemptId) => {
          const path = join(fx.files, `${attemptId}.json`);
          await writeFile(
            path,
            JSON.stringify({
              schemaVersion: 1,
              investigationId: "solver-diagnosis",
              attemptId,
              programId: "solver-a",
              hypothesis: "Compete for the final authorized attempt without extra approval",
              configuration: { variant: 3 },
              nativeSessionId: null,
              workingDirectory: fx.files,
            }),
          );
          return command("attempt", ["--input", path]);
        }),
      );
      assert.equal(contenders.filter((r) => r.exitCode === 0).length, 1);
      const exhausted = JSON.parse(
        (await command("status", ["--investigation", "solver-diagnosis"])).stdout,
      );
      assert.equal(exhausted.status, "exhausted");
      assert.equal(exhausted.remaining.runs, 0);
      assert.equal(exhausted.attempts.length, 5);
      const selectionPath = join(fx.files, "selected-candidate.json");
      await writeFile(
        selectionPath,
        JSON.stringify({
          schemaVersion: 1,
          selectionId: "candidate-main",
          investigationId: "solver-diagnosis",
          attemptId: "attempt-3",
          reason:
            "Choose the observed feasible synthetic configuration for explicit later promotion",
        }),
      );
      const selected = await command("select", ["--input", selectionPath]);
      assert.equal(selected.exitCode, 0, selected.stderr);
      const candidate = JSON.parse(selected.stdout);
      assert.equal(candidate.kind, "tiangong-investigation-candidate");
      assert.equal(candidate.purpose, "diagnostic-candidate-only");
      assert.equal(candidate.recipe.runtime.version, process.version);
      assert.equal(candidate.recipe.script.sha256, await sha256File(scriptPath));
      assert.equal(candidate.recipe.inputs[0].sha256, fx.artifact.sha256);
      assert.deepEqual(candidate.recipe.configuration, { variant: 3 });
      assert.deepEqual(candidate.recipe.telemetry.requiredStatuses, ["runStatus", "modelStatus"]);
      const selectedJournal = await readFile(workspacePaths(fx.root).journal, "utf8");
      assert.deepEqual(
        JSON.parse((await command("select", ["--input", selectionPath])).stdout),
        candidate,
      );
      assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), selectedJournal);
      const candidateStatus = JSON.parse(
        (await command("status", ["--investigation", "solver-diagnosis"])).stdout,
      );
      assert.equal(candidateStatus.status, "candidate-ready");
      assert.equal(candidateStatus.candidate.recordSha256, candidate.recordSha256);
      assert.equal(candidateStatus.candidate.certification, "not-certified");
      const taskStatus = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(taskStatus.currentScope.requirements[0].status, "unanswered");
      assert.equal(taskStatus.executionCertified, false);

      // A real calculation finishes but durable result storage fails. Its known
      // start keeps the full uncertainty reservation and must never be rerun.
      const diagnosticInput = { ...input, investigationId: "diagnostic-contract" };
      await writeFile(inputPath, JSON.stringify(diagnosticInput));
      const diagnosticPlan = JSON.parse((await command("plan", ["--input", inputPath])).stdout);
      const diagnosticApproval = await command("approve", [
        "--input",
        inputPath,
        "--confirm",
        diagnosticPlan.planSha256,
        "--authorization-source",
        source,
      ]);
      assert.equal(diagnosticApproval.exitCode, 0, diagnosticApproval.stderr);
      const diagnosticPath = join(fx.files, "missing-diagnostics.json");
      await writeFile(
        diagnosticPath,
        JSON.stringify({
          schemaVersion: 1,
          investigationId: "diagnostic-contract",
          attemptId: "missing-status",
          programId: "solver-missing-diagnostics",
          hypothesis: "Do not mistake missing required solver statuses for a numerical verdict",
          configuration: { variant: 2 },
          nativeSessionId: null,
          workingDirectory: fx.files,
        }),
      );
      const missingStatus = await command("attempt", ["--input", diagnosticPath]);
      assert.equal(missingStatus.exitCode, 0, missingStatus.stderr);
      const missingRecord = JSON.parse(missingStatus.stdout).record;
      assert.equal(missingRecord.diagnostic.solverReached, true);
      assert.equal(missingRecord.outcome, "diagnostic-incomplete");
      assert.deepEqual(missingRecord.missingTelemetry, [
        "statuses.modelStatus",
        "statuses.runStatus",
      ]);
      const closePath = join(fx.files, "close-investigation.json");
      await writeFile(
        closePath,
        JSON.stringify({
          schemaVersion: 1,
          investigationId: "diagnostic-contract",
          reason: "Stop this diagnostic envelope after identifying the missing required telemetry.",
        }),
      );
      const closed = await command("close", ["--input", closePath]);
      assert.equal(closed.exitCode, 0, closed.stderr);
      const closure = JSON.parse(closed.stdout);
      assert.equal(closure.accountedCostUsd, 0.2);
      assert.equal(closure.releasedCostUpperBoundUsd, 0.8);
      const closeJournal = await readFile(workspacePaths(fx.root).journal, "utf8");
      assert.deepEqual(
        JSON.parse((await command("close", ["--input", closePath])).stdout),
        closure,
      );
      assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), closeJournal);
      const closedStatus = JSON.parse(
        (await command("status", ["--investigation", "diagnostic-contract"])).stdout,
      );
      assert.equal(closedStatus.status, "closed");
      assert.equal(closedStatus.allowedNextAction, "new-investigation-approval");
      const noRestart = await command("attempt", ["--input", diagnosticPath]);
      assert.equal(noRestart.exitCode, 0, "A committed old attempt remains replayable after close");
      const newAttempt = JSON.parse(await readFile(diagnosticPath, "utf8"));
      newAttempt.attemptId = "after-close";
      await writeFile(diagnosticPath, JSON.stringify(newAttempt));
      const deniedRestart = await command("attempt", ["--input", diagnosticPath]);
      assert.notEqual(deniedRestart.exitCode, 0);
      assert.match(deniedRestart.stderr, /RESEARCH_INVESTIGATION_CLOSED/);

      const interruptedInput = { ...input, investigationId: "interrupted-diagnosis" };
      await writeFile(inputPath, JSON.stringify(interruptedInput));
      const interruptedPlan = JSON.parse((await command("plan", ["--input", inputPath])).stdout);
      const interruptedApproval = await command("approve", [
        "--input",
        inputPath,
        "--confirm",
        interruptedPlan.planSha256,
        "--authorization-source",
        source,
      ]);
      assert.equal(interruptedApproval.exitCode, 0, interruptedApproval.stderr);
      const interruptedPath = join(fx.files, "interrupted-attempt.json");
      const interruptedAttempt = {
        schemaVersion: 1,
        investigationId: "interrupted-diagnosis",
        attemptId: "lost-result",
        programId: "solver-a",
        hypothesis: "Retain the reservation after observed execution loses durable result storage",
        configuration: { variant: 3 },
        nativeSessionId: null,
        workingDirectory: fx.files,
      };
      await writeFile(interruptedPath, JSON.stringify(interruptedAttempt));
      const originalRename = fs.rename;
      let interruptedWrites = 0;
      fs.rename = async (from, to) => {
        if (String(to).includes("/task/investigation-attempts/")) {
          interruptedWrites++;
          throw Object.assign(new Error("Synthetic interrupted durable attempt commit"), {
            code: "EIO",
          });
        }
        return originalRename(from, to);
      };
      syncBuiltinESMExports();
      try {
        const failed = await command("attempt", ["--input", interruptedPath]);
        assert.notEqual(failed.exitCode, 0);
      } finally {
        fs.rename = originalRename;
        syncBuiltinESMExports();
      }
      assert.equal(interruptedWrites, 1);
      const interruptedStatus = JSON.parse(
        (await command("status", ["--investigation", "interrupted-diagnosis"])).stdout,
      );
      assert.equal(interruptedStatus.status, "incomplete");
      assert.equal(interruptedStatus.remaining.runs, 4);
      assert.equal(interruptedStatus.remaining.wallSeconds, 7170);
      assert.equal(interruptedStatus.attempts[0].recordSha256, null);
      await writeFile(
        closePath,
        JSON.stringify({
          schemaVersion: 1,
          investigationId: "interrupted-diagnosis",
          reason: "Attempt to release an unresolved process reservation must be rejected.",
        }),
      );
      const unresolvedClose = await command("close", ["--input", closePath]);
      assert.notEqual(unresolvedClose.exitCode, 0);
      assert.match(unresolvedClose.stderr, /RESEARCH_INVESTIGATION_INCOMPLETE/);

      const interruptedJournal = await readFile(workspacePaths(fx.root).journal, "utf8");
      const noReplay = await command("attempt", ["--input", interruptedPath]);
      assert.notEqual(noReplay.exitCode, 0);
      assert.match(noReplay.stderr, /RESEARCH_INVESTIGATION_INCOMPLETE/);
      await writeFile(
        interruptedPath,
        JSON.stringify({ ...interruptedAttempt, attemptId: "blind-retry" }),
      );
      const noNewRun = await command("attempt", ["--input", interruptedPath]);
      assert.notEqual(noNewRun.exitCode, 0);
      assert.match(noNewRun.stderr, /RESEARCH_INVESTIGATION_INCOMPLETE/);
      assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), interruptedJournal);
    } finally {
      await fx.cleanup();
    }
  });
});

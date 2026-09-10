import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { acquiredFixture, cli } from "./helpers/task-fixture.js";
import { loadProject } from "../src/research/workspace/projects.js";
import { loadScientificFulfillmentView } from "../src/research/workspace/scientific-fulfillment.js";
import { regularTreeFiles, sha256File, workspacePaths } from "../src/research/workspace/storage.js";

async function exactControl(root: string) {
  return Promise.all(
    (await regularTreeFiles(workspacePaths(root).control))
      .sort()
      .map(async (path) => [path, await sha256File(path)]),
  );
}
it("separately authorizes a selected recipe and freezes only its predeclared scientific slots", async () => {
  if (process.platform === "win32") return; // Execution confinement has its own unsupported-platform regression.
  const fx = await acquiredFixture("computation", 0, true);
  try {
    const projectId = "task-project";
    const command = (parts: string[], args: string[] = []) =>
      cli([
        "research",
        "project",
        "investigation",
        ...parts,
        projectId,
        ...args,
        "--workspace",
        fx.root,
        "--json",
      ]);
    const must = async (result: Awaited<ReturnType<typeof cli>>) => {
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    await must(
      await cli([
        "research",
        "project",
        "budget",
        "set",
        projectId,
        "--max-cost-usd",
        "10",
        "--confirm-budget",
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    const scriptPath = join(fx.files, "solver.mjs"),
      environmentLockPath = join(fx.files, "environment.json");
    await writeFile(
      scriptPath,
      `import {readFile,writeFile} from 'node:fs/promises';
const bytes=await readFile(process.argv[2]);
await writeFile(process.argv[3],JSON.stringify({schemaVersion:1,solverReached:true,feasible:true,metrics:{iterations:1,inputBytes:bytes.length,residual:0},statuses:{runStatus:'completed',modelStatus:'feasible'},conclusion:'Synthetic deterministic candidate only; no scientific qualification is claimed.'}));
`,
    );
    await writeFile(
      environmentLockPath,
      JSON.stringify({ node: process.version, dependencies: [] }),
    );
    const envelope = {
      schemaVersion: 1,
      investigationId: "model-diagnosis",
      requirementId: fx.rows[0]!.id,
      requirementSha256: fx.rows[0]!.requirementSha256,
      objective: "Select and explicitly promote one bounded synthetic computation recipe",
      canonicalInputs: [
        { id: "source", artifactId: fx.artifact.artifactId, sha256: fx.artifact.sha256 },
      ],
      programs: [
        {
          id: "solver",
          runtime: { kind: "node", path: process.execPath },
          scriptPath,
          environmentLockPath,
          arguments: ["{input:source}", "{output:diagnostic}"],
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
      options: [],
      limits: {
        maxRuns: 2,
        maxWallSeconds: 60,
        maxRunSeconds: 30,
        maxCostUsd: 1,
        maxRunCostUsd: 0.2,
      },
      deniedEffects: ["network", "dependency-install", "holdout", "external-write"],
    };
    const inputPath = join(fx.files, "input.json"),
      source = join(fx.files, "authorization.txt");
    await writeFile(inputPath, JSON.stringify(envelope));
    await writeFile(
      source,
      "Synthetic owner authorizes exactly the displayed envelope and later exact promotion plan in this protocol regression.",
    );
    const oldRunPath = join(fx.files, "prior-observation.json");
    await writeFile(
      oldRunPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "prior-observation",
        requirementId: fx.rows[0]!.id,
        requirementSha256: fx.rows[0]!.requirementSha256,
        nativeSessionId: null,
        workingDirectory: fx.files,
        runtime: { kind: "node", path: process.execPath },
        scriptPath,
        environmentLockPath,
        inputs: envelope.canonicalInputs,
        outputs: envelope.programs[0]!.outputs,
        arguments: envelope.programs[0]!.arguments,
        timeoutSeconds: 30,
      }),
    );
    const oldRun = await must(
      await cli([
        "research",
        "project",
        "task",
        "run",
        "observe",
        projectId,
        "--input",
        oldRunPath,
        "--confirm-execution",
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    const acceptancePath = join(fx.files, "acceptance.json");
    const oldAcceptance = {
      schemaVersion: 1,
      requirementId: fx.rows[0]!.id,
      requirementSha256: fx.rows[0]!.requirementSha256,
      previousRecordSha256: null,
      outcome: "satisfied",
      summary: "A synthetic observation retained before the later investigation",
      checkKind: "computation",
      reportedCommand: null,
      nativeRunSha256: oldRun.record.recordSha256,
      sourceIds: ["source-1"],
      evidenceAtomIds: [fx.atom.atomId],
      analysisFindingIds: [],
      resultFiles: [],
      limitations: ["Synthetic protocol observation, never a scientific conclusion."],
    };
    const accept = () =>
      cli([
        "research",
        "project",
        "task",
        "acceptance",
        "record",
        projectId,
        "--input",
        acceptancePath,
        "--workspace",
        fx.root,
        "--json",
      ]);
    await writeFile(acceptancePath, JSON.stringify(oldAcceptance));
    const earlierAcceptance = await must(await accept());
    const envelopePlan = await must(await command(["plan"], ["--input", inputPath]));
    await must(
      await command(
        ["approve"],
        [
          "--input",
          inputPath,
          "--confirm",
          envelopePlan.planSha256,
          "--authorization-source",
          source,
        ],
      ),
    );
    await writeFile(
      inputPath,
      JSON.stringify({
        schemaVersion: 1,
        investigationId: envelope.investigationId,
        attemptId: "trial-one",
        programId: "solver",
        hypothesis: "Check this fixed-input synthetic implementation before any formal acceptance",
        configuration: {},
        nativeSessionId: null,
        workingDirectory: fx.files,
      }),
    );
    await must(await command(["attempt"], ["--input", inputPath]));
    await writeFile(
      inputPath,
      JSON.stringify({
        schemaVersion: 1,
        investigationId: envelope.investigationId,
        selectionId: "chosen",
        attemptId: "trial-one",
        reason: "Select the exact observed synthetic recipe for a separate promotion decision",
      }),
    );
    const candidate = await must(await command(["select"], ["--input", inputPath]));
    const guardedStatus = JSON.parse((await fx.task(["status"])).stdout);
    assert.equal(guardedStatus.currentScope.requirements[0].status, "unverified-certification");
    await writeFile(
      acceptancePath,
      JSON.stringify({ ...oldAcceptance, previousRecordSha256: earlierAcceptance.recordSha256 }),
    );
    const beforeOldAcceptance = await readFile(workspacePaths(fx.root).journal, "utf8");
    const rejectedOld = await accept();
    assert.notEqual(rejectedOld.exitCode, 0);
    assert.match(rejectedOld.stderr, /RESEARCH_INVESTIGATION_CERTIFICATION_REQUIRED/);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), beforeOldAcceptance);
    const beforeView = await loadScientificFulfillmentView(
      fx.root,
      await loadProject(fx.root, projectId),
    );
    const modelId = beforeView.contract.identity.modelStructures[0]!.id;
    const promotionInput = {
      schemaVersion: 1,
      promotionId: "certify-selected",
      sourceProjectId: projectId,
      investigationId: envelope.investigationId,
      candidateSha256: candidate.recordSha256,
      requirementId: fx.rows[0]!.id,
      requirementSha256: fx.rows[0]!.requirementSha256,
      modelId,
      maxRunSeconds: 30,
      maxCostUsd: 0.2,
    };
    await writeFile(inputPath, JSON.stringify(promotionInput));
    const before = await exactControl(fx.root);
    const plan = await must(await command(["promotion", "plan"], ["--input", inputPath]));
    assert.equal(plan.route, "predeclared-fulfillment");
    assert.equal(plan.candidateSha256, candidate.recordSha256);
    assert.equal(plan.recipeSha256, candidate.recipeSha256);
    assert.equal(plan.certification.maxRuns, 1);
    assert.deepEqual(await exactControl(fx.root), before);
    const unapproved = await command(["promotion", "approve"], ["--input", inputPath]);
    assert.notEqual(unapproved.exitCode, 0);
    assert.deepEqual(await exactControl(fx.root), before);
    const approved = await must(
      await command(
        ["promotion", "approve"],
        ["--input", inputPath, "--confirm", plan.planSha256, "--authorization-source", source],
      ),
    );
    assert.equal(approved.plan.planSha256, plan.planSha256);
    assert.equal(approved.scopeAuthorization.sourceSha256, await sha256File(source));
    const journal = await readFile(workspacePaths(fx.root).journal, "utf8");
    assert.deepEqual(
      await must(
        await command(
          ["promotion", "approve"],
          ["--input", inputPath, "--confirm", plan.planSha256, "--authorization-source", source],
        ),
      ),
      approved,
    );
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), journal);
    const authorizedView = await loadScientificFulfillmentView(
      fx.root,
      await loadProject(fx.root, projectId),
    );
    assert.equal(
      authorizedView.effectiveSha256,
      beforeView.effectiveSha256,
      "Approval alone does not fabricate scientific fulfillment",
    );
    const certificationInput = {
      schemaVersion: 1,
      runId: "certification-one",
      requirementId: fx.rows[0]!.id,
      requirementSha256: fx.rows[0]!.requirementSha256,
      nativeSessionId: null,
      workingDirectory: fx.files,
      runtime: { kind: "node", path: process.execPath },
      scriptPath,
      environmentLockPath,
      inputs: envelope.canonicalInputs,
      outputs: envelope.programs[0]!.outputs,
      arguments: envelope.programs[0]!.arguments,
      timeoutSeconds: 30,
      investigationPromotionSha256: approved.recordSha256,
    };
    const certificationPath = join(fx.files, "certification.json");
    const observe = () =>
      cli([
        "research",
        "project",
        "task",
        "run",
        "observe",
        projectId,
        "--input",
        certificationPath,
        "--confirm-execution",
        "--workspace",
        fx.root,
        "--json",
      ]);
    const { investigationPromotionSha256: _promotion, ...unpromotedInput } = certificationInput;
    await writeFile(certificationPath, JSON.stringify(unpromotedInput));
    const beforeUnpromoted = await readFile(workspacePaths(fx.root).journal, "utf8");
    const unpromoted = await observe();
    assert.notEqual(unpromoted.exitCode, 0);
    assert.match(unpromoted.stderr, /RESEARCH_INVESTIGATION_CERTIFICATION_REQUIRED/);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), beforeUnpromoted);
    await writeFile(certificationPath, JSON.stringify(certificationInput));
    const beforeFrozen = await observe();
    assert.notEqual(beforeFrozen.exitCode, 0);
    assert.match(beforeFrozen.stderr, /RESEARCH_INVESTIGATION_CERTIFICATION_NOT_FROZEN/);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), beforeUnpromoted);
    const scientific = (parts: string[], args: string[]) =>
      cli(["research", "scientific", ...parts, ...args, "--workspace", fx.root, "--json"]);
    const implementation = await must(
      await scientific(
        ["object", "register"],
        ["--kind", "model-implementation", "--path", scriptPath],
      ),
    );
    const environment = await must(
      await scientific(
        ["object", "register"],
        ["--kind", "environment-lock", "--path", environmentLockPath],
      ),
    );
    const fulfillmentInput = {
      schemaVersion: 1,
      designSha256: plan.designSha256,
      parentFulfillmentSha256: beforeView.headSha256,
      reason: "Freeze exactly the candidate authorized by the separate promotion plan",
      modelImplementations: [
        {
          modelId,
          objectLocator: implementation.objectLocator,
          sha256: implementation.sha256,
          recordSha256: implementation.recordSha256,
          entrypoint: "program.mjs",
        },
      ],
      environmentLocks: [
        {
          modelId,
          objectLocator: environment.objectLocator,
          sha256: environment.sha256,
          recordSha256: environment.recordSha256,
        },
      ],
      parameterStates: [],
    };
    await writeFile(inputPath, JSON.stringify(fulfillmentInput));
    await must(await scientific(["fulfillment", "record", projectId], ["--input", inputPath]));
    const frozen = await loadScientificFulfillmentView(
      fx.root,
      await loadProject(fx.root, projectId),
    );
    assert.equal(frozen.effectiveSha256, plan.expectedEffectiveDesignSha256);
    assert.equal(
      frozen.contract.identity.modelStructures[0]!.implementationArtifactSha256,
      candidate.recipe.script.sha256,
    );
    assert.equal(
      frozen.contract.identity.modelStructures[1]!.implementationStatus,
      "pending-source-acquisition",
    );
    await writeFile(
      certificationPath,
      JSON.stringify({
        ...certificationInput,
        arguments: [...certificationInput.arguments, "unapproved-change"],
      }),
    );
    const beforeChanged = await readFile(workspacePaths(fx.root).journal, "utf8");
    const changed = await observe();
    assert.notEqual(changed.exitCode, 0);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), beforeChanged);
    await writeFile(certificationPath, JSON.stringify(certificationInput));
    const beforeUsage = (await loadProject(fx.root, projectId)).usage.wallSeconds;
    const certified = await must(await observe());
    assert.equal(certified.record.status, "succeeded");
    assert.equal(
      certified.record.investigationCertification.promotionSha256,
      approved.recordSha256,
    );
    assert.equal(
      certified.record.investigationCertification.candidateSha256,
      candidate.recordSha256,
    );
    assert.equal(certified.record.investigationCertification.recipeSha256, candidate.recipeSha256);
    assert.equal(certified.record.investigationCertification.status, "passed");
    assert.equal(certified.record.investigationCertification.actualCostUsd, null);
    assert.match(
      certified.record.investigationCertification.isolation.policySha256,
      /^[a-f0-9]{64}$/,
    );
    const afterProject = await loadProject(fx.root, projectId);
    assert.ok(afterProject.usage.wallSeconds > beforeUsage);
    const allocation = afterProject.budget!.entries.find(
      (e) => e.id === `investigation-certification-${approved.recordSha256}`,
    )!;
    assert.equal(allocation.status, "settled");
    assert.equal(allocation.settlementBasis, "allocated-upper-bound");
    const certifiedJournal = await readFile(workspacePaths(fx.root).journal, "utf8");
    const replay = await must(await observe());
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.record, certified.record);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), certifiedJournal);
    await writeFile(
      certificationPath,
      JSON.stringify({ ...certificationInput, runId: "duplicate-certification" }),
    );
    const duplicate = await observe();
    assert.notEqual(duplicate.exitCode, 0);
    assert.match(duplicate.stderr, /RESEARCH_INVESTIGATION_CERTIFICATION_EXHAUSTED/);
    assert.equal(await readFile(workspacePaths(fx.root).journal, "utf8"), certifiedJournal);
    const taskStatus = JSON.parse((await fx.task(["status"])).stdout);
    assert.equal(taskStatus.currentScope.requirements[0].status, "unverified-certification");
    await writeFile(
      acceptancePath,
      JSON.stringify({
        ...oldAcceptance,
        previousRecordSha256: earlierAcceptance.recordSha256,
        nativeRunSha256: certified.record.recordSha256,
      }),
    );
    const certifiedAcceptance = await must(await accept());
    assert.equal(certifiedAcceptance.nativeRunSha256, certified.record.recordSha256);
    const pendingReview = JSON.parse((await fx.task(["status"])).stdout);
    assert.equal(pendingReview.currentScope.status, "incomplete");
    assert.equal(pendingReview.currentScope.requirements[0].status, "recorded");
  } finally {
    await fx.cleanup();
  }
});

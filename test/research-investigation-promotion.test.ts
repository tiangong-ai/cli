import { syntheticScientificPolicy } from "./helpers/scientific-policy.js";
import { scientificDesignInput, passResearchDesignGate } from "./helpers/scientific-design.js";
import { appendJournalEvent } from "../src/research/workspace/journal.js";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { acquiredFixture, cli } from "./helpers/task-fixture.js";
import { loadProject } from "../src/research/workspace/projects.js";
import { loadScientificFulfillmentView } from "../src/research/workspace/scientific-fulfillment.js";
import {
  canonicalJson,
  sha256Text,
  regularTreeFiles,
  sha256File,
  workspacePaths,
} from "../src/research/workspace/storage.js";

async function exactControl(root: string) {
  return Promise.all(
    (await regularTreeFiles(workspacePaths(root).control))
      .sort()
      .map(async (path) => [path, await sha256File(path)]),
  );
}
async function rewriteCertificationHistory(
  bundle: string,
  oldHash: string,
  effectiveHash: string,
  lateFreeze: boolean,
) {
  const manifestPath = join(bundle, "manifest.json"),
    proofPath = join(bundle, "state/journal-event-proofs.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")),
    proof = JSON.parse(await readFile(proofPath, "utf8"));
  const oldPath = `project/task/runs/${oldHash}.json`,
    run = JSON.parse(await readFile(join(bundle, oldPath), "utf8"));
  run.investigationCertification.effectiveDesignSha256 = effectiveHash;
  const { recordSha256: _old, ...core } = run;
  const newHash = sha256Text(canonicalJson(core));
  const newPath = `project/task/runs/${newHash}.json`,
    text = JSON.stringify({ ...core, recordSha256: newHash }, null, 2) + "\n";
  await rm(join(bundle, oldPath));
  await writeFile(join(bundle, newPath), text);
  Object.assign(
    manifest.files.find((f: { path: string }) => f.path === oldPath),
    { path: newPath, sha256: sha256Text(text), bytes: Buffer.byteLength(text) },
  );
  const completed = proof.events.find(
    (e: { type: string; payload: { recordSha256?: string } }) =>
      e.type === "project.task.run.completed" && e.payload.recordSha256 === oldHash,
  );
  completed.payload.recordSha256 = newHash;
  if (lateFreeze) {
    const index = proof.events.findIndex(
      (e: { type: string }) => e.type === "scientific.fulfillment.recorded",
    );
    const [fulfilled] = proof.events.splice(index, 1);
    const started = proof.events.findIndex(
      (e: { type: string; payload: { runId?: string } }) =>
        e.type === "project.task.run.started" && e.payload.runId === run.runId,
    );
    proof.events.splice(started + 1, 0, fulfilled);
  }
  let previous = "0".repeat(64);
  for (const [i, event] of proof.events.entries()) {
    event.sequence = i + 1;
    event.sourcePreviousHash = previous;
    event.sourcePayloadSha256 = sha256Text(canonicalJson(event.payload));
    event.sourceEventHash = sha256Text(
      canonicalJson({
        schemaVersion: 1,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        scope: event.scope,
        payload: event.payload,
        previousHash: previous,
      }),
    );
    previous = event.sourceEventHash;
  }
  proof.workspaceJournalHead = previous;
  manifest.sourceBindings.workspaceJournalHead = previous;
  const proofText = JSON.stringify(proof, null, 2) + "\n";
  await chmod(proofPath, 0o600);
  await writeFile(proofPath, proofText);
  Object.assign(
    manifest.files.find((f: { path: string }) => f.path === "state/journal-event-proofs.json"),
    { sha256: sha256Text(proofText), bytes: Buffer.byteLength(proofText) },
  );
  manifest.files.sort((a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const { manifestSha256: _manifest, ...manifestCore } = manifest;
  await chmod(manifestPath, 0o600);
  await writeFile(
    manifestPath,
    JSON.stringify(
      { ...manifestCore, manifestSha256: sha256Text(canonicalJson(manifestCore)) },
      null,
      2,
    ) + "\n",
  );
}

it("separately authorizes a selected recipe and freezes only its predeclared scientific slots", async () => {
  if (process.platform === "win32") return; // Execution confinement has its own unsupported-platform regression.
  const fx = await acquiredFixture("computation", 0, true);
  try {
    const projectId = "task-project";
    const command = (parts: string[], args: string[] = [], requestedProjectId = projectId) =>
      cli([
        "research",
        "project",
        "investigation",
        ...parts,
        requestedProjectId,
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
console.log(process.cwd().repeat(4));
await new Promise(resolve=>setTimeout(resolve,2000));
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
        maxOutputBytes: 1024,
        maxTotalOutputBytes: 262144,
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
    const closurePath = join(fx.files, "close-source-investigation.json");
    await writeFile(
      closurePath,
      JSON.stringify({
        schemaVersion: 1,
        investigationId: envelope.investigationId,
        reason:
          "Stop exploratory attempts after selection; preserve the candidate for separate promotion.",
      }),
    );
    const sourceClosure = await must(await command(["close"], ["--input", closurePath]));
    assert.equal(sourceClosure.releasedCostUpperBoundUsd, 0.8);
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
    const parallelPromotionPath = join(fx.files, "parallel-promotion.json");
    await writeFile(
      parallelPromotionPath,
      JSON.stringify({ ...promotionInput, promotionId: "parallel-certification" }),
    );
    const parallelPlan = await must(
      await command(["promotion", "plan"], ["--input", parallelPromotionPath]),
    );
    const parallelApproval = await must(
      await command(
        ["promotion", "approve"],
        [
          "--input",
          parallelPromotionPath,
          "--confirm",
          parallelPlan.planSha256,
          "--authorization-source",
          source,
        ],
      ),
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
    const observe = (path = certificationPath) =>
      cli([
        "research",
        "project",
        "task",
        "run",
        "observe",
        projectId,
        "--input",
        path,
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
    const competingInvestigationPath = join(fx.files, "competing-investigation.json");
    await writeFile(
      competingInvestigationPath,
      JSON.stringify({ ...envelope, investigationId: "post-freeze-diagnostics" }),
    );
    const competingPlan = await must(
      await command(["plan"], ["--input", competingInvestigationPath]),
    );
    const competingDefinition = await must(
      await command(
        ["approve"],
        [
          "--input",
          competingInvestigationPath,
          "--confirm",
          competingPlan.planSha256,
          "--authorization-source",
          source,
        ],
      ),
    );
    await writeFile(
      competingInvestigationPath,
      JSON.stringify({
        schemaVersion: 1,
        investigationId: "post-freeze-diagnostics",
        attemptId: "competing-investigation",
        programId: "solver",
        hypothesis: "Honor the time already reserved by a different promoted calculation",
        configuration: {},
        nativeSessionId: null,
        workingDirectory: fx.files,
      }),
    );
    const beforeUsage = (await loadProject(fx.root, projectId)).usage.wallSeconds;
    const configPath = workspacePaths(fx.root).config;
    const originalConfig = await readFile(configPath, "utf8");
    const tightConfig = JSON.parse(originalConfig);
    tightConfig.budget.maxWallSeconds = Math.ceil(beforeUsage) + 30;
    await writeFile(configPath, JSON.stringify(tightConfig));
    const parallelRunPath = join(fx.files, "parallel-certification.json");
    await writeFile(
      parallelRunPath,
      JSON.stringify({
        ...certificationInput,
        runId: "parallel-certification",
        investigationPromotionSha256: parallelApproval.recordSha256,
      }),
    );
    let firstFinished = false;
    const firstRun = observe().finally(() => {
      firstFinished = true;
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const events = (await readFile(workspacePaths(fx.root).journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (
        events.some(
          (e) => e.type === "project.task.run.started" && e.payload.runId === "certification-one",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      firstFinished,
      false,
      "The first actual process must still be in flight for this concurrency regression",
    );
    const [competing, competingInvestigation] = await Promise.all([
      observe(parallelRunPath),
      command(["attempt"], ["--input", competingInvestigationPath]),
    ]);
    const firstResult = await firstRun;
    await writeFile(configPath, originalConfig);
    assert.notEqual(
      competing.exitCode,
      0,
      "Separate promotions must share the remaining project wall budget",
    );
    assert.notEqual(
      competingInvestigation.exitCode,
      0,
      "Investigation attempts must also honor in-flight certification time",
    );
    const certified = await must(firstResult);
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
    const temporalBase = join(fx.files, "temporal-base-audit");
    await must(
      await cli([
        "research",
        "project",
        "audit",
        "export",
        projectId,
        "--output",
        temporalBase,
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    for (const lateFreeze of [false, true]) {
      const tampered = join(fx.files, lateFreeze ? "late-freeze-audit" : "wrong-view-audit");
      await cp(temporalBase, tampered, { recursive: true });
      await rewriteCertificationHistory(
        tampered,
        certified.record.recordSha256,
        lateFreeze ? beforeView.effectiveSha256 : "f".repeat(64),
        lateFreeze,
      );
      const rejected = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        tampered,
        "--json",
      ]);
      assert.notEqual(
        rejected.exitCode,
        0,
        lateFreeze
          ? "A model frozen after launch cannot justify that certification"
          : "A recomputed run hash cannot invent a scientific execution view",
      );
      assert.match(
        rejected.stderr,
        /Certification did not start from its exact frozen scientific execution view/,
      );
    }
    const afterProject = await loadProject(fx.root, projectId);
    assert.ok(afterProject.usage.wallSeconds > beforeUsage);
    const allocation = afterProject.budget!.entries.find(
      (e) => e.id === `investigation-certification-${approved.recordSha256}`,
    )!;
    assert.equal(allocation.status, "settled");
    assert.equal(allocation.settlementBasis, "allocated-upper-bound");
    const completedInvestigation = await must(
      await command(["status"], ["--investigation", envelope.investigationId]),
    );
    assert.equal(completedInvestigation.candidate.certification, "passed");
    assert.equal(completedInvestigation.allowedNextAction, "independent-review");

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
    await appendJournalEvent(
      workspacePaths(fx.root).journal,
      "investigation.approved",
      "unrelated-project",
      { investigationId: projectId, recordSha256: "a".repeat(64), planSha256: "b".repeat(64) },
    );
    const bundle = join(fx.files, "investigation-audit");
    await must(
      await cli([
        "research",
        "project",
        "audit",
        "export",
        projectId,
        "--output",
        bundle,
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    const targetId = "task-project-successor";
    const targetPolicy = await syntheticScientificPolicy(fx.root, targetId, [
      "model-calibrated-or-justified",
    ]);
    const targetDesign = await scientificDesignInput(fx.root, targetId, {
      pendingModels: true,
      policyRules: targetPolicy.resolvedRules,
      approvalStatus: "candidate-only",
    });
    await must(
      await cli([
        "research",
        "project",
        "fork",
        projectId,
        "--to",
        targetId,
        "--resume-through",
        "acquire",
        "--design",
        join(fx.root, `${targetId}-scientific-design.json`),
        "--design-producer-agent",
        targetDesign.producerAgent,
        "--design-producer-session",
        targetDesign.producerSessionId,
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    await passResearchDesignGate(fx.root, targetId);
    const targetStatus = JSON.parse((await fx.task(["status"], targetId)).stdout);
    const targetRow = targetStatus.currentScope.requirements[0];
    const targetModel = targetDesign.design.contract.identity.modelStructures[0]!;
    const targetPromotionPath = join(fx.files, "successor-promotion.json");
    await writeFile(
      targetPromotionPath,
      JSON.stringify({
        ...promotionInput,
        promotionId: "successor-promotion",
        requirementId: targetRow.id,
        requirementSha256: targetRow.requirementSha256,
        modelId: targetModel.id,
      }),
    );
    const targetPlan = await must(
      await command(["promotion", "plan"], ["--input", targetPromotionPath], targetId),
    );
    assert.equal(targetPlan.route, "successor-fulfillment");
    const targetApproval = await must(
      await command(
        ["promotion", "approve"],
        [
          "--input",
          targetPromotionPath,
          "--confirm",
          targetPlan.planSha256,
          "--authorization-source",
          source,
        ],
        targetId,
      ),
    );
    const targetFulfillmentPath = join(fx.files, "successor-fulfillment.json");
    await writeFile(
      targetFulfillmentPath,
      JSON.stringify({
        ...fulfillmentInput,
        designSha256: targetPlan.designSha256,
        parentFulfillmentSha256: null,
        modelImplementations: fulfillmentInput.modelImplementations.map((i) => ({
          ...i,
          modelId: targetModel.id,
        })),
        environmentLocks: fulfillmentInput.environmentLocks.map((i) => ({
          ...i,
          modelId: targetModel.id,
        })),
      }),
    );
    await must(
      await scientific(["fulfillment", "record", targetId], ["--input", targetFulfillmentPath]),
    );
    const targetAcceptancePath = join(fx.files, "successor-acceptance.json");
    const targetAcceptance = {
      ...oldAcceptance,
      requirementId: targetRow.id,
      requirementSha256: targetRow.requirementSha256,
      previousRecordSha256: null,
      nativeRunSha256: certified.record.recordSha256,
    };
    await writeFile(targetAcceptancePath, JSON.stringify(targetAcceptance));
    const targetAccept = () =>
      cli([
        "research",
        "project",
        "task",
        "acceptance",
        "record",
        targetId,
        "--input",
        targetAcceptancePath,
        "--workspace",
        fx.root,
        "--json",
      ]);
    const cannotBorrow = await targetAccept();
    assert.notEqual(cannotBorrow.exitCode, 0);
    const targetRunPath = join(fx.files, "successor-run.json");
    await writeFile(
      targetRunPath,
      JSON.stringify({
        ...certificationInput,
        runId: "successor-certification",
        requirementId: targetRow.id,
        requirementSha256: targetRow.requirementSha256,
        investigationPromotionSha256: targetApproval.recordSha256,
      }),
    );
    const targetRun = await must(
      await cli([
        "research",
        "project",
        "task",
        "run",
        "observe",
        targetId,
        "--input",
        targetRunPath,
        "--confirm-execution",
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    assert.equal(targetRun.record.investigationCertification.status, "passed");
    assert.notEqual(targetRun.record.recordSha256, certified.record.recordSha256);
    await writeFile(
      targetAcceptancePath,
      JSON.stringify({ ...targetAcceptance, nativeRunSha256: targetRun.record.recordSha256 }),
    );
    await must(await targetAccept());
    await writeFile(
      targetPromotionPath,
      JSON.stringify({
        ...promotionInput,
        promotionId: "output-recertification",
        requirementId: targetRow.id,
        requirementSha256: targetRow.requirementSha256,
        modelId: targetModel.id,
      }),
    );
    const outputPlan = await must(
      await command(["promotion", "plan"], ["--input", targetPromotionPath], targetId),
    );
    const outputApproval = await must(
      await command(
        ["promotion", "approve"],
        [
          "--input",
          targetPromotionPath,
          "--confirm",
          outputPlan.planSha256,
          "--authorization-source",
          source,
        ],
        targetId,
      ),
    );
    const longWorkingDirectory = join(fx.files, "long-working-directory-" + "x".repeat(180));
    await mkdir(longWorkingDirectory);
    await writeFile(
      targetRunPath,
      JSON.stringify({
        ...certificationInput,
        runId: "output-limited-certification",
        workingDirectory: longWorkingDirectory,
        requirementId: targetRow.id,
        requirementSha256: targetRow.requirementSha256,
        investigationPromotionSha256: outputApproval.recordSha256,
      }),
    );
    const limitedCertificationResult = await cli([
      "research",
      "project",
      "task",
      "run",
      "observe",
      targetId,
      "--input",
      targetRunPath,
      "--confirm-execution",
      "--workspace",
      fx.root,
      "--json",
    ]);
    assert.notEqual(limitedCertificationResult.exitCode, 0);
    const limitedCertification = JSON.parse(limitedCertificationResult.stdout);
    assert.equal(limitedCertification.record.status, "output-limit-exceeded");
    assert.equal(limitedCertification.record.investigationCertification.status, "failed");
    assert.equal(limitedCertification.record.investigationCertification.outputLimitExceeded, true);
    assert.ok(limitedCertification.record.investigationCertification.observedOutputBytes > 1024);
    const targetBundle = join(fx.files, "successor-audit");
    const targetManifest = await must(
      await cli([
        "research",
        "project",
        "audit",
        "export",
        targetId,
        "--output",
        targetBundle,
        "--workspace",
        fx.root,
        "--json",
      ]),
    );
    assert.ok(
      targetManifest.files.some(
        (f: { path: string }) =>
          f.path ===
          `investigation-sources/${projectId}/task/investigation-candidates/${candidate.recordSha256}.json`,
      ),
    );
    assert.equal(
      targetManifest.files.some((f: { path: string }) =>
        f.path.includes(competingDefinition.recordSha256),
      ),
      false,
    );
    await rm(fx.root, { recursive: true, force: true });
    const verify = () =>
      cli(["research", "project", "audit", "verify", "--bundle", bundle, "--json"]);
    const verifiedTarget = await must(
      await cli(["research", "project", "audit", "verify", "--bundle", targetBundle, "--json"]),
    );
    assert.deepEqual(verifiedTarget.task.investigations, {
      definitions: 1,
      attempts: 1,
      candidates: 1,
      promotions: 2,
      certifications: 2,
      closures: 1,
    });
    {
      const targetManifestPath = join(targetBundle, "manifest.json");
      const missingSourcePath = `investigation-sources/${projectId}/task/investigation-candidates/${candidate.recordSha256}.json`;
      const changed = JSON.parse(await readFile(targetManifestPath, "utf8"));
      await rm(join(targetBundle, missingSourcePath));
      changed.files = changed.files.filter((f: { path: string }) => f.path !== missingSourcePath);
      const { manifestSha256: _previous, ...core } = changed;
      await chmod(targetManifestPath, 0o600);
      await writeFile(
        targetManifestPath,
        JSON.stringify({ ...core, manifestSha256: sha256Text(canonicalJson(core)) }, null, 2) +
          "\n",
      );
      const missingSource = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        targetBundle,
        "--json",
      ]);
      assert.notEqual(
        missingSource.exitCode,
        0,
        "A successor cannot discard the original selected candidate behind its recipe",
      );
    }
    const verifiedAudit = await must(await verify());
    assert.deepEqual(verifiedAudit.task.investigations, {
      definitions: 2,
      attempts: 1,
      candidates: 1,
      promotions: 2,
      certifications: 1,
      closures: 1,
    });
    {
      const statePath = join(bundle, "state/project.json"),
        manifestFile = join(bundle, "manifest.json");
      const originalState = await readFile(statePath, "utf8"),
        originalManifest = await readFile(manifestFile, "utf8");
      const state = JSON.parse(originalState),
        modified = JSON.parse(originalManifest);
      state.budget.authorization.unexpected = { authorization: { value: "fixture-not-a-secret" } };
      const text = JSON.stringify(state, null, 2) + "\n";
      await chmod(statePath, 0o600);
      await writeFile(statePath, text);
      const entry = modified.files.find((f: { path: string }) => f.path === "state/project.json");
      entry.sha256 = sha256Text(text);
      entry.bytes = Buffer.byteLength(text);
      const { manifestSha256: _old, ...core } = modified;
      await chmod(manifestFile, 0o600);
      await writeFile(
        manifestFile,
        JSON.stringify({ ...core, manifestSha256: sha256Text(canonicalJson(core)) }, null, 2) +
          "\n",
      );
      const nestedCredential = await verify();
      assert.notEqual(nestedCredential.exitCode, 0);
      assert.match(nestedCredential.stderr, /RESEARCH_AUDIT_BUNDLE_SENSITIVE/);
      await writeFile(statePath, originalState);
      await chmod(statePath, 0o444);
      await writeFile(manifestFile, originalManifest);
      await chmod(manifestFile, 0o444);
    }
    const candidatePath = `project/task/investigation-candidates/${candidate.recordSha256}.json`;
    const manifestPath = join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(manifest.files.some((f: { path: string }) => f.path === candidatePath));
    await rm(join(bundle, candidatePath));
    manifest.files = manifest.files.filter((f: { path: string }) => f.path !== candidatePath);
    const { manifestSha256: _oldManifest, ...manifestCore } = manifest;
    await chmod(manifestPath, 0o600);
    await writeFile(
      manifestPath,
      JSON.stringify(
        { ...manifestCore, manifestSha256: sha256Text(canonicalJson(manifestCore)) },
        null,
        2,
      ) + "\n",
    );
    const missingCandidate = await verify();
    assert.notEqual(
      missingCandidate.exitCode,
      0,
      "A recomputed manifest cannot erase the selected candidate behind a certified run",
    );
  } finally {
    await fx.cleanup();
  }
});

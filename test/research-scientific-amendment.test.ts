import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import { readAndVerifyScientificDesign } from "../src/research/workspace/scientific-design.js";
import {
  initializeResearchPolicy,
  approveResearchPolicy,
  loadApprovedResearchPolicy,
} from "../src/research/workspace/research-policy.js";
import {
  canonicalJson,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/research/workspace/storage.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import {
  exportProjectAuditBundle,
  verifyProjectAuditBundle,
} from "../src/research/workspace/audit-bundle.js";
import { prepareScientificReview } from "../src/research/workspace/scientific-review.js";
import { loadScientificFulfillmentView } from "../src/research/workspace/scientific-fulfillment.js";
import {
  scientificDesignInput,
  passResearchDesignGate,
  submitPassingReview,
} from "./helpers/scientific-design.js";

describe("owner-authorized pre-analysis scientific amendments", () => {
  it("plans an exact pending-rule binding correction without changing the project or journal", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-design-amendment-"));
    const projectId = "design-amendment";
    try {
      await initializeResearchWorkspace(root, undefined);
      const policy = await parameterPolicy(root, projectId);
      const designInput = await scientificDesignInput(root, projectId, {
        pendingUncertainty: true,
        policyRules: policy.resolvedRules,
        approvalStatus: "candidate-only",
      });
      const design = designInput.design.contract;
      const rule = design.policyRuleDispositions.find(
        (item) => item.ruleId === "robustness-and-uncertainty-reviewed",
      )!;
      const parameterId = design.uncertaintyParameters.find(
        (item) => item.stateValueStatus === "pending-source-acquisition",
      )!.id;
      assert.ok(parameterId);
      rule.uncertaintyParameterIds = [];
      rule.dueGate = "evidence-construct";
      const designPath = join(root, "unbound-design.json");
      await writeJsonAtomic(designPath, design);
      designInput.design = await readAndVerifyScientificDesign(designPath, projectId);
      const project = await initializeProject(
        root,
        projectId,
        "Can a pending policy declaration bind its existing parameter without changing the scientific question?",
        undefined,
        false,
        undefined,
        policy,
        designInput,
      );
      await passResearchDesignGate(root, projectId);
      const beforeProject = canonicalJson(await loadProject(root, projectId));
      let journalReads = 0;
      const originalRead = fs.readFile;
      const reader = t.mock.method(fs, "readFile", (...args: Parameters<typeof readFile>) => {
        if (String(args[0]) === workspacePaths(root).journal) journalReads += 1;
        return originalRead(...args);
      });
      syncBuiltinESMExports();
      try {
        await loadScientificFulfillmentView(root, await loadProject(root, projectId));
      } finally {
        reader.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(
        journalReads,
        0,
        "an unamended base must not reread the full journal for each design view",
      );
      const beforeJournal = await readFile(workspacePaths(root).journal, "utf8");
      const originalPath = join(
        workspacePaths(root).control,
        project.scientificDesign!.objectLocator,
      );
      const beforeDesign = await sha256File(originalPath);
      const inputPath = join(root, "amendment.json");
      await writeJsonAtomic(inputPath, {
        schemaVersion: 1,
        reason: "Bind the existing pending uncertainty parameter to its planned Policy obligation.",
        changes: [
          {
            ruleId: rule.ruleId,
            dueGate: rule.dueGate,
            rationale: rule.rationale,
            modelStructureIds: rule.modelStructureIds,
            uncertaintyParameterIds: [parameterId],
          },
        ],
      });
      const result = await invoke([
        "research",
        "scientific",
        "amendment",
        "plan",
        projectId,
        "--input",
        inputPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.projectId, projectId);
      assert.equal(plan.parentDesignSha256, beforeDesign);
      assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
      assert.equal(plan.changes[0].ruleId, rule.ruleId);
      assert.deepEqual(plan.changes[0].before.uncertaintyParameterIds, []);
      assert.deepEqual(plan.changes[0].after.uncertaintyParameterIds, [parameterId]);
      assert.equal(plan.changes[0].after.status, "planned");
      assert.equal(canonicalJson(await loadProject(root, projectId)), beforeProject);
      assert.equal(await readFile(workspacePaths(root).journal, "utf8"), beforeJournal);
      assert.equal(await sha256File(originalPath), beforeDesign);
      const repeated = await invoke([
        "research",
        "scientific",
        "amendment",
        "plan",
        projectId,
        "--input",
        inputPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).planSha256, plan.planSha256);
      const inputValue = JSON.parse(await readFile(inputPath, "utf8"));
      for (const bad of [
        { ...inputValue, question: "Change the scientific question" },
        { ...inputValue, changes: [{ ...inputValue.changes[0], status: "satisfied-by-design" }] },
        {
          ...inputValue,
          changes: [{ ...inputValue.changes[0], uncertaintyParameterIds: ["undeclared"] }],
        },
        { ...inputValue, changes: [inputValue.changes[0], inputValue.changes[0]] },
      ]) {
        await writeJsonAtomic(inputPath, bad);
        const rejected = await invoke([
          "research",
          "scientific",
          "amendment",
          "plan",
          projectId,
          "--input",
          inputPath,
          "--workspace",
          root,
          "--json",
        ]);
        assert.notEqual(rejected.exitCode, 0);
        assert.equal(await readFile(workspacePaths(root).journal, "utf8"), beforeJournal);
      }
      await writeJsonAtomic(inputPath, {
        ...inputValue,
        reason: "A separate proposed correction requiring its own fresh approval.",
        changes: [
          {
            ...inputValue.changes[0],
            rationale: "Bind the same declared parameter under a separately proposed rationale.",
          },
        ],
      });
      const alternate = await invoke([
        "research",
        "scientific",
        "amendment",
        "plan",
        projectId,
        "--input",
        inputPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(alternate.exitCode, 0, alternate.stderr);
      const stalePlan = JSON.parse(alternate.stdout);
      const planPath = join(root, "reviewed-plan.json");
      const authorizationPath = join(root, "owner-confirmation.txt");
      await writeJsonAtomic(planPath, plan);
      await writeTextAtomic(
        authorizationPath,
        "\uFEFF批准此精确修订。Synthetic owner confirmation of this exact pending-rule binding correction.",
      );
      const command = [
        "research",
        "scientific",
        "amendment",
        "apply",
        projectId,
        "--plan",
        planPath,
        "--authorization-source",
        authorizationPath,
        "--workspace",
        root,
        "--json",
      ];
      const unconfirmed = await invoke(command);
      assert.notEqual(unconfirmed.exitCode, 0);
      assert.equal(await readFile(workspacePaths(root).journal, "utf8"), beforeJournal);
      const policyPath = join(root, "research-policy", projectId, policy.documents[0]!.logicalPath);
      const policyBytes = await readFile(policyPath);
      await writeFile(
        policyPath,
        Buffer.concat([policyBytes, Buffer.from("\nChanged after exact approval.\n")]),
      );
      try {
        const changedPolicy = await invoke([...command, "--confirm", plan.planSha256]);
        assert.notEqual(
          changedPolicy.exitCode,
          0,
          "a changed approved Policy must not admit the old plan",
        );
        assert.equal(await readFile(workspacePaths(root).journal, "utf8"), beforeJournal);
      } finally {
        await writeFile(policyPath, policyBytes);
      }
      const storedSource = join(
        workspacePaths(root).projects,
        projectId,
        "scientific/authorization",
        `${await sha256File(authorizationPath)}.txt`,
      );
      await mkdir(dirname(storedSource), { recursive: true });
      await symlink(join(root, "missing-confirmation-target"), storedSource);
      const linked = await invoke([...command, "--confirm", plan.planSha256]);
      assert.notEqual(
        linked.exitCode,
        0,
        "a dangling immutable-source link must not be overwritten",
      );
      assert.equal((await lstat(storedSource)).isSymbolicLink(), true);
      assert.equal(await readFile(workspacePaths(root).journal, "utf8"), beforeJournal);
      await unlink(storedSource);
      const originalRename = fs.rename;
      let projectionFailures = 0;
      const renamer = t.mock.method(fs, "rename", (...args: Parameters<typeof fs.rename>) => {
        if (
          String(args[1]) === join(workspacePaths(root).projects, projectId, "project.json") &&
          projectionFailures < 2
        ) {
          projectionFailures += 1;
          return Promise.reject(
            Object.assign(new Error("Synthetic post-commit projection failure"), { code: "EIO" }),
          );
        }
        return originalRename(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          invoke([...command, "--confirm", plan.planSha256]),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO",
        );
        assert.equal(projectionFailures, 2);
      } finally {
        renamer.mock.restore();
        syncBuiltinESMExports();
      }
      const applied = await invoke([...command, "--confirm", plan.planSha256]);
      assert.equal(applied.exitCode, 0, applied.stderr);
      const record = JSON.parse(applied.stdout);
      assert.equal(record.plan.planSha256, plan.planSha256);
      assert.equal(record.amendmentAuthorization.kind, "operator-confirmation");
      assert.equal(record.amendmentAuthorization.sourceSha256, await sha256File(authorizationPath));
      const amended = await loadProject(root, projectId);
      assert.equal(amended.scientificDesign!.designSha256, beforeDesign);
      assert.equal(amended.scientificDesign!.gates["research-design"].status, "pending");
      assert.equal(await sha256File(originalPath), beforeDesign);
      const view = await loadScientificFulfillmentView(root, amended);
      const amendedRule = view.contract.policyRuleDispositions.find(
        (item) => item.ruleId === rule.ruleId,
      )!;
      assert.deepEqual(amendedRule.uncertaintyParameterIds, [parameterId]);
      assert.equal(amendedRule.status, "planned");
      const journalAfter = await readFile(workspacePaths(root).journal, "utf8");
      await writeJsonAtomic(planPath, stalePlan);
      const stale = await invoke([...command, "--confirm", stalePlan.planSha256]);
      assert.equal(stale.exitCode, 3, stale.stderr);
      assert.equal(await readFile(workspacePaths(root).journal, "utf8"), journalAfter);
      await writeJsonAtomic(planPath, plan);
      const replay = await invoke([...command, "--confirm", plan.planSha256]);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).recordSha256, record.recordSha256);
      assert.equal(await readFile(workspacePaths(root).journal, "utf8"), journalAfter);
      const status = await invoke([
        "research",
        "scientific",
        "amendment",
        "status",
        projectId,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).amendmentSha256, record.recordSha256);
      const packet = await prepareScientificReview({
        root,
        projectId,
        role: "research-design",
        assessmentPath: join(root, `${projectId}-research-design-assessment.json`),
        reviewerAgent: "claude",
        reviewerSessionId: "independent-amended-design-review",
      });
      assert.equal(packet.design.amendmentSha256, record.recordSha256);
      assert.ok(
        packet.stageInputs.some(
          (item) => item.sha256 === record.amendmentAuthorization.sourceSha256,
        ),
      );
      assert.ok(
        packet.stageInputs.some((item) =>
          item.sourceLocator.endsWith(`/amendments/${record.recordSha256}.json`),
        ),
      );
      assert.ok(packet.stageInputs.some((item) => item.purpose === "effective-scientific-design"));
      const destination = join(root, "portable-amendment-audit");
      await exportProjectAuditBundle({ root, projectId, destination });
      assert.equal((await verifyProjectAuditBundle(destination)).status, "verified");
      const second = await invoke([
        "research",
        "scientific",
        "amendment",
        "plan",
        projectId,
        "--input",
        inputPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(second.exitCode, 0, second.stderr);
      const secondPlan = JSON.parse(second.stdout);
      assert.equal(secondPlan.parentAmendmentSha256, record.recordSha256);
      await writeJsonAtomic(planPath, secondPlan);
      const secondApplied = await invoke([...command, "--confirm", secondPlan.planSha256]);
      assert.equal(secondApplied.exitCode, 0, secondApplied.stderr);
      await assert.rejects(submitPassingReview(root, projectId, packet));
      await passResearchDesignGate(root, projectId, "independent-second-amendment-review");
      const secondView = await loadScientificFulfillmentView(
        root,
        await loadProject(root, projectId),
      );
      assert.equal(secondView.amendments.length, 2);
      assert.equal(secondView.amendments[0]!.recordSha256, record.recordSha256);
      assert.equal(await sha256File(originalPath), beforeDesign);
      const secondDestination = join(root, "portable-amendment-history-audit");
      await exportProjectAuditBundle({ root, projectId, destination: secondDestination });
      assert.equal((await verifyProjectAuditBundle(secondDestination)).status, "verified");
      const committed = (await readFile(workspacePaths(root).journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        committed.filter((event) => event.type === "scientific.amendment.recorded").length,
        2,
      );
      const retainedSourceBytes = await readFile(storedSource);
      await chmod(storedSource, 0o600);
      await writeFile(storedSource, "Changed authorization source bytes.");
      await assert.rejects(loadScientificFulfillmentView(root, await loadProject(root, projectId)));
      await writeFile(storedSource, retainedSourceBytes);
      await chmod(storedSource, 0o444);
      const postAnalysis = await loadProject(root, projectId);
      postAnalysis.packages.find((item) => item.stage === "analyze")!.attempts = 1;
      await saveProject(root, postAnalysis);
      const late = await invoke([
        "research",
        "scientific",
        "amendment",
        "plan",
        projectId,
        "--input",
        inputPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(late.exitCode, 3, late.stderr);
      assert.equal(JSON.parse(late.stderr).error.code, "RESEARCH_SCIENTIFIC_AMENDMENT_UNAVAILABLE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

async function parameterPolicy(root: string, projectId: string): Promise<ResearchPolicyBinding> {
  const sourceRoot = join(root, "synthetic-policy");
  const reviewerRoles = ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"];
  const documents = [
    ["baseline/top-journal.md", "baseline", "bundled-default"],
    ["article-types/computational-modeling.md", "article-type", "bundled-default"],
    ["fields/pavement-engineering.md", "field", "bundled-default"],
    ["journal-classes/discipline-flagship.md", "journal-class", "bundled-default"],
    ...reviewerRoles.map((role) => [
      `reviewer-rubrics/${role}.md`,
      "reviewer-rubric",
      "bundled-default",
    ]),
    ["project/publication-brief.md", "publication-brief", "project-template"],
    ["journals/exact-journal-template.md", "exact-journal", "exact-journal-template"],
  ];
  for (const [path, kind, templateClass] of documents) {
    const metadata = {
      schemaVersion: 1,
      id: `fixture.${path!.replaceAll("/", ".").replace(/\.md$/, "")}`,
      kind,
      templateClass,
      policyVersion: 1,
      targetTier: "top",
      articleType: "computational-modeling",
      field: "pavement-engineering",
      journalClass: "discipline-flagship",
      targetJournal: "none",
      centralQuestion:
        "Can a frozen source parameter be filled without changing its scientific identity?",
      centralClaim: "Protocol behavior is validated using explicitly synthetic sources.",
      centralOutcome: "Correct hash and parameter bindings, not a scientific estimate.",
      contributionType: "protocol-fixture",
      rules: ["uncertainty-propagated", "robustness-and-uncertainty-reviewed"],
      constraints: {
        requireScientificDesignContract: true,
        requireEarlyScientificReviews: true,
        requireRealRecordConstructCanary: true,
      },
      requiredReviewers: reviewerRoles,
      reviewAfterDays: 365,
    };
    await writeTextAtomic(
      join(sourceRoot, "assets/research-policy/defaults", path!),
      `---\n${JSON.stringify(metadata)}\n---\n\n# Synthetic policy\n\nZero-cost deterministic protocol fixture, not journal approval.\n`,
    );
  }
  await initializeResearchPolicy({
    root,
    projectId,
    sourceRoot,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
  });
  await approveResearchPolicy(root, projectId, { confirm: true, acknowledgeDefaults: true });
  return loadApprovedResearchPolicy(root, projectId);
}

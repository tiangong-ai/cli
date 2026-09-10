import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { initializeProject, loadProject } from "../src/research/workspace/projects.js";
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
import { scientificDesignInput } from "./helpers/scientific-design.js";

describe("owner-authorized pre-analysis scientific amendments", () => {
  it("plans an exact pending-rule binding correction without changing the project or journal", async () => {
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
      const beforeProject = canonicalJson(await loadProject(root, projectId));
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

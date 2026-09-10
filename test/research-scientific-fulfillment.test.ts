import assert from "node:assert/strict";
import {
  defineProjectTask,
  taskRequirementSha256,
} from "../src/research/workspace/task-contract.js";
import {
  recordProjectTaskAcceptance,
  compileTaskAcceptanceContext,
} from "../src/research/workspace/task-acceptance.js";
import fs from "node:fs/promises";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCurrentEvidenceSnapshot } from "../src/research/workspace/acquisition.js";
import { loadBoundAcquisitionDesign } from "../src/research/workspace/acquisition-routes.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import {
  freezeEvidenceContentSnapshot,
  registerEvidenceAtom,
} from "../src/research/workspace/content-evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import {
  addProjectInput,
  initializeProject,
  loadProject,
} from "../src/research/workspace/projects.js";
import {
  applyScientificAmendment,
  planScientificAmendment,
} from "../src/research/workspace/scientific-amendment.js";
import {
  exportProjectAuditBundle,
  verifyProjectAuditBundle,
} from "../src/research/workspace/audit-bundle.js";
import {
  loadScientificFulfillmentView,
  recordScientificFulfillment,
} from "../src/research/workspace/scientific-fulfillment.js";
import { readAndVerifyScientificDesign } from "../src/research/workspace/scientific-design.js";
import { prepareScientificReview } from "../src/research/workspace/scientific-review.js";
import {
  initializeResearchPolicy,
  approveResearchPolicy,
  loadApprovedResearchPolicy,
} from "../src/research/workspace/research-policy.js";
import {
  prepareNativeResearchStage,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import {
  workspacePaths,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { passResearchDesignGate, scientificDesignInput } from "./helpers/scientific-design.js";

describe("predeclared scientific parameter fulfillment", () => {
  it("recognizes native POSIX and Windows atom paths in the I/O counter", () => {
    assert.equal(isAtomRecordRead("/study/evidence/atoms/source.json", "source"), true);
    assert.equal(isAtomRecordRead("C:\\study\\evidence\\atoms\\source.json", "source"), true);
    assert.equal(isAtomRecordRead("/study/evidence/atoms/other.json", "source"), false);
  });
  for (const impactBinding of ["claim", "coverage"] as const) {
    it(`binds exact source-derived states and reuses checks through ${impactBinding} amendment impact`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "tiangong-parameter-fulfillment-"));
      const projectId = "parameter-fulfillment";
      try {
        await initializeResearchWorkspace(root, undefined);
        await lockCapabilities(root);
        const policy = await parameterPolicy(root, projectId);
        const designInput = await scientificDesignInput(root, projectId, {
          pendingUncertainty: true,
          policyRules: policy.resolvedRules,
          approvalStatus: "candidate-only",
        });
        const original = designInput.design.contract;
        const parameter = original.uncertaintyParameters.find(
          (item) => item.stateValueStatus === "pending-source-acquisition",
        )!;
        const secondParameter = original.uncertaintyParameters.find(
          (item) => item.id === "uncertainty-shared-layer-modulus",
        )!;
        secondParameter.stateValueStatus = "pending-source-acquisition";
        secondParameter.freezeBeforeGate = "evidence-construct";
        original.policyRuleDispositions
          .find((item) => item.ruleId === "uncertainty-propagated")!
          .uncertaintyParameterIds.push(secondParameter.id);
        const unrelatedDeclaration = original.policyRuleDispositions.find(
          (item) => item.ruleId === "uncertainty-propagated",
        )!;
        unrelatedDeclaration.claimIds = [];
        unrelatedDeclaration.evidenceRoleIds = [];
        if (impactBinding === "coverage")
          for (const role of original.evidenceRoles)
            if (!role.coverageDimensionIds.includes("research-question"))
              role.coverageDimensionIds.push("research-question");
        const designPath = join(root, `${projectId}-scientific-design.json`);
        await writeJsonAtomic(designPath, original);
        designInput.design = await readAndVerifyScientificDesign(designPath, projectId);
        const project = await initializeProject(
          root,
          projectId,
          "Can exact admitted source states fulfill their already declared uncertainty slots?",
          undefined,
          false,
          undefined,
          policy,
          designInput,
        );
        const affectedDeclaration = original.policyRuleDispositions.find(
          (item) => item.ruleId === "robustness-and-uncertainty-reviewed",
        )!;
        const amendmentRequirements = [
          {
            id: "declaration-check",
            text: "Inspect the current planned robustness declaration and parameter bindings.",
            acceptance: "The inspection reflects the current declaration and its bound claim.",
            checkKind: "evidence" as const,
            designClaimIds: impactBinding === "claim" ? affectedDeclaration.claimIds : [],
            coverageDimensionIds: impactBinding === "coverage" ? ["research-question"] : [],
          },
          {
            id: "source-check",
            text: "Inspect the unchanged admitted source parameter text.",
            acceptance: "Source text and its admitted atom remain readable and consistent.",
            checkKind: "evidence" as const,
            designClaimIds: [],
            coverageDimensionIds: [],
          },
        ];
        await defineProjectTask(root, projectId, {
          schemaVersion: 1,
          originalRequest: "Inspect the planned declaration and unchanged source independently.",
          requirements: amendmentRequirements,
        });
        const inputPath = join(root, "source.txt");
        const states = parameter.states.map((state, index) => ({
          stateId: state.id,
          value: String(0.9 + index * 0.1),
          evidenceAtomIds: ["parameter-source-atom"],
        }));
        await writeFile(
          inputPath,
          `Synthetic source states for a deterministic protocol test only: ${states.map((state) => `${state.stateId}=${state.value}`).join(", ")}; ${secondParameter.states.map((state) => `${state.id}=${state.value}`).join(", ")}.\n`,
        );
        await addProjectInput(root, projectId, inputPath, "primary");
        await passResearchDesignGate(root, projectId);
        const discover = await prepareNativeResearchStage({
          root,
          projectId,
          stage: "discover",
          hostAgent: "codex",
        });
        const candidate = (await listEvidenceCandidates(root, projectId))[0]!;
        await recordDiscoveryAssessmentBatch({
          root,
          projectId,
          value: {
            schemaVersion: 1,
            assessments: [
              {
                decision: "admit",
                candidateId: candidate.id,
                sourceId: "parameter-source",
                sourceType: "primary",
                relevance: "Exact synthetic source-derived states.",
                quality: {
                  level: "primary",
                  rationale: "Deterministic synthetic protocol input, not scientific evidence.",
                },
                applicability: "Protocol test only.",
                coverageDimensions: ["research-question"],
                limitations: [],
              },
            ],
          },
        });
        const output = join(root, "stage-output.json");
        await writeJsonAtomic(output, {
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
        });
        await submitNativeResearchStage({
          root,
          projectId,
          sessionId: discover.sessionId,
          outputPath: output,
          confirmedModel: discover.expectedModel,
        });
        const acquire = await prepareNativeResearchStage({
          root,
          projectId,
          stage: "acquire",
          hostAgent: "codex",
        });
        await writeJsonAtomic(output, {
          schemaVersion: 1,
          decisions: [
            {
              sourceId: "parameter-source",
              candidateId: candidate.id,
              artifactIds: [],
              status: "accepted",
              rationale: "The admitted input is the exact readable source.",
              limitations: [],
            },
          ],
          gaps: [],
          limitations: [],
        });
        await submitNativeResearchStage({
          root,
          projectId,
          sessionId: acquire.sessionId,
          outputPath: output,
          confirmedModel: acquire.expectedModel,
        });
        const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
        const artifact = snapshot.artifacts[0]!;
        const atom = await registerEvidenceAtom({
          root,
          projectId,
          value: {
            schemaVersion: 1,
            atomId: "parameter-source-atom",
            sourceId: "parameter-source",
            candidateId: candidate.id,
            artifactId: artifact.artifactId,
            locator: { kind: "line-range", startLine: 1, endLine: 1 },
            statement: "Source states for the protocol fixture.",
            evidenceRoleIds: [parameter.sourceEvidenceRoleIds[0]!],
            coverageDimensionIds: ["research-question"],
            evidenceFunction: "support",
            scope: "Synthetic protocol fixture, not a research conclusion.",
            limitations: [],
          },
        });
        await freezeEvidenceContentSnapshot(root, projectId);
        const input = {
          schemaVersion: 1,
          designSha256: project.scientificDesign!.designSha256,
          parentFulfillmentSha256: null,
          reason:
            "Freeze exactly the source-derived states declared before discovery; all scientific and coverage gates remain in force.",
          modelImplementations: [],
          environmentLocks: [],
          parameterStates: [{ parameterId: parameter.id, states }],
        };
        const journal = await readFile(workspacePaths(root).journal, "utf8");
        await assert.rejects(
          recordScientificFulfillment(root, projectId, {
            ...input,
            parameterStates: [
              {
                parameterId: parameter.id,
                states: states.map((state) => ({ ...state, evidenceAtomIds: ["invented-atom"] })),
              },
            ],
          }),
        );
        await assert.rejects(
          recordScientificFulfillment(root, projectId, {
            ...input,
            parameterStates: [
              {
                parameterId: parameter.id,
                states: [{ ...states[0], value: "NaN" }, ...states.slice(1)],
              },
            ],
          }),
        );
        assert.equal(
          await readFile(workspacePaths(root).journal, "utf8"),
          journal,
          "failed parameter intake commits nothing",
        );
        const record = await recordScientificFulfillment(root, projectId, input);
        assert.deepEqual(await recordScientificFulfillment(root, projectId, input), record);
        assert.ok(
          record.parameterStates[0]!.states.every(
            (state) => state.atoms[0]?.sha256 === atom.atomSha256,
          ),
        );
        await recordScientificFulfillment(root, projectId, {
          ...input,
          parentFulfillmentSha256: record.recordSha256,
          parameterStates: [
            {
              parameterId: secondParameter.id,
              states: secondParameter.states.map((state) => ({
                stateId: state.id,
                value: state.value,
                evidenceAtomIds: [atom.atomId],
              })),
            },
          ],
        });
        const beforeAmendment = await loadScientificFulfillmentView(
          root,
          await loadProject(root, projectId),
        );
        const beforeContent = await readFile(
          join(workspacePaths(root).projects, projectId, "outputs/content-snapshot.json"),
          "utf8",
        );
        const beforeSource = await sha256File(inputPath);
        const plannedRule = beforeAmendment.contract.policyRuleDispositions.find(
          (item) => item.ruleId === "robustness-and-uncertainty-reviewed",
        )!;
        const inspectionPath = join(root, "declaration-inspection.txt");
        await writeFile(inspectionPath, JSON.stringify(plannedRule));
        const checks = amendmentRequirements.map((requirement) => ({
          schemaVersion: 1,
          requirementId: requirement.id,
          requirementSha256: taskRequirementSha256(requirement),
          previousRecordSha256: null,
          outcome: "satisfied",
          summary: requirement.text,
          checkKind: "evidence",
          reportedCommand: null,
          sourceIds: ["parameter-source"],
          evidenceAtomIds: [atom.atomId],
          analysisFindingIds: [],
          resultFiles: requirement.id === "declaration-check" ? [inspectionPath] : [],
          limitations: [],
        }));
        for (const check of checks) await recordProjectTaskAcceptance(root, projectId, check);
        const acceptanceBefore = await compileTaskAcceptanceContext(
          root,
          await loadProject(root, projectId),
        );
        const plan = await planScientificAmendment(root, projectId, {
          schemaVersion: 1,
          reason: "Bind the existing source-filled parameter to its planned robustness obligation.",
          changes: [
            {
              ruleId: plannedRule.ruleId,
              dueGate: "evidence-construct",
              rationale: plannedRule.rationale,
              modelStructureIds: [],
              uncertaintyParameterIds: [parameter.id],
            },
          ],
        });
        assert.deepEqual(plan.affectedTaskRequirementIds, ["declaration-check"]);
        const confirmationPath = join(root, "amendment-confirmation.txt");
        await writeFile(
          confirmationPath,
          "Synthetic owner approval of this exact rule-binding amendment.",
        );
        await applyScientificAmendment(root, projectId, plan, plan.planSha256, confirmationPath);
        const afterAmendment = await loadScientificFulfillmentView(
          root,
          await loadProject(root, projectId),
        );
        assert.deepEqual(afterAmendment.records, beforeAmendment.records);
        const acceptanceAfter = await compileTaskAcceptanceContext(
          root,
          await loadProject(root, projectId),
        );
        const oldCheck = acceptanceBefore!.requirements.find(
          (row) => row.id === "declaration-check",
        )!.record!;
        assert.equal(
          acceptanceBefore!.requirements.find((row) => row.id === "declaration-check")!.status,
          "recorded",
        );
        assert.equal(
          acceptanceAfter!.requirements.find((row) => row.id === "declaration-check")!.status,
          "stale",
        );
        assert.equal(
          acceptanceAfter!.requirements.find((row) => row.id === "source-check")!.status,
          "recorded",
        );
        assert.notEqual(acceptanceAfter!.contextSha256, acceptanceBefore!.contextSha256);
        const sourceCheck = acceptanceBefore!.requirements.find(
          (row) => row.id === "source-check",
        )!.record!;
        assert.equal(
          (await recordProjectTaskAcceptance(root, projectId, checks[1]!)).recordSha256,
          sourceCheck.recordSha256,
        );
        const staleDestination = join(root, "stale-declaration-audit");
        await exportProjectAuditBundle({ root, projectId, destination: staleDestination });
        assert.equal((await verifyProjectAuditBundle(staleDestination)).status, "verified");
        await writeFile(
          inspectionPath,
          JSON.stringify(
            afterAmendment.contract.policyRuleDispositions.find(
              (item) => item.ruleId === plannedRule.ruleId,
            ),
          ),
        );
        const recheck = {
          ...checks[0]!,
          previousRecordSha256: oldCheck.recordSha256,
          summary:
            "The current amended declaration now binds the existing source-filled parameter.",
        };
        const freshCheck = await recordProjectTaskAcceptance(root, projectId, recheck);
        assert.notEqual(freshCheck.recordSha256, oldCheck.recordSha256);
        const currentAcceptance = await compileTaskAcceptanceContext(
          root,
          await loadProject(root, projectId),
        );
        assert.equal(
          currentAcceptance!.requirements.find((row) => row.id === "declaration-check")!.status,
          "recorded",
        );
        const laterRule = afterAmendment.contract.policyRuleDispositions.find(
          (item) => item.ruleId === "uncertainty-propagated",
        )!;
        const unrelatedPlan = await planScientificAmendment(root, projectId, {
          schemaVersion: 1,
          reason:
            "Add an independently approved lifecycle explanation unrelated to these task checks.",
          changes: [
            {
              ruleId: laterRule.ruleId,
              dueGate: laterRule.dueGate,
              rationale:
                laterRule.rationale + " Clarify the existing source provenance requirement.",
              modelStructureIds: laterRule.modelStructureIds,
              uncertaintyParameterIds: laterRule.uncertaintyParameterIds,
            },
          ],
        });
        assert.deepEqual(unrelatedPlan.affectedTaskRequirementIds, []);
        const laterConfirmation = join(root, "later-amendment-confirmation.txt");
        await writeFile(
          laterConfirmation,
          "Synthetic owner approval of the exact second rationale amendment.",
        );
        await applyScientificAmendment(
          root,
          projectId,
          unrelatedPlan,
          unrelatedPlan.planSha256,
          laterConfirmation,
        );
        assert.equal(
          (await compileTaskAcceptanceContext(root, await loadProject(root, projectId)))!
            .contextSha256,
          currentAcceptance!.contextSha256,
        );
        assert.equal(
          (await recordProjectTaskAcceptance(root, projectId, recheck)).recordSha256,
          freshCheck.recordSha256,
        );
        assert.equal(
          (await recordProjectTaskAcceptance(root, projectId, checks[1]!)).recordSha256,
          sourceCheck.recordSha256,
        );
        assert.equal(
          (await loadCurrentEvidenceSnapshot(root, projectId)).snapshotSha256,
          snapshot.snapshotSha256,
        );
        assert.equal(
          await readFile(
            join(workspacePaths(root).projects, projectId, "outputs/content-snapshot.json"),
            "utf8",
          ),
          beforeContent,
        );
        assert.equal(await sha256File(inputPath), beforeSource);
        assert.ok(afterAmendment.deferredObjectRuleIds.includes(plannedRule.ruleId));
        await passResearchDesignGate(root, projectId, "fresh-amended-parameter-design-review");
        let atomReads = 0;
        const originalReadFile = fs.readFile;
        const reader = t.mock.method(fs, "readFile", (...args: Parameters<typeof readFile>) => {
          if (isAtomRecordRead(args[0], atom.atomId)) atomReads += 1;
          return originalReadFile(...args);
        });
        syncBuiltinESMExports();
        const effective = await loadBoundAcquisitionDesign(
          root,
          await loadProject(root, projectId),
        ).finally(() => {
          reader.mock.restore();
          syncBuiltinESMExports();
        });
        assert.equal(
          atomReads,
          1,
          "One view must verify the atom store once, not once per fulfillment record",
        );
        const frozen = effective.uncertaintyParameters.find((item) => item.id === parameter.id)!;
        assert.equal(frozen.stateValueStatus, "frozen");
        assert.equal(frozen.freezeBeforeGate, parameter.freezeBeforeGate);
        assert.deepEqual(
          frozen.states.map(({ value: _value, ...state }) => state),
          parameter.states.map(({ value: _value, ...state }) => state),
        );
        assert.deepEqual(effective.claims, original.claims);
        assert.deepEqual(effective.factors, original.factors);
        await assert.rejects(
          recordScientificFulfillment(root, projectId, {
            ...input,
            parentFulfillmentSha256: record.recordSha256,
          }),
          /pending slots/,
        );
        assert.equal(
          (await loadProject(root, projectId)).scientificDesign!.gates["research-design"].status,
          "passed",
        );
        const canaryPath = join(await realpath(root), "source-canary.json");
        await writeJsonAtomic(canaryPath, {
          sourceId: "parameter-source",
          rowCount: 1,
          syntheticProtocolFixture: true,
        });
        const assessmentPath = join(root, "evidence-assessment.json");
        await writeJsonAtomic(assessmentPath, {
          schemaVersion: 1,
          role: "evidence-construct",
          designSha256: project.scientificDesign!.designSha256,
          recommendation: "stop",
          constructCanary: {
            usesRealRecords: false,
            outcomeBlind: true,
            resultValuesInspected: false,
            rowCount: 1,
            constructedEdgeIds: [],
            failedEdgeIds: original.edges
              .filter((edge) => edge.role === "central")
              .map((edge) => edge.id),
            artifactSha256s: [await sha256File(canaryPath)],
          },
          evidenceRoleCoverage: [],
          closestWorkDispositionComplete: false,
          centralEvidenceFitsContext: true,
          findings: [],
        });
        const packet = await prepareScientificReview({
          root,
          projectId,
          role: "evidence-construct",
          assessmentPath,
          reviewerAgent: "claude",
          reviewerSessionId: "source-readable-review",
          canaryArtifactPaths: [canaryPath],
        });
        assert.equal(
          packet.mechanicalAssessment.canPass,
          false,
          "a synthetic protocol fixture is not a passing scientific study",
        );
        assert.ok(
          packet.stageInputs.some(
            (input) => input.sha256 === artifact.sha256 && input.sourceLocator === artifact.locator,
          ),
          "scientific review needs the exact acquired source bytes, not only source hashes/excerpts",
        );
        const destination = join(root, "amended-fulfillment-audit");
        await exportProjectAuditBundle({ root, projectId, destination });
        assert.equal((await verifyProjectAuditBundle(destination)).status, "verified");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function isAtomRecordRead(path: unknown, atomId: string): boolean {
  return String(path).replaceAll("\\", "/").endsWith(`/evidence/atoms/${atomId}.json`);
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

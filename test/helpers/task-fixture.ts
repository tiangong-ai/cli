import { syntheticScientificPolicy } from "./scientific-policy.js";
import { scientificDesignInput, passResearchDesignGate } from "./scientific-design.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";
import { lockCapabilities } from "../../src/research/workspace/capabilities.js";
import { addProjectInput, initializeProject } from "../../src/research/workspace/projects.js";
import { initializeResearchWorkspace } from "../../src/research/workspace/workspace.js";
import {
  prepareNativeResearchStage,
  submitNativeResearchStage,
} from "../../src/research/workspace/runtime.js";
import { listEvidenceCandidates } from "../../src/research/workspace/evidence-ledger.js";
import { recordDiscoveryAssessmentBatch } from "../../src/research/workspace/discovery.js";
import { loadCurrentEvidenceSnapshot } from "../../src/research/workspace/acquisition.js";
import {
  registerEvidenceAtom,
  freezeEvidenceContentSnapshot,
} from "../../src/research/workspace/content-evidence.js";

export async function cli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: {
      write: (value: string) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr += value;
      },
    },
  });
  return { exitCode, stdout, stderr };
}

export function contractInput() {
  return {
    schemaVersion: 1,
    originalRequest:
      "Compare electricity and water evidence, retaining uncertainty and counterevidence.",
    requirements: [
      {
        id: "electricity",
        text: "Assess the available electricity evidence.",
        acceptance: "Provide a traceable comparison and explicit uncertainty.",
        checkKind: "evidence",
        designClaimIds: [],
        coverageDimensionIds: ["research-question"],
      },
      {
        id: "water",
        text: "Assess water evidence independently from electricity.",
        acceptance: "Provide water evidence or identify the exact unresolved data requirement.",
        checkKind: "evidence",
        designClaimIds: [],
        coverageDimensionIds: ["research-question"],
      },
    ],
  };
}

export async function fixture(pendingModels = false) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-task-contract-"));
  const files = await mkdtemp(join(tmpdir(), "tiangong-task-contract-files-"));
  await initializeResearchWorkspace(root, undefined);
  await lockCapabilities(root);
  const policy = pendingModels
    ? await syntheticScientificPolicy(root, "task-project", ["model-calibrated-or-justified"])
    : undefined;
  const design = policy
    ? await scientificDesignInput(root, "task-project", {
        pendingModels: true,
        policyRules: policy.resolvedRules,
        approvalStatus: "candidate-only",
      })
    : undefined;
  await initializeProject(
    root,
    "task-project",
    "Compare electricity and water evidence without presupposing a result.",
    undefined,
    false,
    undefined,
    policy,
    design,
  );
  const task = async (args: string[], projectId = "task-project") =>
    cli([
      "research",
      "project",
      "task",
      ...args.slice(0, 1),
      projectId,
      ...args.slice(1),
      "--workspace",
      root,
      "--json",
    ]);
  const inputPath = join(files, "requirements.json");
  await writeFile(inputPath, JSON.stringify(contractInput()));
  return {
    root,
    files,
    inputPath,
    task,
    cleanup: () =>
      Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(files, { recursive: true, force: true }),
      ]),
  };
}

export async function acquiredFixture(
  checkKind: "evidence" | "computation" = "evidence",
  inputPaddingBytes = 0,
  pendingModels = false,
) {
  const fx = await fixture(pendingModels);
  const declaration = contractInput();
  declaration.requirements[0]!.checkKind = checkKind;
  await writeFile(fx.inputPath, JSON.stringify(declaration));
  const defined = await fx.task(["define", "--input", fx.inputPath]);
  assert.equal(defined.exitCode, 0, defined.stderr);
  const inputPath = join(fx.files, "evidence.txt");
  await writeFile(
    inputPath,
    "Synthetic electricity and water comparison: no measured difference in this fixture.\n" +
      "non-embedded-input-padding\n".repeat(Math.ceil(inputPaddingBytes / 27)),
  );
  await addProjectInput(fx.root, "task-project", inputPath, "primary");
  if (pendingModels) await passResearchDesignGate(fx.root, "task-project");
  const discover = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "discover",
    hostAgent: "codex",
  });
  const [candidate] = await listEvidenceCandidates(fx.root, "task-project");
  assert.ok(candidate);
  await recordDiscoveryAssessmentBatch({
    root: fx.root,
    projectId: "task-project",
    value: {
      schemaVersion: 1,
      assessments: [
        {
          decision: "admit",
          candidateId: candidate.id,
          sourceId: "source-1",
          sourceType: "primary",
          relevance: "Direct fixture data.",
          quality: { level: "primary", rationale: "Exact synthetic input." },
          applicability: "Fixture only.",
          coverageDimensions: ["research-question"],
          limitations: [],
        },
      ],
    },
  });
  await submitFixtureStage(fx, discover, {
    schemaVersion: 2,
    limitations: [],
    dimensionJudgments: [{ id: "research-question", status: "covered" }],
    gaps: [],
  });
  const acquire = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "acquire",
    hostAgent: "codex",
  });
  await submitFixtureStage(fx, acquire, {
    schemaVersion: 1,
    decisions: [
      {
        sourceId: "source-1",
        candidateId: candidate.id,
        artifactIds: [],
        status: "accepted",
        rationale: "Exact readable input.",
        limitations: [],
      },
    ],
    limitations: [],
    gaps: [],
  });
  const snapshot = await loadCurrentEvidenceSnapshot(fx.root, "task-project");
  const artifact = snapshot.artifacts[0]!;
  const atom = await registerEvidenceAtom({
    root: fx.root,
    projectId: "task-project",
    value: {
      schemaVersion: 1,
      atomId: "task-fixture-atom",
      sourceId: "source-1",
      candidateId: candidate.id,
      artifactId: artifact.artifactId,
      locator: { kind: "line-range", startLine: 1, endLine: 1 },
      statement: "The fixture records a null comparison.",
      evidenceRoleIds: pendingModels ? ["role-central-model"] : [],
      coverageDimensionIds: ["research-question"],
      evidenceFunction: "support",
      scope: "Deterministic protocol fixture only.",
      limitations: [],
    },
  });
  await freezeEvidenceContentSnapshot(fx.root, "task-project");
  const rows = JSON.parse((await fx.task(["status"])).stdout).currentScope.requirements as Array<{
    id: string;
    requirementSha256: string;
  }>;
  return { ...fx, artifact, atom, rows };
}

export async function submitFixtureStage(
  fx: Awaited<ReturnType<typeof fixture>>,
  packet: Awaited<ReturnType<typeof prepareNativeResearchStage>>,
  value: object,
) {
  const outputPath = join(fx.files, `${packet.stage}.json`);
  await writeFile(outputPath, JSON.stringify(value));
  return submitNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    sessionId: packet.sessionId,
    outputPath,
    confirmedModel: packet.expectedModel,
  });
}

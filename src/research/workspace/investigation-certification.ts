import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import {
  investigationAttemptHistory,
  parseInvestigationDiagnostic,
} from "./investigation-attempt.js";
import { loadInvestigationCandidates } from "./investigation-candidate.js";
import {
  loadInvestigationPromotion,
  type InvestigationPromotion,
} from "./investigation-promotion.js";
import { loadInvestigation } from "./investigation.js";
import type { NativeRunInput, NativeRunRecord, captureProcess } from "./native-run.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import {
  applyScientificFulfillmentRecord,
  loadScientificFulfillmentView,
} from "./scientific-fulfillment.js";
import { canonicalJson, sha256File, sha256Text, workspacePaths } from "./storage.js";
import type { JournalEvent, ProjectState } from "./types.js";

function failure(message: string, code = "RESEARCH_INVESTIGATION_CERTIFICATION_INVALID") {
  return new CliError(message, { code, exitCode: 3 });
}
export async function assertInvestigationCertificationRequired(
  root: string,
  projectId: string,
  input: NativeRunInput,
  events: JournalEvent[],
) {
  if (input.investigationPromotionSha256) return;
  for (const event of events) {
    if (event.scope !== projectId || event.type !== "investigation.approved") continue;
    const definition = await loadInvestigation(
      root,
      projectId,
      String(event.payload.investigationId),
      events,
    );
    if (
      definition.plan.requirementId === input.requirementId &&
      definition.plan.requirementSha256 === input.requirementSha256
    )
      throw failure(
        "This investigated requirement needs an exact approved promotion and a fresh certification run. Diagnostic or ordinary runs cannot bypass that boundary.",
        "RESEARCH_INVESTIGATION_CERTIFICATION_REQUIRED",
      );
  }
}
export async function frozenPromotionView(
  root: string,
  project: ProjectState,
  promotion: InvestigationPromotion,
  events: JournalEvent[],
) {
  const plan = promotion.plan;
  if (
    !project.publicationPolicy ||
    !project.scientificDesign ||
    project.scientificDesign.designSha256 !== plan.designSha256 ||
    project.publicationPolicy.resolvedPolicySha256 !== plan.policySha256 ||
    sha256Text(project.question) !== plan.questionSha256
  )
    throw failure("Certification scientific identity changed; review a new exact promotion.");
  await assertResearchPolicyBinding(root, project.publicationPolicy);
  const view = await loadScientificFulfillmentView(root, project, undefined, events);
  const model = view.contract.identity.modelStructures.find((m) => m.id === plan.modelId);
  const recipe = plan.recipe;
  if (
    !model ||
    model.implementationStatus !== "executable-frozen" ||
    model.implementationArtifactSha256 !== recipe.script.sha256 ||
    model.implementationEntrypoint !==
      (recipe.runtime.kind === "node" ? "program.mjs" : "program.py") ||
    model.environmentLockStatus !== "exact-frozen" ||
    model.environmentLockSha256 !== recipe.environmentLock.sha256
  )
    throw failure(
      "Freeze the exact authorized implementation and environment through the existing fulfillment or successor route before certification.",
      "RESEARCH_INVESTIGATION_CERTIFICATION_NOT_FROZEN",
    );
  const before = structuredClone(view.amendedBase);
  let extendsPlan = sha256Text(canonicalJson(before)) === plan.beforeEffectiveDesignSha256;
  for (const record of view.records) {
    applyScientificFulfillmentRecord(before, record);
    extendsPlan ||= sha256Text(canonicalJson(before)) === plan.beforeEffectiveDesignSha256;
  }
  if (!extendsPlan)
    throw failure("The scientific declaration no longer extends the approved promotion view.");
  const acquisition = await loadCurrentEvidenceSnapshot(root, project.id);
  if (acquisition.snapshotSha256 !== plan.acquisitionSnapshotSha256)
    throw failure("The certification acquisition changed after promotion approval.");
  return view.effectiveSha256;
}
export async function prepareInvestigationCertification(
  root: string,
  project: ProjectState,
  input: NativeRunInput,
  binarySha256: string,
  events: JournalEvent[],
) {
  const hash = input.investigationPromotionSha256;
  if (!hash) return null;
  const promotion = await loadInvestigationPromotion(root, project.id, hash, events);
  if (
    events.some(
      (e) =>
        e.scope === project.id &&
        e.type === "project.task.run.started" &&
        e.payload.investigationPromotionSha256 === hash,
    )
  )
    throw failure(
      "This promotion already started its one authorized certification. Inspect that run; a new certification needs a new exact promotion approval.",
      "RESEARCH_INVESTIGATION_CERTIFICATION_EXHAUSTED",
    );
  const plan = promotion.plan;
  if (
    plan.requirementId !== input.requirementId ||
    plan.requirementSha256 !== input.requirementSha256
  )
    throw failure("Certification must use the promoted requirement version.");
  const definition = await loadInvestigation(
    root,
    plan.sourceProjectId,
    plan.investigationId,
    events,
  );
  const attempts = await investigationAttemptHistory(
    root,
    plan.sourceProjectId,
    definition,
    events,
  );
  const candidates = await loadInvestigationCandidates(
    root,
    plan.sourceProjectId,
    definition,
    events,
    attempts,
  );
  const candidate = candidates.find((c) => c.recordSha256 === plan.candidateSha256);
  if (
    !candidate ||
    candidate.recipeSha256 !== plan.recipeSha256 ||
    canonicalJson(candidate.recipe) !== canonicalJson(plan.recipe)
  )
    throw failure("The approved recipe does not match its original observed candidate.");
  const recipe = plan.recipe;
  if (
    input.timeoutSeconds > plan.certification.maxRunSeconds ||
    input.runtime.kind !== recipe.runtime.kind ||
    binarySha256 !== recipe.runtime.binarySha256 ||
    canonicalJson(input.arguments) !== canonicalJson(recipe.arguments) ||
    canonicalJson(input.outputs) !== canonicalJson(recipe.outputs) ||
    canonicalJson(input.inputs) !==
      canonicalJson(
        recipe.inputs.map((i) => ({ id: i.id, artifactId: i.artifactId, sha256: i.sha256 })),
      )
  )
    throw failure(
      "Certification inputs, runtime, arguments, outputs or time exceed the exact promoted recipe.",
    );
  const effectiveDesignSha256 = await frozenPromotionView(root, project, promotion, events);
  for (const [path, hash] of [
    [input.scriptPath, recipe.script.sha256],
    [input.environmentLockPath, recipe.environmentLock.sha256],
  ]) {
    const info = await lstat(path!);
    if (!info.isFile() || info.isSymbolicLink() || (await sha256File(path!)) !== hash)
      throw failure(
        "Certification implementation or environment bytes differ from the promoted recipe.",
      );
  }
  const allocation = project.budget?.entries.find(
    (e) => e.id === `investigation-certification-${promotion.recordSha256}`,
  );
  if (
    !allocation ||
    allocation.status !== "reserved" ||
    allocation.maxCostUsd !== plan.certification.maxCostUsd
  )
    throw failure("Certification has no current exact cost reservation.");
  return { promotion, effectiveDesignSha256 };
}
type ProcessObservation = Awaited<ReturnType<typeof captureProcess>>;
export interface InvestigationCertification {
  promotionSha256: string;
  candidateSha256: string;
  recipeSha256: string;
  effectiveDesignSha256: string;
  status: "passed" | "failed";
  diagnostic: ReturnType<typeof parseInvestigationDiagnostic>;
  missingTelemetry: string[];
  actualCostUsd: null;
  accountedCostUpperBoundUsd: number;
  isolation: { provider: string; policySha256: string };
  runtimeProbeIsolation: { provider: string; policySha256: string };
  runtimeProbe: Omit<ProcessObservation, "stdout" | "stderr">;
}
export async function certificationAssessment(
  root: string,
  projectId: string,
  context: NonNullable<Awaited<ReturnType<typeof prepareInvestigationCertification>>>,
  status: NativeRunRecord["status"],
  outputs: NativeRunRecord["outputs"],
  runtimeProbe: ProcessObservation,
  isolation: InvestigationCertification["isolation"],
  runtimeProbeIsolation: InvestigationCertification["isolation"],
): Promise<InvestigationCertification> {
  const plan = context.promotion.plan;
  const output = outputs.find(
    (o) => o.id === plan.recipe.diagnosticOutputId && o.mediaType === "application/json",
  );
  let diagnostic: ReturnType<typeof parseInvestigationDiagnostic> = null;
  if (output && output.bytes <= 65536) {
    try {
      diagnostic = parseInvestigationDiagnostic(
        JSON.parse(
          await readFile(join(workspacePaths(root).projects, projectId, output.path), "utf8"),
        ),
      );
    } catch {
      /* Missing diagnostics cannot certify the recipe. */
    }
  }
  const missingTelemetry = diagnostic?.solverReached
    ? [
        ...plan.recipe.telemetry.requiredMetrics
          .filter((id) => !Object.hasOwn(diagnostic!.metrics, id))
          .map((id) => `metrics.${id}`),
        ...plan.recipe.telemetry.requiredStatuses
          .filter((id) => !Object.hasOwn(diagnostic!.statuses, id))
          .map((id) => `statuses.${id}`),
      ].sort()
    : [];
  const { stdout: _stdout, stderr: _stderr, ...probe } = runtimeProbe;
  return {
    promotionSha256: context.promotion.recordSha256,
    candidateSha256: plan.candidateSha256,
    recipeSha256: plan.recipeSha256,
    effectiveDesignSha256: context.effectiveDesignSha256,
    status:
      status === "succeeded" &&
      diagnostic?.solverReached &&
      diagnostic.feasible &&
      !missingTelemetry.length
        ? "passed"
        : "failed",
    diagnostic,
    missingTelemetry,
    actualCostUsd: null,
    accountedCostUpperBoundUsd: plan.certification.maxCostUsd,
    isolation,
    runtimeProbeIsolation,
    runtimeProbe: probe,
  };
}

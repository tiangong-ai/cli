import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { investigationAttemptHistory } from "./investigation-attempt.js";
import { loadInvestigationCandidates } from "./investigation-candidate.js";
import { loadInvestigation } from "./investigation.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { storeRunObject } from "./native-run.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { remainingProjectCostUsd, reserveProjectCost } from "./project-budget.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { loadProject } from "./projects.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import {
  applyScientificFulfillmentRecord,
  loadScientificFulfillmentView,
  type ScientificFulfillmentProjection,
} from "./scientific-fulfillment.js";
import { canonicalJson, sha256File, sha256Text, workspacePaths } from "./storage.js";
import { loadProjectTask, taskRequirementSha256, writeTaskObject } from "./task-contract.js";
import type { JournalEvent, OutputRecord } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";
const HASH = /^[a-f0-9]{64}$/;
interface PromotionInput {
  schemaVersion: 1;
  promotionId: string;
  sourceProjectId: string;
  investigationId: string;
  candidateSha256: string;
  requirementId: string;
  requirementSha256: string;
  modelId: string;
  maxRunSeconds: number;
  maxCostUsd: number;
}
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "promotionId",
    "sourceProjectId",
    "investigationId",
    "candidateSha256",
    "requirementId",
    "requirementSha256",
    "modelId",
    "maxRunSeconds",
    "maxCostUsd",
  ],
  properties: {
    schemaVersion: { const: 1 },
    promotionId: id,
    sourceProjectId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,63}$" },
    investigationId: id,
    candidateSha256: { type: "string", pattern: HASH.source },
    requirementId: id,
    requirementSha256: { type: "string", pattern: HASH.source },
    modelId: id,
    maxRunSeconds: { type: "integer", minimum: 1, maximum: 172800 },
    maxCostUsd: { type: "number", minimum: 0 },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile<PromotionInput>(schema);
export function investigationPromotionInputSchema() {
  return structuredClone(schema);
}
function failure(message: string, code = "RESEARCH_INVESTIGATION_PROMOTION_INVALID") {
  return new CliError(message, { code, exitCode: 3 });
}
function parse(value: unknown): PromotionInput {
  if (
    !validate(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw failure("Promotion must match the closed non-secret schema.");
  return structuredClone(value);
}
export async function planInvestigationPromotion(root: string, projectId: string, value: unknown) {
  const input = parse(value);
  const project = await loadProject(root, projectId);
  const source =
    projectId === input.sourceProjectId ? project : await loadProject(root, input.sourceProjectId);
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  assertProjectAuthority(project, projectAuthorityIndex(events));
  const definition = await loadInvestigation(
    root,
    input.sourceProjectId,
    input.investigationId,
    events,
  );
  const attempts = await investigationAttemptHistory(
    root,
    input.sourceProjectId,
    definition,
    events,
  );
  const candidates = await loadInvestigationCandidates(
    root,
    input.sourceProjectId,
    definition,
    events,
    attempts,
  );
  const candidate = candidates.at(-1);
  if (
    !candidate ||
    candidate.recordSha256 !== input.candidateSha256 ||
    attempts.some((a) => !a.record)
  )
    throw failure(
      "Promotion requires the current exact selected candidate and no unresolved attempt.",
    );
  const task = await loadProjectTask(root, projectId, events);
  if (
    !task?.current.requirements.some(
      (r) =>
        r.id === input.requirementId &&
        taskRequirementSha256(r) === input.requirementSha256 &&
        r.checkKind === "computation",
    )
  )
    throw failure("Promotion must bind an active computational requirement.");
  const analyze = project.packages.find((p) => p.stage === "analyze");
  if (
    !project.publicationPolicy ||
    !project.scientificDesign ||
    project.handoff.state !== "agent-actionable" ||
    project.status === "complete" ||
    !analyze ||
    analyze.attempts > 0 ||
    analyze.startedAt ||
    !["pending", "ready"].includes(analyze.status) ||
    project.packages.find((p) => p.stage === "acquire")?.status !== "complete"
  )
    throw failure(
      "Promote through the existing approved scientific design at an idle pre-analysis boundary; otherwise create the applicable reviewed successor.",
      "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
    );
  if (
    projectId !== input.sourceProjectId &&
    (project.lineage.derivedFrom !== input.sourceProjectId ||
      source.lineage.supersededBy !== projectId)
  )
    throw failure(
      "A changed scientific scope must use its actual authoritative successor relationship.",
      "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
    );
  await assertResearchPolicyBinding(root, project.publicationPolicy);
  const view = await loadScientificFulfillmentView(root, project, undefined, events);
  const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
  if (
    !candidate.recipe.inputs.every((i) =>
      snapshot.artifacts.some(
        (a) => a.artifactId === i.artifactId && a.sha256 === i.sha256 && a.bytes === i.bytes,
      ),
    )
  )
    throw failure("The target must freeze the candidate's exact canonical input bytes.");
  if (projectId === input.sourceProjectId) {
    if (
      definition.plan.requirementId !== input.requirementId ||
      definition.plan.requirementSha256 !== input.requirementSha256 ||
      definition.plan.questionSha256 !== sha256Text(project.question) ||
      definition.plan.designSha256 !== project.scientificDesign.designSha256 ||
      definition.plan.policySha256 !== project.publicationPolicy.resolvedPolicySha256 ||
      definition.plan.acquisitionSnapshotSha256 !== snapshot.snapshotSha256
    )
      throw failure(
        "Changed question, requirement, Policy, design or acquisition needs an explicitly reviewed successor.",
        "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
      );
    // Later fulfillment of predeclared slots is permitted. The same immutable
    // declaration must still reproduce the investigation's earlier view.
    const earlier = structuredClone(view.amendedBase);
    let extendsInvestigation =
      sha256Text(canonicalJson(earlier)) === definition.plan.effectiveDesignSha256;
    for (const record of view.records) {
      applyScientificFulfillmentRecord(earlier, record);
      extendsInvestigation ||=
        sha256Text(canonicalJson(earlier)) === definition.plan.effectiveDesignSha256;
    }
    if (!extendsInvestigation)
      throw failure(
        "Scientific declaration changes require a new reviewed successor.",
        "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
      );
  }
  const model = view.contract.identity.modelStructures.find((m) => m.id === input.modelId);
  if (!model) throw failure("Promotion must name a model declared by the target design.");
  const recipe = candidate.recipe;
  const entrypoint = recipe.runtime.kind === "node" ? "program.mjs" : "program.py";
  const fulfillment: ScientificFulfillmentProjection = {
    modelImplementations: [],
    environmentLocks: [],
    parameterStates: [],
  };
  if (
    model.implementationStatus === "pending-source-acquisition" &&
    model.implementationFreezeBeforeGate !== "research-design"
  )
    fulfillment.modelImplementations.push({
      modelId: model.id,
      sha256: recipe.script.sha256,
      objectLocator: `lineage/objects/${recipe.script.sha256}/blob`,
      entrypoint,
      dueGate: model.implementationFreezeBeforeGate,
    });
  else if (
    model.implementationStatus !== "executable-frozen" ||
    model.implementationArtifactSha256 !== recipe.script.sha256 ||
    model.implementationEntrypoint !== entrypoint
  )
    throw failure(
      "Replacing a frozen model implementation requires a reviewed successor.",
      "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
    );
  if (
    model.environmentLockStatus === "pending-runtime-lock" &&
    model.environmentLockFreezeBeforeGate !== "research-design"
  )
    fulfillment.environmentLocks.push({
      modelId: model.id,
      sha256: recipe.environmentLock.sha256,
      objectLocator: `lineage/objects/${recipe.environmentLock.sha256}/blob`,
      dueGate: model.environmentLockFreezeBeforeGate,
    });
  else if (
    model.environmentLockStatus !== "exact-frozen" ||
    model.environmentLockSha256 !== recipe.environmentLock.sha256
  )
    throw failure(
      "Replacing a frozen environment declaration requires a reviewed successor.",
      "RESEARCH_INVESTIGATION_SUCCESSOR_REQUIRED",
    );
  const projected = structuredClone(view.contract);
  applyScientificFulfillmentRecord(projected, fulfillment);
  const config = await loadWorkspaceConfig(root);
  if (
    !project.budget ||
    input.maxCostUsd > remainingProjectCostUsd(project, config) + 1e-9 ||
    input.maxRunSeconds >
      Math.min(
        config.budget.packageMaxWallSeconds.analyze,
        config.budget.maxWallSeconds - project.usage.wallSeconds,
      )
  )
    throw failure(
      "Configure a finite project budget that can admit the one separately authorized certification run.",
    );
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-investigation-promotion-plan" as const,
    projectId,
    promotionId: input.promotionId,
    sourceProjectId: input.sourceProjectId,
    investigationId: input.investigationId,
    candidateSha256: candidate.recordSha256,
    definitionSha256: definition.recordSha256,
    recipeSha256: candidate.recipeSha256,
    recipe,
    requirementId: input.requirementId,
    requirementSha256: input.requirementSha256,
    modelId: input.modelId,
    requestSha256: sha256Text(canonicalJson(input)),
    route:
      projectId !== input.sourceProjectId
        ? ("successor-fulfillment" as const)
        : fulfillment.modelImplementations.length || fulfillment.environmentLocks.length
          ? ("predeclared-fulfillment" as const)
          : ("frozen-recipe" as const),
    questionSha256: sha256Text(project.question),
    designSha256: project.scientificDesign.designSha256,
    policySha256: project.publicationPolicy.resolvedPolicySha256,
    acquisitionSnapshotSha256: snapshot.snapshotSha256,
    beforeEffectiveDesignSha256: view.effectiveSha256,
    expectedEffectiveDesignSha256: sha256Text(canonicalJson(projected)),
    parentFulfillmentSha256: view.headSha256,
    fulfillment,
    certification: {
      maxRuns: 1 as const,
      maxRunSeconds: input.maxRunSeconds,
      maxCostUsd: input.maxCostUsd,
      maxOutputBytes: candidate.recipe.maxOutputBytes,
    },
    purpose: "authorize-freezing-and-fresh-certification" as const,
  };
  return { ...core, planSha256: sha256Text(canonicalJson(core)) };
}
export type InvestigationPromotionPlan = Awaited<ReturnType<typeof planInvestigationPromotion>>;
export interface InvestigationPromotion {
  schemaVersion: 1;
  kind: "tiangong-investigation-promotion";
  projectId: string;
  promotionId: string;
  plan: InvestigationPromotionPlan;
  scopeAuthorization: {
    kind: "operator-confirmation";
    planSha256: string;
    sourceSha256: string;
    source: OutputRecord;
  };
  approvedAt: string;
  recordSha256: string;
}
export async function loadInvestigationPromotion(
  root: string,
  projectId: string,
  hash: string,
  knownEvents?: JournalEvent[],
  store: InvestigationReadStore = localInvestigationReadStore(root),
): Promise<InvestigationPromotion> {
  const record = await store.readTask<InvestigationPromotion>(
    projectId,
    "investigation-promotions",
    hash,
    "recordSha256",
  );
  const events = knownEvents ?? (await readVerifiedJournal(workspacePaths(root).journal));
  const event = events.find(
    (e) =>
      e.scope === projectId &&
      e.type === "investigation.promotion.approved" &&
      e.payload.recordSha256 === hash,
  );
  if (
    !event ||
    record.schemaVersion !== 1 ||
    record.kind !== "tiangong-investigation-promotion" ||
    record.projectId !== projectId ||
    record.promotionId !== event.payload.promotionId ||
    record.plan.projectId !== projectId ||
    record.plan.promotionId !== record.promotionId ||
    record.plan.planSha256 !== event.payload.planSha256 ||
    record.scopeAuthorization.kind !== "operator-confirmation" ||
    record.scopeAuthorization.planSha256 !== record.plan.planSha256 ||
    record.scopeAuthorization.sourceSha256 !== record.scopeAuthorization.source.sha256 ||
    record.scopeAuthorization.source.path !==
      `task/run-objects/${record.scopeAuthorization.sourceSha256}`
  )
    throw failure("Promotion does not match its committed authorization.");
  const { planSha256, ...core } = record.plan;
  if (planSha256 !== sha256Text(canonicalJson(core)))
    throw failure("Promotion plan bytes changed.");
  await store.verifyBlob(projectId, record.scopeAuthorization.source);
  return record;
}
export async function approveInvestigationPromotion(
  root: string,
  projectId: string,
  value: unknown,
  confirmation: string | undefined,
  sourcePath: string | undefined,
) {
  const input = parse(value);
  if (!confirmation || !HASH.test(confirmation) || !sourcePath || !isAbsolute(sourcePath))
    throw failure(
      "Approve the exact promotion plan with --confirm and --authorization-source.",
      "RESEARCH_INVESTIGATION_CONFIRMATION_REQUIRED",
    );
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw failure("Promotion authorization must be bounded regular UTF-8 text.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(sourcePath),
    );
  } catch {
    throw failure("Promotion authorization must be UTF-8 text.");
  }
  if (
    text.trim().length < 8 ||
    sanitizeResearchValue(text, configuredResearchSecrets(process.env)) !== text
  )
    throw failure("Promotion authorization must be bounded non-secret supplied text.");
  return withWorkspaceLock(root, "research.investigation.promotion.approve", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const existing = events.find(
      (e) =>
        e.scope === projectId &&
        e.type === "investigation.promotion.approved" &&
        e.payload.promotionId === input.promotionId,
    );
    if (existing) {
      const record = await loadInvestigationPromotion(
        root,
        projectId,
        String(existing.payload.recordSha256),
        events,
      );
      if (
        record.plan.requestSha256 !== sha256Text(canonicalJson(input)) ||
        record.plan.planSha256 !== confirmation ||
        record.scopeAuthorization.sourceSha256 !== sha256Text(text)
      )
        throw failure("Promotion ID already belongs to another exact approval.");
      return record;
    }
    const plan = await planInvestigationPromotion(root, projectId, input);
    if (plan.planSha256 !== confirmation)
      throw failure("Promotion plan changed; inspect the current exact plan before approving.");
    const source = await storeRunObject(root, projectId, sourcePath);
    if (source.sha256 !== sha256Text(text))
      throw failure("Promotion approval source changed during storage.");
    const core = {
      schemaVersion: 1 as const,
      kind: "tiangong-investigation-promotion" as const,
      projectId,
      promotionId: input.promotionId,
      plan,
      scopeAuthorization: {
        kind: "operator-confirmation" as const,
        planSha256: plan.planSha256,
        sourceSha256: source.sha256,
        source,
      },
      approvedAt: new Date().toISOString(),
    };
    const record: InvestigationPromotion = {
      ...core,
      recordSha256: sha256Text(canonicalJson(core)),
    };
    await writeTaskObject(root, projectId, "investigation-promotions", record.recordSha256, record);
    let mutation = await beginProjectMutation(
      root,
      "investigation-promotion",
      project,
      record.recordSha256,
    );
    try {
      reserveProjectCost(project, await loadWorkspaceConfig(root), {
        id: `investigation-certification-${record.recordSha256}`,
        kind: "investigation",
        reference: `promotion/${input.promotionId}`,
        maxCostUsd: plan.certification.maxCostUsd,
      });
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(
        workspacePaths(root).journal,
        "investigation.promotion.approved",
        projectId,
        {
          projectId,
          promotionId: input.promotionId,
          investigationId: input.investigationId,
          sourceProjectId: input.sourceProjectId,
          recordSha256: record.recordSha256,
          planSha256: plan.planSha256,
          mutation: projectMutationBinding(mutation),
        },
      );
      await settleProjectMutation(root, mutation);
    } catch (error) {
      await settleProjectMutation(root, mutation);
      throw error;
    }
    return record;
  });
}

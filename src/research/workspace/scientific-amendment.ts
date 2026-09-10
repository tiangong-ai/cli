import { Ajv2020 } from "ajv/dist/2020.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { CliError } from "../../errors.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import { evaluateScientificDesign, type ScientificDesignContract } from "./scientific-design.js";
import {
  applyScientificFulfillmentRecord,
  loadScientificFulfillmentView,
  type ScientificFulfillmentRecord,
} from "./scientific-fulfillment.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  resolveContained,
  sha256Text,
  workspacePaths,
  writeTextAtomic,
} from "./storage.js";

import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { withWorkspaceLock } from "./workspace.js";
import type { JournalEvent, ProjectState } from "./types.js";

type Rule = ScientificDesignContract["policyRuleDispositions"][number];
interface AmendmentInput {
  schemaVersion: 1;
  reason: string;
  changes: Array<
    Pick<Rule, "ruleId" | "dueGate" | "rationale" | "modelStructureIds" | "uncertaintyParameterIds">
  >;
}
const HASH = /^[a-f0-9]{64}$/;
const PLAN_NEXT_ACTION =
  "Review the exact changes and their reason. Apply requires confirmation of this plan hash and its supplied authorization source; neither proves authenticated authorship or scientific approval.";
export interface ScientificAmendmentPlan {
  schemaVersion: 1;
  kind: "tiangong-scientific-amendment-plan";
  projectId: string;
  parentDesignSha256: string;
  parentFulfillmentSha256: string | null;
  parentAmendmentSha256: string | null;
  parentEffectiveDesignSha256: string;
  parentProjectSha256: string;
  reason: string;
  changes: Array<{ ruleId: string; before: Rule; after: Rule }>;
  proposedEffectiveDesignSha256: string;
  invalidatedScientificRoles: string[];
  preservedAcquisitionSnapshotSha256: string | null;
  planSha256: string;
  nextAction: string;
}
export interface ScientificAmendmentRecord {
  schemaVersion: 1;
  kind: "tiangong-scientific-amendment";
  projectId: string;
  plan: ScientificAmendmentPlan;
  amendmentAuthorization: {
    kind: "operator-confirmation";
    planSha256: string;
    sourceSha256: string;
    sourceLocator: string;
    sourceBytes: number;
  };
  design: { sha256: string; objectLocator: string };
  recordSha256: string;
}
const ids = {
  type: "array",
  uniqueItems: true,
  maxItems: 128,
  items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
};
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "reason", "changes"],
  properties: {
    schemaVersion: { const: 1 },
    reason: { type: "string", minLength: 8, maxLength: 4000 },
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ruleId",
          "dueGate",
          "rationale",
          "modelStructureIds",
          "uncertaintyParameterIds",
        ],
        properties: {
          ruleId: { type: "string", minLength: 1, maxLength: 128 },
          dueGate: {
            enum: ["research-design", "evidence-construct", "pilot-methods", "publication-freeze"],
          },
          rationale: { type: "string", minLength: 8, maxLength: 4000 },
          modelStructureIds: ids,
          uncertaintyParameterIds: ids,
        },
      },
    },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile<AmendmentInput>(
  inputSchema,
);

export function scientificAmendmentSchema(): Record<string, unknown> {
  return structuredClone(inputSchema);
}

function invalid(message: string, code = "RESEARCH_SCIENTIFIC_AMENDMENT_INVALID") {
  return new CliError(message, { code, exitCode: code.endsWith("INVALID") ? 2 : 3 });
}

/** Derive a reviewable proposal without changing frozen bytes or authority. */
export async function planScientificAmendment(
  root: string,
  projectId: string,
  value: unknown,
): Promise<ScientificAmendmentPlan> {
  if (
    !validate(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw invalid("Amendment must match the closed, secret-free lifecycle/binding schema.");
  const input = value as AmendmentInput;
  if (
    input.reason.trim().length < 8 ||
    input.changes.some((change) => change.rationale.trim().length < 8) ||
    new Set(input.changes.map((change) => change.ruleId)).size !== input.changes.length
  )
    throw invalid("Amendment requires a reason, substantive rationales and unique existing rules.");
  const paths = workspacePaths(root);
  const project = await loadProject(root, projectId);
  const events = await readVerifiedJournal(paths.journal);
  assertProjectAuthority(project, projectAuthorityIndex(events));
  const analyze = project.packages.find((item) => item.stage === "analyze");
  if (
    !project.scientificDesign ||
    project.status === "complete" ||
    project.handoff.state !== "agent-actionable" ||
    !analyze ||
    analyze.attempts > 0 ||
    analyze.startedAt ||
    !["ready", "pending"].includes(analyze.status) ||
    (await pathExists(join(paths.projects, project.id, "native/active.json"))) ||
    (await pathExists(join(paths.projects, project.id, "outputs/inference-snapshot.json")))
  )
    throw invalid(
      "Amend only an idle authoritative pre-analysis project. Resolve the active session or handoff; substantive or post-analysis changes require a reviewed successor.",
      "RESEARCH_SCIENTIFIC_AMENDMENT_UNAVAILABLE",
    );
  const view = await loadScientificFulfillmentView(root, project, undefined, events);
  const effective = structuredClone(view.contract);
  const declaredRules = new Set(project.publicationPolicy?.resolvedRules ?? []);
  const models = new Set(effective.identity.modelStructures.map((model) => model.id));
  const parameters = new Set(effective.uncertaintyParameters.map((parameter) => parameter.id));
  const changes = input.changes.map((change) => {
    const rule = effective.policyRuleDispositions.find((item) => item.ruleId === change.ruleId);
    if (
      !rule ||
      !declaredRules.has(change.ruleId) ||
      rule.status !== "planned" ||
      change.modelStructureIds.some((id) => !models.has(id)) ||
      change.uncertaintyParameterIds.some((id) => !parameters.has(id))
    )
      throw invalid(
        "Amend only planned Policy rules and their existing declared model/parameter IDs.",
      );
    const before = structuredClone(rule);
    Object.assign(rule, change);
    const after = structuredClone(rule);
    if (canonicalJson(before) === canonicalJson(after))
      throw invalid("Each proposed rule amendment must change its lifecycle or bindings.");
    return { ruleId: rule.ruleId, before, after };
  });
  const introducedIssues = evaluateScientificDesign(effective).issueCodes;
  if (introducedIssues.length)
    throw new CliError("Amendment introduces blocking scientific-design issues.", {
      code: "RESEARCH_SCIENTIFIC_AMENDMENT_INVALID",
      exitCode: 2,
      details: { issueCodes: introducedIssues },
    });
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-scientific-amendment-plan" as const,
    projectId: project.id,
    parentDesignSha256: project.scientificDesign.designSha256,
    parentFulfillmentSha256: view.headSha256,
    parentAmendmentSha256: project.scientificDesign.amendmentSha256 ?? null,
    parentEffectiveDesignSha256: view.effectiveSha256,
    parentProjectSha256: sha256Text(canonicalJson(project)),
    reason: input.reason,
    changes,
    proposedEffectiveDesignSha256: sha256Text(canonicalJson(effective)),
    invalidatedScientificRoles: ["research-design", "evidence-construct", "pilot-methods"],
    preservedAcquisitionSnapshotSha256: project.evidenceState.currentSnapshotSha256,
  };
  return {
    ...core,
    planSha256: sha256Text(canonicalJson(core)),
    nextAction: PLAN_NEXT_ACTION,
  };
}

function conflict(): CliError {
  return invalid(
    "Amendment no longer matches its exact parent, authorized changes or immutable history. Inspect amendment status and prepare a new plan; do not edit frozen records.",
    "RESEARCH_SCIENTIFIC_AMENDMENT_CONFLICT",
  );
}

function planInput(plan: ScientificAmendmentPlan): AmendmentInput {
  return {
    schemaVersion: 1,
    reason: plan.reason,
    changes: plan.changes.map(({ ruleId, after }) => ({
      ruleId,
      dueGate: after.dueGate,
      rationale: after.rationale,
      modelStructureIds: after.modelStructureIds,
      uncertaintyParameterIds: after.uncertaintyParameterIds,
    })),
  };
}

function validatePlan(value: unknown): ScientificAmendmentPlan {
  if (!isObject(value)) throw conflict();
  const { planSha256, nextAction, ...core } = value;
  if (
    Object.keys(value).sort().join(",") !==
      "changes,invalidatedScientificRoles,kind,nextAction,parentAmendmentSha256,parentDesignSha256,parentEffectiveDesignSha256,parentFulfillmentSha256,parentProjectSha256,planSha256,preservedAcquisitionSnapshotSha256,projectId,proposedEffectiveDesignSha256,reason,schemaVersion" ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-scientific-amendment-plan" ||
    typeof value.projectId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.projectId) ||
    nextAction !== PLAN_NEXT_ACTION ||
    planSha256 !== sha256Text(canonicalJson(core)) ||
    [
      value.parentDesignSha256,
      value.parentEffectiveDesignSha256,
      value.parentProjectSha256,
      value.proposedEffectiveDesignSha256,
    ].some((hash) => typeof hash !== "string" || !HASH.test(hash)) ||
    [
      value.parentAmendmentSha256,
      value.parentFulfillmentSha256,
      value.preservedAcquisitionSnapshotSha256,
    ].some((hash) => hash !== null && (typeof hash !== "string" || !HASH.test(hash))) ||
    canonicalJson(value.invalidatedScientificRoles) !==
      canonicalJson(["research-design", "evidence-construct", "pilot-methods"]) ||
    !Array.isArray(value.changes) ||
    value.changes.some(
      (change) =>
        !isObject(change) ||
        !isObject(change.before) ||
        !isObject(change.after) ||
        Object.keys(change).sort().join(",") !== "after,before,ruleId",
    )
  )
    throw conflict();
  const plan = value as unknown as ScientificAmendmentPlan;
  if (
    !validate(planInput(plan)) ||
    new Set(plan.changes.map((item) => item.ruleId)).size !== plan.changes.length
  )
    throw conflict();
  return plan;
}

export function scientificAmendmentLocator(projectId: string, hash: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId) || !HASH.test(hash)) throw conflict();
  return `projects/${projectId}/scientific/amendments/${hash}.json`;
}

export function validateScientificAmendmentRecord(
  value: unknown,
  projectId: string,
  hash: string,
): ScientificAmendmentRecord {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !==
      "amendmentAuthorization,design,kind,plan,projectId,recordSha256,schemaVersion"
  )
    throw conflict();
  const { recordSha256, ...core } = value;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-scientific-amendment" ||
    value.projectId !== projectId ||
    recordSha256 !== hash ||
    sha256Text(canonicalJson(core)) !== hash
  )
    throw conflict();
  const plan = validatePlan(value.plan);
  const authorization = value.amendmentAuthorization;
  const design = value.design;
  if (
    plan.projectId !== projectId ||
    !isObject(authorization) ||
    !isObject(design) ||
    Object.keys(authorization).sort().join(",") !==
      "kind,planSha256,sourceBytes,sourceLocator,sourceSha256" ||
    authorization.kind !== "operator-confirmation" ||
    authorization.planSha256 !== plan.planSha256 ||
    typeof authorization.sourceSha256 !== "string" ||
    !HASH.test(authorization.sourceSha256) ||
    authorization.sourceLocator !==
      `projects/${projectId}/scientific/authorization/${authorization.sourceSha256}.txt` ||
    !Number.isSafeInteger(authorization.sourceBytes) ||
    Number(authorization.sourceBytes) < 8 ||
    Number(authorization.sourceBytes) > 65536 ||
    Object.keys(design).sort().join(",") !== "objectLocator,sha256" ||
    typeof design.sha256 !== "string" ||
    !HASH.test(design.sha256) ||
    design.objectLocator !== `projects/${projectId}/scientific/design/objects/${design.sha256}.json`
  )
    throw conflict();
  return value as unknown as ScientificAmendmentRecord;
}

/** Shared by the live loader and portable verifier; rule patches commute with slot fulfillment. */
export function projectScientificAmendments(
  base: ScientificDesignContract,
  baseSha256: string,
  fulfillments: ScientificFulfillmentRecord[],
  records: ScientificAmendmentRecord[],
): ScientificDesignContract {
  const design = structuredClone(base);
  let parent: string | null = null;
  for (const record of records) {
    const plan = record.plan;
    if (
      plan.parentAmendmentSha256 !== parent ||
      plan.parentDesignSha256 !== baseSha256 ||
      plan.projectId !== base.projectId
    )
      throw conflict();
    const prefix =
      plan.parentFulfillmentSha256 === null
        ? 0
        : fulfillments.findIndex((item) => item.recordSha256 === plan.parentFulfillmentSha256) + 1;
    if (plan.parentFulfillmentSha256 !== null && prefix === 0) throw conflict();
    const previous = structuredClone(design);
    for (const item of fulfillments.slice(0, prefix))
      applyScientificFulfillmentRecord(previous, item);
    if (sha256Text(canonicalJson(previous)) !== plan.parentEffectiveDesignSha256) throw conflict();
    const models = new Set(design.identity.modelStructures.map((item) => item.id));
    const parameters = new Set(design.uncertaintyParameters.map((item) => item.id));
    for (const change of plan.changes) {
      const rule = design.policyRuleDispositions.find((item) => item.ruleId === change.ruleId);
      if (
        !rule ||
        rule.status !== "planned" ||
        canonicalJson(rule) !== canonicalJson(change.before)
      )
        throw conflict();
      const expected = { ...rule, ...planInput({ ...plan, changes: [change] }).changes[0] };
      if (
        canonicalJson(expected) !== canonicalJson(change.after) ||
        canonicalJson(rule) === canonicalJson(expected) ||
        expected.modelStructureIds.some((id) => !models.has(id)) ||
        expected.uncertaintyParameterIds.some((id) => !parameters.has(id))
      )
        throw conflict();
      Object.assign(rule, expected);
    }
    const effective = structuredClone(design);
    for (const item of fulfillments.slice(0, prefix))
      applyScientificFulfillmentRecord(effective, item);
    if (
      sha256Text(canonicalJson(design)) !== record.design.sha256 ||
      sha256Text(canonicalJson(effective)) !== plan.proposedEffectiveDesignSha256 ||
      evaluateScientificDesign(effective).issueCodes.length
    )
      throw conflict();
    parent = record.recordSha256;
  }
  return design;
}

async function controlledPath(root: string, locator: string, create = false): Promise<string> {
  const destination = resolveContained(workspacePaths(root).control, locator);
  let directory = workspacePaths(root).control;
  for (const part of locator.split("/").slice(0, -1)) {
    directory = join(directory, part);
    if (create && !(await pathExists(directory))) await mkdir(directory, { mode: 0o700 });
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw conflict();
  }
  return destination;
}

async function readImmutable(
  root: string,
  locator: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<string> {
  const path = await controlledPath(root, locator);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw conflict();
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw conflict();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw conflict();
  }
}

async function writeImmutable(root: string, locator: string, text: string): Promise<void> {
  const path = await controlledPath(root, locator, true);
  if (await pathExists(path)) {
    if ((await readImmutable(root, locator)) !== text) throw conflict();
    return;
  }
  await writeTextAtomic(path, text, 0o444);
}

export async function loadScientificAmendments(
  root: string,
  project: ProjectState,
  events: JournalEvent[],
): Promise<ScientificAmendmentRecord[]> {
  const entries = events.filter(
    (event) => event.scope === project.id && event.type === "scientific.amendment.recorded",
  );
  if (
    (entries.at(-1)?.payload.recordSha256 ?? null) !==
    (project.scientificDesign?.amendmentSha256 ?? null)
  )
    throw conflict();
  const records: ScientificAmendmentRecord[] = [];
  for (const event of entries) {
    const hash = String(event.payload.recordSha256);
    let value: unknown;
    try {
      value = JSON.parse(await readImmutable(root, scientificAmendmentLocator(project.id, hash)));
    } catch {
      throw conflict();
    }
    const record = validateScientificAmendmentRecord(value, project.id, hash);
    if (
      event.payload.planSha256 !== record.plan.planSha256 ||
      !isObject(event.payload.mutation) ||
      event.payload.mutation.requestSha256 !== hash ||
      event.payload.parentAmendmentSha256 !== record.plan.parentAmendmentSha256
    )
      throw conflict();
    const source = await readImmutable(root, record.amendmentAuthorization.sourceLocator, 65536);
    if (
      sha256Text(source) !== record.amendmentAuthorization.sourceSha256 ||
      Buffer.byteLength(source) !== record.amendmentAuthorization.sourceBytes
    )
      throw conflict();
    const version = await readImmutable(root, record.design.objectLocator);
    if (sha256Text(version) !== record.design.sha256) throw conflict();
    records.push(record);
  }
  return records;
}

export async function applyScientificAmendment(
  root: string,
  projectId: string,
  value: unknown,
  confirmation: string | undefined,
  sourcePath: string | undefined,
): Promise<ScientificAmendmentRecord> {
  const plan = validatePlan(value);
  if (confirmation !== plan.planSha256 || !sourcePath || !isAbsolute(sourcePath))
    throw invalid(
      "Apply requires --confirm with the exact reviewed plan hash and an absolute --authorization-source file.",
    );
  const info = await lstat(sourcePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw invalid("Authorization source must be a bounded regular UTF-8 file.");
  const bytes = await readFile(sourcePath);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid("Authorization source must be UTF-8 text.");
  }
  if (
    bytes.length > 65536 ||
    source.trim().length < 8 ||
    sanitizeResearchValue(source, configuredResearchSecrets(process.env)) !== source
  )
    throw invalid("Authorization source must contain bounded, non-secret confirmation text.");
  const sourceSha256 = sha256Text(source);
  return withWorkspaceLock(root, "research.scientific.amendment", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const view = await loadScientificFulfillmentView(root, project, undefined, events);
    const replay = view.amendments.find((record) => record.plan.planSha256 === plan.planSha256);
    if (replay) {
      if (
        canonicalJson(replay.plan) !== canonicalJson(plan) ||
        replay.amendmentAuthorization.sourceSha256 !== sourceSha256
      )
        throw conflict();
      return replay;
    }
    if (
      plan.projectId !== projectId ||
      canonicalJson(await planScientificAmendment(root, projectId, planInput(plan))) !==
        canonicalJson(plan)
    )
      throw conflict();
    const design = structuredClone(view.amendedBase);
    for (const change of plan.changes)
      Object.assign(
        design.policyRuleDispositions.find((rule) => rule.ruleId === change.ruleId)!,
        change.after,
      );
    const designText = canonicalJson(design);
    const designSha256 = sha256Text(designText);
    const core = {
      schemaVersion: 1 as const,
      kind: "tiangong-scientific-amendment" as const,
      projectId,
      plan,
      amendmentAuthorization: {
        kind: "operator-confirmation" as const,
        planSha256: plan.planSha256,
        sourceSha256,
        sourceLocator: `projects/${projectId}/scientific/authorization/${sourceSha256}.txt`,
        sourceBytes: Buffer.byteLength(source),
      },
      design: {
        sha256: designSha256,
        objectLocator: `projects/${projectId}/scientific/design/objects/${designSha256}.json`,
      },
    };
    const record: ScientificAmendmentRecord = {
      ...core,
      recordSha256: sha256Text(canonicalJson(core)),
    };
    await writeImmutable(root, record.amendmentAuthorization.sourceLocator, source);
    await writeImmutable(root, record.design.objectLocator, designText);
    await writeImmutable(
      root,
      scientificAmendmentLocator(projectId, record.recordSha256),
      canonicalJson(record),
    );
    let mutation = await beginProjectMutation(
      root,
      "scientific-amendment",
      project,
      record.recordSha256,
    );
    try {
      project.scientificDesign!.amendmentSha256 = record.recordSha256;
      for (const role of ["research-design", "evidence-construct", "pilot-methods"] as const)
        project.scientificDesign!.gates[role] = {
          status: "pending",
          packetSha256: null,
          assessmentSha256: null,
          reviewSha256: null,
          reviewerSessionSha256: null,
        };
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(
        workspacePaths(root).journal,
        "scientific.amendment.recorded",
        projectId,
        {
          projectId,
          recordSha256: record.recordSha256,
          planSha256: plan.planSha256,
          parentAmendmentSha256: plan.parentAmendmentSha256,
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

export async function inspectScientificAmendment(root: string, projectId: string) {
  const project = await loadProject(root, projectId);
  const view = await loadScientificFulfillmentView(root, project);
  return {
    projectId,
    amendmentSha256: project.scientificDesign?.amendmentSha256 ?? null,
    originalDesignSha256: project.scientificDesign?.designSha256,
    effectiveDesignSha256: view.effectiveSha256,
    records: view.amendments.map((record) => ({
      recordSha256: record.recordSha256,
      planSha256: record.plan.planSha256,
      parentAmendmentSha256: record.plan.parentAmendmentSha256,
      design: record.design,
      reason: record.plan.reason,
    })),
    gates: project.scientificDesign?.gates,
    nextAction:
      "Complete the pending scientific gates for this design version. Reuse still-bound acquisition artifacts and typed evidence; authorization is not scientific approval.",
  };
}

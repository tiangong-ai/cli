import { Ajv2020 } from "ajv/dist/2020.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import {
  evaluateScientificDesign,
  readAndVerifyScientificDesign,
  type ScientificDesignContract,
} from "./scientific-design.js";
import { resolveScientificObjectBinding } from "./scientific-objects.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  resolveContained,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { JournalEvent, ProjectState, ScientificReviewRole } from "./types.js";
import {
  loadScientificAmendments,
  projectScientificAmendments,
  type ScientificAmendmentRecord,
} from "./scientific-amendment.js";
import { withWorkspaceLock } from "./workspace.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const roles = ["research-design", "evidence-construct", "pilot-methods"] as const;
const rank = (role: ScientificReviewRole) => roles.indexOf(role);
type DeferredGate = "evidence-construct" | "pilot-methods";
type ObjectInput = { modelId: string; objectLocator: string; sha256: string; recordSha256: string };
type ImplementationInput = ObjectInput & { entrypoint: string };
interface ParameterInput {
  parameterId: string;
  states: Array<{ stateId: string; value: string; evidenceAtomIds: string[] }>;
}
interface FulfillmentInput {
  schemaVersion: 1;
  designSha256: string;
  parentFulfillmentSha256: string | null;
  reason: string;
  modelImplementations: ImplementationInput[];
  environmentLocks: ObjectInput[];
  parameterStates: ParameterInput[];
}
export interface ScientificFulfillmentRecord extends Omit<
  FulfillmentInput,
  "parameterStates" | "modelImplementations" | "environmentLocks"
> {
  kind: "tiangong-scientific-fulfillment";
  projectId: string;
  requestSha256: string;
  modelImplementations: Array<ImplementationInput & { dueGate: DeferredGate }>;
  environmentLocks: Array<ObjectInput & { dueGate: DeferredGate }>;
  parameterStates: Array<{
    parameterId: string;
    dueGate: DeferredGate;
    states: Array<{ stateId: string; value: string; atoms: Array<{ id: string; sha256: string }> }>;
  }>;
  recordSha256: string;
}
export interface ScientificFulfillmentView {
  base: ScientificDesignContract;
  amendedBase: ScientificDesignContract;
  amendments: ScientificAmendmentRecord[];
  contract: ScientificDesignContract;
  headSha256: string | null;
  effectiveSha256: string;
  records: ScientificFulfillmentRecord[];
  deferredObjectRuleIds: string[];
}
const objectProperties = {
  modelId: { type: "string", pattern: ID },
  objectLocator: { type: "string", pattern: "^lineage/objects/[a-f0-9]{64}/blob$" },
  sha256: { type: "string", pattern: HASH.source },
  recordSha256: { type: "string", pattern: HASH.source },
};
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "designSha256",
    "parentFulfillmentSha256",
    "reason",
    "modelImplementations",
    "environmentLocks",
    "parameterStates",
  ],
  properties: {
    schemaVersion: { const: 1 },
    designSha256: { type: "string", pattern: HASH.source },
    parentFulfillmentSha256: { type: ["string", "null"], pattern: HASH.source },
    reason: { type: "string", minLength: 8, maxLength: 4000 },
    modelImplementations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...Object.keys(objectProperties), "entrypoint"],
        properties: {
          ...objectProperties,
          entrypoint: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
    environmentLocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(objectProperties),
        properties: objectProperties,
      },
    },
    parameterStates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["parameterId", "states"],
        properties: {
          parameterId: { type: "string", pattern: ID },
          states: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["stateId", "value", "evidenceAtomIds"],
              properties: {
                stateId: { type: "string", pattern: ID },
                value: { type: "string", minLength: 1, maxLength: 2000 },
                evidenceAtomIds: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { type: "string", pattern: ID },
                },
              },
            },
          },
        },
      },
    },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(inputSchema);
export function scientificFulfillmentSchema(): Record<string, unknown> {
  return structuredClone(inputSchema);
}

function failure(message: string, code = "RESEARCH_SCIENTIFIC_FULFILLMENT_INVALID", exitCode = 2) {
  return new CliError(message, { code, exitCode });
}
function conflict() {
  return failure(
    "Fulfillment no longer matches its exact declared pending slots or parent. Inspect status; material design changes require a reviewed successor.",
    "RESEARCH_SCIENTIFIC_FULFILLMENT_CONFLICT",
    3,
  );
}
function parseInput(value: unknown): FulfillmentInput {
  if (
    !validate(value) ||
    !isObject(value) ||
    String(value.reason).trim().length < 8 ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  ) {
    throw failure(
      "Fulfillment must match the closed, secret-free input schema; it cannot change scientific assumptions or policy.",
    );
  }
  const input = value as unknown as FulfillmentInput;
  if (
    !input.modelImplementations.length &&
    !input.environmentLocks.length &&
    !input.parameterStates.length
  )
    throw failure("Fulfillment must name at least one predeclared pending slot.");
  for (const items of [
    input.modelImplementations.map((item) => item.modelId),
    input.environmentLocks.map((item) => item.modelId),
    input.parameterStates.map((item) => item.parameterId),
  ]) {
    if (new Set(items).size !== items.length)
      throw failure("A pending slot can be supplied only once per fulfillment.");
  }
  return input;
}
function inputFromRecord(record: ScientificFulfillmentRecord): FulfillmentInput {
  return {
    schemaVersion: 1,
    designSha256: record.designSha256,
    parentFulfillmentSha256: record.parentFulfillmentSha256,
    reason: record.reason,
    modelImplementations: record.modelImplementations.map(({ dueGate: _gate, ...item }) => item),
    environmentLocks: record.environmentLocks.map(({ dueGate: _gate, ...item }) => item),
    parameterStates: record.parameterStates.map((item) => ({
      parameterId: item.parameterId,
      states: item.states.map((state) => ({
        stateId: state.stateId,
        value: state.value,
        evidenceAtomIds: state.atoms.map((atom) => atom.id),
      })),
    })),
  };
}
export function scientificFulfillmentLocator(projectId: string, hash: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId) || !HASH.test(hash)) throw conflict();
  return `projects/${projectId}/scientific/fulfillments/${hash}.json`;
}
async function regularParents(root: string, locator: string, create = false) {
  let directory = workspacePaths(root).control;
  for (const part of locator.split("/").slice(0, -1)) {
    directory = join(directory, part);
    if (create && !(await pathExists(directory))) await mkdir(directory, { mode: 0o700 });
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw conflict();
  }
}
async function readRecord(
  root: string,
  projectId: string,
  hash: string,
): Promise<ScientificFulfillmentRecord> {
  const locator = scientificFulfillmentLocator(projectId, hash);
  await regularParents(root, locator);
  const path = resolveContained(workspacePaths(root).control, locator);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw conflict();
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw conflict();
  }
  return validateScientificFulfillmentRecord(value, projectId, hash);
}
export function validateScientificFulfillmentRecord(
  value: unknown,
  projectId: string,
  hash: string,
): ScientificFulfillmentRecord {
  if (
    !isObject(value) ||
    value.kind !== "tiangong-scientific-fulfillment" ||
    value.projectId !== projectId ||
    value.recordSha256 !== hash
  )
    throw conflict();
  if (
    Object.keys(value).sort().join(",") !==
    "designSha256,environmentLocks,kind,modelImplementations,parameterStates,parentFulfillmentSha256,projectId,reason,recordSha256,requestSha256,schemaVersion"
  )
    throw conflict();
  const { recordSha256: _hash, ...core } = value;
  if (sha256Text(canonicalJson(core)) !== hash) throw conflict();
  try {
    const input = parseInput(inputFromRecord(value as unknown as ScientificFulfillmentRecord));
    if (sha256Text(canonicalJson(input)) !== value.requestSha256) throw conflict();
  } catch {
    throw conflict();
  }
  return value as unknown as ScientificFulfillmentRecord;
}

/** The base bytes never change. The per-gate projection includes only slots due by that gate. */
export async function loadScientificFulfillmentView(
  root: string,
  project: ProjectState,
  throughGate?: ScientificReviewRole,
  knownEvents?: JournalEvent[],
): Promise<ScientificFulfillmentView> {
  const binding = project.scientificDesign;
  if (!binding) throw conflict();
  const basePath = resolveContained(workspacePaths(root).control, binding.objectLocator);
  await regularParents(root, binding.objectLocator);
  const verified = await readAndVerifyScientificDesign(basePath, project.id);
  if (
    verified.sha256 !== binding.designSha256 ||
    sha256Text(await readFile(basePath, "utf8")) !== binding.designSha256
  ) {
    throw new CliError("Frozen evidence acquisition plan no longer matches its design binding.", {
      code: "RESEARCH_EVIDENCE_ACCESS_PLAN_INVALID",
      exitCode: 3,
    });
  }
  const head = binding.fulfillmentSha256 ?? null;
  const hasFulfillmentHistory =
    Boolean(head) ||
    (await pathExists(join(workspacePaths(root).projects, project.id, "scientific/fulfillments")));
  const hasAmendmentHistory =
    Boolean(binding.amendmentSha256) ||
    (await pathExists(join(workspacePaths(root).projects, project.id, "scientific/amendments")));
  // Legacy/unamended reads retain constant-cost absent-namespace checks. Reuse
  // an operation's verified journal when supplied; active history is never cached.
  const journalEvents =
    knownEvents ??
    (hasFulfillmentHistory || hasAmendmentHistory
      ? await readVerifiedJournal(workspacePaths(root).journal)
      : []);
  const records: ScientificFulfillmentRecord[] = [];
  if (hasFulfillmentHistory) {
    const events = journalEvents.filter(
      (event) => event.scope === project.id && event.type === "scientific.fulfillment.recorded",
    );
    if ((events.at(-1)?.payload.recordSha256 ?? null) !== head) throw conflict();
    let cursor: string | null = head;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw conflict();
      seen.add(cursor);
      const record = await readRecord(root, project.id, cursor);
      const event = events.find((item) => item.payload.recordSha256 === cursor);
      if (
        !event ||
        record.designSha256 !== binding.designSha256 ||
        event.payload.parentFulfillmentSha256 !== record.parentFulfillmentSha256 ||
        event.payload.requestSha256 !== record.requestSha256
      )
        throw conflict();
      records.push(record);
      cursor = record.parentFulfillmentSha256;
    }
    if (records.length !== events.length) throw conflict();
    records.reverse();
  }
  // Reuse verified atom identities within this load only. A later operation
  // must reload the store so changed evidence cannot hide behind a cache.
  const atomBindings = records.some((record) => record.parameterStates.length)
    ? await loadAtomBindings(root, project.id)
    : undefined;
  const amendments = await loadScientificAmendments(root, project, journalEvents);
  const amendedBase = projectScientificAmendments(
    verified.contract,
    binding.designSha256,
    records,
    amendments,
  );
  const complete = structuredClone(amendedBase);
  const contract = throughGate ? structuredClone(amendedBase) : complete;
  for (const record of records) {
    await assertObjectRecords(root, record, atomBindings);
    // Even an early-gate projection must reject invalid future-due slots.
    applyScientificFulfillmentRecord(complete, record);
    if (throughGate) applyScientificFulfillmentRecord(contract, record, throughGate);
  }
  return {
    base: verified.contract,
    amendedBase,
    amendments,
    contract,
    headSha256: head,
    effectiveSha256: sha256Text(canonicalJson(contract)),
    records,
    deferredObjectRuleIds: resolvedDeferredObjectRules(amendedBase, contract, records, throughGate),
  };
}
async function loadAtomBindings(root: string, projectId: string): Promise<Map<string, string>> {
  const { loadEvidenceAtomRecords } = await import("./content-evidence.js");
  return new Map(
    (await loadEvidenceAtomRecords(root, projectId)).map((atom) => [atom.atomId, atom.atomSha256]),
  );
}
async function assertObjectRecords(
  root: string,
  record: ScientificFulfillmentRecord,
  knownAtomBindings?: ReadonlyMap<string, string>,
) {
  for (const [kind, items] of [
    ["model-implementation", record.modelImplementations],
    ["environment-lock", record.environmentLocks],
  ] as const) {
    for (const item of items) {
      const object = await resolveScientificObjectBinding({
        root,
        objectKind: kind,
        objectLocator: item.objectLocator,
        expectedSha256: item.sha256,
      });
      if (object.record?.recordSha256 !== item.recordSha256) throw conflict();
    }
  }
  if (record.parameterStates.length) {
    const atoms = knownAtomBindings ?? (await loadAtomBindings(root, record.projectId));
    for (const parameter of record.parameterStates)
      for (const state of parameter.states)
        for (const atom of state.atoms) {
          if (atoms.get(atom.id) !== atom.sha256) throw conflict();
        }
  }
}
export function applyScientificFulfillmentRecord(
  design: ScientificDesignContract,
  record: ScientificFulfillmentRecord,
  throughGate?: ScientificReviewRole,
) {
  const include = (gate: DeferredGate) => !throughGate || rank(gate) <= rank(throughGate);
  for (const item of record.modelImplementations) {
    if (!include(item.dueGate)) continue;
    const model = design.identity.modelStructures.find(
      (candidate) => candidate.id === item.modelId,
    );
    if (
      !model ||
      model.implementationStatus !== "pending-source-acquisition" ||
      model.implementationFreezeBeforeGate !== item.dueGate
    )
      throw conflict();
    model.implementationStatus = "executable-frozen";
    model.implementationArtifactSha256 = item.sha256;
    model.implementationArtifactLocator = item.objectLocator;
    model.implementationEntrypoint = item.entrypoint;
  }
  for (const item of record.environmentLocks) {
    if (!include(item.dueGate)) continue;
    const model = design.identity.modelStructures.find(
      (candidate) => candidate.id === item.modelId,
    );
    if (
      !model ||
      model.environmentLockStatus !== "pending-runtime-lock" ||
      model.environmentLockFreezeBeforeGate !== item.dueGate
    )
      throw conflict();
    model.environmentLockStatus = "exact-frozen";
    model.environmentLockSha256 = item.sha256;
    model.environmentLockLocator = item.objectLocator;
  }
  for (const item of record.parameterStates) {
    if (!include(item.dueGate)) continue;
    const parameter = design.uncertaintyParameters.find(
      (candidate) => candidate.id === item.parameterId,
    );
    if (
      !parameter ||
      parameter.stateValueStatus !== "pending-source-acquisition" ||
      parameter.freezeBeforeGate !== item.dueGate ||
      item.states.length !== parameter.states.length ||
      new Set(item.states.map((state) => state.stateId)).size !== parameter.states.length
    )
      throw conflict();
    for (const state of parameter.states) {
      const supplied = item.states.find((candidate) => candidate.stateId === state.id);
      if (
        !supplied ||
        !supplied.atoms.length ||
        (parameter.stateValueType === "numeric" &&
          (!supplied.value.trim() || !Number.isFinite(Number(supplied.value))))
      )
        throw conflict();
      state.value = supplied.value;
    }
    parameter.stateValueStatus = "frozen";
  }
}
function resolvedDeferredObjectRules(
  base: ScientificDesignContract,
  effective: ScientificDesignContract,
  records: ScientificFulfillmentRecord[],
  throughGate?: ScientificReviewRole,
): string[] {
  if (!records.length) return [];
  return base.policyRuleDispositions
    .filter((rule) => {
      if (
        rule.status !== "planned" ||
        rule.dueGate === "publication-freeze" ||
        rule.dueGate === "research-design" ||
        (throughGate && rank(rule.dueGate) > rank(throughGate))
      )
        return false;
      const modelSlots = base.identity.modelStructures
        .filter((model) => rule.modelStructureIds.includes(model.id))
        .flatMap((model) => [
          ...(model.implementationStatus === "pending-source-acquisition" &&
          model.implementationFreezeBeforeGate === rule.dueGate
            ? [{ id: model.id, kind: "implementation" }]
            : []),
          ...(model.environmentLockStatus === "pending-runtime-lock" &&
          model.environmentLockFreezeBeforeGate === rule.dueGate
            ? [{ id: model.id, kind: "environment" }]
            : []),
        ]);
      const parameters = base.uncertaintyParameters.filter(
        (parameter) =>
          rule.uncertaintyParameterIds.includes(parameter.id) &&
          parameter.stateValueStatus === "pending-source-acquisition" &&
          parameter.freezeBeforeGate === rule.dueGate,
      );
      if (!modelSlots.length && !parameters.length) return false;
      // Only the deferred object-filing blocker is discharged; the policy text and independent judgement are unchanged.
      return (
        modelSlots.every((slot) => {
          const model = effective.identity.modelStructures.find((item) => item.id === slot.id)!;
          return slot.kind === "implementation"
            ? model.implementationStatus === "executable-frozen"
            : model.environmentLockStatus === "exact-frozen";
        }) &&
        parameters.every(
          (parameter) =>
            effective.uncertaintyParameters.find((item) => item.id === parameter.id)
              ?.stateValueStatus === "frozen",
        )
      );
    })
    .map((rule) => rule.ruleId);
}

export async function recordScientificFulfillment(
  root: string,
  projectId: string,
  value: unknown,
): Promise<ScientificFulfillmentRecord> {
  const input = parseInput(value);
  return withWorkspaceLock(root, "research.scientific.fulfillment", async () => {
    const paths = workspacePaths(root);
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(paths.journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const view = await loadScientificFulfillmentView(root, project, undefined, events);
    const requestSha256 = sha256Text(canonicalJson(input));
    const replay = view.records.find((record) => record.requestSha256 === requestSha256);
    if (replay) return replay;
    if (
      input.designSha256 !== project.scientificDesign!.designSha256 ||
      input.parentFulfillmentSha256 !== view.headSha256
    )
      throw conflict();
    const analyze = project.packages.find((item) => item.stage === "analyze");
    if (
      project.status === "complete" ||
      project.handoff.state !== "agent-actionable" ||
      !analyze ||
      analyze.attempts > 0 ||
      analyze.startedAt ||
      !["ready", "pending"].includes(analyze.status) ||
      (await pathExists(join(paths.projects, project.id, "native/active.json"))) ||
      (await pathExists(join(paths.projects, project.id, "outputs/inference-snapshot.json")))
    ) {
      throw failure(
        "Fulfill planned scientific objects only at an idle pre-analysis boundary. Resolve the active session or use a reviewed successor after analysis.",
        "RESEARCH_SCIENTIFIC_FULFILLMENT_UNAVAILABLE",
        3,
      );
    }
    const dueFor = (modelId: string, kind: "implementation" | "environment"): DeferredGate => {
      const model = view.contract.identity.modelStructures.find((item) => item.id === modelId);
      if (
        !model ||
        (kind === "implementation"
          ? model.implementationStatus !== "pending-source-acquisition"
          : model.environmentLockStatus !== "pending-runtime-lock")
      )
        throw conflict();
      const due =
        kind === "implementation"
          ? model.implementationFreezeBeforeGate
          : model.environmentLockFreezeBeforeGate;
      if (due === "research-design") throw conflict();
      return due;
    };
    const modelImplementations = input.modelImplementations.map((item) => ({
      ...item,
      dueGate: dueFor(item.modelId, "implementation"),
    }));
    const environmentLocks = input.environmentLocks.map((item) => ({
      ...item,
      dueGate: dueFor(item.modelId, "environment"),
    }));
    const parameterStates: ScientificFulfillmentRecord["parameterStates"] = [];
    if (input.parameterStates.length) {
      const { loadCurrentEvidenceContentSnapshot } = await import("./content-evidence.js");
      const content = await loadCurrentEvidenceContentSnapshot(root, projectId);
      const atoms = new Map(content.atoms.map((atom) => [atom.atomId, atom]));
      for (const item of input.parameterStates) {
        const parameter = view.contract.uncertaintyParameters.find(
          (candidate) => candidate.id === item.parameterId,
        );
        if (
          !parameter ||
          parameter.stateValueStatus !== "pending-source-acquisition" ||
          parameter.freezeBeforeGate === "research-design"
        )
          throw conflict();
        parameterStates.push({
          parameterId: item.parameterId,
          dueGate: parameter.freezeBeforeGate,
          states: item.states.map((state) => ({
            stateId: state.stateId,
            value: state.value,
            atoms: state.evidenceAtomIds.map((id) => {
              const atom = atoms.get(id);
              if (
                !atom ||
                !atom.evidenceRoleIds.some((role) => parameter.sourceEvidenceRoleIds.includes(role))
              )
                throw conflict();
              return { id, sha256: atom.atomSha256 };
            }),
          })),
        });
      }
    }
    const core = {
      ...input,
      modelImplementations,
      environmentLocks,
      parameterStates,
      kind: "tiangong-scientific-fulfillment" as const,
      projectId,
      requestSha256,
    };
    const record: ScientificFulfillmentRecord = {
      ...core,
      recordSha256: sha256Text(canonicalJson(core)),
    };
    await assertObjectRecords(root, record);
    const effective = structuredClone(view.contract);
    applyScientificFulfillmentRecord(effective, record);
    const previousIssues = new Set(evaluateScientificDesign(view.contract).issueCodes);
    if (evaluateScientificDesign(effective).issueCodes.some((code) => !previousIssues.has(code)))
      throw conflict();
    const dueGate = [...modelImplementations, ...environmentLocks, ...parameterStates]
      .map((item) => item.dueGate)
      .sort((a, b) => rank(a) - rank(b))[0]!;
    const locator = scientificFulfillmentLocator(projectId, record.recordSha256);
    await regularParents(root, locator, true);
    if (await pathExists(resolveContained(paths.control, locator))) {
      if (
        canonicalJson(await readRecord(root, projectId, record.recordSha256)) !==
        canonicalJson(record)
      )
        throw conflict();
    } else await writeJsonAtomic(resolveContained(paths.control, locator), record, 0o444);
    let mutation = await beginProjectMutation(
      root,
      "scientific-fulfillment",
      project,
      requestSha256,
    );
    try {
      project.scientificDesign!.fulfillmentSha256 = record.recordSha256;
      const invalidatedRoles = roles.filter((role) => rank(role) >= rank(dueGate));
      for (const role of invalidatedRoles)
        project.scientificDesign!.gates[role] = {
          status: "pending",
          packetSha256: null,
          assessmentSha256: null,
          reviewSha256: null,
          reviewerSessionSha256: null,
        };
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(paths.journal, "scientific.fulfillment.recorded", projectId, {
        projectId,
        designSha256: input.designSha256,
        recordSha256: record.recordSha256,
        parentFulfillmentSha256: input.parentFulfillmentSha256,
        requestSha256,
        invalidatedRoles,
        mutation: projectMutationBinding(mutation),
      });
      await settleProjectMutation(root, mutation);
    } catch (error) {
      await settleProjectMutation(root, mutation);
      throw error;
    }
    return record;
  });
}

export async function inspectScientificFulfillment(root: string, projectId: string) {
  const project = await loadProject(root, projectId);
  const view = await loadScientificFulfillmentView(root, project);
  return {
    projectId,
    designSha256: project.scientificDesign!.designSha256,
    fulfillmentSha256: view.headSha256,
    effectiveDesignSha256: view.effectiveSha256,
    records: view.records.map((record) => ({
      recordSha256: record.recordSha256,
      parentFulfillmentSha256: record.parentFulfillmentSha256,
    })),
    pendingModels: view.contract.identity.modelStructures.filter(
      (model) =>
        model.implementationStatus === "pending-source-acquisition" ||
        model.environmentLockStatus === "pending-runtime-lock",
    ),
    pendingParameters: view.contract.uncertaintyParameters.filter(
      (parameter) => parameter.stateValueStatus === "pending-source-acquisition",
    ),
    policyRulesAwaitingIndependentJudgement: view.deferredObjectRuleIds,
  };
}

import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { realpath } from "node:fs/promises";
import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import {
  assertProjectAuthority,
  projectAuthorityIndex,
  projectAuthority,
} from "./project-authority.js";
import { loadProject } from "./projects.js";
import { reserveProjectCost, remainingProjectCostUsd } from "./project-budget.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import { loadScientificFulfillmentView } from "./scientific-fulfillment.js";
import { storeRunObject } from "./native-run.js";
import { loadProjectTask, taskRequirementSha256, writeTaskObject } from "./task-contract.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import {
  canonicalJson,
  isObject,
  sha256File,
  sha256Text,
  workspacePaths,
  writeTextAtomic,
} from "./storage.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";
import type { JournalEvent, OutputRecord } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const deniedEffects = ["dependency-install", "external-write", "holdout", "network"];
type Option =
  | { id: string; kind: "number" | "integer"; minimum: number; maximum: number }
  | { id: string; kind: "enum"; values: string[] };
interface ProgramInput {
  id: string;
  runtime: { kind: "node" | "python"; path: string };
  scriptPath: string;
  environmentLockPath: string;
  arguments: string[];
  outputs: Array<{ id: string; fileName: string; mediaType: string }>;
  diagnosticOutputId: string;
  telemetry: { requiredMetrics: string[]; requiredStatuses: string[] };
}
interface InvestigationInput {
  schemaVersion: 1;
  investigationId: string;
  requirementId: string;
  requirementSha256: string;
  objective: string;
  canonicalInputs: Array<{ id: string; artifactId: string; sha256: string }>;
  programs: ProgramInput[];
  options: Option[];
  limits: {
    maxRuns: number;
    maxWallSeconds: number;
    maxRunSeconds: number;
    maxCostUsd: number;
    maxRunCostUsd: number;
    maxOutputBytes: number;
    maxTotalOutputBytes: number;
  };
  deniedEffects: string[];
}
const idSchema = { type: "string", pattern: ID };
const textSchema = { type: "string", minLength: 1, maxLength: 4000 };
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "investigationId",
    "requirementId",
    "requirementSha256",
    "objective",
    "canonicalInputs",
    "programs",
    "options",
    "limits",
    "deniedEffects",
  ],
  properties: {
    schemaVersion: { const: 1 },
    investigationId: idSchema,
    requirementId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    requirementSha256: { type: "string", pattern: HASH.source },
    objective: { type: "string", minLength: 8, maxLength: 4000 },
    canonicalInputs: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "artifactId", "sha256"],
        properties: {
          id: idSchema,
          artifactId: idSchema,
          sha256: { type: "string", pattern: HASH.source },
        },
      },
    },
    programs: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "runtime",
          "scriptPath",
          "environmentLockPath",
          "arguments",
          "outputs",
          "diagnosticOutputId",
          "telemetry",
        ],
        properties: {
          id: idSchema,
          runtime: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "path"],
            properties: { kind: { enum: ["node", "python"] }, path: textSchema },
          },
          scriptPath: textSchema,
          environmentLockPath: textSchema,
          arguments: { type: "array", maxItems: 256, items: textSchema },
          outputs: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "fileName", "mediaType"],
              properties: {
                id: idSchema,
                fileName: idSchema,
                mediaType: { type: "string", pattern: "^(?:text|application|image)/[a-z0-9.+-]+$" },
              },
            },
          },
          diagnosticOutputId: idSchema,
          telemetry: {
            type: "object",
            additionalProperties: false,
            required: ["requiredMetrics", "requiredStatuses"],
            properties: {
              requiredMetrics: { type: "array", maxItems: 128, uniqueItems: true, items: idSchema },
              requiredStatuses: {
                type: "array",
                maxItems: 128,
                uniqueItems: true,
                items: idSchema,
              },
            },
          },
        },
      },
    },
    options: {
      type: "array",
      maxItems: 64,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "minimum", "maximum"],
            properties: {
              id: idSchema,
              kind: { enum: ["integer", "number"] },
              minimum: { type: "number" },
              maximum: { type: "number" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "values"],
            properties: {
              id: idSchema,
              kind: { const: "enum" },
              values: {
                type: "array",
                minItems: 1,
                maxItems: 128,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
        ],
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxRuns",
        "maxWallSeconds",
        "maxRunSeconds",
        "maxCostUsd",
        "maxRunCostUsd",
        "maxOutputBytes",
        "maxTotalOutputBytes",
      ],
      properties: {
        maxRuns: { type: "integer", minimum: 1, maximum: 10000 },
        maxWallSeconds: { type: "integer", minimum: 1, maximum: 172800 },
        maxRunSeconds: { type: "integer", minimum: 1, maximum: 172800 },
        maxCostUsd: { type: "number", minimum: 0 },
        maxRunCostUsd: { type: "number", minimum: 0 },
        maxOutputBytes: { type: "integer", minimum: 1, maximum: 536870912 },
        maxTotalOutputBytes: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    deniedEffects: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
      items: { enum: deniedEffects },
    },
  },
};
const validateInput = new Ajv2020({ strict: false, allErrors: true }).compile<InvestigationInput>(
  inputSchema,
);
export function investigationInputSchema() {
  return structuredClone(inputSchema);
}
function failure(message: string, code = "RESEARCH_INVESTIGATION_INVALID", exitCode = 2) {
  return new CliError(message, { code, exitCode });
}
function conflict() {
  return failure(
    "Investigation identity, authorization or exact inputs changed. Preserve history and inspect the current envelope before preparing a separately approved change.",
    "RESEARCH_INVESTIGATION_CONFLICT",
    3,
  );
}
function parseInput(value: unknown): InvestigationInput {
  if (
    !validateInput(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw failure("Investigation must match the closed, secret-free envelope schema.");
  const input = structuredClone(value);
  for (const items of [input.canonicalInputs, input.programs, input.options])
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw failure("Investigation input, program and option IDs must be unique.");
  if (
    input.objective.trim().length < 8 ||
    input.limits.maxRunSeconds > input.limits.maxWallSeconds ||
    input.limits.maxRunCostUsd > input.limits.maxCostUsd ||
    input.limits.maxOutputBytes > input.limits.maxTotalOutputBytes
  )
    throw failure("The per-run limits must fit the finite investigation envelope.");
  for (const option of input.options)
    if (
      option.kind !== "enum" &&
      (option.minimum > option.maximum ||
        (option.kind === "integer" &&
          (!Number.isSafeInteger(option.minimum) || !Number.isSafeInteger(option.maximum))))
    )
      throw failure("Numerical option bounds are invalid.");
  for (const option of input.options)
    if (option.kind === "enum" && option.values.some((value) => /[{}\r\n\0]/.test(value)))
      throw failure("Enum options must be literal bounded numerical configuration choices.");
  for (const program of input.programs) {
    if (
      new Set(program.outputs.map((output) => output.id)).size !== program.outputs.length ||
      new Set(program.outputs.map((output) => output.fileName)).size !== program.outputs.length ||
      !program.outputs.some(
        (output) =>
          output.id === program.diagnosticOutputId && output.mediaType === "application/json",
      )
    )
      throw failure("Each program needs unique outputs and one declared JSON diagnostic output.");
    for (const argument of program.arguments) {
      if (
        /[\r\n\0]/.test(argument) ||
        /(?:^|=)(?:\/|[A-Za-z]:[\\/])/.test(argument) ||
        /--(?:api-key|auth-token|password|cookie)(?:=|$)/i.test(argument) ||
        /[{}]/.test(argument.replace(/\{(?:input|output|option):[^{}]+\}/g, ""))
      )
        throw failure("Program arguments must be bounded single argv values.");
      for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
        const [kind, id, ...rest] = match[1]!.split(":");
        const items =
          kind === "input"
            ? input.canonicalInputs
            : kind === "output"
              ? program.outputs
              : kind === "option"
                ? input.options
                : [];
        if (rest.length || !items.some((item) => item.id === id))
          throw failure(
            "Program arguments reference an undeclared input, output or numerical option.",
          );
      }
    }
  }
  input.deniedEffects.sort();
  return input;
}
async function regularSource(path: string, maxBytes = 16 * 1024 * 1024) {
  if (!isAbsolute(path)) throw failure("Program, runtime and source paths must be absolute.");
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw failure("Program and confirmation sources must be bounded regular files.");
  return { path, sha256: await sha256File(path), bytes: info.size };
}
export async function planInvestigation(root: string, projectId: string, value: unknown) {
  const input = parseInput(value);
  const project = await loadProject(root, projectId);
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  assertProjectAuthority(project, projectAuthorityIndex(events));
  const task = await loadProjectTask(root, projectId, events);
  const requirement = task?.current.requirements.find(
    (item) =>
      item.id === input.requirementId && taskRequirementSha256(item) === input.requirementSha256,
  );
  if (
    !requirement ||
    requirement.checkKind !== "computation" ||
    project.handoff.state !== "agent-actionable" ||
    project.status === "complete" ||
    project.packages.find((item) => item.stage === "acquire")?.status !== "complete" ||
    project.packages.find((item) => item.stage === "review")?.status === "complete"
  )
    throw failure(
      "An investigation needs an actionable computational requirement and frozen acquisition before final review.",
      "RESEARCH_INVESTIGATION_UNAVAILABLE",
      3,
    );
  if (project.publicationPolicy) await assertResearchPolicyBinding(root, project.publicationPolicy);
  const design = project.scientificDesign
    ? await loadScientificFulfillmentView(root, project, undefined, events)
    : null;
  const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
  for (const inputBinding of input.canonicalInputs)
    if (
      !snapshot.artifacts.some(
        (artifact) =>
          artifact.artifactId === inputBinding.artifactId &&
          artifact.sha256 === inputBinding.sha256,
      )
    )
      throw conflict();
  const programs = [];
  const runtimeHashes = new Map<string, string>();
  for (const program of input.programs) {
    if (!isAbsolute(program.runtime.path)) throw failure("Select an absolute existing runtime.");
    const runtimePath = await realpath(program.runtime.path);
    if (!(await lstat(runtimePath)).isFile())
      throw failure("The runtime is not a regular executable.");
    const runtimeSha = runtimeHashes.get(runtimePath) ?? (await sha256File(runtimePath));
    runtimeHashes.set(runtimePath, runtimeSha);
    const script = await regularSource(program.scriptPath);
    const environment = await regularSource(program.environmentLockPath);
    programs.push({
      id: program.id,
      runtime: {
        kind: program.runtime.kind,
        binarySha256: runtimeSha,
        pathSha256: sha256Text(program.runtime.path),
      },
      scriptSha256: script.sha256,
      environmentLockSha256: environment.sha256,
      arguments: program.arguments,
      outputs: program.outputs,
      diagnosticOutputId: program.diagnosticOutputId,
      telemetry: program.telemetry,
    });
  }
  const config = await loadWorkspaceConfig(root);
  if (input.limits.maxCostUsd > remainingProjectCostUsd(project, config) + 1e-9)
    throw failure(
      "The investigation does not fit the remaining project cost ceiling.",
      "RESEARCH_INVESTIGATION_BUDGET_EXCEEDED",
      3,
    );
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-investigation-plan" as const,
    projectId,
    investigationId: input.investigationId,
    requestSha256: sha256Text(canonicalJson(input)),
    requirementId: input.requirementId,
    requirementSha256: input.requirementSha256,
    questionSha256: sha256Text(project.question),
    designSha256: project.scientificDesign?.designSha256 ?? null,
    effectiveDesignSha256: design?.effectiveSha256 ?? null,
    policySha256: project.publicationPolicy?.resolvedPolicySha256 ?? null,
    acquisitionSnapshotSha256: snapshot.snapshotSha256,
    objective: input.objective,
    canonicalInputs: input.canonicalInputs,
    programs,
    options: input.options,
    limits: input.limits,
    deniedEffects: input.deniedEffects,
    needsProjectBudget: !project.budget,
    purpose: "diagnostic-candidate-only" as const,
  };
  return { ...core, planSha256: sha256Text(canonicalJson(core)) };
}
export type InvestigationPlan = Awaited<ReturnType<typeof planInvestigation>>;
export interface InvestigationDefinition {
  schemaVersion: 1;
  kind: "tiangong-investigation";
  projectId: string;
  investigationId: string;
  plan: InvestigationPlan;
  programs: Array<{ id: string; script: OutputRecord; environmentLock: OutputRecord }>;
  scopeAuthorization: {
    kind: "operator-confirmation";
    planSha256: string;
    sourceSha256: string;
    source: OutputRecord;
  };
  routingSha256: string;
  approvedAt: string;
  recordSha256: string;
}
async function routingPath(root: string, projectId: string, hash: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId) || !HASH.test(hash)) throw conflict();
  let directory = workspacePaths(root).control;
  for (const part of ["projects", projectId, "native", "investigation-routing"]) {
    directory = join(directory, part);
    let info = await lstat(directory).catch(() => null);
    if (!info) {
      await mkdir(directory, { mode: 0o700 });
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw conflict();
  }
  return join(directory, `${hash}.json`);
}
export async function loadInvestigation(
  root: string,
  projectId: string,
  id: string,
  knownEvents?: JournalEvent[],
  store: InvestigationReadStore = localInvestigationReadStore(root),
): Promise<InvestigationDefinition> {
  const events = knownEvents ?? (await readVerifiedJournal(workspacePaths(root).journal));
  const event = events.findLast(
    (item) =>
      item.scope === projectId &&
      item.type === "investigation.approved" &&
      item.payload.investigationId === id,
  );
  if (!event)
    throw failure(
      "Investigation has no committed approval.",
      "RESEARCH_INVESTIGATION_NOT_AUTHORIZED",
      3,
    );
  const record = await store.readTask<InvestigationDefinition>(
    projectId,
    "investigations",
    String(event.payload.recordSha256),
    "recordSha256",
  );
  if (
    !isObject(record) ||
    !isObject(record.plan) ||
    !isObject(record.scopeAuthorization) ||
    !Array.isArray(record.programs) ||
    !Array.isArray(record.plan.programs) ||
    record.kind !== "tiangong-investigation" ||
    record.schemaVersion !== 1 ||
    record.projectId !== projectId ||
    record.investigationId !== id ||
    record.plan.planSha256 !== event.payload.planSha256 ||
    record.scopeAuthorization.planSha256 !== record.plan.planSha256
  )
    throw conflict();
  if (
    record.plan.kind !== "tiangong-investigation-plan" ||
    record.plan.schemaVersion !== 1 ||
    record.plan.projectId !== projectId ||
    record.plan.investigationId !== id ||
    record.plan.purpose !== "diagnostic-candidate-only" ||
    record.scopeAuthorization.kind !== "operator-confirmation" ||
    record.scopeAuthorization.sourceSha256 !== record.scopeAuthorization.source?.sha256 ||
    !HASH.test(record.routingSha256) ||
    !HASH.test(record.plan.requestSha256) ||
    record.programs.length !== record.plan.programs.length ||
    new Set(record.programs.map((p) => p.id)).size !== record.programs.length ||
    record.programs.some((p) => {
      const planned = record.plan.programs.find((item) => item.id === p.id);
      return (
        !planned ||
        planned.scriptSha256 !== p.script?.sha256 ||
        planned.environmentLockSha256 !== p.environmentLock?.sha256 ||
        !HASH.test(planned.runtime?.binarySha256) ||
        !HASH.test(planned.runtime?.pathSha256)
      );
    })
  )
    throw conflict();
  // Validate the portable envelope with the same closed input schema. Host paths
  // are deliberately absent from the definition; only local routing contains them.
  parseInput({
    schemaVersion: 1,
    investigationId: id,
    requirementId: record.plan.requirementId,
    requirementSha256: record.plan.requirementSha256,
    objective: record.plan.objective,
    canonicalInputs: record.plan.canonicalInputs,
    options: record.plan.options,
    limits: record.plan.limits,
    deniedEffects: record.plan.deniedEffects,
    programs: record.plan.programs.map((p) => ({
      id: p.id,
      runtime: { kind: p.runtime.kind, path: "/runtime" },
      scriptPath: "/script",
      environmentLockPath: "/environment",
      arguments: p.arguments,
      outputs: p.outputs,
      diagnosticOutputId: p.diagnosticOutputId,
      telemetry: p.telemetry,
    })),
  });
  const { planSha256, ...planCore } = record.plan;
  if (sha256Text(canonicalJson(planCore)) !== planSha256) throw conflict();
  for (const object of [
    record.scopeAuthorization.source,
    ...record.programs.flatMap((program) => [program.script, program.environmentLock]),
  ]) {
    if (object.path !== `task/run-objects/${object.sha256}`) throw conflict();
    await store.verifyBlob(projectId, object);
  }
  return record;
}
export async function approveInvestigation(
  root: string,
  projectId: string,
  value: unknown,
  confirmation: string | undefined,
  sourcePath: string | undefined,
) {
  const input = parseInput(value);
  if (!confirmation || !HASH.test(confirmation) || !sourcePath)
    throw failure(
      "Approve the exact plan with --confirm and its actual --authorization-source.",
      "RESEARCH_INVESTIGATION_CONFIRMATION_REQUIRED",
    );
  await regularSource(sourcePath, 65536);
  const sourceBytes = await readFile(sourcePath);
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  } catch {
    throw failure("Confirmation must be UTF-8 text.");
  }
  if (
    sourceText.trim().length < 8 ||
    sanitizeResearchValue(sourceText, configuredResearchSecrets(process.env)) !== sourceText
  )
    throw failure("Confirmation must be bounded non-secret supplied text.");
  return withWorkspaceLock(root, "research.investigation.approve", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const existing = events.find(
      (event) =>
        event.scope === projectId &&
        event.type === "investigation.approved" &&
        event.payload.investigationId === input.investigationId,
    );
    if (existing) {
      const record = await loadInvestigation(root, projectId, input.investigationId, events);
      if (
        record.plan.requestSha256 !== sha256Text(canonicalJson(input)) ||
        record.plan.planSha256 !== confirmation ||
        record.scopeAuthorization.sourceSha256 !== sha256Text(sourceText)
      )
        throw conflict();
      return record;
    }
    const plan = await planInvestigation(root, projectId, input);
    if (plan.planSha256 !== confirmation) throw conflict();
    if (!project.budget)
      throw failure(
        "Configure the existing numeric project budget before approving an investigation.",
        "RESEARCH_PROJECT_BUDGET_REQUIRED",
        3,
      );
    const programs = [];
    for (const program of input.programs) {
      const script = await storeRunObject(root, projectId, program.scriptPath);
      const environmentLock = await storeRunObject(root, projectId, program.environmentLockPath);
      const expected = plan.programs.find((item) => item.id === program.id)!;
      if (
        script.sha256 !== expected.scriptSha256 ||
        environmentLock.sha256 !== expected.environmentLockSha256
      )
        throw conflict();
      programs.push({ id: program.id, script, environmentLock });
    }
    const source = await storeRunObject(root, projectId, sourcePath);
    if (source.sha256 !== sha256Text(sourceText)) throw conflict();
    const routing = {
      programs: input.programs.map((program) => ({
        id: program.id,
        runtimePath: program.runtime.path,
      })),
    };
    const routingText = canonicalJson(routing),
      routingSha256 = sha256Text(routingText);
    const path = await routingPath(root, projectId, routingSha256);
    const info = await lstat(path).catch(() => null);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || (await readFile(path, "utf8")) !== routingText)
        throw conflict();
    } else await writeTextAtomic(path, routingText, 0o600);
    const core = {
      schemaVersion: 1 as const,
      kind: "tiangong-investigation" as const,
      projectId,
      investigationId: input.investigationId,
      plan,
      programs,
      scopeAuthorization: {
        kind: "operator-confirmation" as const,
        planSha256: confirmation,
        sourceSha256: source.sha256,
        source,
      },
      routingSha256,
      approvedAt: new Date().toISOString(),
    };
    const record: InvestigationDefinition = {
      ...core,
      recordSha256: sha256Text(canonicalJson(core)),
    };
    await writeTaskObject(root, projectId, "investigations", record.recordSha256, record);
    let mutation = await beginProjectMutation(
      root,
      "investigation-approval",
      project,
      record.recordSha256,
    );
    try {
      reserveProjectCost(project, await loadWorkspaceConfig(root), {
        id: `investigation-${record.recordSha256}`,
        kind: "investigation",
        reference: input.investigationId,
        maxCostUsd: plan.limits.maxCostUsd,
      });
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(workspacePaths(root).journal, "investigation.approved", projectId, {
        projectId,
        investigationId: input.investigationId,
        recordSha256: record.recordSha256,
        planSha256: plan.planSha256,
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
export async function inspectInvestigation(root: string, projectId: string, id: string) {
  const project = await loadProject(root, projectId);
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  const authority = projectAuthority(project, projectAuthorityIndex(events));
  if (authority.state === "invalid") throw conflict();
  const definition = await loadInvestigation(root, projectId, id, events);
  const { investigationAttemptHistory, investigationRemaining, assertInvestigationCurrent } =
    await import("./investigation-attempt.js");
  const { loadInvestigationClosure } = await import("./investigation-close.js");
  const { loadInvestigationCandidates } = await import("./investigation-candidate.js");
  const { loadInvestigationPromotion } = await import("./investigation-promotion.js");
  const { frozenPromotionView } = await import("./investigation-certification.js");
  const { readNativeRun } = await import("./native-run.js");
  const { investigationWallReservations } = await import("./investigation-resources.js");
  const { inspectInvestigationObserver } = await import("./investigation-observer.js");
  const history = await investigationAttemptHistory(root, projectId, definition, events);
  const remaining = investigationRemaining(definition, history);
  const candidates = await loadInvestigationCandidates(
    root,
    projectId,
    definition,
    events,
    history,
  );
  const candidate = candidates.at(-1);
  const closure = await loadInvestigationClosure(root, projectId, definition, history, events);
  const promotions: Array<{
    projectId: string;
    recordSha256: string;
    runId: string | null;
    runSha256: string | null;
    certification: "not-started" | "incomplete" | "failed" | "passed";
    scopeCurrent: boolean;
    frozen: boolean;
    observer?: Awaited<ReturnType<typeof inspectInvestigationObserver>>;
  }> = [];
  for (const event of events) {
    if (
      event.type !== "investigation.promotion.approved" ||
      event.payload.sourceProjectId !== projectId ||
      event.payload.investigationId !== id
    )
      continue;
    const promotion = await loadInvestigationPromotion(
      root,
      event.scope,
      String(event.payload.recordSha256),
      events,
    );
    if (promotion.plan.candidateSha256 !== candidate?.recordSha256) continue;
    const started = events.find(
      (e) =>
        e.scope === event.scope &&
        e.type === "project.task.run.started" &&
        e.payload.investigationPromotionSha256 === promotion.recordSha256,
    );
    const completed = started
      ? events.find(
          (e) =>
            e.scope === event.scope &&
            e.type === "project.task.run.completed" &&
            e.payload.runId === started.payload.runId,
        )
      : undefined;
    const run = completed
      ? await readNativeRun(root, event.scope, String(completed.payload.recordSha256), events)
      : null;
    let frozen = false,
      scopeCurrent = false;
    const target = event.scope === projectId ? project : await loadProject(root, event.scope);
    try {
      await frozenPromotionView(root, target, promotion, events);
      frozen = true;
      scopeCurrent =
        projectAuthority(target, projectAuthorityIndex(events)).state === "authoritative";
    } catch {
      /* The verified historical approval remains visible even when its live scope moved. */
    }
    promotions.push({
      projectId: event.scope,
      recordSha256: promotion.recordSha256,
      runId: started ? String(started.payload.runId) : null,
      runSha256: run?.recordSha256 ?? null,
      certification: run
        ? (run.investigationCertification?.status ?? "failed")
        : started
          ? "incomplete"
          : "not-started",
      scopeCurrent,
      frozen,
      ...(started && !completed
        ? {
            observer: await inspectInvestigationObserver(
              root,
              event.scope,
              String(started.payload.requestSha256),
            ),
          }
        : {}),
    });
  }
  const observers = new Map<string, Awaited<ReturnType<typeof inspectInvestigationObserver>>>();
  for (const attempt of history)
    if (!attempt.record)
      observers.set(
        attempt.start.recordSha256,
        await inspectInvestigationObserver(root, projectId, attempt.start.recordSha256),
      );
  const passed = promotions.findLast((p) => p.certification === "passed" && p.scopeCurrent);
  const pending = promotions.findLast((p) => p.certification === "incomplete");
  const lastPromotion = promotions.at(-1);
  const reservations = await investigationWallReservations(root, projectId, events);
  const config = await loadWorkspaceConfig(root);
  const availableRunSeconds = Math.max(
    0,
    Math.floor(
      Math.min(
        definition.plan.limits.maxRunSeconds,
        remaining.wallSeconds,
        config.budget.packageMaxWallSeconds.analyze,
        config.budget.maxWallSeconds - project.usage.wallSeconds - reservations.wallSeconds,
      ),
    ),
  );
  let authorizationValid = false,
    scopeReason: string | null = null;
  if (!closure && authority.state === "authoritative") {
    try {
      await assertInvestigationCurrent(root, project, definition, events);
      authorizationValid = true;
    } catch (error) {
      scopeReason = error instanceof CliError ? error.code : "RESEARCH_INVESTIGATION_UNAVAILABLE";
    }
  }
  const exhausted =
    remaining.runs === 0 ||
    availableRunSeconds < 1 ||
    remaining.costUpperBoundUsd + 1e-9 < definition.plan.limits.maxRunCostUsd ||
    remaining.outputBytes < 1 ||
    history.some((a) => a.record?.process.outputLimitExceeded);
  const unresolved = history.some((a) => !a.record);
  const allowedNextAction =
    authority.state !== "authoritative"
      ? "inspect-authoritative-project"
      : unresolved
        ? "inspect-unresolved-attempt"
        : pending
          ? "inspect-unresolved-certification"
          : passed
            ? project.packages.find((p) => p.stage === "review")?.status === "complete"
              ? "inspect-task-acceptance"
              : "independent-review"
            : lastPromotion?.certification === "failed"
              ? "new-promotion-approval"
              : lastPromotion?.certification === "not-started"
                ? lastPromotion.frozen
                  ? "certification"
                  : "scientific-fulfillment"
                : candidate
                  ? "promotion-approval"
                  : closure
                    ? "new-investigation-approval"
                    : !authorizationValid
                      ? "new-investigation-approval"
                      : exhausted
                        ? "close-investigation"
                        : "attempt";
  return {
    projectId,
    investigationId: id,
    definitionSha256: definition.recordSha256,
    authority,
    status: closure
      ? "closed"
      : unresolved
        ? "incomplete"
        : candidate
          ? "candidate-ready"
          : exhausted
            ? "exhausted"
            : history.length
              ? "investigating"
              : "authorized",
    remaining,
    availableRunSeconds: authorizationValid && !closure ? availableRunSeconds : 0,
    projectWallReservations: reservations,
    authorizationValid,
    scopeReason,
    allowedNextAction,
    candidate: candidate
      ? {
          recordSha256: candidate.recordSha256,
          attemptSha256: candidate.attemptSha256,
          recipeSha256: candidate.recipeSha256,
          certification: passed
            ? "passed"
            : pending
              ? "incomplete"
              : lastPromotion?.certification === "failed"
                ? "failed"
                : "not-certified",
        }
      : null,
    promotions,
    closure,
    actualCostUsd: null,
    attempts: history.map((a) => ({
      attemptId: a.start.attemptId,
      startSha256: a.start.recordSha256,
      recordSha256: a.record?.recordSha256 ?? null,
      outcome: a.record?.outcome ?? "incomplete",
      hypothesis: a.start.hypothesis,
      configuration: a.start.configuration,
      parentAttemptSha256: a.start.parentAttemptSha256,
      changes: a.start.changes,
      ...(observers.has(a.start.recordSha256)
        ? { observer: observers.get(a.start.recordSha256) }
        : {}),
      conclusion: a.record?.diagnostic?.conclusion ?? a.record?.outcome ?? "unresolved",
    })),
    executionBoundary: "calculation-sandbox-required",
    purpose: definition.plan.purpose,
  };
}

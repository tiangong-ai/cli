import { investigationObserverRoute } from "./investigation-observer.js";
import { investigationWallReservations } from "./investigation-resources.js";
import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import { arch, platform, tmpdir } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { createCalculationSandboxInvocation } from "./executor.js";
import { loadInvestigation, type InvestigationDefinition } from "./investigation.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import {
  type NativeRunRecord,
  captureProcess,
  copyExact,
  nativePacketBinding,
  storeRunObject,
} from "./native-run.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { loadProject } from "./projects.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import { loadScientificFulfillmentView } from "./scientific-fulfillment.js";
import { isContainedRelativePath } from "./scientific-objects.js";
import {
  configuredResearchSecrets,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import {
  canonicalJson,
  isObject,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import { loadProjectTask, taskRequirementSha256, writeTaskObject } from "./task-contract.js";
import type { JournalEvent, OutputRecord, ProjectState } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const HASH = /^[a-f0-9]{64}$/;
const idSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" };
interface AttemptInput {
  schemaVersion: 1;
  investigationId: string;
  attemptId: string;
  programId: string;
  hypothesis: string;
  configuration: Record<string, string | number>;
  nativeSessionId: string | null;
  workingDirectory: string;
  parentAttemptId?: string;
}
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "investigationId",
    "attemptId",
    "programId",
    "hypothesis",
    "configuration",
    "nativeSessionId",
    "workingDirectory",
  ],
  properties: {
    schemaVersion: { const: 1 },
    investigationId: idSchema,
    attemptId: idSchema,
    parentAttemptId: idSchema,
    programId: idSchema,
    hypothesis: { type: "string", minLength: 8, maxLength: 4000 },
    configuration: {
      type: "object",
      maxProperties: 64,
      additionalProperties: { type: ["string", "number"] },
    },
    nativeSessionId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    workingDirectory: { type: "string", minLength: 1, maxLength: 4000 },
  },
};
const validateInput = new Ajv2020({ strict: false, allErrors: true }).compile<AttemptInput>(
  inputSchema,
);
export function investigationAttemptInputSchema() {
  return structuredClone(inputSchema);
}
function invalid(message: string, code = "RESEARCH_INVESTIGATION_INVALID") {
  return new CliError(message, { code, exitCode: 3 });
}
interface AttemptStart {
  schemaVersion: 1;
  kind: "tiangong-investigation-attempt-start";
  projectId: string;
  investigationId: string;
  attemptId: string;
  definitionSha256: string;
  requestSha256: string;
  programId: string;
  hypothesis: string;
  configuration: Record<string, string | number>;
  parentAttemptSha256: string | null;
  changes: InvestigationChanges;
  nativePacketSha256: string | null;
  inputs: Array<OutputRecord & { id: string; artifactId: string }>;
  timeoutSeconds: number;
  maxCostUsd: number;
  maxOutputBytes: number;
  startedAt: string;
  recordSha256: string;
}
type Observed = Awaited<ReturnType<typeof captureProcess>>;
type Diagnostic = {
  schemaVersion: 1;
  solverReached: boolean;
  feasible: boolean;
  metrics: Record<string, number>;
  statuses: Record<string, string>;
  conclusion: string;
};
const outcomes = [
  "harness-failure",
  "output-limit-exceeded",
  "solver-not-reached",
  "numerical-failure",
  "diagnostic-incomplete",
  "feasible-candidate",
  "stale",
  "inputs-changed",
] as const;
export interface InvestigationAttempt {
  schemaVersion: 1;
  kind: "tiangong-investigation-attempt";
  projectId: string;
  investigationId: string;
  attemptId: string;
  startSha256: string;
  definitionSha256: string;
  programId: string;
  configuration: Record<string, string | number>;
  hypothesis: string;
  purpose: "diagnostic-candidate-only";
  parentAttemptSha256: string | null;
  changes: InvestigationChanges;
  outcome: (typeof outcomes)[number];
  diagnostic: Diagnostic | null;
  diagnosticTrust: "program-reported";
  missingTelemetry: string[];
  actualCostUsd: null;
  accountedCostUpperBoundUsd: number;
  process: Omit<Observed, "stdout" | "stderr">;
  runtimeProbe: Omit<Observed, "stdout" | "stderr">;
  runtime: NativeRunRecord["runtime"];
  isolation: { provider: string; policySha256: string };
  logs: { stdout: OutputRecord; stderr: OutputRecord };
  outputs: Array<OutputRecord & { id: string; mediaType: string }>;
  recordSha256: string;
}
export interface InvestigationChanges {
  program: { before: string | null; after: string };
  configuration: Array<{ id: string; before: string | number | null; after: string | number }>;
}
function attemptChanges(
  programId: string,
  configuration: Record<string, string | number>,
  parent: InvestigationAttempt | null,
): InvestigationChanges {
  return {
    program: { before: parent?.programId ?? null, after: programId },
    configuration: Object.keys(configuration)
      .sort()
      .filter((id) => !parent || parent.configuration[id] !== configuration[id])
      .map((id) => ({ id, before: parent?.configuration[id] ?? null, after: configuration[id]! })),
  };
}
function configuredProgram(
  definition: InvestigationDefinition,
  programId: string,
  configuration: Record<string, string | number>,
) {
  const program = definition.plan.programs.find((p) => p.id === programId);
  if (
    !program ||
    !isObject(configuration) ||
    Object.keys(configuration).sort().join("\0") !==
      definition.plan.options
        .map((o) => o.id)
        .sort()
        .join("\0")
  )
    throw invalid("Attempt does not match approved program/options.");
  for (const option of definition.plan.options) {
    const setting = configuration[option.id];
    if (
      option.kind === "enum"
        ? typeof setting !== "string" || !option.values.includes(setting)
        : typeof setting !== "number" ||
          !Number.isFinite(setting) ||
          setting < option.minimum ||
          setting > option.maximum ||
          (option.kind === "integer" && !Number.isSafeInteger(setting))
    )
      throw invalid("Attempt option is outside the approved numerical scope.");
  }
  return program;
}
function matching(events: JournalEvent[], projectId: string, id: string, type: string) {
  return events.filter(
    (e) => e.scope === projectId && e.type === type && e.payload.investigationId === id,
  );
}
async function readStart(
  root: string,
  projectId: string,
  event: JournalEvent,
  store: InvestigationReadStore = localInvestigationReadStore(root),
): Promise<AttemptStart> {
  const record = await store.readTask<AttemptStart>(
    projectId,
    "investigation-starts",
    String(event.payload.recordSha256),
    "recordSha256",
  );
  if (
    record.kind !== "tiangong-investigation-attempt-start" ||
    record.projectId !== projectId ||
    record.investigationId !== event.payload.investigationId ||
    record.attemptId !== event.payload.attemptId ||
    record.requestSha256 !== event.payload.requestSha256 ||
    !HASH.test(record.definitionSha256) ||
    !Number.isFinite(record.timeoutSeconds) ||
    record.timeoutSeconds <= 0 ||
    !Number.isFinite(record.maxCostUsd) ||
    record.maxCostUsd < 0 ||
    !Number.isSafeInteger(record.maxOutputBytes) ||
    record.maxOutputBytes < 1
  )
    throw invalid("Investigation attempt start binding changed.");
  return record;
}
export async function investigationAttemptHistory(
  root: string,
  projectId: string,
  definition: InvestigationDefinition,
  events: JournalEvent[],
  store: InvestigationReadStore = localInvestigationReadStore(root),
) {
  const starts = matching(
    events,
    projectId,
    definition.investigationId,
    "investigation.attempt.started",
  );
  const completed = matching(
    events,
    projectId,
    definition.investigationId,
    "investigation.attempt.completed",
  );
  const attempts: Array<{ start: AttemptStart; record: InvestigationAttempt | null }> = [];
  const seen = new Set<string>();
  const previous = new Map<string, InvestigationAttempt>();
  for (const event of starts) {
    const start = await readStart(root, projectId, event, store);
    if (seen.has(start.attemptId) || start.definitionSha256 !== definition.recordSha256)
      throw invalid("Investigation attempt identity is duplicated or mixed.");
    seen.add(start.attemptId);
    configuredProgram(definition, start.programId, start.configuration);
    const parent =
      start.parentAttemptSha256 === null ? null : previous.get(start.parentAttemptSha256);
    if (
      parent === undefined ||
      canonicalJson(start.changes) !==
        canonicalJson(attemptChanges(start.programId, start.configuration, parent)) ||
      canonicalJson(
        start.inputs.map((i) => ({ id: i.id, artifactId: i.artifactId, sha256: i.sha256 })),
      ) !== canonicalJson(definition.plan.canonicalInputs) ||
      start.maxCostUsd !== definition.plan.limits.maxRunCostUsd ||
      start.timeoutSeconds > definition.plan.limits.maxRunSeconds ||
      start.maxOutputBytes > definition.plan.limits.maxOutputBytes
    )
      throw invalid("Attempt start differs from its approved inputs, configuration or parent.");
    for (const input of start.inputs) await store.verifyBlob(projectId, input);
    const matches = completed.filter((e) => e.payload.attemptId === start.attemptId);
    if (matches.length > 1) throw invalid("Investigation has duplicate committed results.");
    const done = matches[0];
    let record: InvestigationAttempt | null = null;
    if (done) {
      record = await store.readTask<InvestigationAttempt>(
        projectId,
        "investigation-attempts",
        String(done.payload.recordSha256),
        "recordSha256",
      );
      if (
        done.sequence <= event.sequence ||
        record.startSha256 !== start.recordSha256 ||
        record.definitionSha256 !== definition.recordSha256 ||
        record.projectId !== projectId ||
        record.investigationId !== definition.investigationId ||
        record.attemptId !== start.attemptId ||
        record.purpose !== "diagnostic-candidate-only" ||
        !outcomes.includes(record.outcome) ||
        !Number.isFinite(record.process.wallSeconds) ||
        record.process.wallSeconds < 0 ||
        !Number.isSafeInteger(record.process.observedOutputBytes) ||
        Number(record.process.observedOutputBytes) < 0 ||
        typeof record.process.outputLimitExceeded !== "boolean" ||
        (!record.process.outputLimitExceeded &&
          Number(record.process.observedOutputBytes) > start.maxOutputBytes) ||
        record.programId !== start.programId ||
        canonicalJson(record.configuration) !== canonicalJson(start.configuration) ||
        record.hypothesis !== start.hypothesis ||
        record.parentAttemptSha256 !== start.parentAttemptSha256 ||
        canonicalJson(record.changes) !== canonicalJson(start.changes) ||
        record.actualCostUsd !== null ||
        record.accountedCostUpperBoundUsd !== start.maxCostUsd
      )
        throw invalid("Investigation result does not match its committed attempt.");
      for (const object of [...Object.values(record.logs), ...record.outputs]) {
        if (object.path !== `task/run-objects/${object.sha256}` || !HASH.test(object.sha256))
          throw invalid("Investigation object address changed.");
        await store.verifyBlob(projectId, object);
      }
    }
    if (record) previous.set(record.recordSha256, record);
    attempts.push({ start, record });
  }
  if (completed.some((e) => !seen.has(String(e.payload.attemptId))))
    throw invalid("Investigation result has no committed start.");
  return attempts;
}
export function investigationRemaining(
  definition: InvestigationDefinition,
  attempts: Array<{ start: AttemptStart; record: InvestigationAttempt | null }>,
) {
  return {
    runs: Math.max(0, definition.plan.limits.maxRuns - attempts.length),
    wallSeconds: Math.max(
      0,
      definition.plan.limits.maxWallSeconds -
        attempts.reduce(
          (sum, a) => sum + (a.record?.process.wallSeconds ?? a.start.timeoutSeconds),
          0,
        ),
    ),
    outputBytes: Math.max(
      0,
      definition.plan.limits.maxTotalOutputBytes -
        attempts.reduce(
          (sum, a) => sum + (a.record?.process.observedOutputBytes ?? a.start.maxOutputBytes),
          0,
        ),
    ),
    costUpperBoundUsd: Math.max(
      0,
      definition.plan.limits.maxCostUsd - attempts.reduce((sum, a) => sum + a.start.maxCostUsd, 0),
    ),
  };
}
export async function assertInvestigationCurrent(
  root: string,
  project: ProjectState,
  definition: InvestigationDefinition,
  events: JournalEvent[],
) {
  assertProjectAuthority(project, projectAuthorityIndex(events));
  if (
    events.some(
      (e) =>
        e.scope === project.id &&
        e.type === "investigation.closed" &&
        e.payload.investigationId === definition.investigationId,
    )
  )
    throw invalid(
      "This investigation is closed. Preserve its history and approve a new envelope for new work.",
      "RESEARCH_INVESTIGATION_CLOSED",
    );
  const plan = definition.plan;
  const task = await loadProjectTask(root, project.id, events);
  if (
    !task?.current.requirements.some(
      (r) =>
        r.id === plan.requirementId &&
        r.checkKind === "computation" &&
        taskRequirementSha256(r) === plan.requirementSha256,
    ) ||
    sha256Text(project.question) !== plan.questionSha256 ||
    project.handoff.state !== "agent-actionable" ||
    project.status === "complete" ||
    project.packages.find((p) => p.stage === "review")?.status === "complete" ||
    project.packages.find((p) => p.stage === "acquire")?.status !== "complete"
  )
    throw invalid(
      "The approved requirement is no longer actionable.",
      "RESEARCH_INVESTIGATION_STALE",
    );
  if (project.publicationPolicy) await assertResearchPolicyBinding(root, project.publicationPolicy);
  const design = project.scientificDesign
    ? await loadScientificFulfillmentView(root, project, undefined, events)
    : null;
  const snapshot = await loadCurrentEvidenceSnapshot(root, project.id);
  if (
    (project.scientificDesign?.designSha256 ?? null) !== plan.designSha256 ||
    (design?.effectiveSha256 ?? null) !== plan.effectiveDesignSha256 ||
    (project.publicationPolicy?.resolvedPolicySha256 ?? null) !== plan.policySha256 ||
    snapshot.snapshotSha256 !== plan.acquisitionSnapshotSha256
  )
    throw invalid(
      "Investigation scientific inputs changed; prepare a new exact authorization.",
      "RESEARCH_INVESTIGATION_STALE",
    );
  const reserved = project.budget?.entries.find(
    (e) => e.id === `investigation-${definition.recordSha256}`,
  );
  if (!reserved || reserved.status !== "reserved" || reserved.maxCostUsd !== plan.limits.maxCostUsd)
    throw invalid("The investigation budget reservation is no longer available.");
  return snapshot;
}
export function parseInvestigationDiagnostic(value: unknown): Diagnostic | null {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !==
      "conclusion,feasible,metrics,schemaVersion,solverReached,statuses" ||
    value.schemaVersion !== 1 ||
    typeof value.solverReached !== "boolean" ||
    typeof value.feasible !== "boolean" ||
    (value.feasible && !value.solverReached) ||
    !isObject(value.metrics) ||
    Object.keys(value.metrics).length > 128 ||
    !Object.values(value.metrics).every((v) => typeof v === "number" && Number.isFinite(v)) ||
    !isObject(value.statuses) ||
    Object.keys(value.statuses).length > 128 ||
    !Object.values(value.statuses).every(
      (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 512,
    ) ||
    typeof value.conclusion !== "string" ||
    value.conclusion.trim().length < 8 ||
    value.conclusion.length > 4000 ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    return null;
  return value as unknown as Diagnostic;
}
function safeLog(value: string, truncated: boolean) {
  if (truncated)
    return "Capture exceeded the bounded log buffer; full-stream hashes and byte counts remain in the process record.\n";
  return sanitizeResearchText(value, configuredResearchSecrets(process.env)).replace(
    /\/(?:Users|home|private\/tmp|private\/var|tmp)\/[^\s"':)]+/gu,
    "[host-path]",
  );
}
async function observeInvestigationAttemptInternal(
  root: string,
  projectId: string,
  value: unknown,
) {
  if (
    !validateInput(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw invalid("Attempt must match the closed secret-free schema.");
  const input = value;
  const requestSha256 = sha256Text(canonicalJson(input));
  const prepared = await withWorkspaceLock(
    root,
    "research.investigation.attempt.prepare",
    async () => {
      const project = await loadProject(root, projectId);
      const events = await readVerifiedJournal(workspacePaths(root).journal);
      const definition = await loadInvestigation(root, projectId, input.investigationId, events);
      const history = await investigationAttemptHistory(root, projectId, definition, events);
      const known = history.find((a) => a.start.attemptId === input.attemptId);
      if (known) {
        if (known.start.requestSha256 !== requestSha256)
          throw invalid(
            "Attempt ID already binds another exact request.",
            "RESEARCH_INVESTIGATION_CONFLICT",
          );
        if (!known.record)
          throw invalid(
            "Attempt has no committed result. Inspect the unresolved process; it will not be rerun automatically.",
            "RESEARCH_INVESTIGATION_INCOMPLETE",
          );
        return { replay: known.record };
      }
      const snapshot = await assertInvestigationCurrent(root, project, definition, events);
      if (history.some((a) => !a.record))
        throw invalid(
          "Resolve the unfinished attempt before another investigation calculation.",
          "RESEARCH_INVESTIGATION_INCOMPLETE",
        );
      const plan = definition.plan;
      const program = configuredProgram(definition, input.programId, input.configuration);
      const programObjects = definition.programs.find((p) => p.id === input.programId);
      if (!programObjects) throw invalid("Approved program objects are missing.");
      const parent = input.parentAttemptId
        ? history.find((a) => a.start.attemptId === input.parentAttemptId)?.record
        : (history.at(-1)?.record ?? null);
      if (parent === undefined)
        throw invalid("The requested parent must be a committed attempt in this investigation.");
      const parentAttemptSha256 = parent?.recordSha256 ?? null;
      const changes = attemptChanges(input.programId, input.configuration, parent);
      const remaining = investigationRemaining(definition, history);
      const config = await loadWorkspaceConfig(root);
      const { wallSeconds: reservedWall } = await investigationWallReservations(
        root,
        projectId,
        events,
      );
      const timeoutSeconds = Math.floor(
        Math.min(
          plan.limits.maxRunSeconds,
          remaining.wallSeconds,
          config.budget.packageMaxWallSeconds.analyze,
          config.budget.maxWallSeconds - project.usage.wallSeconds - reservedWall,
        ),
      );
      if (
        remaining.runs < 1 ||
        timeoutSeconds < 1 ||
        remaining.costUpperBoundUsd + 1e-9 < plan.limits.maxRunCostUsd ||
        remaining.outputBytes < 1 ||
        history.some((a) => a.record?.process.outputLimitExceeded)
      )
        throw invalid(
          "The remaining finite investigation budget cannot admit another attempt.",
          "RESEARCH_INVESTIGATION_BUDGET_EXCEEDED",
        );
      if (!isAbsolute(input.workingDirectory))
        throw invalid("Attempt staging needs an absolute directory.");
      const info = await lstat(input.workingDirectory);
      const working = await realpath(input.workingDirectory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        isContainedRelativePath(relative(await realpath(workspacePaths(root).control), working))
      )
        throw invalid("Attempt staging must be a regular directory outside the control store.");
      const routePath = join(
        workspacePaths(root).projects,
        projectId,
        "native/investigation-routing",
        `${definition.routingSha256}.json`,
      );
      const routeBytes = await readFile(routePath, "utf8");
      if (sha256Text(routeBytes) !== definition.routingSha256)
        throw invalid("Local investigation routing changed.");
      const routing = JSON.parse(routeBytes) as {
        programs: Array<{ id: string; runtimePath: string }>;
      };
      const selected = routing.programs.find((p) => p.id === input.programId);
      if (!selected || sha256Text(selected.runtimePath) !== program.runtime.pathSha256)
        throw invalid("Selected runtime routing changed.");
      const runtimePath = await realpath(selected.runtimePath);
      if ((await sha256File(runtimePath)) !== program.runtime.binarySha256)
        throw invalid("Approved runtime bytes changed.");
      const nativePacketSha256 = await nativePacketBinding(root, project, input.nativeSessionId);
      const staging = await mkdtemp(join(working, ".tiangong-investigation-"));
      const privateHome = join(staging, "home");
      await mkdir(privateHome, { mode: 0o700 });
      const script = join(staging, program.runtime.kind === "node" ? "program.mjs" : "program.py");
      await copyExact(
        join(workspacePaths(root).projects, projectId, programObjects.script.path),
        script,
        program.scriptSha256,
      );
      const inputs: Array<OutputRecord & { id: string; artifactId: string }> = [];
      const inputPaths = new Map<string, string>();
      for (const item of plan.canonicalInputs) {
        const artifact = snapshot.artifacts.find(
          (a) => a.artifactId === item.artifactId && a.sha256 === item.sha256,
        );
        if (!artifact) throw invalid("Approved input is missing from acquisition.");
        const path = join(staging, `input-${item.id}`);
        await copyExact(
          resolveContained(workspacePaths(root).control, artifact.locator),
          path,
          item.sha256,
        );
        inputs.push({
          ...(await storeRunObject(root, projectId, path)),
          id: item.id,
          artifactId: item.artifactId,
        });
        inputPaths.set(item.id, path);
      }
      const outputPaths = new Map(program.outputs.map((o) => [o.id, join(staging, o.fileName)]));
      if (
        new Set([
          script,
          privateHome,
          join(staging, "execution.sb"),
          join(staging, "calculation.sb"),
          ...inputPaths.values(),
          ...outputPaths.values(),
        ]).size !==
        4 + inputPaths.size + outputPaths.size
      )
        throw invalid("Attempt outputs collide with protected files.");
      const args = program.arguments.map((a) =>
        a.replace(/\{(input|output|option):([^}]+)\}/gu, (_m, kind: string, id: string) =>
          kind === "input"
            ? inputPaths.get(id)!
            : kind === "output"
              ? outputPaths.get(id)!
              : String(input.configuration[id]),
        ),
      );
      const invocation = await createCalculationSandboxInvocation({
        binary: runtimePath,
        args: [script, ...args],
        capsuleRoot: staging,
        workspaceRoot: root,
      });
      const versionInvocation = await createCalculationSandboxInvocation({
        binary: runtimePath,
        args: ["--version"],
        capsuleRoot: staging,
        workspaceRoot: root,
      });
      const core = {
        schemaVersion: 1 as const,
        kind: "tiangong-investigation-attempt-start" as const,
        projectId,
        investigationId: input.investigationId,
        attemptId: input.attemptId,
        definitionSha256: definition.recordSha256,
        requestSha256,
        programId: input.programId,
        hypothesis: input.hypothesis,
        configuration: input.configuration,
        parentAttemptSha256,
        changes,
        nativePacketSha256,
        inputs,
        timeoutSeconds,
        maxCostUsd: plan.limits.maxRunCostUsd,
        maxOutputBytes: Math.min(plan.limits.maxOutputBytes, remaining.outputBytes),
        startedAt: new Date().toISOString(),
      };
      const start: AttemptStart = { ...core, recordSha256: sha256Text(canonicalJson(core)) };
      await writeTaskObject(root, projectId, "investigation-starts", start.recordSha256, start);
      await appendJournalEvent(
        workspacePaths(root).journal,
        "investigation.attempt.started",
        projectId,
        {
          investigationId: input.investigationId,
          attemptId: input.attemptId,
          recordSha256: start.recordSha256,
          requestSha256,
        },
      );
      return {
        project,
        definition,
        program,
        start,
        staging,
        privateHome,
        script,
        inputPaths,
        outputPaths,
        runtimePath,
        invocation,
        versionInvocation,
      };
    },
  );
  if ("replay" in prepared) return { record: prepared.replay, replayed: true };
  const { start, program } = prepared;
  const env = {
    PATH: dirname(prepared.runtimePath),
    HOME: prepared.privateHome,
    TMPDIR: prepared.staging,
    LANG: "C.UTF-8",
    TZ: "UTC",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  const probe = await captureProcess(
    prepared.versionInvocation.binary,
    prepared.versionInvocation.args,
    prepared.staging,
    env,
    Math.min(5, start.timeoutSeconds),
    { maxBytes: start.maxOutputBytes },
    investigationObserverRoute(
      root,
      projectId,
      start.recordSha256,
      "runtime-probe",
      prepared.staging,
    ),
  );
  const version = probe.stdout.trim() || probe.stderr.trim();
  const validRuntime =
    probe.exitCode === 0 &&
    !probe.outputLimitExceeded &&
    !probe.timedOut &&
    !probe.cancelled &&
    (program.runtime.kind === "node" ? /^v\d+\.\d+\.\d+$/u : /^Python \d+\.\d+\.\d+$/u).test(
      version,
    );
  const available = start.timeoutSeconds - probe.wallSeconds;
  const availableOutput = start.maxOutputBytes - (probe.observedOutputBytes ?? 0);
  const observed =
    validRuntime && available > 0 && availableOutput > 0
      ? await captureProcess(
          prepared.invocation.binary,
          prepared.invocation.args,
          prepared.staging,
          env,
          available,
          { maxBytes: availableOutput, paths: [...prepared.outputPaths.values()] },
          investigationObserverRoute(
            root,
            projectId,
            start.recordSha256,
            "calculation",
            prepared.staging,
          ),
        )
      : probe;
  return withWorkspaceLock(root, "research.investigation.attempt.commit", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    let stale = false;
    try {
      await assertInvestigationCurrent(root, project, prepared.definition, events);
      if (
        (await nativePacketBinding(root, project, input.nativeSessionId)) !==
        start.nativePacketSha256
      )
        stale = true;
    } catch {
      stale = true;
    }
    const outputLimitExceeded = Boolean(
      probe.outputLimitExceeded || observed.outputLimitExceeded || availableOutput <= 0,
    );
    const observedOutputBytes =
      (observed.observedOutputBytes ?? 0) +
      (observed === probe ? 0 : (probe.observedOutputBytes ?? 0));
    const outputs: InvestigationAttempt["outputs"] = [];
    let diagnostic: Diagnostic | null = null;
    for (const output of outputLimitExceeded ? [] : program.outputs) {
      const path = prepared.outputPaths.get(output.id)!;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > start.maxOutputBytes) continue;
        const object = await storeRunObject(root, projectId, path);
        outputs.push({ ...object, id: output.id, mediaType: output.mediaType });
        if (output.id === program.diagnosticOutputId && info.size <= 65536)
          diagnostic = parseInvestigationDiagnostic(
            JSON.parse(
              await readFile(join(workspacePaths(root).projects, projectId, object.path), "utf8"),
            ),
          );
      } catch {
        /* Missing, unsafe or invalid diagnostics cannot establish a candidate. */
      }
    }
    let stable = true;
    for (const file of [
      { path: prepared.runtimePath, sha256: program.runtime.binarySha256 },
      { path: prepared.script, sha256: program.scriptSha256 },
      ...start.inputs.map((i) => ({ path: prepared.inputPaths.get(i.id)!, sha256: i.sha256 })),
    ]) {
      try {
        const info = await lstat(file.path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (await sha256File(file.path)) !== file.sha256
        )
          stable = false;
      } catch {
        stable = false;
      }
    }
    const missingTelemetry = diagnostic?.solverReached
      ? [
          ...program.telemetry.requiredMetrics
            .filter((id) => !Object.hasOwn(diagnostic.metrics, id))
            .map((id) => `metrics.${id}`),
          ...program.telemetry.requiredStatuses
            .filter((id) => !Object.hasOwn(diagnostic.statuses, id))
            .map((id) => `statuses.${id}`),
        ].sort()
      : [];
    const outcome: InvestigationAttempt["outcome"] = outputLimitExceeded
      ? "output-limit-exceeded"
      : stale
        ? "stale"
        : !stable
          ? "inputs-changed"
          : !validRuntime
            ? "harness-failure"
            : !diagnostic
              ? observed.exitCode === 0
                ? "diagnostic-incomplete"
                : "harness-failure"
              : !diagnostic.solverReached
                ? "solver-not-reached"
                : missingTelemetry.length
                  ? "diagnostic-incomplete"
                  : !diagnostic.feasible
                    ? "numerical-failure"
                    : observed.exitCode === 0 &&
                        !observed.timedOut &&
                        !observed.cancelled &&
                        outputs.length === program.outputs.length
                      ? "feasible-candidate"
                      : "diagnostic-incomplete";
    const logs = {} as InvestigationAttempt["logs"];
    // Parent-created log storage is outside the child-writable capsule. Never
    // follow a program-created output/symlink while persisting capture bytes.
    const logDirectory = await mkdtemp(join(tmpdir(), "tiangong-investigation-capture-"));
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const path = join(logDirectory, stream);
        await writeFile(path, safeLog(observed[stream], observed.truncated), {
          mode: 0o600,
          flag: "wx",
        });
        logs[stream] = await storeRunObject(root, projectId, path);
      }
    } finally {
      await rm(logDirectory, { recursive: true, force: true });
    }
    const { stdout: _out, stderr: _err, ...processRecord } = observed;
    const { stdout: _probeOut, stderr: _probeErr, ...runtimeProbe } = probe;
    const wallSeconds =
      observed === probe ? probe.wallSeconds : probe.wallSeconds + observed.wallSeconds;
    const core = {
      schemaVersion: 1 as const,
      kind: "tiangong-investigation-attempt" as const,
      projectId,
      investigationId: input.investigationId,
      attemptId: input.attemptId,
      startSha256: start.recordSha256,
      definitionSha256: prepared.definition.recordSha256,
      programId: program.id,
      configuration: input.configuration,
      hypothesis: input.hypothesis,
      purpose: "diagnostic-candidate-only" as const,
      parentAttemptSha256: start.parentAttemptSha256,
      changes: start.changes,
      outcome,
      diagnostic,
      diagnosticTrust: "program-reported" as const,
      missingTelemetry,
      actualCostUsd: null,
      accountedCostUpperBoundUsd: start.maxCostUsd,
      process: {
        ...processRecord,
        startedAt: probe.startedAt,
        wallSeconds,
        outputLimitExceeded,
        observedOutputBytes,
      },
      runtimeProbe,
      runtime: {
        kind: program.runtime.kind,
        version,
        binarySha256: program.runtime.binarySha256,
        platform: platform(),
        architecture: arch(),
      },
      isolation: prepared.invocation.isolation,
      logs,
      outputs,
    };
    const record: InvestigationAttempt = { ...core, recordSha256: sha256Text(canonicalJson(core)) };
    await writeTaskObject(root, projectId, "investigation-attempts", record.recordSha256, record);
    let mutation = await beginProjectMutation(
      root,
      "investigation-attempt",
      project,
      start.recordSha256,
    );
    try {
      project.usage.wallSeconds += wallSeconds;
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(
        workspacePaths(root).journal,
        "investigation.attempt.completed",
        projectId,
        {
          projectId,
          investigationId: input.investigationId,
          attemptId: input.attemptId,
          recordSha256: record.recordSha256,
          startSha256: start.recordSha256,
          mutation: projectMutationBinding(mutation),
        },
      );
      await settleProjectMutation(root, mutation);
    } catch (error) {
      await settleProjectMutation(root, mutation);
      throw error;
    }
    return { record, replayed: false, stagingDirectoryName: basename(prepared.staging) };
  });
}

/** Preserve an unresolved start on unexpected storage/runtime failure. */
export async function observeInvestigationAttempt(root: string, projectId: string, value: unknown) {
  try {
    return await observeInvestigationAttemptInternal(root, projectId, value);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid(
      "The investigation attempt could not commit its observation. Preserve its files and inspect the investigation status before any further execution; unresolved attempts are never retried automatically.",
      "RESEARCH_INVESTIGATION_OBSERVATION_FAILED",
    );
  }
}

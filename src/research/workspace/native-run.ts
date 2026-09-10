import { createCalculationSandboxInvocation } from "./executor.js";
import {
  assertInvestigationCertificationRequired,
  prepareInvestigationCertification,
  frozenPromotionView,
  certificationAssessment,
  type InvestigationCertification,
} from "./investigation-certification.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { settleProjectCost } from "./project-budget.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { loadProject } from "./projects.js";
import {
  configuredResearchSecrets,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import { isContainedRelativePath, registerScientificObject } from "./scientific-objects.js";
import {
  canonicalJson,
  fileRecord,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import {
  loadProjectTask,
  readTaskObject,
  taskDirectory,
  taskRequirementSha256,
  writeTaskObject,
} from "./task-contract.js";
import type { JournalEvent, OutputRecord, ProjectState } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const statuses = [
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "invalid-output",
  "inputs-changed",
  "stale",
] as const;
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "runId",
    "requirementId",
    "requirementSha256",
    "nativeSessionId",
    "workingDirectory",
    "runtime",
    "scriptPath",
    "environmentLockPath",
    "inputs",
    "outputs",
    "arguments",
    "timeoutSeconds",
  ],
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: "string", pattern: ID },
    requirementId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    requirementSha256: { type: "string", pattern: HASH.source },
    nativeSessionId: { type: ["string", "null"], minLength: 1 },
    workingDirectory: { type: "string", minLength: 1 },
    scriptPath: { type: "string", minLength: 1 },
    environmentLockPath: { type: "string", minLength: 1 },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path"],
      properties: { kind: { enum: ["node", "python"] }, path: { type: "string", minLength: 1 } },
    },
    inputs: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "artifactId", "sha256"],
        properties: {
          id: { type: "string", pattern: ID },
          artifactId: { type: "string", pattern: ID },
          sha256: { type: "string", pattern: HASH.source },
        },
      },
    },
    outputs: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "fileName", "mediaType"],
        properties: {
          id: { type: "string", pattern: ID },
          fileName: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          mediaType: { type: "string", pattern: "^(?:text|application|image)/[a-z0-9.+-]+$" },
        },
      },
    },
    arguments: { type: "array", maxItems: 256, items: { type: "string", maxLength: 4000 } },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 172800 },
    investigationPromotionSha256: { type: "string", pattern: HASH.source },
  },
};
const validateInput = new Ajv2020({ strict: false, allErrors: true }).compile(inputSchema);
export interface NativeRunInput {
  schemaVersion: 1;
  runId: string;
  requirementId: string;
  requirementSha256: string;
  nativeSessionId: string | null;
  workingDirectory: string;
  runtime: { kind: "node" | "python"; path: string };
  scriptPath: string;
  environmentLockPath: string;
  inputs: Array<{ id: string; artifactId: string; sha256: string }>;
  outputs: Array<{ id: string; fileName: string; mediaType: string }>;
  arguments: string[];
  timeoutSeconds: number;
  investigationPromotionSha256?: string;
}
type RunObject = OutputRecord & { id: string };
export interface NativeRunRecord {
  schemaVersion: 1;
  kind: "tiangong-native-run";
  projectId: string;
  runId: string;
  requestSha256: string;
  requirementId: string;
  requirementSha256: string;
  designSha256: string | null;
  policySha256: string | null;
  nativePacketSha256: string | null;
  status: (typeof statuses)[number];
  observation: "cli-observed-native-process";
  executionCertified: false;
  environmentVerification: "declared-lock-not-attested";
  runtime: {
    kind: "node" | "python";
    version: string;
    binarySha256: string;
    platform: string;
    architecture: string;
  };
  script: OutputRecord;
  environmentLock: OutputRecord;
  inputs: Array<RunObject & { artifactId: string }>;
  outputs: Array<RunObject & { mediaType: string }>;
  expectedOutputIds: string[];
  arguments: string[];
  process: {
    exitCode: number | null;
    signal: string | null;
    startedAt: string;
    finishedAt: string;
    wallSeconds: number;
    stdoutSha256: string;
    stderrSha256: string;
    stdoutBytes: number;
    stderrBytes: number;
    diagnostic: string;
  };
  investigationCertification?: InvestigationCertification;
  recordSha256: string;
}
export function nativeRunInputSchema(): Record<string, unknown> {
  return structuredClone(inputSchema);
}
function error(message: string, code = "RESEARCH_NATIVE_RUN_INVALID", exitCode = 3) {
  return new CliError(message, { code, exitCode });
}
function parseInput(value: unknown): NativeRunInput {
  if (
    !validateInput(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw error(
      "Native run must match the closed secret-free schema; supply an ordinary calculation, not an agent launcher.",
      undefined,
      2,
    );
  const input = value as unknown as NativeRunInput;
  for (const names of [
    input.inputs.map((item) => item.id),
    input.outputs.map((item) => item.id),
    input.outputs.map((item) => item.fileName),
  ]) {
    if (new Set(names).size !== names.length)
      throw error("Native run inputs and outputs need distinct exact names.", undefined, 2);
  }
  for (const argument of input.arguments) {
    if (
      /[\r\n\0]/u.test(argument) ||
      /(?:^|=)(?:\/|[A-Za-z]:[\\/])/u.test(argument) ||
      /--(?:api-key|auth-token|password|cookie)(?:=|$)/iu.test(argument)
    )
      throw error(
        "Use exact input/output placeholders and non-secret arguments, not host paths or credentials.",
        undefined,
        2,
      );
    for (const match of argument.matchAll(/\{(input|output):([^}]+)\}/gu)) {
      const collection = match[1] === "input" ? input.inputs : input.outputs;
      if (!collection.some((item) => item.id === match[2]))
        throw error("Native run argument refers to an undeclared file.", undefined, 2);
    }
    if (/[{}]/u.test(argument.replace(/\{(?:input|output):[^}]+\}/gu, "")))
      throw error("Native run contains an unsupported argument placeholder.", undefined, 2);
  }
  return input;
}

/** One explicitly requested non-AI calculation. It inherits the native host's OS
 * restrictions; this observer is neither an agent scheduler nor a new sandbox. */
export async function observeNativeRun(
  root: string,
  projectId: string,
  value: unknown,
  confirm: boolean,
) {
  if (!confirm)
    throw error(
      "Review the exact calculation and pass --confirm-execution; no program was started.",
      "RESEARCH_NATIVE_RUN_CONFIRMATION_REQUIRED",
      2,
    );
  const input = parseInput(value);
  const requestSha256 = sha256Text(canonicalJson(input));
  try {
    const prepared = await withWorkspaceLock(root, "research.task.run.prepare", async () => {
      const project = await loadProject(root, projectId);
      const events = await readVerifiedJournal(workspacePaths(root).journal);
      assertProjectAuthority(project, projectAuthorityIndex(events));
      const started = events.find(
        (event) =>
          event.scope === projectId &&
          event.type === "project.task.run.started" &&
          event.payload.runId === input.runId,
      );
      if (started) {
        if (started.payload.requestSha256 !== requestSha256)
          throw error(
            "This run ID already names a different exact request. Use a new run ID for a new calculation.",
            "RESEARCH_NATIVE_RUN_CONFLICT",
          );
        const completed = completedRunEvent(events, projectId, input.runId);
        if (!completed)
          throw error(
            "This run was started but has no committed result. Inspect the interrupted calculation; it will not be rerun automatically. Use a new run ID only for an explicitly authorized new attempt.",
            "RESEARCH_NATIVE_RUN_INCOMPLETE",
          );
        return {
          replay: await readNativeRun(root, projectId, String(completed.payload.recordSha256)),
          stagingDirectoryName: String(started.payload.stagingDirectoryName ?? ""),
        };
      }
      await assertInvestigationCertificationRequired(root, projectId, input, events);
      await assertRunWindow(root, project, input);
      const config = await loadWorkspaceConfig(root);
      const timeoutSeconds = Math.min(
        input.timeoutSeconds,
        config.budget.packageMaxWallSeconds.analyze,
        config.budget.maxWallSeconds - project.usage.wallSeconds,
      );
      if (timeoutSeconds < input.timeoutSeconds)
        throw error(
          "The declared calculation timeout exceeds the remaining finite workspace time budget.",
        );
      const working = await exactDirectory(input.workingDirectory);
      if (isContainedRelativePath(relative(await realpath(workspacePaths(root).control), working)))
        throw error(
          "Calculation staging must use an explicit directory outside the control store.",
        );
      if (!isAbsolute(input.runtime.path) || input.runtime.path !== resolve(input.runtime.path))
        throw error("Select an absolute Node or Python interpreter path.");
      const runtimePath = await realpath(input.runtime.path);
      if (!(await lstat(runtimePath)).isFile())
        throw error("The selected interpreter is not a regular executable file.");
      const binarySha256 = await sha256File(runtimePath);
      const certification = await prepareInvestigationCertification(
        root,
        project,
        input,
        binarySha256,
        events,
      );
      let reportedVersion = "";
      if (!certification) {
        const version = await captureProcess(
          input.runtime.path,
          ["--version"],
          working,
          { PATH: dirname(input.runtime.path) },
          5,
        );
        reportedVersion = version.stdout.trim() || version.stderr.trim();
        if (
          version.exitCode !== 0 ||
          !(input.runtime.kind === "node" ? /^v\d+\.\d+\.\d+$/u : /^Python \d+\.\d+\.\d+$/u).test(
            reportedVersion,
          )
        )
          throw error(
            "The selected executable is not the declared ordinary Node/Python runtime. Agent CLI launchers are not supported.",
          );
      }
      const acquisition = await loadCurrentEvidenceSnapshot(root, projectId);
      const selected = input.inputs.map((item) => {
        const artifact = acquisition.artifacts.find(
          (artifact) => artifact.artifactId === item.artifactId && artifact.sha256 === item.sha256,
        );
        if (!artifact)
          throw error(
            "Calculation input must name an exact artifact in the current frozen acquisition.",
          );
        return { ...item, artifact };
      });
      const script = await registerScientificObject({
        root,
        objectKind: "model-implementation",
        path: input.scriptPath,
        mediaType: input.runtime.kind === "node" ? "text/javascript" : "text/x-python",
      });
      const environment = await registerScientificObject({
        root,
        objectKind: "environment-lock",
        path: input.environmentLockPath,
        mediaType: input.environmentLockPath.endsWith(".json") ? "application/json" : "text/plain",
      });
      const staging = await mkdtemp(join(working, `.tiangong-run-${input.runId}-`));
      const privateHome = join(staging, "home");
      await mkdir(privateHome, { mode: 0o700 });
      const scriptFile = join(
        staging,
        certification
          ? input.runtime.kind === "node"
            ? "program.mjs"
            : "program.py"
          : basename(input.scriptPath),
      );
      await copyExact(
        resolveContained(workspacePaths(root).control, script.objectLocator),
        scriptFile,
        script.sha256,
      );
      const runInputs: Array<NativeRunRecord["inputs"][number] & { executionPath: string }> = [];
      for (const item of selected) {
        const source = resolveContained(workspacePaths(root).control, item.artifact.locator);
        const executionPath = join(staging, `input-${item.id}`);
        await copyExact(source, executionPath, item.sha256);
        runInputs.push({
          id: item.id,
          artifactId: item.artifactId,
          ...(await storeRunObject(root, projectId, executionPath)),
          executionPath,
        });
      }
      const outputPaths = new Map(
        input.outputs.map((item) => [item.id, join(staging, item.fileName)]),
      );
      if (
        new Set([
          ...runInputs.map((item) => item.executionPath),
          scriptFile,
          privateHome,
          ...outputPaths.values(),
        ]).size !==
        runInputs.length + outputPaths.size + 2
      )
        throw error("Declared outputs collide with protected calculation inputs.");
      const args = input.arguments.map((argument) =>
        argument.replace(/\{(input|output):([^}]+)\}/gu, (_match, kind: string, id: string) =>
          kind === "input"
            ? runInputs.find((item) => item.id === id)!.executionPath
            : outputPaths.get(id)!,
        ),
      );
      const nativePacketSha256 = await nativePacketBinding(root, project, input.nativeSessionId);
      const sourceScript = await storeRunObject(root, projectId, scriptFile);
      const environmentLock = await storeRunObject(
        root,
        projectId,
        resolveContained(workspacePaths(root).control, environment.objectLocator),
      );
      if (
        certification &&
        (sourceScript.sha256 !== certification.promotion.plan.recipe.script.sha256 ||
          environmentLock.sha256 !== certification.promotion.plan.recipe.environmentLock.sha256)
      )
        throw error(
          "The staged certification bytes changed after promotion scope validation.",
          "RESEARCH_INVESTIGATION_CERTIFICATION_INVALID",
        );
      const invocation = certification
        ? await createCalculationSandboxInvocation({
            binary: runtimePath,
            args: [scriptFile, ...args],
            capsuleRoot: staging,
            workspaceRoot: root,
          })
        : null;
      const versionInvocation = certification
        ? await createCalculationSandboxInvocation({
            binary: runtimePath,
            args: ["--version"],
            capsuleRoot: staging,
            workspaceRoot: root,
          })
        : null;
      await appendJournalEvent(
        workspacePaths(root).journal,
        "project.task.run.started",
        projectId,
        {
          runId: input.runId,
          requestSha256,
          requirementId: input.requirementId,
          requirementSha256: input.requirementSha256,
          scriptSha256: sourceScript.sha256,
          environmentLockSha256: environmentLock.sha256,
          runtimeBinarySha256: binarySha256,
          nativePacketSha256,
          stagingDirectoryName: basename(staging),
          ...(certification
            ? {
                investigationPromotionSha256: certification.promotion.recordSha256,
                certificationReservedWallSeconds: timeoutSeconds,
              }
            : {}),
        },
      );
      return {
        project,
        certification,
        invocation,
        versionInvocation,
        runtimePath,
        binarySha256,
        reportedVersion,
        staging,
        privateHome,
        scriptFile,
        runInputs,
        outputPaths,
        args,
        nativePacketSha256,
        sourceScript,
        environmentLock,
        timeoutSeconds,
      };
    });
    if ("replay" in prepared)
      return {
        record: prepared.replay,
        replayed: true,
        stagingDirectoryName: prepared.stagingDirectoryName,
      };
    // No workspace lease is held during either the certification runtime probe
    // or the calculation. Its one-use start is durable before either process.
    const environment = {
      PATH: dirname(input.runtime.path),
      HOME: prepared.privateHome,
      TMPDIR: prepared.staging,
      LANG: "C.UTF-8",
      TZ: "UTC",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    };
    const probe = prepared.versionInvocation
      ? await captureProcess(
          prepared.versionInvocation.binary,
          prepared.versionInvocation.args,
          prepared.staging,
          environment,
          Math.min(5, prepared.timeoutSeconds),
        )
      : null;
    const probeVersion = probe
      ? probe.stdout.trim() || probe.stderr.trim()
      : prepared.reportedVersion;
    const runtimeValid =
      !probe ||
      (probe.exitCode === 0 &&
        probeVersion === prepared.certification!.promotion.plan.recipe.runtime.version);
    const availableSeconds = prepared.timeoutSeconds - (probe?.wallSeconds ?? 0);
    const observed =
      probe && (!runtimeValid || availableSeconds <= 0)
        ? probe
        : await captureProcess(
            prepared.invocation?.binary ?? input.runtime.path,
            prepared.invocation?.args ?? [prepared.scriptFile, ...prepared.args],
            prepared.staging,
            environment,
            availableSeconds,
          );
    const wallSeconds =
      observed.wallSeconds + (probe && observed !== probe ? probe.wallSeconds : 0);
    return await withWorkspaceLock(root, "research.task.run.commit", async () => {
      const project = await loadProject(root, projectId);
      let status: NativeRunRecord["status"] = observed.cancelled
        ? "cancelled"
        : observed.timedOut
          ? "timed-out"
          : observed.exitCode === 0
            ? "succeeded"
            : "failed";
      if (!runtimeValid) status = "failed";
      try {
        await assertRunWindow(root, project, input);
        if (
          prepared.certification &&
          (await frozenPromotionView(
            root,
            project,
            prepared.certification.promotion,
            await readVerifiedJournal(workspacePaths(root).journal),
          )) !== prepared.certification.effectiveDesignSha256
        )
          status = "stale";
        if (
          (await nativePacketBinding(root, project, input.nativeSessionId)) !==
            prepared.nativePacketSha256 ||
          project.scientificDesign?.designSha256 !==
            prepared.project.scientificDesign?.designSha256 ||
          project.publicationPolicy?.resolvedPolicySha256 !==
            prepared.project.publicationPolicy?.resolvedPolicySha256
        )
          status = "stale";
        const current = await loadCurrentEvidenceSnapshot(root, projectId);
        if (
          prepared.runInputs.some(
            (item) =>
              !current.artifacts.some(
                (artifact) =>
                  artifact.artifactId === item.artifactId && artifact.sha256 === item.sha256,
              ),
          )
        )
          status = "stale";
      } catch {
        status = "stale";
      }
      const stable = await filesStillMatch([
        { path: prepared.runtimePath, sha256: prepared.binarySha256 },
        { path: prepared.scriptFile, sha256: prepared.sourceScript.sha256 },
        ...prepared.runInputs.map((item) => ({ path: item.executionPath, sha256: item.sha256 })),
      ]);
      if (!stable || (await realpath(input.runtime.path)) !== prepared.runtimePath)
        status = "inputs-changed";
      const outputs: NativeRunRecord["outputs"] = [];
      for (const output of input.outputs) {
        const path = prepared.outputPaths.get(output.id)!;
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink())
            throw error("Calculation output is not a regular file.");
          if (output.mediaType === "application/json") JSON.parse(await readFile(path, "utf8"));
          outputs.push({
            id: output.id,
            mediaType: output.mediaType,
            ...(await storeRunObject(root, projectId, path)),
          });
        } catch {
          if (status === "succeeded") status = "invalid-output";
        }
      }
      const investigationCertification = prepared.certification
        ? await certificationAssessment(
            root,
            projectId,
            prepared.certification,
            status,
            outputs,
            probe!,
            prepared.invocation!.isolation,
            prepared.versionInvocation!.isolation,
          )
        : undefined;
      const core = {
        schemaVersion: 1 as const,
        kind: "tiangong-native-run" as const,
        projectId,
        runId: input.runId,
        requestSha256,
        requirementId: input.requirementId,
        requirementSha256: input.requirementSha256,
        designSha256: prepared.project.scientificDesign?.designSha256 ?? null,
        policySha256: prepared.project.publicationPolicy?.resolvedPolicySha256 ?? null,
        nativePacketSha256: prepared.nativePacketSha256,
        status,
        observation: "cli-observed-native-process" as const,
        executionCertified: false as const,
        environmentVerification: "declared-lock-not-attested" as const,
        runtime: {
          kind: input.runtime.kind,
          version: runtimeValid ? probeVersion : "unverified",
          binarySha256: prepared.binarySha256,
          platform: platform(),
          architecture: arch(),
        },
        script: prepared.sourceScript,
        environmentLock: prepared.environmentLock,
        inputs: prepared.runInputs.map(({ executionPath: _path, ...item }) => item),
        outputs,
        expectedOutputIds: input.outputs.map((item) => item.id),
        arguments: input.arguments,
        process: {
          exitCode: observed.exitCode,
          signal: observed.signal,
          startedAt: probe?.startedAt ?? observed.startedAt,
          finishedAt: observed.finishedAt,
          wallSeconds,
          stdoutSha256: observed.stdoutSha256,
          stderrSha256: observed.stderrSha256,
          stdoutBytes: observed.stdoutBytes,
          stderrBytes: observed.stderrBytes,
          diagnostic: safeDiagnostic(observed.stderr, observed.truncated),
        },
        ...(investigationCertification ? { investigationCertification } : {}),
      };
      const record: NativeRunRecord = { ...core, recordSha256: sha256Text(canonicalJson(core)) };
      await writeTaskObject(root, projectId, "runs", record.recordSha256, record);
      if (prepared.certification) {
        let mutation = await beginProjectMutation(
          root,
          "investigation-certification",
          project,
          record.recordSha256,
        );
        try {
          settleProjectCost(
            project,
            `investigation-certification-${prepared.certification.promotion.recordSha256}`,
            prepared.certification.promotion.plan.certification.maxCostUsd,
            "allocated-upper-bound",
          );
          project.usage.wallSeconds += wallSeconds;
          project.updatedAt = new Date().toISOString();
          mutation = await prepareProjectMutation(root, mutation, project);
          await appendJournalEvent(
            workspacePaths(root).journal,
            "project.task.run.completed",
            projectId,
            {
              projectId,
              runId: input.runId,
              requestSha256,
              recordSha256: record.recordSha256,
              status,
              mutation: projectMutationBinding(mutation),
            },
          );
          await settleProjectMutation(root, mutation);
        } catch (error) {
          await settleProjectMutation(root, mutation);
          throw error;
        }
      } else {
        await appendJournalEvent(
          workspacePaths(root).journal,
          "project.task.run.completed",
          projectId,
          { runId: input.runId, requestSha256, recordSha256: record.recordSha256, status },
        );
      }
      return { record, replayed: false, stagingDirectoryName: basename(prepared.staging) };
    });
  } catch (caught) {
    if (caught instanceof CliError) throw caught;
    throw error(
      "The exact native calculation could not be observed. Preserve its files and inspect run status before an explicit new attempt.",
      "RESEARCH_NATIVE_RUN_FAILED",
    );
  }
}

async function assertRunWindow(root: string, project: ProjectState, input: NativeRunInput) {
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  assertProjectAuthority(project, projectAuthorityIndex(events));
  const task = await loadProjectTask(root, project.id, events);
  const requirement = task?.current.requirements.find(
    (item) =>
      item.id === input.requirementId && taskRequirementSha256(item) === input.requirementSha256,
  );
  if (
    !requirement ||
    requirement.checkKind !== "computation" ||
    project.packages.find((item) => item.stage === "acquire")?.status !== "complete" ||
    project.packages.find((item) => item.stage === "review")?.status === "complete" ||
    project.handoff.state !== "agent-actionable"
  )
    throw error(
      "An observed calculation needs an active computational requirement, frozen acquisition, and an actionable project before completed review.",
    );
  await nativePacketBinding(root, project, input.nativeSessionId);
}
export async function nativePacketBinding(
  root: string,
  project: ProjectState,
  sessionId: string | null,
) {
  const active = await pathExists(
    join(workspacePaths(root).projects, project.id, "native/active.json"),
  );
  if (!active) {
    if (sessionId !== null) throw error("The selected native stage session is no longer active.");
    return null;
  }
  if (!sessionId) throw error("An active native calculation must name its exact stage session.");
  const { inspectNativeCalculationScope } = await import("./runtime.js");
  return inspectNativeCalculationScope(root, project, sessionId);
}
async function exactDirectory(path: string) {
  if (!isAbsolute(path) || path !== resolve(path))
    throw error("Native calculation directory must be explicit, absolute and canonical.");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw error("Native calculation directory cannot be a symbolic link.");
  // Canonicalize parent aliases such as macOS /var before containment checks.
  return realpath(path);
}
export async function copyExact(source: string, target: string, sha256: string) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || (await sha256File(source)) !== sha256)
    throw error("A bound calculation file is missing, linked or changed.");
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o444);
  if ((await sha256File(target)) !== sha256)
    throw error("Calculation bytes changed during staging.");
}
export async function storeRunObject(
  root: string,
  projectId: string,
  source: string,
): Promise<OutputRecord> {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink())
    throw error("Run objects must be exact regular files.");
  const bytes = await readFile(source);
  if (
    sanitizeResearchText(bytes.toString("utf8"), configuredResearchSecrets(process.env)) !==
    bytes.toString("utf8")
  )
    throw error(
      "Calculation files contain sensitive material; provide an explicitly safe artifact.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await taskDirectory(root, projectId, "run-objects", true);
  const target = join(directory, sha256);
  if (!(await pathExists(target))) await copyExact(source, target, sha256);
  else if (!(await filesStillMatch([{ path: target, sha256 }])))
    throw error("An immutable native run object changed.");
  return { path: `task/run-objects/${sha256}`, sha256, bytes: bytes.length };
}
async function filesStillMatch(files: Array<{ path: string; sha256: string }>) {
  for (const file of files) {
    const info = await lstat(file.path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || (await sha256File(file.path)) !== file.sha256)
      return false;
  }
  return true;
}
function completedRunEvent(events: JournalEvent[], projectId: string, runId: string) {
  return events.findLast(
    (event) =>
      event.scope === projectId &&
      event.type === "project.task.run.completed" &&
      event.payload.runId === runId,
  );
}
export async function inspectNativeRun(root: string, projectId: string, runId: string) {
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  const completed = completedRunEvent(events, projectId, runId);
  if (completed)
    return { record: await readNativeRun(root, projectId, String(completed.payload.recordSha256)) };
  return {
    projectId,
    runId,
    status: events.some(
      (event) =>
        event.scope === projectId &&
        event.type === "project.task.run.started" &&
        event.payload.runId === runId,
    )
      ? "incomplete"
      : "not-found",
    automaticRetry: false,
  };
}
export async function readNativeRun(
  root: string,
  projectId: string,
  hash: string,
  knownEvents?: JournalEvent[],
): Promise<NativeRunRecord> {
  const record = validateNativeRunRecord(
    await readTaskObject(root, projectId, "runs", hash, "recordSha256"),
    projectId,
  );
  const events = knownEvents ?? (await readVerifiedJournal(workspacePaths(root).journal));
  const completed = completedRunEvent(events, projectId, record.runId);
  const started = events.find(
    (event) =>
      event.scope === projectId &&
      event.type === "project.task.run.started" &&
      event.payload.runId === record.runId,
  );
  if (
    completed?.payload.recordSha256 !== hash ||
    completed.payload.requestSha256 !== record.requestSha256 ||
    started?.payload.requestSha256 !== record.requestSha256 ||
    started.payload.scriptSha256 !== record.script.sha256 ||
    started.payload.runtimeBinarySha256 !== record.runtime.binarySha256 ||
    started.payload.environmentLockSha256 !== record.environmentLock.sha256 ||
    started.payload.nativePacketSha256 !== record.nativePacketSha256 ||
    started.payload.investigationPromotionSha256 !==
      record.investigationCertification?.promotionSha256 ||
    completed.payload.status !== record.status ||
    started.sequence >= completed.sequence
  )
    throw error(
      "Native run does not match its committed start and completion.",
      "RESEARCH_NATIVE_RUN_BINDING_INVALID",
    );
  await taskDirectory(root, projectId, "run-objects", false);
  for (const object of [
    record.script,
    record.environmentLock,
    ...record.inputs,
    ...record.outputs,
  ]) {
    const path = join(workspacePaths(root).projects, projectId, object.path);
    if (
      !(await filesStillMatch([{ path, sha256: object.sha256 }])) ||
      (await lstat(path)).size !== object.bytes
    )
      throw error("Native run object bytes changed.", "RESEARCH_NATIVE_RUN_BINDING_INVALID");
  }
  return record;
}

/** Explicit journal references only; no directory scan or newest-result selection. */
export async function nativeRunArtifactRecords(
  root: string,
  projectId: string,
): Promise<OutputRecord[]> {
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  const hashes = [
    ...new Set(
      events
        .filter((event) => event.scope === projectId && event.type === "project.task.run.completed")
        .map((event) => String(event.payload.recordSha256)),
    ),
  ];
  const objects = new Map<string, OutputRecord>();
  for (const hash of hashes) {
    const run = await readNativeRun(root, projectId, hash, events);
    const path = `task/runs/${hash}.json`;
    objects.set(path, await fileRecord(join(workspacePaths(root).projects, projectId, path), path));
    for (const object of [run.script, run.environmentLock, ...run.inputs, ...run.outputs]) {
      objects.set(object.path, { path: object.path, sha256: object.sha256, bytes: object.bytes });
    }
  }
  return [...objects.values()];
}
export function validateNativeRunRecord(value: unknown, projectId: string): NativeRunRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-native-run" ||
    value.projectId !== projectId ||
    value.observation !== "cli-observed-native-process" ||
    value.executionCertified !== false ||
    value.environmentVerification !== "declared-lock-not-attested" ||
    !statuses.includes(value.status as (typeof statuses)[number]) ||
    !isObject(value.runtime) ||
    !isObject(value.process) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.outputs) ||
    !Array.isArray(value.expectedOutputIds)
  )
    throw error("Native run record is malformed.", "RESEARCH_NATIVE_RUN_BINDING_INVALID");
  const { recordSha256, ...core } = value;
  if (recordSha256 !== sha256Text(canonicalJson(core)))
    throw error("Native run record hash changed.", "RESEARCH_NATIVE_RUN_BINDING_INVALID");
  for (const object of [value.script, value.environmentLock, ...value.inputs, ...value.outputs]) {
    if (
      !isObject(object) ||
      typeof object.sha256 !== "string" ||
      !HASH.test(object.sha256) ||
      object.path !== `task/run-objects/${object.sha256}` ||
      !Number.isSafeInteger(object.bytes) ||
      Number(object.bytes) < 0
    )
      throw error("Native run object address is invalid.", "RESEARCH_NATIVE_RUN_BINDING_INVALID");
  }
  if (
    value.status === "succeeded" &&
    (value.process.exitCode !== 0 ||
      value.process.signal !== null ||
      value.outputs.length !== value.expectedOutputIds.length)
  )
    throw error(
      "A successful run needs an observed zero exit and every declared output.",
      "RESEARCH_NATIVE_RUN_BINDING_INVALID",
    );
  return value as unknown as NativeRunRecord;
}
function safeDiagnostic(text: string, truncated: boolean) {
  if (truncated)
    return "Calculation diagnostics exceeded the bounded log capture; no partial secret-bearing text is reported.";
  return sanitizeResearchText(text, configuredResearchSecrets(process.env))
    .replace(/\/(?:Users|home|private\/tmp|private\/var|tmp)\/[^\s"':)]+/gu, "[host-path]")
    .replace(/[A-Za-z]:\\[^\s"']+/gu, "[host-path]")
    .slice(0, 2000);
}
export async function captureProcess(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
) {
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    startedAt: string;
    finishedAt: string;
    wallSeconds: number;
    stdout: string;
    stderr: string;
    stdoutSha256: string;
    stderrSha256: string;
    stdoutBytes: number;
    stderrBytes: number;
    truncated: boolean;
    timedOut: boolean;
    cancelled: boolean;
  }>((resolvePromise) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      shell: false,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createHash("sha256"),
      err = createHash("sha256");
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      truncated = false,
      timedOut = false,
      cancelled = false,
      spawnFailed = false;
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (platform() === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const cancel = () => {
      cancelled = true;
      terminate("SIGKILL");
    };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      out.update(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 1024 * 1024) stdout.push(chunk);
      else truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.update(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
      else truncated = true;
    });
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      resolvePromise({
        exitCode: spawnFailed ? null : exitCode,
        signal,
        startedAt,
        finishedAt: new Date().toISOString(),
        wallSeconds: Number(process.hrtime.bigint() - start) / 1e9,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutSha256: out.digest("hex"),
        stderrSha256: err.digest("hex"),
        stdoutBytes,
        stderrBytes,
        truncated,
        timedOut,
        cancelled,
      });
    });
  });
}

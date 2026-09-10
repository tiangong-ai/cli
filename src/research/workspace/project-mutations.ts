import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { CliError } from "../../errors.js";
import { appendEvidenceLedgerEvent, evidenceLedgerPath } from "./evidence-ledger.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { canonicalJson, isObject, sha256Text, workspacePaths, writeJsonAtomic } from "./storage.js";
import type { JournalEvent, ProjectState } from "./types.js";

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

interface MutationIdentity {
  schemaVersion: 1;
  kind:
    | "fork"
    | "retry"
    | "acquisition-revision"
    | "task-scope"
    | "scientific-fulfillment"
    | "scientific-amendment";
  operationId: string;
  sourceProjectId: string;
  targetProjectId: string | null;
  requestSha256: string;
  beforeSha256: string;
}

export interface ProjectMutation {
  identity: MutationIdentity;
  after: ProjectState | null;
  afterSha256: string | null;
  targetSha256: string | null;
  recordSha256: string;
}

function failure(message: string, record?: ProjectMutation): CliError {
  return new CliError(message, {
    code: "RESEARCH_PROJECT_RECOVERY_REQUIRED",
    exitCode: 3,
    details: record
      ? {
          operationId: record.identity.operationId,
          sourceProjectId: record.identity.sourceProjectId,
          targetProjectId: record.identity.targetProjectId,
          recovery:
            "Preserve the stored state. Resolve the reported conflict or restore a trusted backup before retrying the same explicit request; do not forge journal/project records.",
        }
      : undefined,
  });
}

async function privateDirectory(
  root: string,
  parts: string[],
  create: boolean,
): Promise<string | null> {
  let path = workspacePaths(root).control;
  if (!create) {
    const existing = await lstat(join(path, "lineage", ...parts)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      },
    );
    if (!existing) return null;
  }
  await requireDirectory(path);
  for (const part of ["lineage", ...parts]) {
    path = join(path, part);
    let info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      if (!create) return null;
      await mkdir(path, { mode: 0o700 });
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw failure("Project recovery storage must use regular non-symlink directories.");
    }
  }
  return path;
}

async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw failure(
      "Project recovery directories must be regular and cannot redirect through symlinks.",
    );
  }
}

function filename(record: ProjectMutation): string {
  return (
    record.identity.kind +
    "-" +
    (record.identity.targetProjectId ?? record.identity.sourceProjectId) +
    ".json"
  );
}

function bindRecord(core: Omit<ProjectMutation, "recordSha256">): ProjectMutation {
  return { ...core, recordSha256: sha256Text(canonicalJson(core)) };
}

async function readRecord(path: string): Promise<ProjectMutation> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    throw failure("Project recovery record is not a bounded regular file.");
  }
  const value = await readRecoveryJson(path);
  if (!isObject(value) || !isObject(value.identity))
    throw failure("Project recovery record is invalid.");
  const identity = value.identity;
  if (
    identity.schemaVersion !== 1 ||
    ![
      "fork",
      "retry",
      "acquisition-revision",
      "task-scope",
      "scientific-fulfillment",
      "scientific-amendment",
    ].includes(String(identity.kind)) ||
    typeof identity.operationId !== "string" ||
    !UUID.test(identity.operationId) ||
    typeof identity.sourceProjectId !== "string" ||
    !ID.test(identity.sourceProjectId) ||
    typeof identity.requestSha256 !== "string" ||
    !HASH.test(identity.requestSha256) ||
    typeof identity.beforeSha256 !== "string" ||
    !HASH.test(identity.beforeSha256) ||
    (identity.kind === "fork"
      ? typeof identity.targetProjectId !== "string" ||
        !ID.test(identity.targetProjectId) ||
        identity.targetProjectId === identity.sourceProjectId
      : identity.targetProjectId !== null) ||
    (value.after !== null &&
      (!isObject(value.after) || value.after.id !== identity.sourceProjectId)) ||
    (value.afterSha256 !== null &&
      (typeof value.afterSha256 !== "string" || !HASH.test(value.afterSha256))) ||
    (value.targetSha256 !== null &&
      (typeof value.targetSha256 !== "string" || !HASH.test(value.targetSha256)))
  )
    throw failure("Project recovery record identity is invalid.");
  const { recordSha256, ...core } = value;
  if (
    recordSha256 !== sha256Text(canonicalJson(core)) ||
    (value.after === null
      ? value.afterSha256 !== null
      : value.afterSha256 !== sha256Text(canonicalJson(value.after)))
  ) {
    throw failure("Project recovery record failed its hash binding.");
  }
  const record = value as unknown as ProjectMutation;
  if (basename(path) !== filename(record))
    throw failure("Project recovery record filename is invalid.");
  return record;
}

async function projectState(root: string, projectId: string): Promise<ProjectState> {
  const projects = workspacePaths(root).projects;
  await requireDirectory(projects);
  await requireDirectory(join(projects, projectId));
  const path = join(projects, projectId, "project.json");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    throw failure("Project recovery requires a bounded regular project state.");
  }
  const value = await readRecoveryJson(path);
  if (!isObject(value) || value.id !== projectId)
    throw failure("Project recovery state identity is invalid.");
  return value as unknown as ProjectState;
}

async function readRecoveryJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw failure("Project recovery JSON is missing or invalid; preserved bytes were not changed.");
  }
}

/** Called only under the existing workspace lease, before creating a fork target. */
export async function beginProjectMutation(
  root: string,
  kind: MutationIdentity["kind"],
  source: ProjectState,
  requestSha256: string,
  targetProjectId: string | null = null,
): Promise<ProjectMutation> {
  if (
    !ID.test(source.id) ||
    !HASH.test(requestSha256) ||
    (kind === "fork"
      ? !targetProjectId || !ID.test(targetProjectId) || targetProjectId === source.id
      : targetProjectId !== null)
  ) {
    throw failure("Project mutation identity is invalid.");
  }
  const directory = (await privateDirectory(root, ["pending-project-mutations"], true))!;
  const record = bindRecord({
    identity: {
      schemaVersion: 1,
      kind,
      operationId: randomUUID(),
      sourceProjectId: source.id,
      targetProjectId,
      requestSha256,
      beforeSha256: sha256Text(canonicalJson(source)),
    },
    after: null,
    afterSha256: null,
    targetSha256: null,
  });
  const path = join(directory, filename(record));
  if (await lstat(path).catch(() => undefined))
    throw failure("An earlier project mutation needs recovery.", record);
  await writeJsonAtomic(path, record);
  await appendJournalEvent(workspacePaths(root).journal, "project.mutation.started", source.id, {
    ...record.identity,
    identitySha256: sha256Text(canonicalJson(record.identity)),
  });
  return record;
}

export async function prepareProjectMutation(
  root: string,
  record: ProjectMutation,
  after: ProjectState,
): Promise<ProjectMutation> {
  const directory = await privateDirectory(root, ["pending-project-mutations"], false);
  if (!directory || after.id !== record.identity.sourceProjectId)
    throw failure("Prepared project mutation identity changed.", record);
  const currentRecord = await readRecord(join(directory, filename(record)));
  if (
    currentRecord.recordSha256 !== record.recordSha256 ||
    sha256Text(canonicalJson(await projectState(root, record.identity.sourceProjectId))) !==
      record.identity.beforeSha256
  ) {
    throw failure("Project state changed during the prepared mutation.", record);
  }
  const target = record.identity.targetProjectId
    ? await projectState(root, record.identity.targetProjectId)
    : null;
  const prepared = bindRecord({
    identity: record.identity,
    after: structuredClone(after),
    afterSha256: sha256Text(canonicalJson(after)),
    targetSha256: target ? sha256Text(canonicalJson(target)) : null,
  });
  await writeJsonAtomic(join(directory, filename(prepared)), prepared);
  return prepared;
}

export function projectMutationBinding(record: ProjectMutation): Record<string, string> {
  return {
    operationId: record.identity.operationId,
    requestSha256: record.identity.requestSha256,
    recordSha256: record.recordSha256,
    resultSha256: record.afterSha256 ?? "",
  };
}

function committedEvent(events: JournalEvent[], record: ProjectMutation): JournalEvent | undefined {
  return events.find(
    (event) =>
      event.type ===
        (record.identity.kind === "fork"
          ? "project.forked"
          : record.identity.kind === "retry"
            ? "project.retry.requested"
            : record.identity.kind === "acquisition-revision"
              ? "project.acquisition.revision.requested"
              : record.identity.kind === "scientific-fulfillment"
                ? "scientific.fulfillment.recorded"
                : record.identity.kind === "scientific-amendment"
                  ? "scientific.amendment.recorded"
                  : "project.task.scope.approved") &&
      isObject(event.payload.mutation) &&
      event.payload.mutation.operationId === record.identity.operationId,
  );
}

/** The journal event is the commit point; state/ledger files are recoverable projections. */
async function settleMutation(
  root: string,
  record: ProjectMutation,
  events: JournalEvent[],
): Promise<boolean> {
  const paths = workspacePaths(root);
  await requireDirectory(paths.projects);
  const identity = record.identity;
  const started = events.find(
    (event) =>
      event.type === "project.mutation.started" &&
      event.payload.operationId === identity.operationId,
  );
  const commit = committedEvent(events, record);
  const targetPath = identity.targetProjectId
    ? join(paths.projects, identity.targetProjectId)
    : null;
  const targetInfo = targetPath
    ? await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  if (
    started?.scope !== identity.sourceProjectId ||
    started?.payload.identitySha256 !== sha256Text(canonicalJson(identity))
  ) {
    // A crash before the intent append cannot have created a target.
    if (started || commit || targetInfo)
      throw failure("Project recovery has no matching journal intent.", record);
  } else if (commit) {
    const binding = commit.payload.mutation;
    if (
      !isObject(binding) ||
      binding.recordSha256 !== record.recordSha256 ||
      binding.requestSha256 !== identity.requestSha256 ||
      binding.resultSha256 !== record.afterSha256 ||
      commit.scope !== (identity.targetProjectId ?? identity.sourceProjectId) ||
      (identity.kind === "fork"
        ? commit.payload.sourceProjectId !== identity.sourceProjectId ||
          commit.payload.targetProjectId !== identity.targetProjectId
        : commit.payload.projectId !== identity.sourceProjectId) ||
      !record.after ||
      !record.afterSha256
    ) {
      throw failure("Committed project mutation does not match its recovery record.", record);
    }
    if (targetPath) {
      if (
        !targetInfo?.isDirectory() ||
        targetInfo.isSymbolicLink() ||
        sha256Text(canonicalJson(await projectState(root, identity.targetProjectId!))) !==
          record.targetSha256
      ) {
        throw failure("Committed fork target changed before recovery completed.", record);
      }
    }
    const current = await projectState(root, identity.sourceProjectId);
    const currentHash = sha256Text(canonicalJson(current));
    if (currentHash !== record.afterSha256) {
      if (currentHash !== identity.beforeSha256)
        throw failure("Recovery will not overwrite changed project state.", record);
      await writeJsonAtomic(
        join(paths.projects, identity.sourceProjectId, "project.json"),
        record.after,
      );
    }
    if (identity.kind === "fork") {
      const ledger = await readVerifiedJournal(evidenceLedgerPath(root, identity.sourceProjectId));
      if (
        !ledger.some(
          (event) =>
            event.type === "project.superseded" &&
            event.payload.operationId === identity.operationId,
        )
      ) {
        await appendEvidenceLedgerEvent(root, identity.sourceProjectId, "project.superseded", {
          sourceProjectId: identity.sourceProjectId,
          supersededBy: identity.targetProjectId,
          reason: "recovery-fork",
          operationId: identity.operationId,
          commitSha256: commit.hash,
        });
      }
    }
  } else {
    if (targetInfo) {
      if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
        throw failure("Recovery will not move an unknown or linked fork target.", record);
      }
      // Preserve interrupted bytes instead of recursively deleting a control tree.
      const retained = (await privateDirectory(
        root,
        ["interrupted-project-mutations", identity.operationId],
        true,
      ))!;
      await rename(targetPath!, join(retained, "target"));
    }
    if (
      !events.some(
        (event) =>
          event.type === "project.mutation.aborted" &&
          event.payload.operationId === identity.operationId,
      )
    ) {
      await appendJournalEvent(
        paths.journal,
        "project.mutation.aborted",
        identity.sourceProjectId,
        {
          operationId: identity.operationId,
          mutationKind: identity.kind,
          targetProjectId: identity.targetProjectId,
          retainedInterruptedTarget: Boolean(targetInfo),
        },
      );
    }
  }
  const directory = (await privateDirectory(root, ["pending-project-mutations"], false))!;
  await rm(join(directory, filename(record)));
  // Leave no normal-path recovery scan once all owned records are settled.
  await rmdir(directory).catch(() => undefined);
  return Boolean(commit);
}

/** Settle an operation after success or caught failure; committed targets are never rolled back. */
export async function settleProjectMutation(
  root: string,
  record: ProjectMutation,
): Promise<boolean> {
  const directory = await privateDirectory(root, ["pending-project-mutations"], false);
  const path = directory ? join(directory, filename(record)) : null;
  if (!path || !(await lstat(path).catch(() => undefined))) {
    return Boolean(committedEvent(await readVerifiedJournal(workspacePaths(root).journal), record));
  }
  const latest = await readRecord(path);
  if (latest.identity.operationId !== record.identity.operationId)
    throw failure("Project recovery identity changed.", record);
  return settleMutation(root, latest, await readVerifiedJournal(workspacePaths(root).journal));
}

/** Constant-size directory check in normal operation; journal/state work only when pending. */
export async function recoverProjectMutations(root: string): Promise<void> {
  const directory = await privateDirectory(root, ["pending-project-mutations"], false);
  if (!directory) return;
  const files = (await readdir(directory)).filter((name) =>
    /^(?:fork|retry|acquisition-revision|task-scope|scientific-fulfillment|scientific-amendment)-[a-z0-9][a-z0-9-]{2,63}\.json$/.test(
      name,
    ),
  );
  if (!files.length) return;
  const events = await readVerifiedJournal(workspacePaths(root).journal);
  for (const file of files.sort())
    await settleMutation(root, await readRecord(join(directory, file)), events);
}

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { readVerifiedJournal } from "./journal.js";
import { isObject, workspacePaths } from "./storage.js";
import type { JournalEvent, ProjectState, ScientificReviewRole } from "./types.js";

export interface ProjectAuthorityIndex {
  forks: Map<string, JournalEvent>;
  addenda: Map<string, JournalEvent>;
  successors: Map<string, string>;
  pendingTargets: Set<string>;
  registered: Set<string>;
  resolvedSuccessors: Map<string, string | null>;
  taskEvents: Map<string, JournalEvent[]>;
}

/** One verified journal view per inspection/admission, never a per-project artifact scan. */
export async function readProjectAuthorityIndex(root: string): Promise<ProjectAuthorityIndex> {
  return projectAuthorityIndex(await readVerifiedJournal(workspacePaths(root).journal));
}

export function projectAuthorityIndex(events: JournalEvent[]): ProjectAuthorityIndex {
  const result: ProjectAuthorityIndex = {
    forks: new Map(),
    addenda: new Map(),
    successors: new Map(),
    pendingTargets: new Set(),
    registered: new Set(),
    resolvedSuccessors: new Map(),
    taskEvents: new Map(),
  };
  const pending = new Map<string, string>();
  for (const event of events) {
    if (
      event.type.startsWith("project.task.") ||
      event.type === "scientific.amendment.recorded" ||
      event.type === "scientific.fulfillment.recorded" ||
      (event.type === "package.completed" && event.payload.packageId === "review") ||
      (["project.forked", "project.addendum.created"].includes(event.type) &&
        isObject(event.payload.taskContract))
    ) {
      const entries = result.taskEvents.get(event.scope) ?? [];
      entries.push(event);
      result.taskEvents.set(event.scope, entries);
    }
    if (event.type === "project.initialized") result.registered.add(event.scope);
    if (
      event.type === "project.mutation.started" &&
      event.payload.kind === "fork" &&
      typeof event.payload.operationId === "string" &&
      typeof event.payload.targetProjectId === "string"
    ) {
      pending.set(event.payload.operationId, event.payload.targetProjectId);
    }
    if (
      event.type === "project.mutation.aborted" &&
      typeof event.payload.operationId === "string"
    ) {
      pending.delete(event.payload.operationId);
    }
    if (event.type !== "project.forked" && event.type !== "project.addendum.created") continue;
    const source = event.payload.sourceProjectId;
    const target = event.payload.targetProjectId;
    if (typeof source !== "string" || typeof target !== "string" || event.scope !== target)
      continue;
    result.registered.add(target);
    result.successors.set(source, target);
    if (event.type === "project.forked") result.forks.set(target, event);
    else result.addenda.set(target, event);
    if (
      isObject(event.payload.mutation) &&
      typeof event.payload.mutation.operationId === "string"
    ) {
      pending.delete(event.payload.mutation.operationId);
    }
  }
  for (const target of pending.values()) {
    if (!result.registered.has(target)) result.pendingTargets.add(target);
  }
  return result;
}

export function projectAuthority(
  project: ProjectState,
  index: ProjectAuthorityIndex,
): {
  state: "authoritative" | "superseded" | "archived" | "abandoned" | "invalid";
  projectId: string;
} {
  const creation =
    project.lineage.kind === "fork" ? index.forks.get(project.id) : index.addenda.get(project.id);
  if (
    project.lineage.kind !== "primary" &&
    (!creation ||
      creation.payload.sourceProjectId !== project.lineage.derivedFrom ||
      creation.payload.sourceProjectId !== project.lineage.supersedes)
  ) {
    return { state: "invalid", projectId: project.id };
  }
  const current = resolveSuccessor(project.id, index);
  if (current === null) return { state: "invalid", projectId: project.id };
  if (project.status === "archived" || project.status === "abandoned") {
    return { state: project.status, projectId: current };
  }
  return { state: current === project.id ? "authoritative" : "superseded", projectId: current };
}

function resolveSuccessor(id: string, index: ProjectAuthorityIndex): string | null {
  let current = id;
  const path = new Set<string>();
  let resolved: string | null;
  for (;;) {
    if (index.resolvedSuccessors.has(current)) {
      resolved = index.resolvedSuccessors.get(current)!;
      break;
    }
    if (path.has(current)) {
      resolved = null;
      break;
    }
    path.add(current);
    const next = index.successors.get(current);
    if (!next) {
      resolved = current;
      break;
    }
    current = next;
  }
  // Cache only within this immutable verified-journal view, never across commands.
  for (const entry of path) index.resolvedSuccessors.set(entry, resolved);
  return resolved;
}

export function assertProjectAuthority(project: ProjectState, index: ProjectAuthorityIndex): void {
  const authority = projectAuthority(project, index);
  if (authority.state !== "authoritative") {
    throw new CliError("Research project is not a committed authoritative project.", {
      code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      exitCode: 3,
      details: {
        projectId: project.id,
        authority: authority.state,
        authoritativeProjectId: authority.projectId,
      },
    });
  }
}

/** Mutable files mirror the journal; ignore only uncommitted derived supersession. */
export function projectWithEffectiveAuthority(
  project: ProjectState,
  index: ProjectAuthorityIndex,
): ProjectState {
  const next = index.successors.get(project.id) ?? null;
  let result = project.lineage.supersededBy === next ? project : structuredClone(project);
  const old = result.lineage.supersededBy;
  if (result !== project) result.lineage.supersededBy = next;
  if (result !== project && next) {
    result.evidenceState.staleReason = "Superseded by committed project " + next + ".";
    if (result.status !== "archived" && result.status !== "abandoned") result.status = "stale";
  } else if (
    result !== project &&
    old &&
    [
      "Superseded by recovery fork " + old + ".",
      "Superseded by evidence addendum " + old + ".",
    ].includes(result.evidenceState.staleReason ?? "")
  ) {
    result.evidenceState.staleReason = null;
  }
  const scope = index.taskEvents
    .get(project.id)
    ?.findLast((event) => event.type === "project.task.scope.approved");
  const invalidated = scope?.payload.invalidatedScientificReviews;
  if (result.scientificDesign && Array.isArray(invalidated)) {
    for (const entry of invalidated) {
      if (
        !isObject(entry) ||
        !["research-design", "evidence-construct", "pilot-methods"].includes(String(entry.role)) ||
        typeof entry.packetSha256 !== "string"
      )
        continue;
      const role = entry.role as ScientificReviewRole;
      if (result.scientificDesign!.gates[role].packetSha256 !== entry.packetSha256) continue;
      if (result === project) result = structuredClone(project);
      result.scientificDesign!.gates[role] = {
        status: "pending",
        packetSha256: null,
        assessmentSha256: null,
        reviewSha256: null,
        reviewerSessionSha256: null,
      };
    }
  }
  return result;
}

export async function visibleProjectIds(
  root: string,
  index: ProjectAuthorityIndex,
): Promise<string[]> {
  const paths = workspacePaths(root);
  const entries = await readdir(paths.projects, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || index.pendingTargets.has(entry.name))
      continue;
    const info = await lstat(join(paths.projects, entry.name, "project.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    // A never-committed directory is not a project. Do not hide damage to a committed one.
    if (!info && !index.registered.has(entry.name)) continue;
    result.push(entry.name);
  }
  return result;
}

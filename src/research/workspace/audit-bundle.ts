import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { loadEvidenceArtifactRecords } from "./artifacts.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { verifyCapabilities } from "./capabilities.js";
import { loadCurrentEvidenceContentSnapshot } from "./content-evidence.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import { loadCurrentClaimEvidenceGraph, loadCurrentInferenceSnapshot } from "./inference.js";
import { readJournal, verifyJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { inspectPublicationStatus } from "./publication-workflow.js";
import { verifyTaskAudit, writeTaskAuditContext, type TaskAuditBinding } from "./task-audit.js";
import { loadScientificFulfillmentView } from "./scientific-fulfillment.js";
import { verifyScientificFulfillmentAudit } from "./scientific-fulfillment-audit.js";
import { resolveScientificObjectBinding } from "./scientific-objects.js";
import { verifyArtifactReadAudit } from "./artifact-read-audit.js";
import {
  isSensitiveEnvironmentName,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  regularTreeFiles,
  resolveContained,
  safeRelativePath,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { AgentRoute, ProjectState, RuntimeLock } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXT_SCAN_BYTES = 16 * 1024 * 1024;
const SENSITIVE_CONTAINER_KEY =
  /^(?:(?:access|refresh|id|auth|bearer|session|csrf|xsrf)[_-]?token|(?:client|app|consumer)[_-]?secret|api[_-]?key|apikey|auth|authorization|cookie|credential|password|passwd|private[_-]?key|secret[_-]?access[_-]?key|session(?:[_-]?id)?|token)$/i;

export interface ProjectAuditManifest {
  schemaVersion: 1;
  kind: "tiangong-project-audit-bundle";
  projectId: string;
  createdAt: string;
  authority: {
    status: ProjectState["status"];
    lineageKind: ProjectState["lineage"]["kind"];
    derivedFrom: string | null;
    supersedes: string | null;
    supersededBy: string | null;
  };
  sourceBindings: {
    projectStateSha256: string;
    workspaceJournalHead: string;
    workspaceRuntimeLockSha256: string;
    capabilityLockSha256: string | null;
    sourceWorkspacePathSha256: string;
  };
  researchChain: {
    task?: TaskAuditBinding;
    acquisitionSnapshot: AuditChainBinding | null;
    contentSnapshot: AuditChainBinding | null;
    inferenceSnapshot: AuditChainBinding | null;
    analysisRun: AuditChainBinding | null;
    claimEvidenceGraph: AuditChainBinding | null;
    publication: {
      generationSha256: string;
      manuscriptSha256: string;
      submissionPackageSha256: string;
      closureSha256: string | null;
    } | null;
  };
  locatorRoots: {
    project: "project";
    workspaceObjects: "workspace-objects";
    inputs: "inputs";
  };
  exclusions: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
  manifestSha256: string;
}

interface AuditChainBinding {
  id: string;
  sha256: string;
}

export async function exportProjectAuditBundle(input: {
  root: string;
  projectId: string;
  destination: string;
}): Promise<ProjectAuditManifest> {
  return withWorkspaceLock(input.root, "research.audit.export", async () => {
    const destination = await validateNewDestination(input.destination);
    const paths = workspacePaths(input.root);
    const project = await loadProject(input.root, input.projectId);
    const journal = await verifyJournal(paths.journal);
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      const staged = new Set<string>();
      const stageFile = async (source: string, logicalPath: string): Promise<void> => {
        const logical = safeRelativePath(logicalPath, "Audit bundle file");
        if (staged.has(logical)) return;
        const info = await lstat(source).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) {
          throw auditError(`Audit source is not an exact regular file: ${logical}`);
        }
        const target = resolveContained(temporary, logical);
        await ensureDirectory(dirname(target));
        await copyFile(source, target, fsConstants.COPYFILE_EXCL);
        await chmod(target, 0o444).catch(() => undefined);
        staged.add(logical);
      };

      const projectRoot = join(paths.projects, project.id);
      const researchChain = await loadVerifiedResearchChain(input.root, project);
      if (project.scientificDesign) {
        const fulfillment = await loadScientificFulfillmentView(input.root, project);
        for (const record of fulfillment.records) {
          for (const [kind, items] of [
            ["model-implementation", record.modelImplementations],
            ["environment-lock", record.environmentLocks],
          ] as const) {
            for (const item of items) {
              const object = await resolveScientificObjectBinding({
                root: input.root,
                objectKind: kind,
                objectLocator: item.objectLocator,
                expectedSha256: item.sha256,
              });
              await stageFile(object.sourcePath, `workspace-objects/${item.objectLocator}`);
              await stageFile(
                resolveContained(paths.control, object.record!.recordLocator),
                `workspace-objects/${object.record!.recordLocator}`,
              );
            }
          }
        }
      }
      const task = await writeTaskAuditContext(input.root, project, temporary);
      if (task) researchChain.task = task;
      const projectFiles = await regularTreeFiles(projectRoot).catch((error) => {
        throw auditError("Project tree contains a non-portable entry.", error);
      });
      for (const source of projectFiles) {
        const logical = relative(projectRoot, source).split(sep).join("/");
        if (
          logical === "project.json" ||
          logical.startsWith("runs/") ||
          logical.startsWith("native/")
        ) {
          continue;
        }
        await stageFile(source, `project/${logical}`);
      }

      const portableProject = portableProjectState(project);
      await writeJsonAtomic(join(temporary, "state", "project.json"), portableProject, 0o444);
      staged.add("state/project.json");

      for (const inputRecord of project.inputs) {
        await assertSourceBinding(inputRecord.path, inputRecord.sha256, inputRecord.bytes);
        await stageFile(inputRecord.path, `inputs/${inputRecord.sha256}`);
        if (inputRecord.contextPath && inputRecord.contextSha256 && inputRecord.contextBytes) {
          await assertSourceBinding(
            inputRecord.contextPath,
            inputRecord.contextSha256,
            inputRecord.contextBytes,
          );
          await stageFile(inputRecord.contextPath, `inputs/${inputRecord.contextSha256}`);
        }
      }

      for (const document of project.publicationPolicy?.documents ?? []) {
        const source = resolveContained(paths.control, document.objectLocator);
        await assertSourceBinding(source, document.sha256);
        await stageFile(source, `workspace-objects/${document.objectLocator}`);
      }

      const receipts = await loadProjectEvidenceReceipts(input.root, project.id);
      for (const receipt of receipts) {
        for (const locator of [
          receipt.locator,
          receipt.contextLocator,
          ...(receipt.data?.artifacts.map((artifact) => artifact.locator) ?? []),
        ]) {
          await stageFile(resolveContained(paths.control, locator), `workspace-objects/${locator}`);
        }
      }
      const artifacts = await loadEvidenceArtifactRecords(input.root, project.id);
      for (const artifact of artifacts) {
        await assertSourceBinding(
          resolveContained(paths.control, artifact.locator),
          artifact.sha256,
          artifact.bytes,
        );
        await stageFile(
          resolveContained(paths.control, artifact.locator),
          `workspace-objects/${artifact.locator}`,
        );
      }

      const [config, runtimeLock, capabilityVerification, journalEvents] = await Promise.all([
        loadWorkspaceConfig(input.root),
        readJsonFile<RuntimeLock>(paths.runtimeLock, "Research runtime lock"),
        verifyCapabilities(input.root),
        readJournal(paths.journal),
      ]);
      await writeJsonAtomic(
        join(temporary, "state", "environment.json"),
        {
          schemaVersion: 1,
          mode: config.mode,
          producer: portableAgentRoute(config.producer),
          reviewer: portableAgentRoute(config.reviewer),
          reviewerExecution: config.reviewerExecution,
          budget: config.budget,
          runtimeLock,
          capabilityVerification,
        },
        0o444,
      );
      staged.add("state/environment.json");
      await writeJsonAtomic(
        join(temporary, "state", "journal-event-proofs.json"),
        {
          schemaVersion: 1,
          workspaceJournalHead: journal.head,
          events: journalEvents
            .filter(
              (event) =>
                event.scope === project.id || containsExactString(event.payload, project.id),
            )
            .map(portableJournalEvent),
        },
        0o444,
      );
      staged.add("state/journal-event-proofs.json");

      await assertPortableTextFiles(temporary, resolve(input.root));
      const files = await bundleFileRecords(temporary);
      const projectStatePath = join(projectRoot, "project.json");
      const capabilityLockSha256 = (await pathExists(paths.capabilityLock))
        ? await sha256File(paths.capabilityLock)
        : null;
      const manifestCore = {
        schemaVersion: 1 as const,
        kind: "tiangong-project-audit-bundle" as const,
        projectId: project.id,
        createdAt: new Date().toISOString(),
        authority: {
          status: project.status,
          lineageKind: project.lineage.kind,
          derivedFrom: project.lineage.derivedFrom,
          supersedes: project.lineage.supersedes,
          supersededBy: project.lineage.supersededBy,
        },
        sourceBindings: {
          projectStateSha256: await sha256File(projectStatePath),
          workspaceJournalHead: journal.head,
          workspaceRuntimeLockSha256: await sha256File(paths.runtimeLock),
          capabilityLockSha256,
          sourceWorkspacePathSha256: sha256Text(resolve(input.root)),
        },
        researchChain,
        locatorRoots: {
          project: "project" as const,
          workspaceObjects: "workspace-objects" as const,
          inputs: "inputs" as const,
        },
        exclusions: [
          "credentials and environment secrets",
          "setup sources and browser profiles",
          "active native-stage state",
          "ephemeral run capsules and raw agent authentication",
          "unrelated workspace projects and files",
        ],
        files,
      };
      const manifest: ProjectAuditManifest = {
        ...manifestCore,
        manifestSha256: sha256Text(canonicalJson(manifestCore)),
      };
      await writeJsonAtomic(join(temporary, "manifest.json"), manifest, 0o444);
      await verifyProjectAuditBundle(temporary);
      await rename(temporary, destination);
      return manifest;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function portableJournalEvent(event: Awaited<ReturnType<typeof readJournal>>[number]) {
  const onceSanitized = sanitizeResearchValue(event.payload);
  const payload = JSON.parse(sanitizeResearchText(JSON.stringify(onceSanitized))) as Record<
    string,
    unknown
  >;
  return {
    schemaVersion: 1,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    scope: event.scope,
    payload,
    sourcePayloadSha256: sha256Text(canonicalJson(event.payload)),
    sourcePreviousHash: event.previousHash,
    sourceEventHash: event.hash,
  };
}

async function loadVerifiedResearchChain(
  root: string,
  project: ProjectState,
): Promise<ProjectAuditManifest["researchChain"]> {
  const projectRoot = join(workspacePaths(root).projects, project.id);
  const outputPath = (name: string) => join(projectRoot, "outputs", name);
  const acquisition = (await pathExists(outputPath("evidence-snapshot.json")))
    ? await loadCurrentEvidenceSnapshot(root, project.id)
    : null;
  const content = (await pathExists(outputPath("content-snapshot.json")))
    ? await loadCurrentEvidenceContentSnapshot(root, project.id)
    : null;
  const inference = (await pathExists(outputPath("inference-snapshot.json")))
    ? await loadCurrentInferenceSnapshot(root, project.id)
    : null;
  const graph = (await pathExists(outputPath("claim-evidence-graph.json")))
    ? await loadCurrentClaimEvidenceGraph(root, project.id)
    : null;
  const publicationCurrent = join(projectRoot, "publication", "current.json");
  const publication = (await pathExists(publicationCurrent))
    ? await inspectPublicationStatus(root, project.id)
    : null;
  return {
    acquisitionSnapshot: acquisition
      ? { id: acquisition.snapshotId, sha256: acquisition.snapshotSha256 }
      : null,
    contentSnapshot: content ? { id: content.snapshotId, sha256: content.snapshotSha256 } : null,
    inferenceSnapshot: inference
      ? { id: inference.snapshotId, sha256: inference.snapshotSha256 }
      : null,
    analysisRun: graph ? { id: graph.analysisRunId, sha256: graph.analysisSha256 } : null,
    claimEvidenceGraph: graph ? { id: graph.graphId, sha256: graph.graphSha256 } : null,
    publication:
      publication?.generationSha256 &&
      publication.manuscriptSha256 &&
      publication.submissionPackageSha256
        ? {
            generationSha256: publication.generationSha256,
            manuscriptSha256: publication.manuscriptSha256,
            submissionPackageSha256: publication.submissionPackageSha256,
            closureSha256: publication.closureSha256,
          }
        : null,
  };
}

export async function verifyProjectAuditBundle(bundlePath: string): Promise<{
  status: "verified";
  projectId: string;
  manifestSha256: string;
  files: number;
  artifactReads: { verifiedReadReceipts: number; uncommittedReadReceipts: number };
  task?: TaskAuditBinding & { executionCertified: false };
}> {
  if (!isAbsolute(bundlePath) || resolve(bundlePath) !== bundlePath) {
    throw auditPathError("Audit bundle path must be absolute and normalized.");
  }
  const info = await lstat(bundlePath).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw auditPathError("Audit bundle must be a regular directory and not a symbolic link.");
  }
  const manifestPath = join(bundlePath, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch(() => undefined);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw auditError("Audit manifest is missing or is not a regular file.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    throw auditError("Audit manifest is not valid JSON.");
  }
  const manifest = parseManifest(value);
  const { manifestSha256, ...core } = manifest;
  if (sha256Text(canonicalJson(core)) !== manifestSha256) {
    throw auditError("Audit manifest failed its hash binding.");
  }
  const actualFiles = (await regularTreeFiles(bundlePath))
    .map((path) => relative(bundlePath, path).split(sep).join("/"))
    .filter((path) => path !== "manifest.json");
  const expectedPaths = manifest.files.map((file) => file.path);
  if (
    actualFiles.length !== expectedPaths.length ||
    actualFiles.some((path, index) => path !== expectedPaths[index])
  ) {
    throw auditError("Audit bundle contains missing, extra, or unordered files.");
  }
  for (const record of manifest.files) {
    const path = resolveContained(bundlePath, record.path);
    const fileInfo = await lstat(path).catch(() => undefined);
    if (
      !fileInfo?.isFile() ||
      fileInfo.isSymbolicLink() ||
      fileInfo.size !== record.bytes ||
      (await sha256File(path)) !== record.sha256
    ) {
      throw auditError(`Audit file failed its exact binding: ${record.path}`);
    }
  }
  await assertPortableTextFiles(bundlePath);
  const amendmentImpact = await verifyScientificFulfillmentAudit(
    bundlePath,
    manifest.projectId,
    manifest.files,
  );
  const readProof = await readJsonFile<{
    events: Array<Pick<import("./types.js").JournalEvent, "type" | "scope" | "payload">>;
  }>(join(bundlePath, "state/journal-event-proofs.json"), "Artifact read journal proof");
  const artifactReads = await verifyArtifactReadAudit({
    projectId: manifest.projectId,
    files: manifest.files
      .filter((file) => file.path.startsWith("project/"))
      .map((file) => ({ ...file, path: file.path.slice("project/".length) })),
    events: readProof.events,
    readBytes: (path) => readFile(resolveContained(bundlePath, `project/${path}`)),
  });
  let task: Awaited<ReturnType<typeof verifyTaskAudit>>;
  try {
    task = await verifyTaskAudit(
      bundlePath,
      manifest.projectId,
      manifest.researchChain.task,
      manifest.files,
      amendmentImpact,
    );
  } catch (error) {
    throw auditError("Task audit relationship verification failed.", error);
  }
  return {
    status: "verified",
    projectId: manifest.projectId,
    manifestSha256,
    files: manifest.files.length,
    artifactReads,
    ...(task ? { task } : {}),
  };
}

function portableProjectState(project: ProjectState): ProjectState {
  const portable = structuredClone(project);
  portable.inputs = portable.inputs.map((input) => ({
    ...input,
    path: `inputs/${input.sha256}`,
    ...(input.contextPath && input.contextSha256
      ? { contextPath: `inputs/${input.contextSha256}` }
      : {}),
  }));
  return portable;
}

function portableAgentRoute(route: AgentRoute) {
  return {
    agent: route.agent,
    executionMode: route.executionMode,
    binaryName: basename(route.binary),
    model: route.model,
    effort: route.effort ?? null,
    verbosity: route.verbosity ?? null,
  };
}

async function bundleFileRecords(
  root: string,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const files = await regularTreeFiles(root);
  return Promise.all(
    files
      .map((path) => ({ path, logical: relative(root, path).split(sep).join("/") }))
      .filter((item) => item.logical !== "manifest.json")
      .map(async ({ path, logical }) => {
        const info = await lstat(path);
        return { path: logical, sha256: await sha256File(path), bytes: info.size };
      }),
  );
}

async function assertSourceBinding(
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (expectedBytes !== undefined && info.size !== expectedBytes) ||
    (await sha256File(path)) !== expectedSha256
  ) {
    throw auditError("An audit source no longer matches its recorded hash and size.");
  }
}

async function assertPortableTextFiles(root: string, forbiddenRoot?: string): Promise<void> {
  for (const path of await regularTreeFiles(root)) {
    const info = await lstat(path);
    if (info.size > MAX_TEXT_SCAN_BYTES) continue;
    const bytes = await readFile(path);
    if (!looksTextual(path, bytes)) continue;
    const text = bytes.toString("utf8");
    const sensitive = (): never => {
      throw new CliError(
        `Audit bundle contains credential-like or sensitive text in ${relative(root, path).split(sep).join("/")}.`,
        {
          code: "RESEARCH_AUDIT_BUNDLE_SENSITIVE",
          exitCode: 3,
        },
      );
    };
    const inspectText = (value: string): void => {
      if (forbiddenRoot && value.includes(forbiddenRoot)) {
        throw new CliError("Audit bundle contains a host-specific workspace path.", {
          code: "RESEARCH_AUDIT_BUNDLE_NONPORTABLE",
          exitCode: 3,
          details: { path: relative(root, path).split(sep).join("/") },
        });
      }
      if (sanitizeResearchText(value) !== value) sensitive();
    };
    inspectText(text);

    // Decode only for inspection. Evidence and ledger bytes must remain unchanged.
    const pending: unknown[] = [];
    const enqueueJson = (value: string): boolean => {
      if (!/^\s*[[{"]/u.test(value)) return false;
      try {
        pending.push(JSON.parse(value) as unknown);
        return true;
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw auditError("Audit JSON could not be inspected safely.");
      }
    };
    if (!enqueueJson(text)) {
      for (const line of text.split(/\r?\n/u)) enqueueJson(line);
    }
    const sensitiveStringKeys = new Map<string, boolean>();
    const sensitiveContainerKeys = new Map<string, boolean>();
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === "string") {
        inspectText(value);
        enqueueJson(value);
      } else if (Array.isArray(value)) {
        for (const item of value) pending.push(item);
      } else if (isObject(value)) {
        for (const [key, item] of Object.entries(value)) {
          inspectText(key);
          const stringValue = typeof item === "string" && item !== "[REDACTED]";
          const containerValue =
            (Array.isArray(item) && item.length > 0) ||
            (isObject(item) && Object.keys(item).length > 0);
          if (stringValue || containerValue) {
            const keyCache = containerValue ? sensitiveContainerKeys : sensitiveStringKeys;
            let keyIsSensitive = keyCache.get(key);
            if (keyIsSensitive === undefined) {
              if (containerValue) {
                keyIsSensitive =
                  isSensitiveEnvironmentName(key) || SENSITIVE_CONTAINER_KEY.test(key);
              } else {
                const probe = JSON.stringify({ [key]: "audit-field-probe" });
                keyIsSensitive = sanitizeResearchText(probe) !== probe;
              }
              keyCache.set(key, keyIsSensitive);
            }
            if (keyIsSensitive) sensitive();
          }
          pending.push(item);
        }
      }
    }
  }
}

function looksTextual(path: string, bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  if (/\.(?:csv|json|jsonl|md|txt|tsv|ya?ml)$/iu.test(path)) return true;
  const start = bytes.subarray(0, 64).toString("utf8").trimStart();
  return start.startsWith("{") || start.startsWith("[") || isUtf8(bytes);
}

async function validateNewDestination(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw auditPathError("Audit export destination must be absolute and normalized.");
  }
  if (await pathExists(value)) {
    throw auditPathError("Audit export destination must not already exist.");
  }
  const parent = dirname(value);
  const parentInfo = await lstat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw auditPathError("Audit export parent must be an existing regular directory.");
  }
  return value;
}

function parseManifest(value: unknown): ProjectAuditManifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-project-audit-bundle" ||
    typeof value.projectId !== "string" ||
    typeof value.createdAt !== "string" ||
    !isObject(value.authority) ||
    !isObject(value.sourceBindings) ||
    !validResearchChain(value.researchChain) ||
    !isObject(value.locatorRoots) ||
    value.locatorRoots.project !== "project" ||
    value.locatorRoots.workspaceObjects !== "workspace-objects" ||
    value.locatorRoots.inputs !== "inputs" ||
    !Array.isArray(value.exclusions) ||
    value.exclusions.some((item) => typeof item !== "string") ||
    !Array.isArray(value.files) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256)
  ) {
    throw auditError("Audit manifest shape is invalid.");
  }
  const files = value.files as unknown[];
  if (
    files.some(
      (file) =>
        !isObject(file) ||
        typeof file.path !== "string" ||
        safePathOrNull(file.path) === null ||
        typeof file.sha256 !== "string" ||
        !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        Number(file.bytes) < 0,
    )
  ) {
    throw auditError("Audit manifest file records are invalid.");
  }
  const paths = files.map((file) => String((file as Record<string, unknown>).path));
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path)
  ) {
    throw auditError("Audit manifest file paths must be unique and byte-order sorted.");
  }
  return value as unknown as ProjectAuditManifest;
}

function validResearchChain(value: unknown): boolean {
  if (!isObject(value)) return false;
  const task = value.task;
  if (
    task !== undefined &&
    (!isObject(task) ||
      !["contractSha256", "originalContractSha256", "contextSha256"].every(
        (key) => typeof task[key] === "string" && SHA256.test(task[key] as string),
      ))
  )
    return false;
  for (const key of [
    "acquisitionSnapshot",
    "contentSnapshot",
    "inferenceSnapshot",
    "analysisRun",
    "claimEvidenceGraph",
  ]) {
    const binding = value[key];
    if (
      binding !== null &&
      (!isObject(binding) ||
        typeof binding.id !== "string" ||
        typeof binding.sha256 !== "string" ||
        !SHA256.test(binding.sha256))
    ) {
      return false;
    }
  }
  const publication = value.publication;
  return (
    publication === null ||
    (isObject(publication) &&
      typeof publication.generationSha256 === "string" &&
      SHA256.test(publication.generationSha256) &&
      typeof publication.manuscriptSha256 === "string" &&
      SHA256.test(publication.manuscriptSha256) &&
      typeof publication.submissionPackageSha256 === "string" &&
      SHA256.test(publication.submissionPackageSha256) &&
      (publication.closureSha256 === null ||
        (typeof publication.closureSha256 === "string" && SHA256.test(publication.closureSha256))))
  );
}

function safePathOrNull(value: string): string | null {
  try {
    return safeRelativePath(value, "Audit manifest path");
  } catch {
    return null;
  }
}

function containsExactString(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, target));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => containsExactString(item, target));
}

function auditError(message: string, cause?: unknown): CliError {
  return new CliError(message, {
    code: "RESEARCH_AUDIT_BUNDLE_INVALID",
    exitCode: 3,
    details: cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : undefined,
  });
}

function auditPathError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_AUDIT_BUNDLE_PATH_INVALID",
    exitCode: 2,
  });
}

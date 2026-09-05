import { constants as fsConstants } from "node:fs";
import { cp, lstat, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DataMissingRange } from "../../data/contracts.js";
import { CliError } from "../../errors.js";
import {
  ensureDirectory,
  pathExists,
  resolveContained,
  sha256Bytes,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";

export interface BrokerEvidenceReceipt {
  schemaVersion: 1;
  /** Absent on legacy broker receipts; an explicit value identifies data-runtime evidence. */
  evidenceKind?: "data";
  attemptId: string;
  projectId: string;
  capabilityId: string;
  credentialId: string | null;
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
  sourceSha256: string;
  locator: string;
  contextLocator: string;
  contextSha256: string;
  contextBytes: number;
  contextEstimatedTokens: number;
  contextItems: number | null;
  contextOffset?: number;
  contextTotalItems?: number | null;
  contextNextOffset?: number | null;
  contextTruncated: boolean;
  redactions: number;
  retrievedAt: string;
  servedAt: string;
  cacheHit: boolean;
  data?: DataEvidenceBinding;
}

export interface DataEvidenceArtifactBinding {
  relativePath: string;
  sha256: string;
  bytes: number;
  locator: string;
}

export interface DataEvidenceBinding {
  coreReceiptDigest: string;
  capabilityId: string;
  capabilityVersion: string;
  operationId: string;
  operationVersion: string;
  requestDigest: string;
  manifestDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  resultStatus: "success" | "partial";
  coverage?: {
    status: "bounded" | "complete" | "partial";
    truncated: boolean;
    stopReason: string | null;
    recordCount: number;
    missing: DataMissingRange[];
  };
  providerCoverage?: {
    status: "complete" | "partial";
    missing: DataMissingRange[];
  };
  limitCoverage?: {
    status: "bounded" | "within-requested-limits";
    limitsHit: string[];
  };
  contextView?: {
    status: "full" | "metadata-only" | "projected";
    strategy: string;
    collection?: string | null;
    itemCount: number;
    totalItems: number;
    offset?: number;
    remainingItems?: number;
    nextCursor?: string | null;
    maxItems: number;
    maxBytes: number;
  };
  artifacts: DataEvidenceArtifactBinding[];
}

export interface DataEvidenceArtifactInput {
  relativePath: string;
  sha256: string;
  byteSize: number;
  bytes: Uint8Array;
}

export async function persistBrokerEvidence(
  root: string,
  receipt: Omit<
    BrokerEvidenceReceipt,
    | "schemaVersion"
    | "bytes"
    | "sha256"
    | "locator"
    | "contextLocator"
    | "contextSha256"
    | "contextBytes"
    | "contextEstimatedTokens"
    | "servedAt"
  >,
  bytes: Uint8Array,
  contextBytes: Uint8Array = bytes,
): Promise<BrokerEvidenceReceipt> {
  const digest = sha256Bytes(bytes);
  const locator = `evidence/objects/${digest.slice(0, 2)}/${digest}`;
  const contextDigest = sha256Bytes(contextBytes);
  const contextLocator = `evidence/objects/${contextDigest.slice(0, 2)}/${contextDigest}`;
  const paths = workspacePaths(root);
  const objectPath = resolveContained(paths.control, locator);
  await ensureDirectory(dirname(objectPath));
  await writeImmutableObject(objectPath, bytes, digest);
  if (contextDigest !== digest) {
    const contextPath = resolveContained(paths.control, contextLocator);
    await ensureDirectory(dirname(contextPath));
    await writeImmutableObject(contextPath, contextBytes, contextDigest);
  }
  const value: BrokerEvidenceReceipt = {
    schemaVersion: 1,
    ...receipt,
    bytes: bytes.byteLength,
    sha256: digest,
    locator,
    contextLocator,
    contextSha256: contextDigest,
    contextBytes: contextBytes.byteLength,
    contextEstimatedTokens: estimateBrokerContextTokens(contextBytes.byteLength),
    servedAt: new Date().toISOString(),
  };
  const receiptPath = join(
    paths.projects,
    receipt.projectId,
    "evidence",
    "receipts",
    `${receipt.attemptId}.json`,
  );
  if (await pathExists(receiptPath)) {
    const existing = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new CliError("Broker evidence receipt already exists with different content.", {
        code: "RESEARCH_EVIDENCE_STORE_INVALID",
        exitCode: 3,
      });
    }
  } else {
    await writeJsonAtomic(receiptPath, value, 0o444);
  }
  return value;
}

export async function persistDataEvidence(
  root: string,
  receipt: Omit<
    BrokerEvidenceReceipt,
    | "schemaVersion"
    | "evidenceKind"
    | "bytes"
    | "sha256"
    | "locator"
    | "contextLocator"
    | "contextSha256"
    | "contextBytes"
    | "contextEstimatedTokens"
    | "servedAt"
    | "data"
  > & { data: Omit<DataEvidenceBinding, "artifacts"> },
  bytes: Uint8Array,
  contextBytes: Uint8Array,
  artifacts: DataEvidenceArtifactInput[] = [],
): Promise<BrokerEvidenceReceipt> {
  const artifactBindings: DataEvidenceArtifactBinding[] = [];
  for (const artifact of [...artifacts].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const digest = sha256Bytes(artifact.bytes);
    if (
      digest !== artifact.sha256 ||
      artifact.bytes.byteLength !== artifact.byteSize ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(artifact.relativePath)
    ) {
      throw evidenceStoreError("Data evidence artifact binding is invalid.");
    }
    const locator = `evidence/objects/${digest.slice(0, 2)}/${digest}`;
    const objectPath = resolveContained(workspacePaths(root).control, locator);
    await ensureDirectory(dirname(objectPath));
    await writeImmutableObject(objectPath, artifact.bytes, digest);
    artifactBindings.push({
      relativePath: artifact.relativePath,
      sha256: digest,
      bytes: artifact.bytes.byteLength,
      locator,
    });
  }
  return persistBrokerEvidence(
    root,
    {
      ...receipt,
      evidenceKind: "data",
      data: { ...receipt.data, artifacts: artifactBindings },
    },
    bytes,
    contextBytes,
  );
}

export async function loadProjectEvidenceReceipts(
  root: string,
  projectId: string,
): Promise<BrokerEvidenceReceipt[]> {
  const directory = join(workspacePaths(root).projects, projectId, "evidence", "receipts");
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const receipts: BrokerEvidenceReceipt[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as unknown;
    const receipt = parseReceipt(value);
    if (receipt.projectId !== projectId || `${receipt.attemptId}.json` !== entry.name) {
      throw evidenceStoreError("Broker evidence receipt identity does not match its path.");
    }
    await verifyEvidenceReceipt(root, receipt);
    receipts.push(receipt);
  }
  return receipts;
}

export async function verifyEvidenceReceipt(
  root: string,
  receipt: BrokerEvidenceReceipt,
): Promise<string> {
  const objectPath = resolveContained(workspacePaths(root).control, receipt.locator);
  const info = await lstat(objectPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== receipt.bytes) {
    throw evidenceStoreError(`Broker evidence object is missing or invalid: ${receipt.attemptId}`);
  }
  if ((await sha256File(objectPath)) !== receipt.sha256) {
    throw evidenceStoreError(`Broker evidence object hash mismatch: ${receipt.attemptId}`);
  }
  const expectedLocator = `evidence/objects/${receipt.sha256.slice(0, 2)}/${receipt.sha256}`;
  if (receipt.locator !== expectedLocator) {
    throw evidenceStoreError(
      `Broker evidence locator is not content-addressed: ${receipt.attemptId}`,
    );
  }
  const contextPath = resolveContained(workspacePaths(root).control, receipt.contextLocator);
  const contextInfo = await lstat(contextPath).catch(() => undefined);
  if (
    !contextInfo?.isFile() ||
    contextInfo.isSymbolicLink() ||
    contextInfo.size !== receipt.contextBytes ||
    receipt.contextEstimatedTokens !== estimateBrokerContextTokens(receipt.contextBytes) ||
    (await sha256File(contextPath)) !== receipt.contextSha256 ||
    receipt.contextLocator !==
      `evidence/objects/${receipt.contextSha256.slice(0, 2)}/${receipt.contextSha256}`
  ) {
    throw evidenceStoreError(`Broker evidence context object is invalid: ${receipt.attemptId}`);
  }
  for (const artifact of receipt.data?.artifacts ?? []) {
    const artifactPath = resolveContained(workspacePaths(root).control, artifact.locator);
    const artifactInfo = await lstat(artifactPath).catch(() => undefined);
    if (
      artifact.locator !== `evidence/objects/${artifact.sha256.slice(0, 2)}/${artifact.sha256}` ||
      !artifactInfo?.isFile() ||
      artifactInfo.isSymbolicLink() ||
      artifactInfo.size !== artifact.bytes ||
      (await sha256File(artifactPath)) !== artifact.sha256
    ) {
      throw evidenceStoreError(`Data evidence artifact is invalid: ${receipt.attemptId}`);
    }
  }
  return objectPath;
}

export async function stageProjectEvidence(
  root: string,
  projectId: string,
  capsuleProject: string,
): Promise<BrokerEvidenceReceipt[]> {
  const receipts = await loadProjectEvidenceReceipts(root, projectId);
  const copied = new Set<string>();
  for (const receipt of receipts) {
    await verifyEvidenceReceipt(root, receipt);
    for (const [digest, locator] of [
      [receipt.sha256, receipt.locator],
      [receipt.contextSha256, receipt.contextLocator],
      ...(receipt.data?.artifacts.map((artifact) => [artifact.sha256, artifact.locator] as const) ??
        []),
    ] as const) {
      if (copied.has(digest)) continue;
      const source = resolveContained(workspacePaths(root).control, locator);
      const destination = resolveContained(capsuleProject, locator);
      await ensureDirectory(dirname(destination));
      await cp(source, destination, { errorOnExist: true, force: false });
      copied.add(digest);
    }
  }
  return receipts;
}

export async function cloneProjectEvidenceReceipts(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<BrokerEvidenceReceipt[]> {
  const receipts = await loadProjectEvidenceReceipts(root, sourceProjectId);
  const destination = join(workspacePaths(root).projects, targetProjectId, "evidence", "receipts");
  await ensureDirectory(destination);
  const cloned: BrokerEvidenceReceipt[] = [];
  for (const receipt of receipts) {
    const value = { ...receipt, projectId: targetProjectId };
    await writeJsonAtomic(join(destination, `${receipt.attemptId}.json`), value, 0o444);
    cloned.push(value);
  }
  return cloned;
}

export async function loadBrokerEvidenceCache(
  root: string,
  cacheKeySha256: string,
): Promise<BrokerEvidenceReceipt | null> {
  const path = brokerCachePath(root, cacheKeySha256);
  if (!(await pathExists(path))) return null;
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw evidenceStoreError("Broker evidence cache entry is not a regular file.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { cacheKeySha256?: unknown }).cacheKeySha256 !== cacheKeySha256
  ) {
    throw evidenceStoreError("Broker evidence cache entry has an unsupported shape.");
  }
  const receipt = parseReceipt((value as { receipt?: unknown }).receipt);
  await verifyEvidenceReceipt(root, receipt);
  return receipt;
}

export async function storeBrokerEvidenceCache(
  root: string,
  cacheKeySha256: string,
  receipt: BrokerEvidenceReceipt,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(cacheKeySha256)) {
    throw evidenceStoreError("Broker evidence cache key is invalid.");
  }
  await verifyEvidenceReceipt(root, receipt);
  const path = brokerCachePath(root, cacheKeySha256);
  if (await pathExists(path)) return;
  await writeJsonAtomic(path, { schemaVersion: 1, cacheKeySha256, receipt }, 0o444);
}

function parseReceipt(value: unknown): BrokerEvidenceReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as BrokerEvidenceReceipt).schemaVersion !== 1 ||
    typeof (value as BrokerEvidenceReceipt).attemptId !== "string" ||
    typeof (value as BrokerEvidenceReceipt).projectId !== "string" ||
    typeof (value as BrokerEvidenceReceipt).capabilityId !== "string" ||
    !["string", "object"].includes(typeof (value as BrokerEvidenceReceipt).credentialId) ||
    typeof (value as BrokerEvidenceReceipt).status !== "number" ||
    typeof (value as BrokerEvidenceReceipt).contentType !== "string" ||
    !Number.isInteger((value as BrokerEvidenceReceipt).bytes) ||
    typeof (value as BrokerEvidenceReceipt).sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as BrokerEvidenceReceipt).sha256) ||
    typeof (value as BrokerEvidenceReceipt).sourceSha256 !== "string" ||
    typeof (value as BrokerEvidenceReceipt).locator !== "string" ||
    typeof (value as BrokerEvidenceReceipt).contextLocator !== "string" ||
    typeof (value as BrokerEvidenceReceipt).contextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as BrokerEvidenceReceipt).contextSha256) ||
    !Number.isInteger((value as BrokerEvidenceReceipt).contextBytes) ||
    !Number.isInteger((value as BrokerEvidenceReceipt).contextEstimatedTokens) ||
    (value as BrokerEvidenceReceipt).contextEstimatedTokens < 0 ||
    ((value as BrokerEvidenceReceipt).contextItems !== null &&
      !Number.isInteger((value as BrokerEvidenceReceipt).contextItems)) ||
    ((value as BrokerEvidenceReceipt).contextOffset !== undefined &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextOffset) ||
        (value as BrokerEvidenceReceipt).contextOffset! < 0)) ||
    ((value as BrokerEvidenceReceipt).contextTotalItems !== undefined &&
      (value as BrokerEvidenceReceipt).contextTotalItems !== null &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextTotalItems) ||
        (value as BrokerEvidenceReceipt).contextTotalItems! < 0)) ||
    ((value as BrokerEvidenceReceipt).contextNextOffset !== undefined &&
      (value as BrokerEvidenceReceipt).contextNextOffset !== null &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextNextOffset) ||
        (value as BrokerEvidenceReceipt).contextNextOffset! < 0)) ||
    typeof (value as BrokerEvidenceReceipt).contextTruncated !== "boolean" ||
    !Number.isInteger((value as BrokerEvidenceReceipt).redactions) ||
    (value as BrokerEvidenceReceipt).redactions < 0 ||
    typeof (value as BrokerEvidenceReceipt).retrievedAt !== "string" ||
    typeof (value as BrokerEvidenceReceipt).servedAt !== "string" ||
    typeof (value as BrokerEvidenceReceipt).cacheHit !== "boolean"
  ) {
    throw evidenceStoreError("Broker evidence receipt has an unsupported shape.");
  }
  const receipt = value as BrokerEvidenceReceipt;
  if (receipt.credentialId !== null && typeof receipt.credentialId !== "string") {
    throw evidenceStoreError("Broker evidence credential identity is invalid.");
  }
  if (receipt.evidenceKind !== undefined && receipt.evidenceKind !== "data") {
    throw evidenceStoreError("Research evidence kind is invalid.");
  }
  if (receipt.evidenceKind === "data") parseDataEvidenceBinding(receipt.data);
  else if (receipt.data !== undefined) {
    throw evidenceStoreError("Broker evidence receipt cannot contain a data binding.");
  }
  return receipt;
}

function parseDataEvidenceBinding(value: unknown): DataEvidenceBinding {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !/^[0-9a-f]{64}$/.test(String((value as DataEvidenceBinding).coreReceiptDigest)) ||
    typeof (value as DataEvidenceBinding).capabilityId !== "string" ||
    typeof (value as DataEvidenceBinding).capabilityVersion !== "string" ||
    typeof (value as DataEvidenceBinding).operationId !== "string" ||
    typeof (value as DataEvidenceBinding).operationVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(String((value as DataEvidenceBinding).requestDigest)) ||
    !/^[0-9a-f]{64}$/.test(String((value as DataEvidenceBinding).manifestDigest)) ||
    !/^[0-9a-f]{64}$/.test(String((value as DataEvidenceBinding).inputSchemaDigest)) ||
    !/^[0-9a-f]{64}$/.test(String((value as DataEvidenceBinding).outputSchemaDigest)) ||
    !["success", "partial"].includes(String((value as DataEvidenceBinding).resultStatus)) ||
    !Array.isArray((value as DataEvidenceBinding).artifacts)
  ) {
    throw evidenceStoreError("Data evidence receipt has an unsupported shape.");
  }
  for (const artifact of (value as DataEvidenceBinding).artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      typeof artifact.relativePath !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(artifact.sha256)) ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      typeof artifact.locator !== "string"
    ) {
      throw evidenceStoreError("Data evidence artifact receipt has an unsupported shape.");
    }
  }
  const binding = value as DataEvidenceBinding;
  if (binding.coverage !== undefined) {
    if (
      !binding.coverage ||
      !["bounded", "complete", "partial"].includes(binding.coverage.status) ||
      typeof binding.coverage.truncated !== "boolean" ||
      (binding.coverage.stopReason !== null && typeof binding.coverage.stopReason !== "string") ||
      !Number.isInteger(binding.coverage.recordCount) ||
      binding.coverage.recordCount < 0 ||
      !Array.isArray(binding.coverage.missing)
    ) {
      throw evidenceStoreError("Data evidence coverage binding is invalid.");
    }
  }
  if (
    binding.providerCoverage !== undefined &&
    (!binding.providerCoverage ||
      !["complete", "partial"].includes(binding.providerCoverage.status) ||
      !Array.isArray(binding.providerCoverage.missing))
  ) {
    throw evidenceStoreError("Data evidence provider-coverage binding is invalid.");
  }
  if (
    binding.limitCoverage !== undefined &&
    (!binding.limitCoverage ||
      !["bounded", "within-requested-limits"].includes(binding.limitCoverage.status) ||
      !Array.isArray(binding.limitCoverage.limitsHit) ||
      binding.limitCoverage.limitsHit.some((item) => typeof item !== "string"))
  ) {
    throw evidenceStoreError("Data evidence limit-coverage binding is invalid.");
  }
  if (binding.contextView !== undefined) {
    if (
      !binding.contextView ||
      !["full", "metadata-only", "projected"].includes(binding.contextView.status) ||
      typeof binding.contextView.strategy !== "string" ||
      !Number.isInteger(binding.contextView.itemCount) ||
      binding.contextView.itemCount < 0 ||
      !Number.isInteger(binding.contextView.totalItems) ||
      binding.contextView.totalItems < 0 ||
      (binding.contextView.offset !== undefined &&
        (!Number.isInteger(binding.contextView.offset) || binding.contextView.offset < 0)) ||
      (binding.contextView.remainingItems !== undefined &&
        (!Number.isInteger(binding.contextView.remainingItems) ||
          binding.contextView.remainingItems < 0)) ||
      (binding.contextView.nextCursor !== undefined &&
        binding.contextView.nextCursor !== null &&
        typeof binding.contextView.nextCursor !== "string") ||
      !Number.isInteger(binding.contextView.maxItems) ||
      binding.contextView.maxItems < 1 ||
      !Number.isInteger(binding.contextView.maxBytes) ||
      binding.contextView.maxBytes < 1
    ) {
      throw evidenceStoreError("Data evidence context-view binding is invalid.");
    }
  }
  return value as DataEvidenceBinding;
}

function brokerCachePath(root: string, cacheKeySha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(cacheKeySha256)) {
    throw evidenceStoreError("Broker evidence cache key is invalid.");
  }
  return join(
    workspacePaths(root).evidenceCache,
    cacheKeySha256.slice(0, 2),
    `${cacheKeySha256}.json`,
  );
}

async function writeImmutableObject(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o444,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (await sha256File(path)) !== expectedSha256) {
      throw evidenceStoreError("Content-addressed evidence object failed its integrity check.");
    }
  }
}

function evidenceStoreError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_EVIDENCE_STORE_INVALID",
    exitCode: 3,
  });
}

function estimateBrokerContextTokens(bytes: number): number {
  return Math.ceil(bytes / 3);
}

import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot, loadVerifiedEvidencePreparationView } from "./acquisition.js";
import { loadEvidenceArtifactRecords, type EvidenceArtifactRecord } from "./artifacts.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import {
  EVIDENCE_CONTENT_CLASSES,
  EVIDENCE_CONTENT_FUNCTIONS,
  EVIDENCE_CONTENT_IDENTIFIER,
  EVIDENCE_CONTENT_LIMITS,
  isEvidenceContentInputShape,
} from "./evidence-content-schema.js";
import { appendEvidenceLedgerEvent, evidenceLedgerPath } from "./evidence-ledger.js";
import { computeRoleCoverage } from "./evidence-role-coverage.js";
import { readJournal, readVerifiedJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";

const IDENTIFIER = new RegExp(EVIDENCE_CONTENT_IDENTIFIER);
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_CLASSES = new Set<string>(EVIDENCE_CONTENT_CLASSES);
const EVIDENCE_FUNCTIONS = new Set<string>(EVIDENCE_CONTENT_FUNCTIONS);
const PRODUCER_VISIBLE_MEDIA_TYPES = new Set([
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
]);
const MAX_EXCERPT_BYTES = EVIDENCE_CONTENT_LIMITS.maxExcerptBytes;
const MAX_BATCH_RECORDS = EVIDENCE_CONTENT_LIMITS.maxBatchRecords;
const MAX_BATCH_INPUT_BYTES = EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes;

interface ContentPreparationView {
  acquisition: Awaited<ReturnType<typeof loadCurrentEvidenceSnapshot>>;
  acquisitionAncestors: Set<string>;
  artifacts: Map<string, EvidenceArtifactRecord>;
  roleIds: Set<string> | null;
  texts: Map<string, { text: string; lines?: string[]; json?: unknown }>;
  work: {
    acquisitionVerifications: number;
    artifactStoreScans: number;
    excerptFileReads: number;
    ledgerAppends: number;
  };
}

export interface ArtifactDecompositionRecord {
  schemaVersion: 1;
  decompositionId: string;
  decompositionSha256: string;
  projectId: string;
  candidateId: string;
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  acquisitionSnapshotSha256?: string;
  supersedesSha256?: string | null;
  status: "complete" | "limited" | "failed";
  parser: { id: string; version: string };
  outputArtifactIds: string[];
  outputArtifactSha256s: string[];
  contentClasses: string[];
  limitations: string[];
  recordedAt: string;
}

export interface EvidenceAtomRecord {
  schemaVersion: 1;
  atomId: string;
  atomSha256: string;
  projectId: string;
  sourceId: string;
  candidateId: string;
  artifactId: string;
  artifactSha256: string;
  locator:
    | { kind: "line-range"; startLine: number; endLine: number }
    | { kind: "json-pointer"; pointer: string };
  excerpt: string;
  excerptSha256: string;
  statement: string;
  evidenceRoleIds: string[];
  coverageDimensionIds: string[];
  evidenceFunction: string;
  scope: string;
  limitations: string[];
  registeredAt: string;
}

export interface EvidenceContentSnapshot {
  schemaVersion: 1;
  kind: "tiangong-evidence-content-snapshot";
  snapshotId: string;
  snapshotSha256: string;
  projectId: string;
  acquisitionSnapshotId: string;
  acquisitionSnapshotSha256: string;
  createdAt: string;
  ledgerHead: string;
  decompositions: ArtifactDecompositionRecord[];
  atoms: EvidenceAtomRecord[];
  sourceCoverage: Array<{
    sourceId: string;
    atomIds: string[];
    evidenceRoleIds: string[];
    coverageDimensionIds: string[];
    evidenceFunctions: string[];
  }>;
  roleCoverage: Array<{
    roleId: string;
    sourceIds: string[];
    fullTextSourceIds: string[];
    datedSourceIds: string[];
    coverageDimensionIds: string[];
    sourceTypes: string[];
    decision: "pass" | "insufficient";
    gaps: string[];
  }>;
  gate: {
    decision: "pass" | "stop";
    reasons: string[];
    requiredDecompositionArtifactIds: string[];
    missingDecompositionArtifactIds: string[];
    acceptedFullTextSourceIds: string[];
    sourcesWithoutAtoms: string[];
  };
}

export async function recordArtifactDecomposition(input: {
  root: string;
  projectId: string;
  value: Record<string, unknown>;
}): Promise<ArtifactDecompositionRecord> {
  const view = await loadContentPreparationView(input.root, input.projectId);
  let record = prepareDecompositionRecord(input, view);
  const existing = (await loadDecompositionRecords(input.root, input.projectId)).find(
    (item) => item.sourceArtifactId === record.sourceArtifactId,
  );
  record = selectDecompositionRevision(record, existing, view);
  if (record === existing) return existing;
  const destination = decompositionRecordPath(
    input.root,
    input.projectId,
    existing ? record.decompositionSha256 : record.sourceArtifactId,
  );
  if (await pathExists(destination)) {
    const staged = await readDecompositionFile(destination);
    assertSameContentRecord(
      staged.decompositionSha256,
      record.decompositionSha256,
      "decomposition",
    );
    record = staged;
  } else await writeJsonAtomic(destination, record, 0o444);
  await chmod(destination, 0o444).catch(() => undefined);
  await appendEvidenceLedgerEvent(input.root, input.projectId, "decomposition.recorded", {
    decompositionId: record.decompositionId,
    decompositionSha256: record.decompositionSha256,
    sourceArtifactId: record.sourceArtifactId,
    sourceArtifactSha256: record.sourceArtifactSha256,
    candidateId: record.candidateId,
    status: record.status,
    outputArtifactIds: record.outputArtifactIds,
    outputArtifactSha256s: record.outputArtifactSha256s,
    contentClasses: record.contentClasses,
    acquisitionSnapshotSha256: record.acquisitionSnapshotSha256,
    supersedesSha256: record.supersedesSha256,
  });
  return record;
}

function prepareDecompositionRecord(
  input: { projectId: string; value: Record<string, unknown> },
  view: ContentPreparationView,
): ArtifactDecompositionRecord {
  const value = parseDecompositionInput(input.value);
  const { acquisition, artifacts } = view;
  const source = artifacts.get(value.sourceArtifactId);
  if (
    !source ||
    !acquisition.artifacts.some((artifact) => artifact.artifactId === source.artifactId)
  ) {
    throw contentError(
      "Decomposition source must be an artifact in the current acquisition snapshot.",
      "RESEARCH_DECOMPOSITION_ARTIFACT_INVALID",
    );
  }
  const outputs = value.outputArtifactIds.map((artifactId) => {
    const output = artifacts.get(artifactId);
    if (
      !output ||
      output.candidateId !== source.candidateId ||
      !artifactDescendsFrom(output, source.artifactId, artifacts)
    ) {
      throw contentError(
        "Every decomposition output must be an exact derived descendant of its source artifact.",
        "RESEARCH_DECOMPOSITION_LINEAGE_INVALID",
      );
    }
    return output;
  });
  if (value.status === "complete" && outputs.length === 0) {
    throw contentError(
      "A complete decomposition requires at least one derived output artifact.",
      "RESEARCH_DECOMPOSITION_OUTPUT_REQUIRED",
    );
  }
  const stable = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    candidateId: source.candidateId,
    sourceArtifactId: source.artifactId,
    sourceArtifactSha256: source.sha256,
    acquisitionSnapshotSha256: acquisition.snapshotSha256,
    supersedesSha256: null,
    status: value.status,
    parser: value.parser,
    outputArtifactIds: outputs.map((artifact) => artifact.artifactId),
    outputArtifactSha256s: outputs.map((artifact) => artifact.sha256),
    contentClasses: value.contentClasses,
    limitations: value.limitations,
  };
  const decompositionSha256 = sha256Text(canonicalJson(stable));
  const record: ArtifactDecompositionRecord = {
    ...stable,
    decompositionId: `decomposition-${decompositionSha256.slice(0, 24)}`,
    decompositionSha256,
    recordedAt: new Date().toISOString(),
  };
  return record;
}

function selectDecompositionRevision(
  prepared: ArtifactDecompositionRecord,
  previous: ArtifactDecompositionRecord | undefined,
  view: ContentPreparationView,
): ArtifactDecompositionRecord {
  if (!previous) return prepared;
  const semantic = (record: ArtifactDecompositionRecord) => {
    const value: Record<string, unknown> = { ...record };
    for (const key of [
      "decompositionId",
      "decompositionSha256",
      "recordedAt",
      "acquisitionSnapshotSha256",
      "supersedesSha256",
    ])
      delete value[key];
    return canonicalJson(value);
  };
  if (semantic(prepared) === semantic(previous)) return previous;
  if (
    !previous.acquisitionSnapshotSha256 ||
    !view.acquisitionAncestors.has(previous.acquisitionSnapshotSha256)
  ) {
    assertSameContentRecord(
      previous.decompositionSha256,
      prepared.decompositionSha256,
      "decomposition",
    );
  }
  const { decompositionId: _id, decompositionSha256: _sha, recordedAt, ...stable } = prepared;
  const revised = { ...stable, supersedesSha256: previous.decompositionSha256 };
  const decompositionSha256 = sha256Text(canonicalJson(revised));
  return {
    ...revised,
    decompositionId: `decomposition-${decompositionSha256.slice(0, 24)}`,
    decompositionSha256,
    recordedAt,
  };
}

export async function registerEvidenceAtom(input: {
  root: string;
  projectId: string;
  value: Record<string, unknown>;
}): Promise<EvidenceAtomRecord> {
  const view = await loadContentPreparationView(input.root, input.projectId);
  const record = await prepareEvidenceAtom(input, view);
  const existing = (await loadEvidenceAtomRecords(input.root, input.projectId)).find(
    (item) => item.atomId === record.atomId,
  );
  if (existing) {
    assertSameContentRecord(existing.atomSha256, record.atomSha256, "atom");
    return existing;
  }
  const destination = atomRecordPath(input.root, input.projectId, record.atomId);
  await writeJsonAtomic(destination, record, 0o444);
  await chmod(destination, 0o444).catch(() => undefined);
  await appendEvidenceLedgerEvent(input.root, input.projectId, "atom.registered", {
    atomId: record.atomId,
    atomSha256: record.atomSha256,
    sourceId: record.sourceId,
    candidateId: record.candidateId,
    artifactId: record.artifactId,
    artifactSha256: record.artifactSha256,
    excerptSha256: record.excerptSha256,
    evidenceRoleIds: record.evidenceRoleIds,
    coverageDimensionIds: record.coverageDimensionIds,
    evidenceFunction: record.evidenceFunction,
  });
  return record;
}

async function prepareEvidenceAtom(
  input: { root: string; projectId: string; value: Record<string, unknown> },
  view: ContentPreparationView,
): Promise<EvidenceAtomRecord> {
  const value = parseAtomInput(input.value);
  const { acquisition } = view;
  const source = acquisition.sources.find((candidate) => candidate.id === value.sourceId);
  if (
    !source ||
    !Array.isArray(source.artifactIds) ||
    !source.artifactIds.includes(value.artifactId)
  ) {
    throw contentError(
      "Evidence atom source and artifact must belong to the same frozen acquisition source.",
      "RESEARCH_EVIDENCE_ATOM_SOURCE_INVALID",
    );
  }
  const artifact = view.artifacts.get(value.artifactId);
  if (
    !artifact ||
    artifact.candidateId !== value.candidateId ||
    !PRODUCER_VISIBLE_MEDIA_TYPES.has(artifact.mediaType)
  ) {
    throw contentError(
      "Evidence atoms may reference only producer-readable artifacts bound to the declared candidate.",
      "RESEARCH_EVIDENCE_ATOM_ARTIFACT_INVALID",
    );
  }
  validateAtomTaxonomy(source, value, view.roleIds);
  const artifactPath = resolveContained(workspacePaths(input.root).control, artifact.locator);
  let document = view.texts.get(artifact.artifactId);
  if (document === undefined) {
    const text = await readFile(artifactPath, "utf8");
    if (sha256Text(text) !== artifact.sha256) {
      throw contentError(
        "Evidence atom artifact changed during preparation.",
        "RESEARCH_ARTIFACT_DRIFT",
      );
    }
    view.work.excerptFileReads += 1;
    document = { text };
    view.texts.set(artifact.artifactId, document);
  }
  const excerpt = extractAtomExcerptFromDocument(document, artifact.mediaType, value.locator);
  assertSafeContent(excerpt, "Evidence atom excerpt contains sensitive material.");
  const stable = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    atomId: value.atomId,
    sourceId: value.sourceId,
    candidateId: value.candidateId,
    artifactId: artifact.artifactId,
    artifactSha256: artifact.sha256,
    locator: value.locator,
    excerpt,
    excerptSha256: sha256Text(excerpt),
    statement: value.statement,
    evidenceRoleIds: value.evidenceRoleIds,
    coverageDimensionIds: value.coverageDimensionIds,
    evidenceFunction: value.evidenceFunction,
    scope: value.scope,
    limitations: value.limitations,
  };
  const atomSha256 = sha256Text(canonicalJson(stable));
  const record: EvidenceAtomRecord = {
    ...stable,
    atomSha256,
    registeredAt: new Date().toISOString(),
  };
  return record;
}

type ContentRecord = ArtifactDecompositionRecord | EvidenceAtomRecord;
type ContentBatchKind = "decomposition" | "atom";

interface ContentBatch {
  schemaVersion: 1;
  projectId: string;
  kind: ContentBatchKind;
  batchSha256: string;
  records: ContentRecord[];
}

/** Caller holds one workspace mutation lock for the whole operation. */
export async function registerEvidenceContentBatch(input: {
  root: string;
  projectId: string;
  kind: ContentBatchKind;
  value: Record<string, unknown>;
}): Promise<ContentBatch & { work: ContentPreparationView["work"] }> {
  const values = input.value.records;
  if (
    input.value.schemaVersion !== 1 ||
    Object.keys(input.value).some((key) => !["schemaVersion", "records"].includes(key)) ||
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_BATCH_RECORDS ||
    values.some((value) => !isObject(value)) ||
    Buffer.byteLength(canonicalJson(input.value)) > MAX_BATCH_INPUT_BYTES ||
    !isEvidenceContentInputShape(
      input.kind === "atom" ? "evidence-atom-batch" : "artifact-decomposition-batch",
      input.value,
    )
  ) {
    throw contentError(
      `Evidence batch requires 1-${MAX_BATCH_RECORDS} records within ${MAX_BATCH_INPUT_BYTES} bytes.`,
      "RESEARCH_EVIDENCE_BATCH_INVALID",
    );
  }
  const view = await loadContentPreparationView(input.root, input.projectId);
  const existingRecords =
    input.kind === "atom"
      ? await loadEvidenceAtomRecords(input.root, input.projectId)
      : await loadDecompositionRecords(input.root, input.projectId);
  const existing = new Map(existingRecords.map((record) => [contentRecordId(record), record]));
  const seen = new Set<string>();
  const records: ContentRecord[] = [];
  let added = 0;
  // Group extraction by artifact, then restore caller order. At most one parsed
  // document stays live, and each referenced artifact is read/parsed once.
  const ordered = values.map((value, index) => ({
    value: value as Record<string, unknown>,
    index,
  }));
  if (input.kind === "atom")
    ordered.sort((left, right) =>
      String(left.value.artifactId).localeCompare(String(right.value.artifactId)),
    );
  let currentArtifact: unknown;
  for (const { value, index } of ordered) {
    if (value.artifactId !== currentArtifact) {
      view.texts.clear();
      currentArtifact = value.artifactId;
    }
    let prepared =
      input.kind === "atom"
        ? await prepareEvidenceAtom({ ...input, value: value as Record<string, unknown> }, view)
        : prepareDecompositionRecord({ ...input, value: value as Record<string, unknown> }, view);
    const id = contentRecordId(prepared);
    if (seen.has(id)) {
      throw contentError(
        "Evidence batch contains duplicate record identities.",
        "RESEARCH_EVIDENCE_BATCH_INVALID",
      );
    }
    seen.add(id);
    const previous = existing.get(id);
    if (input.kind === "decomposition") {
      prepared = selectDecompositionRevision(
        prepared as ArtifactDecompositionRecord,
        previous as ArtifactDecompositionRecord | undefined,
        view,
      );
      if (prepared !== previous) added += 1;
    } else if (previous)
      assertSameContentRecord(
        contentRecordSha256(previous),
        contentRecordSha256(prepared),
        input.kind,
      );
    else added += 1;
    records[index] = input.kind === "decomposition" ? prepared : (previous ?? prepared);
  }
  const stable = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    kind: input.kind,
    records,
  };
  const batchSha256 = contentBatchHash(stable);
  let batch: ContentBatch = { ...stable, batchSha256 };
  const committed =
    added === 0 &&
    (await readVerifiedJournal(evidenceLedgerPath(input.root, input.projectId))).some(
      (event) =>
        event.type === "content.batch.registered" && event.payload.batchSha256 === batchSha256,
    );
  if (!committed) {
    const path = contentBatchPath(input.root, input.projectId, batchSha256);
    if (await pathExists(path)) {
      // A crash before the commit event can leave a complete invisible envelope.
      // Reuse only its verified bytes, preserving the original timestamps.
      batch = await readContentBatch(path, input.projectId, batchSha256, input.kind);
    } else {
      await writeJsonAtomic(path, batch, 0o444);
    }
    await appendEvidenceLedgerEvent(input.root, input.projectId, "content.batch.registered", {
      batchSha256,
      envelopeSha256: sha256Text(canonicalJson(batch)),
      kind: input.kind,
      recordCount: records.length,
    });
    view.work.ledgerAppends += 1;
  }
  return { ...batch, work: view.work };
}

async function loadContentPreparationView(
  root: string,
  projectId: string,
): Promise<ContentPreparationView> {
  const project = await assertContentPreparationWindow(root, projectId);
  const work = {
    acquisitionVerifications: 0,
    artifactStoreScans: 0,
    excerptFileReads: 0,
    ledgerAppends: 0,
  };
  const verified = await loadVerifiedEvidencePreparationView(root, projectId);
  work.acquisitionVerifications += 1;
  work.artifactStoreScans += 1;
  const roleIds = project.scientificDesign
    ? new Set(
        (await loadBoundAcquisitionDesign(root, project)).evidenceRoles.map((role) => role.id),
      )
    : null;
  return {
    acquisition: verified.snapshot,
    acquisitionAncestors: new Set(verified.ancestorSnapshotSha256s),
    artifacts: new Map(verified.artifacts.map((artifact) => [artifact.artifactId, artifact])),
    roleIds,
    texts: new Map(),
    work,
  };
}

function contentRecordId(record: ContentRecord): string {
  return "atomId" in record ? record.atomId : record.sourceArtifactId;
}

function contentRecordSha256(record: ContentRecord): string {
  return "atomSha256" in record ? record.atomSha256 : record.decompositionSha256;
}

function assertSameContentRecord(previous: string, next: string, kind: ContentBatchKind): void {
  if (previous !== next) {
    throw contentError(
      `Evidence ${kind} identity already exists with different content.`,
      kind === "atom" ? "RESEARCH_EVIDENCE_ATOM_CONFLICT" : "RESEARCH_DECOMPOSITION_CONFLICT",
    );
  }
}

function contentBatchHash(batch: Omit<ContentBatch, "batchSha256">): string {
  return sha256Text(
    canonicalJson({
      schemaVersion: batch.schemaVersion,
      projectId: batch.projectId,
      kind: batch.kind,
      records: batch.records.map((record) => ({
        id: contentRecordId(record),
        sha256: contentRecordSha256(record),
      })),
    }),
  );
}

function contentBatchPath(root: string, projectId: string, sha256: string): string {
  return resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/content-batches/${sha256}.json`,
  );
}

async function readContentBatch(
  path: string,
  projectId: string,
  sha256: string,
  kind: ContentBatchKind,
): Promise<ContentBatch> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
    throw contentError(
      "Committed evidence batch file is absent or invalid.",
      "RESEARCH_EVIDENCE_BATCH_INVALID",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw contentError(
      "Stored evidence batch is not valid JSON.",
      "RESEARCH_EVIDENCE_BATCH_INVALID",
    );
  }
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== projectId ||
    value.kind !== kind ||
    value.batchSha256 !== sha256 ||
    !Array.isArray(value.records) ||
    value.records.length < 1 ||
    value.records.length > MAX_BATCH_RECORDS
  ) {
    throw contentError(
      "Stored evidence batch identity is invalid.",
      "RESEARCH_EVIDENCE_BATCH_INVALID",
    );
  }
  const records = value.records.map((record) =>
    kind === "atom" ? parseAtomRecord(record) : parseDecompositionRecord(record),
  );
  const batch = { schemaVersion: 1 as const, projectId, kind, batchSha256: sha256, records };
  if (
    records.some((record) => record.projectId !== projectId) ||
    new Set(records.map(contentRecordId)).size !== records.length ||
    contentBatchHash(batch) !== sha256
  ) {
    throw contentError(
      "Stored evidence batch hash binding is invalid.",
      "RESEARCH_EVIDENCE_BATCH_INVALID",
    );
  }
  return batch;
}

async function loadCommittedContentBatchRecords(
  root: string,
  projectId: string,
  kind: ContentBatchKind,
  verifiedEvents?: Awaited<ReturnType<typeof readVerifiedJournal>>,
): Promise<ContentRecord[]> {
  const ledger = evidenceLedgerPath(root, projectId);
  const events = verifiedEvents ?? (await readVerifiedJournal(ledger));
  const records: ContentRecord[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "content.batch.registered" || event.payload.kind !== kind) continue;
    const hash = event.payload.batchSha256;
    if (
      event.scope !== projectId ||
      typeof hash !== "string" ||
      !SHA256.test(hash) ||
      seen.has(hash)
    ) {
      throw contentError(
        "Evidence batch commit event is invalid.",
        "RESEARCH_EVIDENCE_BATCH_INVALID",
      );
    }
    seen.add(hash);
    const batch = await readContentBatch(
      contentBatchPath(root, projectId, hash),
      projectId,
      hash,
      kind,
    );
    if (
      event.payload.recordCount !== batch.records.length ||
      event.payload.envelopeSha256 !== sha256Text(canonicalJson(batch))
    ) {
      throw contentError(
        "Evidence batch commit count is invalid.",
        "RESEARCH_EVIDENCE_BATCH_INVALID",
      );
    }
    records.push(...batch.records);
  }
  return records;
}

function mergeContentRecords<T extends ContentRecord>(records: T[], kind: ContentBatchKind): T[] {
  const merged = new Map<string, T>();
  for (const record of records) {
    const id = contentRecordId(record);
    const previous = merged.get(id);
    if (previous)
      assertSameContentRecord(contentRecordSha256(previous), contentRecordSha256(record), kind);
    else merged.set(id, record);
  }
  return [...merged.values()].sort((left, right) =>
    contentRecordId(left).localeCompare(contentRecordId(right)),
  );
}

export async function freezeEvidenceContentSnapshot(
  root: string,
  projectId: string,
): Promise<EvidenceContentSnapshot> {
  await assertContentPreparationWindow(root, projectId);
  const [project, acquisition, artifacts, decompositions, recordedAtoms, ledgerEvents] =
    await Promise.all([
      loadProject(root, projectId),
      loadCurrentEvidenceSnapshot(root, projectId),
      loadEvidenceArtifactRecords(root, projectId),
      loadDecompositionRecords(root, projectId),
      loadEvidenceAtomRecords(root, projectId),
      readJournal(evidenceLedgerPath(root, projectId)),
    ]);
  const selectedArtifactIds = new Set(acquisition.artifacts.map((artifact) => artifact.artifactId));
  const activeAtom = currentAcquisitionAtomPredicate(acquisition);
  const atoms = recordedAtoms.filter(activeAtom);
  const selectedArtifacts = artifacts.filter((artifact) =>
    selectedArtifactIds.has(artifact.artifactId),
  );
  const childParents = new Set(
    selectedArtifacts.flatMap((artifact) =>
      artifact.derivedFromArtifactId ? [artifact.derivedFromArtifactId] : [],
    ),
  );
  const requiredDecompositionArtifactIds = selectedArtifacts
    .filter(
      (artifact) =>
        !PRODUCER_VISIBLE_MEDIA_TYPES.has(artifact.mediaType) &&
        (artifact.downloadBinding !== null || childParents.has(artifact.artifactId)),
    )
    .map((artifact) => artifact.artifactId)
    .sort();
  const decompositionByArtifact = new Map(
    decompositions.map((decomposition) => [decomposition.sourceArtifactId, decomposition]),
  );
  const missingDecompositionArtifactIds = requiredDecompositionArtifactIds.filter(
    (artifactId) => !decompositionByArtifact.has(artifactId),
  );
  const reasons = missingDecompositionArtifactIds.map(
    (artifactId) => `missing decomposition disposition for artifact ${artifactId}`,
  );
  for (const decomposition of decompositions) {
    if (!selectedArtifactIds.has(decomposition.sourceArtifactId)) continue;
    if (decomposition.status === "failed") {
      reasons.push(`decomposition failed for artifact ${decomposition.sourceArtifactId}`);
    }
  }
  const atomsBySource = new Map<string, EvidenceAtomRecord[]>();
  for (const atom of atoms) {
    const values = atomsBySource.get(atom.sourceId) ?? [];
    values.push(atom);
    atomsBySource.set(atom.sourceId, values);
  }
  const acceptedFullTextSourceIds = acquisition.sources
    .filter(
      (source) => source.acquisitionStatus === "accepted" && source.fullTextAvailable === true,
    )
    .map((source) => String(source.id))
    .sort();
  const sourcesWithoutAtoms = acceptedFullTextSourceIds.filter(
    (sourceId) => !atomsBySource.get(sourceId)?.length,
  );
  reasons.push(
    ...sourcesWithoutAtoms.map(
      (sourceId) => `accepted full-text source has no evidence atom: ${sourceId}`,
    ),
  );
  const sourceCoverage = acquisition.sources.map((source) => {
    const sourceAtoms = (atomsBySource.get(String(source.id)) ?? []).sort((left, right) =>
      left.atomId.localeCompare(right.atomId),
    );
    return {
      sourceId: String(source.id),
      atomIds: sourceAtoms.map((atom) => atom.atomId),
      evidenceRoleIds: sortedUnique(sourceAtoms.flatMap((atom) => atom.evidenceRoleIds)),
      coverageDimensionIds: sortedUnique(sourceAtoms.flatMap((atom) => atom.coverageDimensionIds)),
      evidenceFunctions: sortedUnique(sourceAtoms.map((atom) => atom.evidenceFunction)),
    };
  });
  const roleCoverage = project.scientificDesign
    ? computeRoleCoverage(
        (await loadBoundAcquisitionDesign(root, project)).evidenceRoles,
        acquisition.sources,
        atoms,
      )
    : [];
  reasons.push(...roleCoverage.flatMap((coverage) => coverage.gaps));
  const uniqueReasons = sortedUnique(reasons);
  const ledgerHead = ledgerEvents.at(-1)?.hash ?? "0".repeat(64);
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-evidence-content-snapshot" as const,
    projectId,
    acquisitionSnapshotId: acquisition.snapshotId,
    acquisitionSnapshotSha256: acquisition.snapshotSha256,
    createdAt: new Date().toISOString(),
    ledgerHead,
    decompositions: decompositions
      .filter((record) => selectedArtifactIds.has(record.sourceArtifactId))
      .sort((left, right) => left.decompositionId.localeCompare(right.decompositionId)),
    atoms: atoms.sort((left, right) => left.atomId.localeCompare(right.atomId)),
    sourceCoverage,
    roleCoverage,
    gate: {
      decision: (uniqueReasons.length ? "stop" : "pass") as "pass" | "stop",
      reasons: uniqueReasons,
      requiredDecompositionArtifactIds,
      missingDecompositionArtifactIds,
      acceptedFullTextSourceIds,
      sourcesWithoutAtoms,
    },
  };
  const snapshotId = `content-snapshot-${sha256Text(canonicalJson(core)).slice(0, 24)}`;
  const withoutHash = { ...core, snapshotId };
  const snapshot: EvidenceContentSnapshot = {
    ...withoutHash,
    snapshotSha256: sha256Text(canonicalJson(withoutHash)),
  };
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const logicalPath = `evidence/content-snapshots/${snapshot.snapshotSha256}.json`;
  const immutablePath = resolveContained(projectRoot, logicalPath);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (await pathExists(immutablePath)) {
    if ((await sha256File(immutablePath)) !== sha256Text(content)) {
      throw contentError(
        "Content-addressed evidence content snapshot drifted.",
        "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
      );
    }
  } else {
    await ensureDirectory(dirname(immutablePath));
    await writeTextAtomic(immutablePath, content, 0o444);
    await chmod(immutablePath, 0o444).catch(() => undefined);
  }
  await writeTextAtomic(join(projectRoot, "outputs", "content-snapshot.json"), content);
  await appendEvidenceLedgerEvent(root, projectId, "content.snapshot.frozen", {
    snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    acquisitionSnapshotId: snapshot.acquisitionSnapshotId,
    acquisitionSnapshotSha256: snapshot.acquisitionSnapshotSha256,
    path: logicalPath,
    decompositionCount: snapshot.decompositions.length,
    atomCount: snapshot.atoms.length,
    gate: snapshot.gate,
  });
  return snapshot;
}

export async function loadCurrentEvidenceContentSnapshot(
  root: string,
  projectId: string,
): Promise<EvidenceContentSnapshot> {
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const currentPath = join(projectRoot, "outputs", "content-snapshot.json");
  if (!(await pathExists(currentPath))) {
    throw contentError(
      "Evidence content snapshot has not been frozen.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_REQUIRED",
    );
  }
  const snapshot = parseContentSnapshot(JSON.parse(await readFile(currentPath, "utf8")));
  const { snapshotSha256, ...withoutHash } = snapshot;
  if (sha256Text(canonicalJson(withoutHash)) !== snapshotSha256) {
    throw contentError(
      "Evidence content snapshot hash binding is invalid.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
    );
  }
  const immutablePath = resolveContained(
    projectRoot,
    `evidence/content-snapshots/${snapshotSha256}.json`,
  );
  if (
    !(await pathExists(immutablePath)) ||
    (await sha256File(immutablePath)) !== (await sha256File(currentPath))
  ) {
    throw contentError(
      "Evidence content snapshot is not bound to its immutable copy.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
    );
  }
  const acquisition = await loadCurrentEvidenceSnapshot(root, projectId);
  if (
    acquisition.snapshotId !== snapshot.acquisitionSnapshotId ||
    acquisition.snapshotSha256 !== snapshot.acquisitionSnapshotSha256
  ) {
    throw contentError(
      "Evidence content snapshot belongs to a different acquisition snapshot.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_STALE",
    );
  }
  const decompositions = new Map(
    (await loadDecompositionRecords(root, projectId)).map((record) => [
      record.decompositionId,
      record,
    ]),
  );
  for (const record of snapshot.decompositions) {
    if (canonicalJson(decompositions.get(record.decompositionId)) !== canonicalJson(record)) {
      throw contentError(
        `Evidence decomposition binding drifted: ${record.decompositionId}.`,
        "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
      );
    }
  }
  const atoms = new Map(
    (await loadEvidenceAtomRecords(root, projectId)).map((record) => [record.atomId, record]),
  );
  const activeAtom = currentAcquisitionAtomPredicate(acquisition);
  for (const record of snapshot.atoms) {
    if (!activeAtom(record) || canonicalJson(atoms.get(record.atomId)) !== canonicalJson(record)) {
      throw contentError(
        `Evidence atom binding drifted: ${record.atomId}.`,
        "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
      );
    }
  }
  return snapshot;
}

function currentAcquisitionAtomPredicate(
  acquisition: Awaited<ReturnType<typeof loadCurrentEvidenceSnapshot>>,
) {
  const artifacts = new Map(
    acquisition.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const sourceArtifacts = new Map(
    acquisition.sources.map((source) => [
      String(source.id),
      new Set(Array.isArray(source.artifactIds) ? (source.artifactIds as string[]) : []),
    ]),
  );
  return (atom: EvidenceAtomRecord) => {
    const artifact = artifacts.get(atom.artifactId);
    return Boolean(
      artifact &&
      sourceArtifacts.get(atom.sourceId)?.has(atom.artifactId) &&
      artifact.sha256 === atom.artifactSha256 &&
      artifact.candidateId === atom.candidateId,
    );
  };
}

export async function loadDecompositionRecords(
  root: string,
  projectId: string,
): Promise<ArtifactDecompositionRecord[]> {
  const directory = resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/decompositions`,
  );
  const events = await readVerifiedJournal(evidenceLedgerPath(root, projectId));
  const records: ArtifactDecompositionRecord[] = [];
  for (const event of events) {
    if (event.type !== "decomposition.recorded") continue;
    const hash = event.payload.decompositionSha256;
    const artifactId = event.payload.sourceArtifactId;
    if (typeof hash !== "string" || !SHA256.test(hash) || !identifierValue(artifactId)) {
      throw contentError(
        "Decomposition commit identity is invalid.",
        "RESEARCH_DECOMPOSITION_STORE_INVALID",
      );
    }
    const versionPath = resolve(directory, `${hash}.json`);
    const record = await readDecompositionFile(
      (await pathExists(versionPath)) ? versionPath : resolve(directory, `${artifactId}.json`),
    );
    if (
      record.projectId !== projectId ||
      record.sourceArtifactId !== artifactId ||
      record.decompositionSha256 !== hash
    ) {
      throw contentError(
        "Evidence decomposition identity does not match its path.",
        "RESEARCH_DECOMPOSITION_STORE_INVALID",
      );
    }
    records.push(record);
  }
  const batched = await loadCommittedContentBatchRecords(root, projectId, "decomposition", events);
  return effectiveDecompositions([...records, ...(batched as ArtifactDecompositionRecord[])]);
}

async function readDecompositionFile(path: string): Promise<ArtifactDecompositionRecord> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_BATCH_INPUT_BYTES) {
    throw contentError(
      "Committed decomposition is not a bounded regular file.",
      "RESEARCH_DECOMPOSITION_STORE_INVALID",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw contentError(
      "Committed decomposition JSON is invalid.",
      "RESEARCH_DECOMPOSITION_STORE_INVALID",
    );
  }
  return parseDecompositionRecord(value);
}

function effectiveDecompositions(
  records: ArtifactDecompositionRecord[],
): ArtifactDecompositionRecord[] {
  const groups = new Map<string, Map<string, ArtifactDecompositionRecord>>();
  for (const record of records) {
    const group =
      groups.get(record.sourceArtifactId) ?? new Map<string, ArtifactDecompositionRecord>();
    if (!group.has(record.decompositionSha256)) group.set(record.decompositionSha256, record);
    groups.set(record.sourceArtifactId, group);
  }
  const result: ArtifactDecompositionRecord[] = [];
  for (const group of groups.values()) {
    const parents = new Set<string>();
    for (const record of group.values()) {
      if (!record.supersedesSha256) continue;
      const parent = group.get(record.supersedesSha256);
      if (
        !parent ||
        !record.acquisitionSnapshotSha256 ||
        record.acquisitionSnapshotSha256 === parent.acquisitionSnapshotSha256 ||
        record.projectId !== parent.projectId ||
        record.sourceArtifactSha256 !== parent.sourceArtifactSha256
      ) {
        throw contentError(
          "Decomposition revision lineage is invalid.",
          "RESEARCH_DECOMPOSITION_STORE_INVALID",
        );
      }
      parents.add(record.supersedesSha256);
    }
    const heads = [...group.values()].filter((record) => !parents.has(record.decompositionSha256));
    const seen = new Set<string>();
    let cursor = heads[0];
    while (cursor && !seen.has(cursor.decompositionSha256)) {
      seen.add(cursor.decompositionSha256);
      cursor = cursor.supersedesSha256 ? group.get(cursor.supersedesSha256) : undefined;
    }
    if (heads.length !== 1 || seen.size !== group.size || cursor) {
      throw contentError(
        "Decomposition has conflicting or cyclic revisions.",
        "RESEARCH_DECOMPOSITION_CONFLICT",
      );
    }
    result.push(heads[0]!);
  }
  return result.sort((a, b) => a.sourceArtifactId.localeCompare(b.sourceArtifactId));
}

export async function loadEvidenceAtomRecords(
  root: string,
  projectId: string,
): Promise<EvidenceAtomRecord[]> {
  const directory = resolveContained(workspacePaths(root).projects, `${projectId}/evidence/atoms`);
  const entries = (await pathExists(directory))
    ? await readdir(directory, { withFileTypes: true })
    : [];
  const records: EvidenceAtomRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const record = parseAtomRecord(
      JSON.parse(await readFile(resolve(directory, entry.name), "utf8")),
    );
    if (entry.name !== `${record.atomId}.json` || record.projectId !== projectId) {
      throw contentError(
        "Evidence atom identity does not match its path.",
        "RESEARCH_EVIDENCE_ATOM_STORE_INVALID",
      );
    }
    records.push(record);
  }
  const batched = await loadCommittedContentBatchRecords(root, projectId, "atom");
  return mergeContentRecords([...records, ...(batched as EvidenceAtomRecord[])], "atom");
}

async function assertContentPreparationWindow(root: string, projectId: string) {
  const project = await loadProject(root, projectId);
  const acquire = project.packages.find((workPackage) => workPackage.stage === "acquire");
  const analyze = project.packages.find((workPackage) => workPackage.stage === "analyze");
  if (
    acquire?.status !== "complete" ||
    !analyze ||
    !["pending", "ready"].includes(analyze.status) ||
    analyze.attempts !== 0
  ) {
    throw contentError(
      "Evidence content preparation is allowed only after acquisition and before analysis starts.",
      "RESEARCH_EVIDENCE_CONTENT_STAGE_REQUIRED",
    );
  }
  return project;
}

function parseDecompositionInput(value: Record<string, unknown>): {
  sourceArtifactId: string;
  status: "complete" | "limited" | "failed";
  parser: { id: string; version: string };
  outputArtifactIds: string[];
  contentClasses: string[];
  limitations: string[];
} {
  const allowed = new Set([
    "schemaVersion",
    "sourceArtifactId",
    "status",
    "parser",
    "outputArtifactIds",
    "contentClasses",
    "limitations",
  ]);
  if (
    !isEvidenceContentInputShape("artifact-decomposition", value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceArtifactId !== "string" ||
    !IDENTIFIER.test(value.sourceArtifactId) ||
    !["complete", "limited", "failed"].includes(String(value.status)) ||
    !isObject(value.parser) ||
    typeof value.parser.id !== "string" ||
    !IDENTIFIER.test(value.parser.id) ||
    typeof value.parser.version !== "string" ||
    value.parser.version.length < 1 ||
    value.parser.version.length > 100 ||
    !Array.isArray(value.outputArtifactIds) ||
    value.outputArtifactIds.length > 100 ||
    value.outputArtifactIds.some(
      (artifactId) => typeof artifactId !== "string" || !IDENTIFIER.test(artifactId),
    ) ||
    new Set(value.outputArtifactIds).size !== value.outputArtifactIds.length ||
    !Array.isArray(value.contentClasses) ||
    value.contentClasses.length < 1 ||
    value.contentClasses.length > CONTENT_CLASSES.size ||
    value.contentClasses.some(
      (contentClass) => typeof contentClass !== "string" || !CONTENT_CLASSES.has(contentClass),
    ) ||
    new Set(value.contentClasses).size !== value.contentClasses.length ||
    !safeStringArray(value.limitations, 100, 2_000)
  ) {
    throw contentError(
      "Artifact decomposition record failed validation.",
      "RESEARCH_DECOMPOSITION_INVALID",
    );
  }
  for (const text of [value.parser.version, ...(value.limitations as string[])]) {
    assertSafeContent(text, "Artifact decomposition contains sensitive material.");
  }
  return value as unknown as ReturnType<typeof parseDecompositionInput>;
}

function parseAtomInput(value: Record<string, unknown>): {
  atomId: string;
  sourceId: string;
  candidateId: string;
  artifactId: string;
  locator: EvidenceAtomRecord["locator"];
  statement: string;
  evidenceRoleIds: string[];
  coverageDimensionIds: string[];
  evidenceFunction: string;
  scope: string;
  limitations: string[];
} {
  const allowed = new Set([
    "schemaVersion",
    "atomId",
    "sourceId",
    "candidateId",
    "artifactId",
    "locator",
    "statement",
    "evidenceRoleIds",
    "coverageDimensionIds",
    "evidenceFunction",
    "scope",
    "limitations",
  ]);
  if (
    !isEvidenceContentInputShape("evidence-atom", value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== 1 ||
    !identifierValue(value.atomId) ||
    !identifierValue(value.sourceId) ||
    !identifierValue(value.candidateId) ||
    !identifierValue(value.artifactId) ||
    !validAtomLocator(value.locator) ||
    !boundedString(value.statement, 8, 2_000) ||
    !safeIdentifierArray(value.evidenceRoleIds, 100) ||
    !safeIdentifierArray(value.coverageDimensionIds, 100) ||
    typeof value.evidenceFunction !== "string" ||
    !EVIDENCE_FUNCTIONS.has(value.evidenceFunction) ||
    !boundedString(value.scope, 8, 1_000) ||
    !safeStringArray(value.limitations, 100, 2_000)
  ) {
    throw contentError("Evidence atom failed validation.", "RESEARCH_EVIDENCE_ATOM_INVALID");
  }
  for (const text of [value.statement, value.scope, ...(value.limitations as string[])]) {
    assertSafeContent(text as string, "Evidence atom contains sensitive material.");
  }
  return value as unknown as ReturnType<typeof parseAtomInput>;
}

function validateAtomTaxonomy(
  source: Record<string, unknown>,
  value: ReturnType<typeof parseAtomInput>,
  knownRoleIds: Set<string> | null,
): void {
  const sourceDimensions = new Set(
    Array.isArray(source.coverageDimensions)
      ? source.coverageDimensions.filter((item): item is string => typeof item === "string")
      : [],
  );
  if (value.coverageDimensionIds.some((dimension) => !sourceDimensions.has(dimension))) {
    throw contentError(
      "Evidence atom dimensions must be declared by its frozen acquisition source.",
      "RESEARCH_EVIDENCE_ATOM_TAXONOMY_INVALID",
    );
  }
  if (!knownRoleIds) {
    if (value.evidenceRoleIds.length) {
      throw contentError(
        "A project without a scientific design cannot declare evidence-role IDs.",
        "RESEARCH_EVIDENCE_ATOM_TAXONOMY_INVALID",
      );
    }
    return;
  }
  if (
    value.evidenceRoleIds.length < 1 ||
    value.evidenceRoleIds.some((roleId) => !knownRoleIds.has(roleId))
  ) {
    throw contentError(
      "Scientific evidence atoms must bind only declared evidence-role IDs.",
      "RESEARCH_EVIDENCE_ATOM_TAXONOMY_INVALID",
    );
  }
}

function extractAtomExcerptFromDocument(
  document: { text: string; lines?: string[]; json?: unknown },
  mediaType: string,
  locator: EvidenceAtomRecord["locator"],
): string {
  let excerpt: string;
  if (locator.kind === "line-range") {
    if (!["text/plain", "text/markdown", "text/csv"].includes(mediaType)) {
      throw contentError(
        "Line-range evidence atoms require a text or CSV artifact.",
        "RESEARCH_EVIDENCE_ATOM_LOCATOR_INVALID",
      );
    }
    const lines = (document.lines ??= document.text.split(/\r\n|\n|\r/u));
    if (locator.endLine > lines.length) {
      throw contentError(
        "Evidence atom line range exceeds the artifact.",
        "RESEARCH_EVIDENCE_ATOM_LOCATOR_INVALID",
      );
    }
    excerpt = lines.slice(locator.startLine - 1, locator.endLine).join("\n");
  } else {
    if (mediaType !== "application/json") {
      throw contentError(
        "JSON Pointer evidence atoms require an application/json artifact.",
        "RESEARCH_EVIDENCE_ATOM_LOCATOR_INVALID",
      );
    }
    if (!("json" in document)) document.json = JSON.parse(document.text);
    let selected: unknown = document.json;
    for (const segment of locator.pointer
      .slice(1)
      .split("/")
      .map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (Array.isArray(selected) && /^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        selected = selected[Number(segment)];
      } else if (isObject(selected) && Object.prototype.hasOwnProperty.call(selected, segment)) {
        selected = selected[segment];
      } else {
        throw contentError(
          "Evidence atom JSON Pointer does not exist.",
          "RESEARCH_EVIDENCE_ATOM_LOCATOR_INVALID",
        );
      }
    }
    excerpt = typeof selected === "string" ? selected : JSON.stringify(selected);
  }
  if (!excerpt.trim() || Buffer.byteLength(excerpt, "utf8") > MAX_EXCERPT_BYTES) {
    throw contentError(
      "Evidence atom excerpt must be non-empty and within the byte bound.",
      "RESEARCH_EVIDENCE_ATOM_EXCERPT_INVALID",
    );
  }
  return excerpt;
}

function artifactDescendsFrom(
  artifact: EvidenceArtifactRecord,
  ancestorId: string,
  artifacts: Map<string, EvidenceArtifactRecord>,
): boolean {
  const visited = new Set<string>();
  let current: EvidenceArtifactRecord | undefined = artifact;
  while (current?.derivedFromArtifactId) {
    if (current.derivedFromArtifactId === ancestorId) return true;
    if (visited.has(current.artifactId)) return false;
    visited.add(current.artifactId);
    current = artifacts.get(current.derivedFromArtifactId);
  }
  return false;
}

function parseDecompositionRecord(value: unknown): ArtifactDecompositionRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !identifierValue(value.decompositionId) ||
    typeof value.decompositionSha256 !== "string" ||
    !SHA256.test(value.decompositionSha256) ||
    !identifierValue(value.projectId) ||
    !identifierValue(value.candidateId) ||
    !identifierValue(value.sourceArtifactId) ||
    typeof value.sourceArtifactSha256 !== "string" ||
    !SHA256.test(value.sourceArtifactSha256) ||
    (value.acquisitionSnapshotSha256 !== undefined &&
      (typeof value.acquisitionSnapshotSha256 !== "string" ||
        !SHA256.test(value.acquisitionSnapshotSha256))) ||
    (value.supersedesSha256 !== undefined &&
      value.supersedesSha256 !== null &&
      (typeof value.supersedesSha256 !== "string" || !SHA256.test(value.supersedesSha256))) ||
    !["complete", "limited", "failed"].includes(String(value.status)) ||
    !isObject(value.parser) ||
    !identifierValue(value.parser.id) ||
    typeof value.parser.version !== "string" ||
    !safeIdentifierArray(value.outputArtifactIds, 100) ||
    !Array.isArray(value.outputArtifactSha256s) ||
    value.outputArtifactSha256s.some(
      (sha256) => typeof sha256 !== "string" || !SHA256.test(sha256),
    ) ||
    value.outputArtifactSha256s.length !== value.outputArtifactIds.length ||
    !Array.isArray(value.contentClasses) ||
    value.contentClasses.some(
      (contentClass) => typeof contentClass !== "string" || !CONTENT_CLASSES.has(contentClass),
    ) ||
    !safeStringArray(value.limitations, 100, 2_000) ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    throw contentError(
      "Stored artifact decomposition is invalid.",
      "RESEARCH_DECOMPOSITION_STORE_INVALID",
    );
  }
  const record = value as unknown as ArtifactDecompositionRecord;
  const { decompositionId: _id, decompositionSha256, recordedAt: _time, ...stable } = record;
  if (sha256Text(canonicalJson(stable)) !== decompositionSha256) {
    throw contentError(
      "Stored artifact decomposition hash binding is invalid.",
      "RESEARCH_DECOMPOSITION_STORE_INVALID",
    );
  }
  return record;
}

export function parseAtomRecord(value: unknown): EvidenceAtomRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !identifierValue(value.atomId) ||
    typeof value.atomSha256 !== "string" ||
    !SHA256.test(value.atomSha256) ||
    !identifierValue(value.projectId) ||
    !identifierValue(value.sourceId) ||
    !identifierValue(value.candidateId) ||
    !identifierValue(value.artifactId) ||
    typeof value.artifactSha256 !== "string" ||
    !SHA256.test(value.artifactSha256) ||
    !validAtomLocator(value.locator) ||
    typeof value.excerpt !== "string" ||
    typeof value.excerptSha256 !== "string" ||
    sha256Text(value.excerpt) !== value.excerptSha256 ||
    !boundedString(value.statement, 8, 2_000) ||
    !safeIdentifierArray(value.evidenceRoleIds, 100) ||
    !safeIdentifierArray(value.coverageDimensionIds, 100) ||
    typeof value.evidenceFunction !== "string" ||
    !EVIDENCE_FUNCTIONS.has(value.evidenceFunction) ||
    !boundedString(value.scope, 8, 1_000) ||
    !safeStringArray(value.limitations, 100, 2_000) ||
    typeof value.registeredAt !== "string" ||
    !Number.isFinite(Date.parse(value.registeredAt))
  ) {
    throw contentError("Stored evidence atom is invalid.", "RESEARCH_EVIDENCE_ATOM_STORE_INVALID");
  }
  const record = value as unknown as EvidenceAtomRecord;
  const { atomSha256, registeredAt: _time, ...stable } = record;
  if (sha256Text(canonicalJson(stable)) !== atomSha256) {
    throw contentError(
      "Stored evidence atom hash binding is invalid.",
      "RESEARCH_EVIDENCE_ATOM_STORE_INVALID",
    );
  }
  return record;
}

function parseContentSnapshot(value: unknown): EvidenceContentSnapshot {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-evidence-content-snapshot" ||
    !identifierValue(value.snapshotId) ||
    typeof value.snapshotSha256 !== "string" ||
    !SHA256.test(value.snapshotSha256) ||
    !identifierValue(value.projectId) ||
    !identifierValue(value.acquisitionSnapshotId) ||
    typeof value.acquisitionSnapshotSha256 !== "string" ||
    !SHA256.test(value.acquisitionSnapshotSha256) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.ledgerHead !== "string" ||
    !SHA256.test(value.ledgerHead) ||
    !Array.isArray(value.decompositions) ||
    !Array.isArray(value.atoms) ||
    !Array.isArray(value.sourceCoverage) ||
    !Array.isArray(value.roleCoverage) ||
    !isObject(value.gate) ||
    !["pass", "stop"].includes(String(value.gate.decision)) ||
    !safeStringArray(value.gate.reasons, 10_000, 4_000) ||
    !safeIdentifierArray(value.gate.requiredDecompositionArtifactIds, 10_000) ||
    !safeIdentifierArray(value.gate.missingDecompositionArtifactIds, 10_000) ||
    !safeIdentifierArray(value.gate.acceptedFullTextSourceIds, 10_000) ||
    !safeIdentifierArray(value.gate.sourcesWithoutAtoms, 10_000)
  ) {
    throw contentError(
      "Evidence content snapshot is malformed.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
    );
  }
  for (const record of value.decompositions) parseDecompositionRecord(record);
  for (const record of value.atoms) parseAtomRecord(record);
  return value as unknown as EvidenceContentSnapshot;
}

function validAtomLocator(value: unknown): value is EvidenceAtomRecord["locator"] {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "line-range") {
    return (
      Object.keys(value).every((key) => ["kind", "startLine", "endLine"].includes(key)) &&
      Number.isInteger(value.startLine) &&
      Number(value.startLine) >= 1 &&
      Number.isInteger(value.endLine) &&
      Number(value.endLine) >= Number(value.startLine) &&
      Number(value.endLine) - Number(value.startLine) < 20
    );
  }
  return (
    value.kind === "json-pointer" &&
    Object.keys(value).every((key) => ["kind", "pointer"].includes(key)) &&
    typeof value.pointer === "string" &&
    value.pointer.startsWith("/") &&
    value.pointer.length <= 1_000
  );
}

function decompositionRecordPath(root: string, projectId: string, artifactId: string): string {
  return resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/decompositions/${artifactId}.json`,
  );
}

function atomRecordPath(root: string, projectId: string, atomId: string): string {
  return resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/atoms/${atomId}.json`,
  );
}

function identifierValue(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function safeIdentifierArray(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(identifierValue) &&
    new Set(value).size === value.length
  );
}

function safeStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => typeof item === "string" && item.length <= maximumLength)
  );
}

function assertSafeContent(value: string, message: string): void {
  if (sanitizeResearchText(value, configuredResearchSecrets(process.env)) !== value) {
    throw contentError(message, "RESEARCH_EVIDENCE_CONTENT_SENSITIVE");
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function contentError(message: string, code: string): CliError {
  return new CliError(message, { code, exitCode: 3 });
}

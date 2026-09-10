import { serializeProviderStateWrite } from "./provider-state.js";
import { basename, join } from "node:path";

import { CliError } from "../../errors.js";
import type { BrokerEvidenceReceipt } from "./evidence.js";
import { appendJournalEvent, readJournal, verifyJournal } from "./journal.js";
import { sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  readJsonFile,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import type { JournalEvent, ProjectInput } from "./types.js";

const TRACKING_QUERY_KEY = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|awsaccesskeyid|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token|x[_-]amz[_-](?:credential|security[_-]?token|signature)|x[_-]goog[_-](?:credential|signature))$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TITLE_LENGTH = 500;
const MAX_EXCERPT_LENGTH = 2_000;

export type EvidenceLedgerEventType =
  | "activity.recorded"
  | "candidate.discovered"
  | "candidate.duplicate"
  | "candidate.assessed"
  | "candidate.admitted"
  | "candidate.rejected"
  | "download.bound"
  | "download.failed"
  | "handoff.requested"
  | "handoff.resolved"
  | "artifact.registered"
  | "artifact.assessed"
  | "decomposition.recorded"
  | "atom.registered"
  | "content.batch.registered"
  | "content.snapshot.frozen"
  | "inference.snapshot.frozen"
  | "claim-graph.frozen"
  | "snapshot.frozen"
  | "claim.used"
  | "review.bound"
  | "addendum.created"
  | "project.superseded";

export interface EvidenceCandidateOrigin {
  kind: "broker" | "data" | "input" | "native";
  receiptId: string | null;
  inputId: string | null;
  capabilityId: string | null;
  locator: string | null;
  jsonPointer: string | null;
  retrievedAt: string;
}

export interface EvidenceCandidate {
  id: string;
  canonicalKeySha256: string;
  title: string;
  url: string | null;
  doi: string | null;
  publicationDate: string | null;
  excerpt: string | null;
  discoveredAt: string;
  origin: EvidenceCandidateOrigin;
  occurrences: EvidenceCandidateOrigin[];
}

export function evidenceLedgerPath(root: string, projectId: string): string {
  assertProjectId(projectId);
  return join(workspacePaths(root).projects, projectId, "evidence", "ledger.jsonl");
}

export async function appendEvidenceLedgerEvent(
  root: string,
  projectId: string,
  type: EvidenceLedgerEventType,
  payload: Record<string, unknown>,
): Promise<JournalEvent> {
  try {
    await ensureDirectory(join(workspacePaths(root).projects, projectId, "evidence"));
    return await appendJournalEvent(evidenceLedgerPath(root, projectId), type, projectId, {
      ...payload,
      projectId,
    });
  } catch (error) {
    throw evidenceLedgerError(error);
  }
}

export async function cloneEvidenceLedger(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<number> {
  await verifyEvidenceLedger(root, sourceProjectId);
  const events = await readJournal(evidenceLedgerPath(root, sourceProjectId));
  const replayable = new Set<EvidenceLedgerEventType>([
    "activity.recorded",
    "candidate.discovered",
    "candidate.duplicate",
    "candidate.assessed",
    "candidate.admitted",
    "candidate.rejected",
    "download.bound",
    "download.failed",
    "handoff.requested",
    "handoff.resolved",
    "artifact.registered",
    "artifact.assessed",
  ]);
  let count = 0;
  for (const event of events) {
    if (!replayable.has(event.type as EvidenceLedgerEventType)) continue;
    const { projectId: _sourceProjectId, ...payload } = event.payload;
    void _sourceProjectId;
    await appendEvidenceLedgerEvent(
      root,
      targetProjectId,
      event.type as EvidenceLedgerEventType,
      payload,
    );
    count += 1;
  }
  return count;
}

export async function verifyEvidenceLedger(
  root: string,
  projectId: string,
): Promise<{ events: number; candidates: number; head: string }> {
  try {
    const path = evidenceLedgerPath(root, projectId);
    const verification = await verifyJournal(path);
    const candidates = await listEvidenceCandidates(root, projectId);
    return { events: verification.events, candidates: candidates.length, head: verification.head };
  } catch (error) {
    throw evidenceLedgerError(error);
  }
}

export async function listEvidenceCandidates(
  root: string,
  projectId: string,
): Promise<EvidenceCandidate[]> {
  let events: JournalEvent[];
  try {
    events = await readJournal(evidenceLedgerPath(root, projectId));
    await verifyJournal(evidenceLedgerPath(root, projectId));
  } catch (error) {
    throw evidenceLedgerError(error);
  }
  const candidates = new Map<string, EvidenceCandidate>();
  for (const event of events) {
    if (event.scope !== projectId)
      throw evidenceLedgerError("Ledger scope does not match project.");
    if (event.type === "candidate.discovered") {
      const candidate = parseCandidate(event.payload.candidate);
      if (candidates.has(candidate.id)) {
        throw evidenceLedgerError(`Duplicate candidate identity in ledger: ${candidate.id}`);
      }
      candidates.set(candidate.id, candidate);
    } else if (event.type === "candidate.duplicate") {
      const candidateId = event.payload.candidateId;
      const occurrence = parseOrigin(event.payload.occurrence);
      if (typeof candidateId !== "string" || !candidates.has(candidateId)) {
        throw evidenceLedgerError("Duplicate event refers to an unknown candidate.");
      }
      const candidate = candidates.get(candidateId)!;
      candidate.occurrences.push(occurrence);
    }
  }
  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function registerBrokerCandidates(input: {
  root: string;
  projectId: string;
  receipt: BrokerEvidenceReceipt;
  contextBytes: Uint8Array;
  selectedJsonPointer?: string | null;
  itemOffset?: number;
}): Promise<EvidenceCandidate[]> {
  if (input.receipt.projectId !== input.projectId) {
    throw evidenceLedgerError("Broker receipt project does not match the evidence ledger.");
  }
  const selectedJsonPointer = input.selectedJsonPointer ?? null;
  const itemOffset = input.itemOffset ?? input.receipt.contextOffset ?? 0;
  if (!Number.isInteger(itemOffset) || itemOffset < 0) {
    throw evidenceLedgerError("Broker candidate item offset is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input.contextBytes).toString("utf8")) as unknown;
  } catch {
    return [];
  }
  const items = candidateItems(parsed, selectedJsonPointer, itemOffset);
  if (!items.length) return [];
  return serializeProviderStateWrite(input.root, input.projectId, async () => {
    const existing = await listEvidenceCandidates(input.root, input.projectId);
    const byCanonicalKey = new Map(
      existing.map((candidate) => [candidate.canonicalKeySha256, candidate]),
    );
    const registered: EvidenceCandidate[] = [];
    for (const item of items) {
      const occurrence: EvidenceCandidateOrigin = {
        kind: "broker",
        receiptId: input.receipt.attemptId,
        inputId: null,
        capabilityId: input.receipt.capabilityId,
        locator: input.receipt.locator,
        jsonPointer: item.jsonPointer,
        retrievedAt: input.receipt.retrievedAt,
      };
      const candidate = candidateFromValue(item.value, occurrence);
      const duplicate = byCanonicalKey.get(candidate.canonicalKeySha256);
      if (duplicate) {
        await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.duplicate", {
          candidateId: duplicate.id,
          canonicalKeySha256: duplicate.canonicalKeySha256,
          occurrence,
        });
        registered.push({ ...duplicate, origin: occurrence });
        continue;
      }
      await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.discovered", {
        candidate,
      });
      byCanonicalKey.set(candidate.canonicalKeySha256, candidate);
      registered.push(candidate);
    }
    return registered;
  });
}

export async function registerDataResultCandidate(input: {
  root: string;
  projectId: string;
  receipt: BrokerEvidenceReceipt;
  title: string;
  excerpt: string;
}): Promise<EvidenceCandidate> {
  if (
    input.receipt.projectId !== input.projectId ||
    input.receipt.evidenceKind !== "data" ||
    !input.receipt.data
  ) {
    throw evidenceLedgerError("Data receipt does not match the evidence ledger.");
  }
  const occurrence: EvidenceCandidateOrigin = {
    kind: "data",
    receiptId: input.receipt.attemptId,
    inputId: null,
    capabilityId: input.receipt.capabilityId,
    locator: input.receipt.locator,
    jsonPointer: "/data",
    retrievedAt: input.receipt.retrievedAt,
  };
  const canonicalKeySha256 = sha256Text(`data:${input.receipt.data.coreReceiptDigest}`);
  const existing = (await listEvidenceCandidates(input.root, input.projectId)).find(
    (candidate) => candidate.canonicalKeySha256 === canonicalKeySha256,
  );
  if (existing) {
    await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.duplicate", {
      candidateId: existing.id,
      canonicalKeySha256,
      occurrence,
    });
    return { ...existing, origin: occurrence, occurrences: [...existing.occurrences, occurrence] };
  }
  const candidate: EvidenceCandidate = {
    id: `candidate-${canonicalKeySha256.slice(0, 24)}`,
    canonicalKeySha256,
    title: boundedText(input.title, MAX_TITLE_LENGTH),
    url: null,
    doi: null,
    publicationDate: null,
    excerpt: boundedText(input.excerpt, MAX_EXCERPT_LENGTH),
    discoveredAt: input.receipt.retrievedAt,
    origin: occurrence,
    occurrences: [occurrence],
  };
  await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.discovered", {
    candidate,
  });
  return candidate;
}

export async function registerProjectInputCandidates(
  root: string,
  projectId: string,
  inputs: ProjectInput[],
): Promise<EvidenceCandidate[]> {
  const existing = await listEvidenceCandidates(root, projectId);
  const byCanonicalKey = new Map(
    existing.map((candidate) => [candidate.canonicalKeySha256, candidate]),
  );
  const registered: EvidenceCandidate[] = [];
  for (const input of inputs) {
    const canonicalKeySha256 = sha256Text(`input:${input.sha256}`);
    const occurrence: EvidenceCandidateOrigin = {
      kind: "input",
      receiptId: null,
      inputId: input.id,
      capabilityId: null,
      locator: join("inputs", input.id, basename(input.path)).replaceAll("\\", "/"),
      jsonPointer: null,
      retrievedAt: input.addedAt,
    };
    const duplicate = byCanonicalKey.get(canonicalKeySha256);
    if (duplicate) {
      registered.push(duplicate);
      continue;
    }
    const candidate: EvidenceCandidate = {
      id: `candidate-${canonicalKeySha256.slice(0, 24)}`,
      canonicalKeySha256,
      title: basename(input.path),
      url: null,
      doi: null,
      publicationDate: input.publicationDate ?? null,
      excerpt: null,
      discoveredAt: input.addedAt,
      origin: occurrence,
      occurrences: [occurrence],
    };
    await appendEvidenceLedgerEvent(root, projectId, "candidate.discovered", { candidate });
    byCanonicalKey.set(canonicalKeySha256, candidate);
    registered.push(candidate);
  }
  return registered;
}

export async function registerNativeDiscoveryCandidate(input: {
  root: string;
  projectId: string;
  value: Record<string, unknown>;
}): Promise<{
  candidate: EvidenceCandidate;
  duplicate: boolean;
  admissionStatus: "supplemental-not-admitted" | "formalized-not-admitted";
  nextAction: string;
}> {
  const allowedKeys = new Set(["title", "url", "doi", "publicationDate", "excerpt"]);
  const unknownKeys = Object.keys(input.value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw evidenceLedgerError(
      `Native discovery candidate contains unsupported fields: ${unknownKeys.sort().join(", ")}.`,
    );
  }
  const project = await readJsonFile<Record<string, unknown>>(
    join(workspacePaths(input.root).projects, input.projectId, "project.json"),
    `Research project ${input.projectId}`,
  );
  const packages = Array.isArray(project.packages) ? project.packages : [];
  const discover = packages.find(
    (workPackage) => isObject(workPackage) && workPackage.stage === "discover",
  );
  if (!isObject(discover) || discover.status !== "running") {
    throw evidenceLedgerError(
      "Native discovery candidates may be registered only during the active discover stage.",
    );
  }
  if (typeof input.value.title !== "string" || !input.value.title.trim()) {
    throw evidenceLedgerError("Native discovery candidate requires a non-empty title.");
  }
  if (typeof input.value.url === "string") assertSafeNativeCandidateUrl(input.value.url);
  if (typeof input.value.url !== "string" && typeof input.value.doi !== "string") {
    throw evidenceLedgerError("Native discovery candidate requires a public HTTPS URL or DOI.");
  }
  const occurrence: EvidenceCandidateOrigin = {
    kind: "native",
    receiptId: null,
    inputId: null,
    capabilityId: null,
    locator: null,
    jsonPointer: null,
    retrievedAt: new Date().toISOString(),
  };
  const candidate = candidateFromValue(
    {
      title: input.value.title,
      url: input.value.url,
      doi: input.value.doi,
      publicationDate: input.value.publicationDate,
      description: input.value.excerpt,
    },
    occurrence,
  );
  if (!candidate.url && !candidate.doi) {
    throw evidenceLedgerError("Native discovery candidate URL or DOI is invalid.");
  }
  const existing = (await listEvidenceCandidates(input.root, input.projectId)).find(
    (item) => item.canonicalKeySha256 === candidate.canonicalKeySha256,
  );
  if (existing) {
    await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.duplicate", {
      candidateId: existing.id,
      canonicalKeySha256: existing.canonicalKeySha256,
      occurrence,
    });
    const formalized = existing.occurrences.some(
      (existingOccurrence) =>
        existingOccurrence.kind === "broker" ||
        existingOccurrence.kind === "data" ||
        existingOccurrence.kind === "input",
    );
    return {
      candidate: { ...existing, occurrences: [...existing.occurrences, occurrence] },
      duplicate: true,
      admissionStatus: formalized ? "formalized-not-admitted" : "supplemental-not-admitted",
      nextAction: formalized
        ? "This candidate already has immutable broker or input provenance and may be assessed. It remains unadmitted until an explicit discovery assessment records an admit decision."
        : "Fetch this URL/DOI through a reviewed broker capability. The immutable receipt will attach to the same candidate before formal admission.",
    };
  }
  await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.discovered", {
    candidate,
  });
  return {
    candidate,
    duplicate: false,
    admissionStatus: "supplemental-not-admitted",
    nextAction:
      "Fetch this URL/DOI through a reviewed broker capability. Native discovery alone cannot support a claim or formal admission.",
  };
}

function candidateFromValue(value: unknown, origin: EvidenceCandidateOrigin): EvidenceCandidate {
  const record = isObject(value) ? value : { value };
  const sourceCitation = parseSourceCitation(firstString(record, ["source"]));
  const title = boundedText(
    firstString(record, ["title", "name", "headline"]) ??
      sourceCitation.label ??
      "Untitled candidate",
    MAX_TITLE_LENGTH,
  );
  const url =
    canonicalPublicUrl(firstString(record, ["url", "link", "href"])) ?? sourceCitation.url;
  const doi = normalizeDoi(firstString(record, ["doi"])) ?? sourceCitation.doi;
  const publicationDate = normalizePublicationDate(
    firstString(record, [
      "publicationDate",
      "publication_date",
      "publishedAt",
      "published_at",
      "page_age",
      "date",
    ]) ?? sourceCitation.publicationDate,
  );
  const excerptValue = firstString(record, [
    "content",
    "description",
    "snippet",
    "abstract",
    "text",
    "summary",
  ]);
  const excerpt = excerptValue ? boundedText(excerptValue, MAX_EXCERPT_LENGTH) : null;
  const canonicalIdentity = url ?? (doi ? `doi:${doi}` : canonicalJson({ title, publicationDate }));
  const canonicalKeySha256 = sha256Text(canonicalIdentity);
  const id = `candidate-${canonicalKeySha256.slice(0, 24)}`;
  return {
    id,
    canonicalKeySha256,
    title,
    url,
    doi,
    publicationDate,
    excerpt,
    discoveredAt: origin.retrievedAt,
    origin,
    occurrences: [origin],
  };
}

function parseSourceCitation(value: string | null): {
  label: string | null;
  url: string | null;
  doi: string | null;
  publicationDate: string | null;
} {
  if (!value) return { label: null, url: null, doi: null, publicationDate: null };
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("](");
  const isMarkdownLink = trimmed.startsWith("[") && separator > 1 && trimmed.endsWith(")");
  const label = isMarkdownLink ? trimmed.slice(1, separator).trim() : null;
  const target = isMarkdownLink ? trimmed.slice(separator + 2, -1).trim() : trimmed;
  const url = canonicalPublicUrl(target);
  const doi = normalizeDoi(target) ?? normalizeDoi(extractDoi(label ?? trimmed));
  const dates = (label ?? trimmed).match(/\b(?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?/g);
  const publicationDate = normalizePublicationDate(dates?.at(-1) ?? null);
  return {
    label: label ? boundedText(label.replace(/\s*\.\s*$/, ""), MAX_TITLE_LENGTH) : null,
    url,
    doi,
    publicationDate,
  };
}

function extractDoi(value: string): string | null {
  return /10\.\d{4,9}\/[^\s\])}>"']+/i.exec(value)?.[0] ?? null;
}

function candidateItems(
  value: unknown,
  selectedJsonPointer: string | null,
  itemOffset: number,
): Array<{ value: unknown; jsonPointer: string }> {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      value: item,
      jsonPointer: appendPointer(selectedJsonPointer ?? "", itemOffset + index),
    }));
  }
  if (!isObject(value)) return [];
  for (const [key, candidate] of [
    ["/web/results", isObject(value.web) ? value.web.results : undefined],
    ["/results", value.results],
    ["/records", value.records],
    ["/items", value.items],
    ["/data", value.data],
  ] as const) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map((item, index) => ({
      value: item,
      jsonPointer: appendPointer(selectedJsonPointer ?? key, itemOffset + index),
    }));
  }
  if (looksLikeCandidate(value)) {
    return [{ value, jsonPointer: selectedJsonPointer ?? "" }];
  }
  return [];
}

function looksLikeCandidate(value: Record<string, unknown>): boolean {
  return ["title", "name", "headline", "url", "link", "href", "doi"].some(
    (key) => typeof value[key] === "string",
  );
}

function appendPointer(base: string, index: number): string {
  return `${base === "/" ? "" : base}/${index}` || `/${index}`;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function canonicalPublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key) || TRACKING_QUERY_KEY.test(key))
        url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, url.pathname === "/" && !url.search ? "" : "/");
  } catch {
    return null;
  }
}

function assertSafeNativeCandidateUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw evidenceLedgerError("Native discovery candidate URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw evidenceLedgerError(
      "Native discovery candidate URL must be public HTTPS without embedded credentials.",
    );
  }
  if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
    throw evidenceLedgerError("Native discovery candidate URL contains a sensitive parameter.");
  }
}

function normalizeDoi(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return /^10\.\d{4,9}\/[\S]+$/i.test(normalized) ? normalized : null;
}

function normalizePublicationDate(value: string | null): string | null {
  if (!value) return null;
  const exact = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value.trim());
  if (!exact) return null;
  const candidate = exact[3]
    ? `${exact[1]}-${exact[2]}-${exact[3]}`
    : exact[2]
      ? `${exact[1]}-${exact[2]}`
      : exact[1]!;
  if (candidate.length === 10) {
    const timestamp = Date.parse(`${candidate}T00:00:00.000Z`);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== candidate
    ) {
      return null;
    }
  }
  return candidate;
}

function boundedText(value: string, maxLength: number): string {
  const sanitized = sanitizeResearchText(value).replace(/\s+/g, " ").trim();
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}

function parseCandidate(value: unknown): EvidenceCandidate {
  if (!isObject(value)) throw evidenceLedgerError("Candidate event is malformed.");
  const origin = parseOrigin(value.origin);
  const occurrences = Array.isArray(value.occurrences)
    ? value.occurrences.map(parseOrigin)
    : [origin];
  if (
    typeof value.id !== "string" ||
    !IDENTIFIER.test(value.id) ||
    typeof value.canonicalKeySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.canonicalKeySha256) ||
    typeof value.title !== "string" ||
    (value.url !== null && typeof value.url !== "string") ||
    (value.doi !== null && typeof value.doi !== "string") ||
    (value.publicationDate !== null && typeof value.publicationDate !== "string") ||
    (value.excerpt !== null && typeof value.excerpt !== "string") ||
    typeof value.discoveredAt !== "string" ||
    !Number.isFinite(Date.parse(value.discoveredAt))
  ) {
    throw evidenceLedgerError("Candidate event has invalid fields.");
  }
  return {
    id: value.id,
    canonicalKeySha256: value.canonicalKeySha256,
    title: value.title,
    url: value.url as string | null,
    doi: value.doi as string | null,
    publicationDate: value.publicationDate as string | null,
    excerpt: value.excerpt as string | null,
    discoveredAt: value.discoveredAt,
    origin,
    occurrences,
  };
}

function parseOrigin(value: unknown): EvidenceCandidateOrigin {
  if (
    !isObject(value) ||
    !["broker", "data", "input", "native"].includes(String(value.kind)) ||
    (value.receiptId !== null && typeof value.receiptId !== "string") ||
    (value.inputId !== null && typeof value.inputId !== "string") ||
    (value.capabilityId !== null && typeof value.capabilityId !== "string") ||
    (value.locator !== null && typeof value.locator !== "string") ||
    (value.jsonPointer !== null && typeof value.jsonPointer !== "string") ||
    typeof value.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(value.retrievedAt))
  ) {
    throw evidenceLedgerError("Candidate origin is malformed.");
  }
  return value as unknown as EvidenceCandidateOrigin;
}

function assertProjectId(projectId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId)) {
    throw evidenceLedgerError("Evidence ledger project ID is invalid.");
  }
}

function evidenceLedgerError(error: unknown): CliError {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? sanitizeResearchText(error.message)
        : "Evidence ledger is invalid.";
  return new CliError(message, {
    code: "RESEARCH_EVIDENCE_LEDGER_INVALID",
    exitCode: 3,
  });
}

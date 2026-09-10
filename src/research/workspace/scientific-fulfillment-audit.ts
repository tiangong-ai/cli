import {
  validateScientificAmendmentRecord,
  scientificAmendmentImpact,
  projectScientificAmendments,
  type ScientificAmendmentRecord,
} from "./scientific-amendment.js";
import type { ScientificFulfillmentRecord } from "./scientific-fulfillment.js";
import { readFile } from "node:fs/promises";
import { parseAtomRecord } from "./content-evidence.js";
import { CliError } from "../../errors.js";
import { parseScientificDesign, type ScientificDesignContract } from "./scientific-design.js";
import {
  applyScientificFulfillmentRecord,
  validateScientificFulfillmentRecord,
} from "./scientific-fulfillment.js";
import { canonicalJson, isObject, resolveContained, sha256Text } from "./storage.js";
import type { JournalEvent, OutputRecord, ProjectState } from "./types.js";

export interface ScientificAuditHistory {
  project: ProjectState;
  base: ScientificDesignContract;
  fulfillments: Array<{ sequence: number; record: ScientificFulfillmentRecord }>;
  amendments: Array<{ sequence: number; record: ScientificAmendmentRecord }>;
  amendmentImpact: ReturnType<typeof scientificAmendmentImpact>;
}
/** Reconstruct only already verified declarations committed before one event. */
export function scientificAuditViewBefore(history: ScientificAuditHistory, sequence: number) {
  const records = history.fulfillments
    .filter((item) => item.sequence < sequence)
    .map((item) => item.record);
  const amendments = history.amendments
    .filter((item) => item.sequence < sequence)
    .map((item) => item.record);
  const view = projectScientificAmendments(
    history.base,
    history.project.scientificDesign!.designSha256,
    records,
    amendments,
  );
  for (const record of records) applyScientificFulfillmentRecord(view, record);
  return view;
}

/** A portable integrity check, not certification of authorship, scientific truth or execution. */
export async function verifyScientificFulfillmentAudit(
  bundle: string,
  projectId: string,
  files: OutputRecord[],
): Promise<ScientificAuditHistory | undefined> {
  const indexed = new Map(files.map((file) => [file.path, file]));
  const cache = new Map<string, unknown>();
  const read = async <T>(path: string): Promise<T> => {
    if (!cache.has(path)) {
      const expected = indexed.get(path);
      if (!expected || expected.bytes > 16 * 1024 * 1024) throw invalid();
      const text = await readFile(resolveContained(bundle, path), "utf8");
      if (sha256Text(text) !== expected.sha256 || Buffer.byteLength(text) !== expected.bytes)
        throw invalid();
      try {
        cache.set(path, JSON.parse(text));
      } catch {
        throw invalid();
      }
    }
    return cache.get(path) as T;
  };
  const project = await read<ProjectState>("state/project.json");
  const proof = await read<{
    events: Array<
      Pick<JournalEvent, "scope" | "type" | "payload" | "sequence" | "timestamp"> & {
        sourcePayloadSha256: string;
        sourcePreviousHash: string;
        sourceEventHash: string;
      }
    >;
  }>("state/journal-event-proofs.json");
  if (project.id !== projectId || !Array.isArray(proof.events)) throw invalid();
  const events = proof.events.filter(
    (event) => event.scope === projectId && event.type === "scientific.fulfillment.recorded",
  );
  const binding = project.scientificDesign;
  const amendmentEvents = proof.events.filter(
    (event) => event.scope === projectId && event.type === "scientific.amendment.recorded",
  );
  if (!binding) {
    if (events.length || amendmentEvents.length) throw invalid();
    return;
  }
  if (
    (binding.fulfillmentSha256 ?? null) !== (events.at(-1)?.payload.recordSha256 ?? null) ||
    (binding.amendmentSha256 ?? null) !== (amendmentEvents.at(-1)?.payload.recordSha256 ?? null)
  )
    throw invalid();
  for (const event of [...events, ...amendmentEvents]) {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 ||
      event.sourcePayloadSha256 !== sha256Text(canonicalJson(event.payload)) ||
      event.sourceEventHash !==
        sha256Text(
          canonicalJson({
            schemaVersion: 1,
            sequence: event.sequence,
            timestamp: event.timestamp,
            type: event.type,
            scope: event.scope,
            payload: event.payload,
            previousHash: event.sourcePreviousHash,
          }),
        )
    )
      throw invalid();
  }
  const basePath = `project/scientific/design/objects/${binding.designSha256}.json`;
  if (indexed.get(basePath)?.sha256 !== binding.designSha256) throw invalid();
  const base = parseScientificDesign(await read(basePath));
  if (base.projectId !== projectId) throw invalid();
  const effective = structuredClone(base);
  const fulfillmentRecords: ScientificFulfillmentRecord[] = [];
  let parent: string | null = null;
  const seen = new Set<string>();
  for (const event of events) {
    if (event.sourcePayloadSha256 !== sha256Text(canonicalJson(event.payload))) throw invalid();
    const hash = String(event.payload.recordSha256);
    if (seen.has(hash) || !/^[a-f0-9]{64}$/.test(hash)) throw invalid();
    seen.add(hash);
    const record = validateScientificFulfillmentRecord(
      await read(`project/scientific/fulfillments/${hash}.json`),
      projectId,
      hash,
    );
    if (
      record.designSha256 !== binding.designSha256 ||
      record.parentFulfillmentSha256 !== parent ||
      event.payload.parentFulfillmentSha256 !== parent ||
      record.requestSha256 !== event.payload.requestSha256
    )
      throw invalid();
    for (const [kind, items] of [
      ["model-implementation", record.modelImplementations],
      ["environment-lock", record.environmentLocks],
    ] as const) {
      for (const item of items) {
        const locator = `lineage/objects/${item.sha256}/${kind}.json`;
        const metadata = await read<Record<string, unknown>>(`workspace-objects/${locator}`);
        const { recordSha256, ...core } = metadata;
        const bytes = indexed.get(`workspace-objects/${item.objectLocator}`);
        if (
          metadata.kind !== "tiangong-scientific-object" ||
          metadata.schemaVersion !== 1 ||
          metadata.objectKind !== kind ||
          metadata.sha256 !== item.sha256 ||
          metadata.objectLocator !== item.objectLocator ||
          metadata.recordLocator !== locator ||
          metadata.hashBasis !== "raw-file-bytes" ||
          recordSha256 !== item.recordSha256 ||
          recordSha256 !== sha256Text(canonicalJson(core)) ||
          bytes?.sha256 !== item.sha256 ||
          bytes.bytes !== metadata.bytes
        )
          throw invalid();
      }
    }
    if (record.parameterStates.length) {
      const content = await read<{ snapshotSha256: string; atoms: Array<Record<string, unknown>> }>(
        "project/outputs/content-snapshot.json",
      );
      const { snapshotSha256, ...core } = content;
      if (snapshotSha256 !== sha256Text(canonicalJson(core)) || !Array.isArray(content.atoms))
        throw invalid();
      const atoms = new Map(content.atoms.map((atom) => [String(atom.atomId), atom]));
      for (const parameter of record.parameterStates) {
        const declared = base.uncertaintyParameters.find(
          (item) => item.id === parameter.parameterId,
        );
        for (const state of parameter.states)
          for (const reference of state.atoms) {
            const atom = atoms.get(reference.id);
            if (
              !atom ||
              atom.atomSha256 !== reference.sha256 ||
              !Array.isArray(atom.evidenceRoleIds) ||
              !atom.evidenceRoleIds.some((role) =>
                declared?.sourceEvidenceRoleIds.includes(String(role)),
              )
            )
              throw invalid();
            try {
              parseAtomRecord(atom);
            } catch {
              throw invalid();
            }
          }
      }
    }
    fulfillmentRecords.push(record);
    applyScientificFulfillmentRecord(effective, record);
    parent = hash;
  }
  const amendments: ScientificAmendmentRecord[] = [];
  for (const event of amendmentEvents) {
    if (event.sourcePayloadSha256 !== sha256Text(canonicalJson(event.payload))) throw invalid();
    const hash = String(event.payload.recordSha256);
    const record = validateScientificAmendmentRecord(
      await read(`project/scientific/amendments/${hash}.json`),
      projectId,
      hash,
    );
    if (
      event.payload.planSha256 !== record.plan.planSha256 ||
      event.payload.parentAmendmentSha256 !== record.plan.parentAmendmentSha256 ||
      !isObject(event.payload.mutation) ||
      event.payload.mutation.requestSha256 !== hash
    )
      throw invalid();
    const sourcePath = `project/scientific/authorization/${record.amendmentAuthorization.sourceSha256}.txt`;
    const source = indexed.get(sourcePath);
    if (
      source?.sha256 !== record.amendmentAuthorization.sourceSha256 ||
      source.bytes !== record.amendmentAuthorization.sourceBytes
    )
      throw invalid();
    const sourceBytes = await readFile(resolveContained(bundle, sourcePath));
    if (
      sourceBytes.length !== source.bytes ||
      sha256Text(sourceBytes.toString("utf8")) !== source.sha256
    )
      throw invalid();
    const designPath = `project/scientific/design/objects/${record.design.sha256}.json`;
    if (indexed.get(designPath)?.sha256 !== record.design.sha256) throw invalid();
    await read(designPath);
    amendments.push(record);
  }
  const amendedBase = projectScientificAmendments(
    base,
    binding.designSha256,
    fulfillmentRecords,
    amendments,
  );
  // Current prepared/passed gate packets must bind their deadline-specific view.
  for (const role of ["research-design", "evidence-construct", "pilot-methods"] as const) {
    const gate = binding.gates[role];
    if (!gate.packetSha256) continue;
    const packet = await read<Record<string, unknown>>(
      `project/scientific/review-packets/${role}/${gate.packetSha256}.json`,
    );
    const { packetSha256, ...packetCore } = packet;
    if (
      packetSha256 !== gate.packetSha256 ||
      sha256Text(canonicalJson(packetCore)) !== packetSha256 ||
      !isObject(packet.design)
    )
      throw invalid();
    if ((packet.design.amendmentSha256 ?? null) !== (binding.amendmentSha256 ?? null))
      throw invalid();
    const view = structuredClone(amendedBase);
    for (const event of events)
      applyScientificFulfillmentRecord(
        view,
        validateScientificFulfillmentRecord(
          await read(`project/scientific/fulfillments/${event.payload.recordSha256}.json`),
          projectId,
          String(event.payload.recordSha256),
        ),
        role,
      );
    const packetView = packet.design.fulfillment;
    if (isObject(packetView)) {
      if (
        packetView.effectiveSha256 !== sha256Text(canonicalJson(view)) ||
        (packetView.headSha256 !== null && !seen.has(String(packetView.headSha256)))
      )
        throw invalid();
    } else if (canonicalJson(view) !== canonicalJson(base)) throw invalid();
  }
  return {
    project,
    base,
    fulfillments: fulfillmentRecords.map((record, index) => ({
      record,
      sequence: events[index]!.sequence,
    })),
    amendments: amendments.map((record, index) => ({
      record,
      sequence: amendmentEvents[index]!.sequence,
    })),
    amendmentImpact: scientificAmendmentImpact(amendments, base),
  };
}
function invalid() {
  return new CliError(
    "Scientific design history, fulfillment, amendment authorization or source objects are inconsistent.",
    { code: "RESEARCH_AUDIT_BUNDLE_INVALID", exitCode: 3 },
  );
}

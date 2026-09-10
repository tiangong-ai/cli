import { readFile } from "node:fs/promises";
import { CliError } from "../../errors.js";
import { loadInvestigation, type InvestigationDefinition } from "./investigation.js";
import {
  investigationAttemptHistory,
  parseInvestigationDiagnostic,
} from "./investigation-attempt.js";
import {
  loadInvestigationCandidates,
  type InvestigationCandidate,
} from "./investigation-candidate.js";
import {
  loadInvestigationPromotion,
  type InvestigationPromotion,
} from "./investigation-promotion.js";
import { assertInvestigationBlob, type InvestigationReadStore } from "./investigation-store.js";
import type { NativeRunRecord } from "./native-run.js";
import { canonicalJson, resolveContained, sha256Text } from "./storage.js";
import { validateTaskObject } from "./task-contract.js";
import type { JournalEvent, OutputRecord } from "./types.js";

export type InvestigationProofEvent = Pick<
  JournalEvent,
  "scope" | "type" | "payload" | "sequence" | "timestamp"
> & { sourcePayloadSha256: string; sourcePreviousHash: string; sourceEventHash: string };
export interface InvestigationAuditSummary {
  definitions: number;
  attempts: number;
  candidates: number;
  promotions: number;
  certifications: number;
}
const HASH = /^[a-f0-9]{64}$/;
function invalid(message: string) {
  return new CliError(message, { code: "RESEARCH_AUDIT_BUNDLE_INVALID", exitCode: 3 });
}
export async function loadInvestigationAudit(
  bundle: string,
  projectId: string,
  files: OutputRecord[],
  proofs: InvestigationProofEvent[],
) {
  if (
    !proofs.some(
      (e) =>
        e.type.startsWith("investigation.") ||
        (e.type === "project.task.run.started" && e.payload.investigationPromotionSha256),
    )
  )
    return null;
  const relevant = proofs.filter(
    (e) => e.type.startsWith("investigation.") || e.type.startsWith("project.task.run."),
  );
  const indexed = new Map(files.map((f) => [f.path, f]));
  const decoded = new Map<string, unknown>();
  const prefix = (id: string) => {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id))
      throw invalid("Investigation audit project address is invalid.");
    return id === projectId ? "project" : `investigation-sources/${id}`;
  };
  const store: InvestigationReadStore = {
    readTask: async <T>(id: string, group: string, hash: string, field: string) => {
      if (
        !/^investigation(?:s|-starts|-attempts|-candidates|-promotions)$/.test(group) ||
        !HASH.test(hash)
      )
        throw invalid("Investigation audit object address is invalid.");
      const path = `${prefix(id)}/task/${group}/${hash}.json`,
        expected = indexed.get(path);
      if (!expected || expected.bytes > 16 * 1024 * 1024)
        throw invalid("Investigation audit is missing a referenced immutable record.");
      if (!decoded.has(path)) {
        const text = await readFile(resolveContained(bundle, path), "utf8");
        if (Buffer.byteLength(text) !== expected.bytes || sha256Text(text) !== expected.sha256)
          throw invalid("Investigation audit record bytes changed.");
        decoded.set(path, JSON.parse(text));
      }
      return validateTaskObject<T>(decoded.get(path), hash, field);
    },
    verifyBlob: async (id, object) => {
      assertInvestigationBlob(object);
      const entry = indexed.get(`${prefix(id)}/${object.path}`);
      if (!entry || entry.sha256 !== object.sha256 || entry.bytes !== object.bytes)
        throw invalid(
          "Investigation audit is missing exact program, input, approval or result bytes.",
        );
    },
    readBlob: async (id, object, maxBytes) => {
      await store.verifyBlob(id, object);
      if (object.bytes > maxBytes)
        throw invalid("Investigation audit diagnostic exceeds its bounded read.");
      return readFile(resolveContained(bundle, `${prefix(id)}/${object.path}`));
    },
  };
  for (const proof of relevant) {
    if (
      !Number.isSafeInteger(proof.sequence) ||
      proof.sequence < 1 ||
      proof.sourcePayloadSha256 !== sha256Text(canonicalJson(proof.payload)) ||
      !HASH.test(proof.sourceEventHash) ||
      !HASH.test(proof.sourcePreviousHash)
    )
      throw invalid("Investigation journal proof is malformed or changed.");
    const unsigned = {
      schemaVersion: 1,
      sequence: proof.sequence,
      timestamp: proof.timestamp,
      type: proof.type,
      scope: proof.scope,
      payload: proof.payload,
      previousHash: proof.sourcePreviousHash,
    };
    if (sha256Text(canonicalJson(unsigned)) !== proof.sourceEventHash)
      throw invalid("Investigation journal proof no longer matches its source event.");
  }
  const events: JournalEvent[] = proofs.map((p) => ({
    schemaVersion: 1,
    sequence: p.sequence,
    timestamp: p.timestamp,
    type: p.type,
    scope: p.scope,
    payload: p.payload,
    previousHash: p.sourcePreviousHash,
    hash: p.sourceEventHash,
  }));
  const definitions = new Map<string, InvestigationDefinition>();
  const candidates = new Map<string, InvestigationCandidate>();
  let attemptCount = 0;
  for (const event of events) {
    if (event.type !== "investigation.approved") continue;
    const definition = await loadInvestigation(
      bundle,
      event.scope,
      String(event.payload.investigationId),
      events,
      store,
    );
    if (definitions.has(definition.recordSha256))
      throw invalid("Investigation audit contains duplicate approval authority.");
    definitions.set(definition.recordSha256, definition);
    const history = await investigationAttemptHistory(
      bundle,
      event.scope,
      definition,
      events,
      store,
    );
    attemptCount += history.length;
    for (const attempt of history)
      for (const input of attempt.start.inputs) await store.verifyBlob(event.scope, input);
    for (const candidate of await loadInvestigationCandidates(
      bundle,
      event.scope,
      definition,
      events,
      history,
      store,
    ))
      candidates.set(candidate.recordSha256, candidate);
  }
  const promotions = new Map<string, InvestigationPromotion>();
  for (const event of events) {
    if (event.type !== "investigation.promotion.approved") continue;
    const promotion = await loadInvestigationPromotion(
      bundle,
      event.scope,
      String(event.payload.recordSha256),
      events,
      store,
    );
    const plan = promotion.plan,
      definition = definitions.get(plan.definitionSha256),
      candidate = candidates.get(plan.candidateSha256);
    const selected = events.find(
      (e) =>
        e.type === "investigation.candidate.selected" &&
        e.scope === plan.sourceProjectId &&
        e.payload.recordSha256 === plan.candidateSha256,
    );
    if (
      !definition ||
      !candidate ||
      definition.projectId !== plan.sourceProjectId ||
      definition.investigationId !== plan.investigationId ||
      candidate.definitionSha256 !== definition.recordSha256 ||
      candidate.recipeSha256 !== plan.recipeSha256 ||
      canonicalJson(candidate.recipe) !== canonicalJson(plan.recipe) ||
      !selected ||
      selected.sequence >= event.sequence ||
      promotions.has(promotion.recordSha256)
    )
      throw invalid(
        "Investigation promotion does not bind its exact previously selected candidate and definition.",
      );
    if (
      plan.certification.maxRuns !== 1 ||
      !Number.isSafeInteger(plan.certification.maxRunSeconds) ||
      plan.certification.maxRunSeconds < 1 ||
      !Number.isFinite(plan.certification.maxCostUsd) ||
      plan.certification.maxCostUsd < 0
    )
      throw invalid("Investigation promotion has no finite one-run certification envelope.");
    promotions.set(promotion.recordSha256, promotion);
  }
  const usedPromotions = new Set<string>();
  for (const event of events) {
    if (event.type !== "project.task.run.started" || !event.payload.investigationPromotionSha256)
      continue;
    const hash = String(event.payload.investigationPromotionSha256),
      promotion = promotions.get(hash);
    const approved = events.find(
      (e) =>
        e.type === "investigation.promotion.approved" &&
        e.scope === event.scope &&
        e.payload.recordSha256 === hash,
    );
    if (
      !promotion ||
      promotion.projectId !== event.scope ||
      !approved ||
      approved.sequence >= event.sequence ||
      usedPromotions.has(hash) ||
      event.payload.requirementId !== promotion.plan.requirementId ||
      event.payload.requirementSha256 !== promotion.plan.requirementSha256 ||
      typeof event.payload.certificationReservedWallSeconds !== "number" ||
      event.payload.certificationReservedWallSeconds < 1 ||
      event.payload.certificationReservedWallSeconds > promotion.plan.certification.maxRunSeconds
    )
      throw invalid("Certification start exceeds or precedes its exact promotion authority.");
    usedPromotions.add(hash);
  }
  let certifications = 0;
  return {
    verifyRun: async (run: NativeRunRecord, started: InvestigationProofEvent) => {
      const cert = run.investigationCertification;
      if (started.payload.investigationPromotionSha256 !== cert?.promotionSha256)
        throw invalid("Native run lost or changed its promoted certification purpose.");
      if (!cert) return;
      const promotion = promotions.get(cert.promotionSha256),
        candidate = promotion ? candidates.get(promotion.plan.candidateSha256) : undefined;
      if (
        !promotion ||
        !candidate ||
        promotion.projectId !== run.projectId ||
        cert.candidateSha256 !== candidate.recordSha256 ||
        cert.recipeSha256 !== candidate.recipeSha256
      )
        throw invalid("Certification references an absent or foreign promoted candidate.");
      const recipe = candidate.recipe;
      if (
        run.requirementId !== promotion.plan.requirementId ||
        run.requirementSha256 !== promotion.plan.requirementSha256 ||
        run.script.sha256 !== recipe.script.sha256 ||
        run.environmentLock.sha256 !== recipe.environmentLock.sha256 ||
        run.runtime.binarySha256 !== recipe.runtime.binarySha256 ||
        run.runtime.kind !== recipe.runtime.kind ||
        canonicalJson(run.arguments) !== canonicalJson(recipe.arguments) ||
        canonicalJson(
          run.inputs.map((i) => ({ id: i.id, artifactId: i.artifactId, sha256: i.sha256 })),
        ) !==
          canonicalJson(
            recipe.inputs.map((i) => ({ id: i.id, artifactId: i.artifactId, sha256: i.sha256 })),
          ) ||
        canonicalJson(run.expectedOutputIds) !== canonicalJson(recipe.outputs.map((o) => o.id)) ||
        cert.actualCostUsd !== null ||
        cert.accountedCostUpperBoundUsd !== promotion.plan.certification.maxCostUsd ||
        !HASH.test(cert.effectiveDesignSha256) ||
        !["passed", "failed"].includes(cert.status)
      )
        throw invalid("Certification differs from its exact promoted execution recipe.");
      const output = run.outputs.find(
        (o) => o.id === recipe.diagnosticOutputId && o.mediaType === "application/json",
      );
      let diagnostic: ReturnType<typeof parseInvestigationDiagnostic> = null;
      if (output && output.bytes <= 65536) {
        try {
          diagnostic = parseInvestigationDiagnostic(
            JSON.parse((await store.readBlob(run.projectId, output, 65536)).toString("utf8")),
          );
        } catch {
          /* Invalid diagnostic cannot certify execution. */
        }
      }
      const missing = diagnostic?.solverReached
        ? [
            ...recipe.telemetry.requiredMetrics
              .filter((id) => !Object.hasOwn(diagnostic!.metrics, id))
              .map((id) => `metrics.${id}`),
            ...recipe.telemetry.requiredStatuses
              .filter((id) => !Object.hasOwn(diagnostic!.statuses, id))
              .map((id) => `statuses.${id}`),
          ].sort()
        : [];
      const expectedStatus =
        run.status === "succeeded" &&
        diagnostic?.solverReached &&
        diagnostic.feasible &&
        !missing.length
          ? "passed"
          : "failed";
      if (
        canonicalJson(cert.diagnostic) !== canonicalJson(diagnostic) ||
        canonicalJson(cert.missingTelemetry) !== canonicalJson(missing) ||
        cert.status !== expectedStatus ||
        !cert.isolation ||
        !cert.runtimeProbeIsolation ||
        !HASH.test(cert.isolation.policySha256) ||
        !HASH.test(cert.runtimeProbeIsolation.policySha256) ||
        !["sandbox-exec", "bubblewrap"].includes(cert.isolation.provider) ||
        cert.isolation.provider !== cert.runtimeProbeIsolation.provider
      )
        throw invalid("Certification diagnostic or isolation evidence is inconsistent.");
      if (
        cert.status === "passed" &&
        (run.runtime.version !== recipe.runtime.version ||
          cert.runtimeProbe.exitCode !== 0 ||
          cert.runtimeProbe.timedOut ||
          cert.runtimeProbe.cancelled)
      )
        throw invalid("Passed certification has no successful exact runtime probe.");
      certifications++;
    },
    report: (): InvestigationAuditSummary => ({
      definitions: definitions.size,
      attempts: attemptCount,
      candidates: candidates.size,
      promotions: promotions.size,
      certifications,
    }),
  };
}

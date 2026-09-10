import { CliError } from "../../errors.js";
import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import type { JournalEvent } from "./types.js";

function invalid() {
  return new CliError("Unresolved investigation time does not match its committed start.", {
    code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
    exitCode: 3,
  });
}
/** One pass over authoritative facts. A terminal event releases uncertainty,
 * while actual completed time remains in the recovered project usage. */
export async function investigationWallReservations(
  root: string,
  projectId: string,
  events: JournalEvent[],
  store: InvestigationReadStore = localInvestigationReadStore(root),
) {
  const attempts = new Map<string, JournalEvent>(),
    certifications = new Map<string, JournalEvent>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.scope !== projectId) continue;
    const attemptKey = `${String(event.payload.investigationId)}\0${String(event.payload.attemptId)}`;
    if (event.type === "investigation.attempt.started") {
      const key = `attempt/${attemptKey}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      attempts.set(attemptKey, event);
    } else if (event.type === "investigation.attempt.completed") {
      const start = attempts.get(attemptKey);
      if (!start || start.payload.recordSha256 !== event.payload.startSha256) throw invalid();
      attempts.delete(attemptKey);
    } else if (
      event.type === "project.task.run.started" &&
      event.payload.investigationPromotionSha256
    ) {
      const id = String(event.payload.runId),
        key = `certification/${id}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      certifications.set(id, event);
    } else if (event.type === "project.task.run.completed") {
      const id = String(event.payload.runId),
        start = certifications.get(id);
      if (start) {
        if (start.payload.requestSha256 !== event.payload.requestSha256) throw invalid();
        certifications.delete(id);
      }
    }
  }
  const reservations: Array<{
    kind: "investigation-attempt" | "certification";
    id: string;
    wallSeconds: number;
  }> = [];
  for (const event of attempts.values()) {
    const record = await store.readTask<{
      projectId: string;
      investigationId: string;
      attemptId: string;
      timeoutSeconds: number;
    }>(projectId, "investigation-starts", String(event.payload.recordSha256), "recordSha256");
    if (
      record.projectId !== projectId ||
      record.investigationId !== event.payload.investigationId ||
      record.attemptId !== event.payload.attemptId ||
      !Number.isSafeInteger(record.timeoutSeconds) ||
      record.timeoutSeconds < 1
    )
      throw invalid();
    reservations.push({
      kind: "investigation-attempt",
      id: `${record.investigationId}/${record.attemptId}`,
      wallSeconds: record.timeoutSeconds,
    });
  }
  for (const event of certifications.values()) {
    const seconds = event.payload.certificationReservedWallSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1)
      throw invalid();
    reservations.push({
      kind: "certification",
      id: String(event.payload.runId),
      wallSeconds: seconds,
    });
  }
  const wallSeconds = reservations.reduce((sum, item) => sum + item.wallSeconds, 0);
  if (!Number.isSafeInteger(wallSeconds)) throw invalid();
  return { wallSeconds, reservations };
}

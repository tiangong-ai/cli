import type { JournalEvent } from "./types.js";

export interface InvestigationSourceReference {
  projectId: string;
  investigationId: string;
}
/** Incoming dependencies only. Equal strings in unrelated payloads do not
 * grant that project's records authority over this export. */
export function relevantInvestigationEvents<
  T extends Pick<JournalEvent, "scope" | "type" | "payload">,
>(projectId: string, events: T[], sources: InvestigationSourceReference[]): T[] {
  const allowed = new Set(
    sources.map((source) => `${source.projectId}\0${source.investigationId}`),
  );
  return events.filter(
    (event) =>
      event.scope === projectId ||
      (event.type.startsWith("investigation.") &&
        !event.type.startsWith("investigation.promotion.") &&
        allowed.has(`${event.scope}\0${String(event.payload.investigationId)}`)),
  );
}

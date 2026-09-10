import { loadInvestigationClosure } from "./investigation-close.js";
import { join } from "node:path";
import { loadInvestigation } from "./investigation.js";
import { investigationAttemptHistory } from "./investigation-attempt.js";
import { loadInvestigationCandidates } from "./investigation-candidate.js";
import { loadInvestigationPromotion } from "./investigation-promotion.js";
import { localInvestigationReadStore } from "./investigation-store.js";
import type { InvestigationSourceReference } from "./investigation-lineage.js";
import { workspacePaths } from "./storage.js";
import type { JournalEvent, OutputRecord } from "./types.js";

/** Export only immutable incoming investigation dependencies named by this
 * project's committed promotion approvals. Local routing and other studies
 * never enter the source closure. */
export async function stageInvestigationSources(
  root: string,
  projectId: string,
  events: JournalEvent[],
  stageFile: (source: string, logical: string) => Promise<void>,
): Promise<InvestigationSourceReference[]> {
  const store = localInvestigationReadStore(root);
  const sources = new Map<string, InvestigationSourceReference>();
  for (const event of events) {
    if (event.scope !== projectId || event.type !== "investigation.promotion.approved") continue;
    const promotion = await loadInvestigationPromotion(
      root,
      projectId,
      String(event.payload.recordSha256),
      events,
      store,
    );
    if (promotion.plan.sourceProjectId === projectId) continue;
    const reference = {
      projectId: promotion.plan.sourceProjectId,
      investigationId: promotion.plan.investigationId,
    };
    sources.set(`${reference.projectId}\0${reference.investigationId}`, reference);
  }
  for (const source of sources.values()) {
    const definition = await loadInvestigation(
      root,
      source.projectId,
      source.investigationId,
      events,
      store,
    );
    const attempts = await investigationAttemptHistory(
      root,
      source.projectId,
      definition,
      events,
      store,
    );
    const candidates = await loadInvestigationCandidates(
      root,
      source.projectId,
      definition,
      events,
      attempts,
      store,
    );
    const prefix = `investigation-sources/${source.projectId}`;
    const stageRecord = (group: string, hash: string) => {
      const path = `task/${group}/${hash}.json`;
      return stageFile(
        join(workspacePaths(root).projects, source.projectId, path),
        `${prefix}/${path}`,
      );
    };
    const blobs = new Map<string, OutputRecord>();
    const collect = (object: OutputRecord) => blobs.set(object.path, object);
    await stageRecord("investigations", definition.recordSha256);
    const closure = await loadInvestigationClosure(
      root,
      source.projectId,
      definition,
      attempts,
      events,
      store,
    );
    if (closure) await stageRecord("investigation-closures", closure.recordSha256);
    collect(definition.scopeAuthorization.source);
    for (const program of definition.programs) {
      collect(program.script);
      collect(program.environmentLock);
    }
    for (const attempt of attempts) {
      await stageRecord("investigation-starts", attempt.start.recordSha256);
      for (const input of attempt.start.inputs) collect(input);
      if (attempt.record) {
        await stageRecord("investigation-attempts", attempt.record.recordSha256);
        for (const log of Object.values(attempt.record.logs)) collect(log);
        for (const output of attempt.record.outputs) collect(output);
      }
    }
    for (const candidate of candidates)
      await stageRecord("investigation-candidates", candidate.recordSha256);
    for (const object of blobs.values()) {
      await store.verifyBlob(source.projectId, object);
      await stageFile(
        join(workspacePaths(root).projects, source.projectId, object.path),
        `${prefix}/${object.path}`,
      );
    }
  }
  return [...sources.values()];
}

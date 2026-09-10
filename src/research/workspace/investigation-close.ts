import { Ajv2020 } from "ajv/dist/2020.js";
import { CliError } from "../../errors.js";
import { investigationAttemptHistory } from "./investigation-attempt.js";
import { loadInvestigationCandidates } from "./investigation-candidate.js";
import { loadInvestigation, type InvestigationDefinition } from "./investigation.js";
import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { settleProjectCost } from "./project-budget.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import { canonicalJson, sha256Text, workspacePaths } from "./storage.js";
import { writeTaskObject } from "./task-contract.js";
import type { JournalEvent } from "./types.js";
import { withWorkspaceLock } from "./workspace.js";
interface CloseInput {
  schemaVersion: 1;
  investigationId: string;
  reason: string;
}
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "investigationId", "reason"],
  properties: {
    schemaVersion: { const: 1 },
    investigationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    reason: { type: "string", minLength: 8, maxLength: 4000 },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile<CloseInput>(schema);
export function investigationCloseInputSchema() {
  return structuredClone(schema);
}
function invalid(message: string, code = "RESEARCH_INVESTIGATION_CLOSE_INVALID") {
  return new CliError(message, { code, exitCode: 3 });
}
export interface InvestigationClosure extends CloseInput {
  kind: "tiangong-investigation-closure";
  projectId: string;
  definitionSha256: string;
  candidateSha256: string | null;
  requestSha256: string;
  attemptSha256s: string[];
  attemptCostUpperBoundUsd: number;
  accountedCostUsd: number;
  releasedCostUpperBoundUsd: number;
  actualCostUsd: null;
  settlementBasis: "allocated-upper-bound" | "owner-estimate" | "reported-usage";
  closedAt: string;
  recordSha256: string;
}
type History = Awaited<ReturnType<typeof investigationAttemptHistory>>;
export async function loadInvestigationClosure(
  root: string,
  projectId: string,
  definition: InvestigationDefinition,
  history: History,
  events: JournalEvent[],
  store: InvestigationReadStore = localInvestigationReadStore(root),
) {
  const closed = events.filter(
    (e) =>
      e.scope === projectId &&
      e.type === "investigation.closed" &&
      e.payload.investigationId === definition.investigationId,
  );
  if (!closed.length) return null;
  if (closed.length !== 1) throw invalid("Investigation has duplicate closure authority.");
  const event = closed[0]!;
  const record = await store.readTask<InvestigationClosure>(
    projectId,
    "investigation-closures",
    String(event.payload.recordSha256),
    "recordSha256",
  );
  const input = {
    schemaVersion: record.schemaVersion,
    investigationId: record.investigationId,
    reason: record.reason,
  };
  const candidates = await loadInvestigationCandidates(
    root,
    projectId,
    definition,
    events,
    history,
    store,
  );
  const spent = history.reduce((sum, a) => sum + a.start.maxCostUsd, 0);
  if (
    !validate(input) ||
    record.kind !== "tiangong-investigation-closure" ||
    record.projectId !== projectId ||
    record.investigationId !== definition.investigationId ||
    record.definitionSha256 !== definition.recordSha256 ||
    record.requestSha256 !== sha256Text(canonicalJson(input)) ||
    record.candidateSha256 !== (candidates.at(-1)?.recordSha256 ?? null) ||
    history.some((a) => !a.record) ||
    canonicalJson(record.attemptSha256s) !==
      canonicalJson(history.map((a) => a.record!.recordSha256)) ||
    !Number.isFinite(record.attemptCostUpperBoundUsd) ||
    record.attemptCostUpperBoundUsd < 0 ||
    Math.abs(record.attemptCostUpperBoundUsd - spent) > 1e-9 ||
    !["allocated-upper-bound", "owner-estimate", "reported-usage"].includes(
      record.settlementBasis,
    ) ||
    (record.settlementBasis === "allocated-upper-bound" &&
      Math.abs(record.accountedCostUsd - spent) > 1e-9) ||
    !Number.isFinite(record.releasedCostUpperBoundUsd) ||
    record.releasedCostUpperBoundUsd < 0 ||
    !Number.isFinite(record.accountedCostUsd) ||
    record.accountedCostUsd < 0 ||
    record.actualCostUsd !== null ||
    Math.abs(
      record.releasedCostUpperBoundUsd -
        Math.max(0, definition.plan.limits.maxCostUsd - record.accountedCostUsd),
    ) > 1e-9 ||
    events.some(
      (e) =>
        e.scope === projectId &&
        e.payload.investigationId === definition.investigationId &&
        [
          "investigation.attempt.started",
          "investigation.attempt.completed",
          "investigation.candidate.selected",
        ].includes(e.type) &&
        e.sequence >= event.sequence,
    )
  )
    throw invalid("Investigation closure does not match its complete immutable history.");
  return record;
}
export async function closeInvestigation(root: string, projectId: string, value: unknown) {
  if (
    !validate(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw invalid("Close with a bounded non-secret reason and exact investigation ID.");
  const input = value,
    requestSha256 = sha256Text(canonicalJson(input));
  return withWorkspaceLock(root, "research.investigation.close", async () => {
    const project = await loadProject(root, projectId),
      events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const definition = await loadInvestigation(root, projectId, input.investigationId, events);
    const history = await investigationAttemptHistory(root, projectId, definition, events);
    const known = await loadInvestigationClosure(root, projectId, definition, history, events);
    if (known) {
      if (known.requestSha256 !== requestSha256)
        throw invalid("The closed investigation already binds a different final reason.");
      return known;
    }
    if (history.some((a) => !a.record))
      throw invalid(
        "An unresolved attempt keeps its reservation. Inspect it before closing; no resource estimate was erased.",
        "RESEARCH_INVESTIGATION_INCOMPLETE",
      );
    const candidates = await loadInvestigationCandidates(
      root,
      projectId,
      definition,
      events,
      history,
    );
    const allocation = project.budget?.entries.find(
      (e) => e.id === `investigation-${definition.recordSha256}`,
    );
    if (!allocation) throw invalid("Investigation has no project allocation to settle.");
    const spent = history.reduce((sum, a) => sum + a.start.maxCostUsd, 0);
    const accounted = allocation.status === "reserved" ? spent : allocation.accountedCostUsd!;
    if (
      !Number.isFinite(accounted) ||
      accounted < 0 ||
      spent > definition.plan.limits.maxCostUsd + 1e-9
    )
      throw invalid("Investigation resource accounting is inconsistent.");
    const core = {
      ...input,
      kind: "tiangong-investigation-closure" as const,
      projectId,
      definitionSha256: definition.recordSha256,
      candidateSha256: candidates.at(-1)?.recordSha256 ?? null,
      requestSha256,
      attemptSha256s: history.map((a) => a.record!.recordSha256),
      attemptCostUpperBoundUsd: spent,
      accountedCostUsd: accounted,
      releasedCostUpperBoundUsd: Math.max(0, definition.plan.limits.maxCostUsd - accounted),
      actualCostUsd: null,
      settlementBasis:
        allocation.status === "reserved"
          ? ("allocated-upper-bound" as const)
          : allocation.settlementBasis!,
      closedAt: new Date().toISOString(),
    };
    const record: InvestigationClosure = { ...core, recordSha256: sha256Text(canonicalJson(core)) };
    await writeTaskObject(root, projectId, "investigation-closures", record.recordSha256, record);
    let mutation = await beginProjectMutation(
      root,
      "investigation-closure",
      project,
      record.recordSha256,
    );
    try {
      if (allocation.status === "reserved")
        settleProjectCost(project, allocation.id, spent, "allocated-upper-bound");
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(workspacePaths(root).journal, "investigation.closed", projectId, {
        projectId,
        investigationId: input.investigationId,
        recordSha256: record.recordSha256,
        mutation: projectMutationBinding(mutation),
      });
      await settleProjectMutation(root, mutation);
    } catch (error) {
      await settleProjectMutation(root, mutation);
      throw error;
    }
    return record;
  });
}

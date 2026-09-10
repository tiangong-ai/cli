import { localInvestigationReadStore, type InvestigationReadStore } from "./investigation-store.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CliError } from "../../errors.js";
import { loadInvestigation, type InvestigationDefinition } from "./investigation.js";
import {
  assertInvestigationCurrent,
  investigationAttemptHistory,
} from "./investigation-attempt.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import { canonicalJson, sha256Text, workspacePaths } from "./storage.js";
import { writeTaskObject } from "./task-contract.js";
import type { JournalEvent } from "./types.js";
import { withWorkspaceLock } from "./workspace.js";

interface SelectionInput {
  schemaVersion: 1;
  selectionId: string;
  investigationId: string;
  attemptId: string;
  reason: string;
}
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" };
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "selectionId", "investigationId", "attemptId", "reason"],
  properties: {
    schemaVersion: { const: 1 },
    selectionId: id,
    investigationId: id,
    attemptId: id,
    reason: { type: "string", minLength: 8, maxLength: 4000 },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile<SelectionInput>(schema);
export function investigationCandidateInputSchema() {
  return structuredClone(schema);
}
function failure(message: string) {
  return new CliError(message, { code: "RESEARCH_INVESTIGATION_CANDIDATE_INVALID", exitCode: 3 });
}
type AttemptHistory = Awaited<ReturnType<typeof investigationAttemptHistory>>;
function recipeFor(definition: InvestigationDefinition, attempt: AttemptHistory[number]) {
  const run = attempt.record;
  const program = definition.plan.programs.find((p) => p.id === run?.programId);
  const files = definition.programs.find((p) => p.id === run?.programId);
  if (
    !run ||
    !program ||
    !files ||
    ["stale", "inputs-changed"].includes(run.outcome) ||
    run.runtime.binarySha256 !== program.runtime.binarySha256 ||
    run.runtime.kind !== program.runtime.kind ||
    !(run.runtime.kind === "node" ? /^v\d+\.\d+\.\d+$/u : /^Python \d+\.\d+\.\d+$/u).test(
      run.runtime.version,
    )
  )
    throw failure(
      "Select one committed, stable diagnostic attempt with its observed runtime identity.",
    );
  return {
    programId: program.id,
    runtime: run.runtime,
    script: files.script,
    environmentLock: files.environmentLock,
    inputs: attempt.start.inputs,
    configuration: run.configuration,
    arguments: program.arguments.map((arg) =>
      arg.replace(/\{option:([^}]+)\}/gu, (_match, key: string) => String(run.configuration[key])),
    ),
    outputs: program.outputs,
    diagnosticOutputId: program.diagnosticOutputId,
    telemetry: program.telemetry,
  };
}
export interface InvestigationCandidate extends SelectionInput {
  kind: "tiangong-investigation-candidate";
  projectId: string;
  definitionSha256: string;
  attemptSha256: string;
  parentCandidateSha256: string | null;
  requestSha256: string;
  recipe: ReturnType<typeof recipeFor>;
  recipeSha256: string;
  purpose: "diagnostic-candidate-only";
  selectedAt: string;
  recordSha256: string;
}
export async function loadInvestigationCandidates(
  root: string,
  projectId: string,
  definition: InvestigationDefinition,
  events: JournalEvent[],
  attempts: AttemptHistory,
  store: InvestigationReadStore = localInvestigationReadStore(root),
) {
  const selected = events.filter(
    (e) =>
      e.scope === projectId &&
      e.type === "investigation.candidate.selected" &&
      e.payload.investigationId === definition.investigationId,
  );
  const records: InvestigationCandidate[] = [];
  const ids = new Set<string>();
  for (const event of selected) {
    const record = await store.readTask<InvestigationCandidate>(
      projectId,
      "investigation-candidates",
      String(event.payload.recordSha256),
      "recordSha256",
    );
    const input = {
      schemaVersion: record.schemaVersion,
      selectionId: record.selectionId,
      investigationId: record.investigationId,
      attemptId: record.attemptId,
      reason: record.reason,
    };
    const attempt = attempts.find(
      (a) =>
        a.record?.recordSha256 === record.attemptSha256 && a.start.attemptId === record.attemptId,
    );
    const completed = events.find(
      (e) =>
        e.scope === projectId &&
        e.type === "investigation.attempt.completed" &&
        e.payload.recordSha256 === record.attemptSha256,
    );
    if (
      !validate(input) ||
      !attempt ||
      !completed ||
      completed.sequence >= event.sequence ||
      record.kind !== "tiangong-investigation-candidate" ||
      record.projectId !== projectId ||
      record.investigationId !== definition.investigationId ||
      record.definitionSha256 !== definition.recordSha256 ||
      record.parentCandidateSha256 !== (records.at(-1)?.recordSha256 ?? null) ||
      ids.has(record.selectionId) ||
      record.selectionId !== event.payload.selectionId ||
      record.attemptSha256 !== event.payload.attemptSha256 ||
      record.recipeSha256 !== event.payload.recipeSha256 ||
      record.purpose !== "diagnostic-candidate-only" ||
      record.requestSha256 !== sha256Text(canonicalJson(input))
    )
      throw failure("Candidate selection does not match its committed investigation history.");
    const recipe = recipeFor(definition, attempt);
    if (
      canonicalJson(recipe) !== canonicalJson(record.recipe) ||
      sha256Text(canonicalJson(recipe)) !== record.recipeSha256
    )
      throw failure("Candidate recipe differs from the exact observed attempt.");
    ids.add(record.selectionId);
    records.push(record);
  }
  return records;
}
export async function selectInvestigationCandidate(
  root: string,
  projectId: string,
  value: unknown,
) {
  if (
    !validate(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw failure("Candidate selection must match the closed non-secret schema.");
  const input = value;
  const requestSha256 = sha256Text(canonicalJson(input));
  return withWorkspaceLock(root, "research.investigation.select", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    const definition = await loadInvestigation(root, projectId, input.investigationId, events);
    const attempts = await investigationAttemptHistory(root, projectId, definition, events);
    const candidates = await loadInvestigationCandidates(
      root,
      projectId,
      definition,
      events,
      attempts,
    );
    const known = candidates.find((c) => c.selectionId === input.selectionId);
    if (known) {
      if (known.requestSha256 !== requestSha256)
        throw failure("Selection ID already belongs to another exact request.");
      return known;
    }
    await assertInvestigationCurrent(root, project, definition, events);
    if (attempts.some((a) => !a.record))
      throw failure("Resolve the unfinished attempt before choosing a candidate.");
    const attempt = attempts.find((a) => a.start.attemptId === input.attemptId);
    if (!attempt?.record) throw failure("Candidate selection needs an exact committed attempt.");
    const recipe = recipeFor(definition, attempt);
    const core = {
      ...input,
      kind: "tiangong-investigation-candidate" as const,
      projectId,
      definitionSha256: definition.recordSha256,
      attemptSha256: attempt.record.recordSha256,
      parentCandidateSha256: candidates.at(-1)?.recordSha256 ?? null,
      requestSha256,
      recipe,
      recipeSha256: sha256Text(canonicalJson(recipe)),
      purpose: "diagnostic-candidate-only" as const,
      selectedAt: new Date().toISOString(),
    };
    const record: InvestigationCandidate = {
      ...core,
      recordSha256: sha256Text(canonicalJson(core)),
    };
    await writeTaskObject(root, projectId, "investigation-candidates", record.recordSha256, record);
    await appendJournalEvent(
      workspacePaths(root).journal,
      "investigation.candidate.selected",
      projectId,
      {
        investigationId: input.investigationId,
        selectionId: input.selectionId,
        recordSha256: record.recordSha256,
        attemptSha256: record.attemptSha256,
        recipeSha256: record.recipeSha256,
      },
    );
    return record;
  });
}

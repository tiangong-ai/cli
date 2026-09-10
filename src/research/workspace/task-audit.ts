import {
  loadInvestigationAudit,
  type InvestigationProofEvent,
  type InvestigationAuditSummary,
} from "./investigation-audit.js";
import { investigatedRequirementHashes } from "./investigation-requirements.js";
import {
  requirementAmendmentBinding,
  type ScientificAmendmentImpact,
} from "./scientific-amendment.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { unrecordedRequestProvenance } from "./request-provenance.js";
import { validateNativeRunRecord, type NativeRunRecord } from "./native-run.js";
import {
  compileTaskAcceptanceContext,
  taskRecordStatus,
  taskRequirementRows,
  validateTaskAcceptanceRecord,
  validateTaskReview,
  type ReferenceView,
  type TaskAcceptanceContext,
  type TaskAcceptanceRecord,
} from "./task-acceptance.js";
import {
  latestTaskBinding,
  loadTaskHistory,
  taskRequirementSha256,
  validateTaskObject,
  type TaskObjectReader,
} from "./task-contract.js";
import {
  canonicalJson,
  isObject,
  resolveContained,
  sha256Text,
  writeJsonAtomic,
} from "./storage.js";
import type { OutputRecord, ProjectState } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
export interface TaskAuditBinding {
  contractSha256: string;
  originalContractSha256: string;
  contextSha256: string;
}
type ProofEvent = InvestigationProofEvent;

/** Derived export view, not a second mutable task state. */
export async function writeTaskAuditContext(
  root: string,
  project: ProjectState,
  destination: string,
): Promise<TaskAuditBinding | undefined> {
  const context = await compileTaskAcceptanceContext(root, project);
  if (!context) return undefined;
  await writeJsonAtomic(join(destination, "state/task-acceptance.json"), context, 0o444);
  return {
    contractSha256: context.contractSha256,
    originalContractSha256: context.originalContractSha256,
    contextSha256: context.contextSha256,
  };
}

/** Verify new task relationships using only the bundle's already indexed exact files. */
export async function verifyTaskAudit(
  bundle: string,
  projectId: string,
  binding: TaskAuditBinding | undefined,
  files: Array<OutputRecord>,
  amendmentImpact?: ScientificAmendmentImpact,
): Promise<
  | (TaskAuditBinding & { executionCertified: false; investigations?: InvestigationAuditSummary })
  | undefined
> {
  const indexed = new Map(files.map((file) => [file.path, file]));
  const json = new Map<string, unknown>();
  const read = async <T>(path: string): Promise<T> => {
    if (!json.has(path)) {
      const expected = indexed.get(path);
      if (!expected || expected.bytes > 16 * 1024 * 1024)
        throw invalid("Task audit reference is missing or oversized.");
      const text = await readFile(resolveContained(bundle, path), "utf8");
      if (Buffer.byteLength(text) !== expected.bytes || sha256Text(text) !== expected.sha256)
        throw invalid("Task audit bytes changed during verification.");
      try {
        json.set(path, JSON.parse(text));
      } catch {
        throw invalid("Task audit object is not valid JSON.");
      }
    }
    return json.get(path) as T;
  };
  const proof = await read<{ events: ProofEvent[] }>("state/journal-event-proofs.json");
  if (!Array.isArray(proof.events)) throw invalid("Task audit requires its journal proof view.");
  const events = proof.events.filter((event) => event.scope === projectId);
  const investigations = await loadInvestigationAudit(bundle, projectId, files, proof.events);
  const currentBinding = latestTaskBinding(events, projectId);
  if (!currentBinding) {
    if (
      binding ||
      indexed.has("state/task-acceptance.json") ||
      events.some((event) => event.type.startsWith("project.task.run."))
    )
      throw invalid("Task audit has no committed task authority.");
    return undefined;
  }
  if (!binding || currentBinding.contractSha256 !== binding.contractSha256)
    throw invalid("Audit task binding does not match its committed task.");
  const objectReader: TaskObjectReader = async <T>(
    group: string,
    hash: string,
    hashField: string,
  ) => {
    if (
      ![
        "contracts",
        "proposals",
        "acceptance",
        "request-sources",
        "runs",
        "investigations",
        "investigation-promotions",
      ].includes(group) ||
      !HASH.test(hash)
    )
      throw invalid("Task audit object address is invalid.");
    return validateTaskObject<T>(await read(`project/task/${group}/${hash}.json`), hash, hashField);
  };
  const history = await loadTaskHistory(projectId, binding.contractSha256, objectReader);
  if (history.original.contractSha256 !== binding.originalContractSha256)
    throw invalid("Audit original requirement binding is inconsistent.");
  const project = await read<ProjectState>("state/project.json");
  if (project.id !== projectId || history.current.questionSha256 !== sha256Text(project.question))
    throw invalid("Audit task belongs to a different research question.");
  if (project.scientificDesign?.amendmentSha256 && !amendmentImpact)
    throw invalid("Amended task acceptance requires verified design history.");
  const context = validateTaskObject<TaskAcceptanceContext>(
    await read("state/task-acceptance.json"),
    binding.contextSha256,
    "contextSha256",
  );
  if (
    context.schemaVersion !== 1 ||
    context.projectId !== projectId ||
    context.contractSha256 !== binding.contractSha256 ||
    context.originalContractSha256 !== binding.originalContractSha256 ||
    context.originalRequest !== history.original.originalRequest ||
    canonicalJson(context.requestProvenance) !==
      canonicalJson(history.original.requestProvenance ?? unrecordedRequestProvenance()) ||
    !Array.isArray(context.requirements) ||
    !Array.isArray(context.results)
  )
    throw invalid("Audit task view has inconsistent identity.");
  const contracts = new Map(
    history.contracts.map((contract) => [contract.contractSha256, contract]),
  );
  const latest = new Map<string, TaskAcceptanceRecord>();
  const runStarts = new Map<string, ProofEvent>();
  const nativeRuns = new Map<string, NativeRunRecord>();
  let activeContract: string | null = null;
  for (const event of events) {
    const isTaskAuthority = latestTaskBinding([event], projectId);
    if (event.type.startsWith("project.task.") || isTaskAuthority) {
      if (event.sourcePayloadSha256 !== sha256Text(canonicalJson(event.payload)))
        throw invalid("Task audit journal payload changed from its source proof.");
    }
    if (isTaskAuthority) activeContract = String(isTaskAuthority.contractSha256);
    if (event.type === "project.task.run.started") {
      const runId = String(event.payload.runId);
      const contract = activeContract ? contracts.get(activeContract) : null;
      const requirement = contract?.requirements.find(
        (item) =>
          taskRequirementSha256(item) === event.payload.requirementSha256 &&
          item.id === event.payload.requirementId,
      );
      if (runStarts.has(runId) || !requirement || requirement.checkKind !== "computation")
        throw invalid("Native run start is not bound to its active computational requirement.");
      runStarts.set(runId, event);
      continue;
    }
    if (event.type === "project.task.run.completed") {
      const hash = String(event.payload.recordSha256);
      const run = validateNativeRunRecord(
        await objectReader("runs", hash, "recordSha256"),
        projectId,
      );
      const started = runStarts.get(run.runId);
      if (
        !started ||
        nativeRuns.has(hash) ||
        event.payload.runId !== run.runId ||
        event.payload.requestSha256 !== run.requestSha256 ||
        event.payload.status !== run.status ||
        started.payload.requestSha256 !== run.requestSha256 ||
        started.payload.requirementSha256 !== run.requirementSha256 ||
        started.payload.requirementId !== run.requirementId ||
        started.payload.scriptSha256 !== run.script.sha256 ||
        started.payload.environmentLockSha256 !== run.environmentLock.sha256 ||
        started.payload.runtimeBinarySha256 !== run.runtime.binarySha256 ||
        started.payload.nativePacketSha256 !== run.nativePacketSha256
      )
        throw invalid(
          "Native run completion does not bind its exact observed start and artifacts.",
        );
      for (const object of [run.script, run.environmentLock, ...run.inputs, ...run.outputs]) {
        const file = indexed.get(`project/${object.path}`);
        if (!file || file.sha256 !== object.sha256 || file.bytes !== object.bytes)
          throw invalid(
            "Native run program, input, environment or output bytes are absent or inconsistent.",
          );
      }
      await investigations?.verifyRun(run, started);
      nativeRuns.set(hash, run);
      continue;
    }
    if (event.type !== "project.task.acceptance.recorded") continue;
    const record = validateTaskAcceptanceRecord(
      await objectReader<TaskAcceptanceRecord>(
        "acceptance",
        String(event.payload.recordSha256),
        "recordSha256",
      ),
      projectId,
    );
    const contract = activeContract ? contracts.get(activeContract) : null;
    const requirement = contract?.requirements.find(
      (item) => taskRequirementSha256(item) === record.requirementSha256,
    );
    if (
      !requirement ||
      requirement.id !== record.requirementId ||
      requirement.checkKind !== record.checkKind ||
      event.payload.requirementSha256 !== record.requirementSha256 ||
      (latest.get(record.requirementSha256)?.recordSha256 ?? null) !== record.previousRecordSha256
    )
      throw invalid(
        "Audit check history is not bound to its active requirement or previous record.",
      );
    latest.set(record.requirementSha256, record);
    if (
      record.nativeRunSha256 &&
      canonicalJson(nativeRuns.get(record.nativeRunSha256)) !== canonicalJson(record.nativeRun)
    )
      throw invalid("Acceptance does not bind a previously committed exact native run.");
    for (const result of record.results) {
      const file = indexed.get(`project/${result.path}`);
      if (!file || file.sha256 !== result.sha256 || file.bytes !== result.bytes)
        throw invalid("Audit native check result is missing or inconsistent.");
    }
  }
  const references: ReferenceView = {
    ready: project.packages.find((item) => item.stage === "acquire")?.status === "complete",
    sources: new Map(),
    atoms: new Map(),
    findings: new Map(),
    artifacts: new Map(),
  };
  if (references.ready && latest.size) {
    const acquisition = await read<{
      snapshotSha256: string;
      sources: Array<{ id: string; artifactIds: string[] }>;
      artifacts: Array<{ artifactId: string; sha256: string; candidateId: string }>;
      evidenceRecord: { path: string; sha256: string };
    }>("project/outputs/evidence-snapshot.json");
    validateTaskObject(acquisition, acquisition.snapshotSha256, "snapshotSha256");
    const evidenceFile = indexed.get(`project/${acquisition.evidenceRecord.path}`);
    if (evidenceFile?.sha256 !== acquisition.evidenceRecord.sha256)
      throw invalid("Audit source metadata is not snapshot-bound.");
    const evidence = await read<{ sources: Array<Record<string, unknown>> }>(
      `project/${acquisition.evidenceRecord.path}`,
    );
    const included = new Set(acquisition.sources.map((source) => source.id));
    for (const artifact of acquisition.artifacts)
      references.artifacts.set(artifact.artifactId, artifact.sha256);
    for (const source of evidence.sources)
      if (included.has(String(source.id)))
        references.sources.set(String(source.id), sha256Text(canonicalJson(source)));
    if (indexed.has("project/outputs/content-snapshot.json")) {
      const content = await read<{
        snapshotSha256: string;
        acquisitionSnapshotSha256: string;
        atoms: Array<{
          atomId: string;
          atomSha256: string;
          sourceId: string;
          artifactId: string;
          artifactSha256: string;
          candidateId: string;
        }>;
      }>("project/outputs/content-snapshot.json");
      validateTaskObject(content, content.snapshotSha256, "snapshotSha256");
      if (content.acquisitionSnapshotSha256 === acquisition.snapshotSha256) {
        const artifacts = new Map(acquisition.artifacts.map((item) => [item.artifactId, item]));
        const sourceArtifacts = new Map(
          acquisition.sources.map((item) => [item.id, new Set(item.artifactIds)]),
        );
        for (const atom of content.atoms) {
          const artifact = artifacts.get(atom.artifactId);
          if (
            !artifact ||
            artifact.sha256 !== atom.artifactSha256 ||
            artifact.candidateId !== atom.candidateId ||
            !sourceArtifacts.get(atom.sourceId)?.has(atom.artifactId)
          )
            throw invalid("Audit atom no longer belongs to the selected source artifact.");
          references.atoms.set(atom.atomId, atom.atomSha256);
        }
      }
    }
    if (project.packages.find((item) => item.stage === "analyze")?.status === "complete") {
      const graph = await read<{ analysisSha256: string }>(
        "project/outputs/claim-evidence-graph.json",
      );
      if (indexed.get("project/outputs/analysis.json")?.sha256 !== graph.analysisSha256)
        throw invalid("Audit analysis is not graph-bound.");
      const analysis = await read<{ findings: Array<Record<string, unknown>> }>(
        "project/outputs/analysis.json",
      );
      for (const finding of analysis.findings)
        references.findings.set(String(finding.id), sha256Text(canonicalJson(finding)));
    }
  }
  const expectedRows = taskRequirementRows(history);
  const results = new Map<string, OutputRecord>();
  const investigated = await investigatedRequirementHashes(projectId, events, objectReader);
  for (const [hash, row] of expectedRows) {
    if (investigated.has(hash)) row.requiresInvestigationCertification = true;
    const record = latest.get(hash);
    if (!record) continue;
    row.record = record;
    const amendmentBinding = requirementAmendmentBinding(row, amendmentImpact);
    if (amendmentBinding) row.requiredDesignAmendmentSha256 = amendmentBinding;
    row.status = taskRecordStatus(
      record,
      references,
      project,
      amendmentBinding,
      Boolean(row.requiresInvestigationCertification),
    );
    for (const result of record.results) results.set(result.sha256, result);
  }
  if (
    canonicalJson([...expectedRows.values()]) !== canonicalJson(context.requirements) ||
    canonicalJson([...results.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) !==
      canonicalJson(context.results)
  )
    throw invalid(
      "Audit task view disagrees with the verified requirements, check records or current dependencies.",
    );
  if (project.packages.find((item) => item.stage === "review")?.status === "complete") {
    const review = await read<Record<string, unknown>>("project/outputs/review.json");
    const completed = events.findLast(
      (event) => event.type === "package.completed" && event.payload.packageId === "review",
    );
    if (
      !Array.isArray(completed?.payload.outputs) ||
      !completed.payload.outputs.some(
        (item) =>
          isObject(item) &&
          item.path === "outputs/review.json" &&
          item.sha256 === indexed.get("project/outputs/review.json")?.sha256,
      )
    )
      throw invalid("Audit review has no matching promoted result.");
    const hash = String(review.packetSha256);
    if (!HASH.test(hash)) throw invalid("Audit review packet identity is invalid.");
    const packet = validateTaskObject<{ taskAcceptance: TaskAcceptanceContext }>(
      await read(`project/review/packets/${hash}.json`),
      hash,
      "packetSha256",
    );
    if (packet.taskAcceptance?.contextSha256 !== context.contextSha256)
      throw invalid("Audit review task context is stale.");
    validateTaskReview(review, context);
  }
  return {
    ...binding,
    executionCertified: false,
    ...(investigations ? { investigations: investigations.report() } : {}),
  };
}

function invalid(message: string): CliError {
  return new CliError(message, { code: "RESEARCH_AUDIT_BUNDLE_INVALID", exitCode: 3 });
}

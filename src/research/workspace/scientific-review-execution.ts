import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError } from "../../errors.js";
import {
  artifactPromptContext,
  artifactReadInstructions,
  persistArtifactReads,
  persistArtifactViewIndex,
  writeArtifactViewIndex,
} from "./artifact-views.js";
import { verifyCapabilities } from "./capabilities.js";
import type { AgentExecutionRequest } from "./executor.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import {
  calculateAgentCallTokenReservation,
  RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
  RESEARCH_PACKET_READ_MAX_TURNS,
  RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS,
  researchStructuredOutputMaxTurns,
  reservedAgentPackageCost,
} from "./preflight.js";
import { loadProject, saveProject } from "./projects.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import { createReviewExecutor } from "./review-executor.js";
import {
  loadPreparedScientificReview,
  readScientificReviewOutput,
  scientificReviewSchema,
  submitScientificReview,
  type ScientificReviewPacket,
} from "./scientific-review.js";
import {
  configuredResearchSecrets,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  ExecutionResult,
  ResearchPolicyBinding,
  ScientificReviewRole,
  WorkspaceConfig,
  OutputRecord,
} from "./types.js";
import { loadWorkspaceConfig, verifyDoctorAttestation, withWorkspaceLock } from "./workspace.js";

type ReviewerExecutor = (request: AgentExecutionRequest) => Promise<ExecutionResult>;
const MAX_EXECUTION_RECEIPT_BYTES = 1024 * 1024;

export async function executeScientificReview(
  input: {
    root: string;
    projectId: string;
    role: ScientificReviewRole;
    confirmCost: boolean;
    retry?: boolean;
    environment: NodeJS.ProcessEnv;
  },
  executor?: ReviewerExecutor,
) {
  if (!input.confirmCost) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_COST_CONFIRMATION_REQUIRED",
      "Explicit --confirm-review-cost is required before running the independent reviewer.",
    );
  }
  const prepared = await withWorkspaceLock(input.root, "scientific-review.execute", async () => {
    const paths = workspacePaths(input.root);
    const journal = await readVerifiedJournal(paths.journal);
    const existingProject = await loadProject(input.root, input.projectId);
    const existingGate = existingProject.scientificDesign?.gates[input.role];
    const packetHash = existingGate?.packetSha256;
    const events = journal.filter(
      (event) =>
        event.scope === input.projectId &&
        event.payload.packetSha256 === packetHash &&
        event.payload.role === input.role,
    );
    const completed = events.findLast(
      (event) => event.type === "scientific-review.execution.completed",
    );
    if (completed) {
      const receipt = await readReceipt(
        input.root,
        completed.payload.receiptLocator,
        completed.payload.receiptSha256,
        {
          projectId: input.projectId,
          role: input.role,
          packetSha256: packetHash,
          reviewerSessionSha256: existingGate?.reviewerSessionSha256,
        },
      );
      return {
        packetSha256: String(packetHash),
        receipt,
        receiptSha256: String(completed.payload.receiptSha256),
        replayed: true,
      };
    }
    const { project, packet } = await loadPreparedScientificReview(
      input.root,
      input.projectId,
      input.role,
    );
    assertProjectAuthority(project, projectAuthorityIndex(journal));
    const config = await loadWorkspaceConfig(input.root);
    if (
      project.lineage.supersededBy ||
      ["archived", "abandoned"].includes(project.status) ||
      project.handoff.state !== "agent-actionable"
    ) {
      throw executionError(
        "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
        "Only an active authoritative project may execute a scientific review.",
      );
    }
    if (
      config.reviewer.agent !== packet.reviewer.agent ||
      config.reviewer.agent === project.scientificDesign?.producer.agent
    ) {
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEWER_MISMATCH",
        "The prepared packet must use the configured independent reviewer family.",
      );
    }
    const capabilities = await verifyCapabilities(input.root);
    if (capabilities.status !== "verified") {
      throw executionError(
        "RESEARCH_CAPABILITY_DRIFT",
        "Verify the locked capabilities before reviewer execution.",
      );
    }
    let expectedRuntime: AgentExecutionRequest["expectedRuntime"];
    if (config.mode === "production-research") {
      const doctor = await verifyDoctorAttestation(input.root);
      if (doctor.status !== "verified" || !doctor.attestation) {
        throw executionError(
          "RESEARCH_DOCTOR_ATTESTATION_REQUIRED",
          "Refresh the independent reviewer doctor attestation before production review.",
        );
      }
      expectedRuntime = doctor.attestation.runtimes.find(
        (runtime) =>
          runtime.agent === config.reviewer.agent && runtime.model === config.reviewer.model,
      );
      if (!expectedRuntime) {
        throw executionError(
          "RESEARCH_EXECUTOR_DRIFT",
          "The doctor attestation does not bind the configured reviewer route.",
        );
      }
      await assertResearchPolicyBinding(input.root, project.publicationPolicy!);
    }
    const attempts = events.filter(
      (event) => event.type === "scientific-review.execution.started",
    ).length;
    if (attempts > 0 && !input.retry) {
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEW_RETRY_REQUIRED",
        "The previous execution did not complete. Inspect its recorded failure diagnostic, correct the cause, then explicitly use --retry.",
      );
    }
    if (attempts >= config.budget.maxAttemptsPerPackage) {
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEW_ATTEMPTS_EXHAUSTED",
        "The bounded scientific reviewer attempts are exhausted; do not retry automatically.",
      );
    }
    const runId = randomUUID();
    const capsuleParent = join(paths.runtime, "scientific-capsules");
    await ensureDirectory(capsuleParent);
    const capsuleRoot = await mkdtemp(join(capsuleParent, "review-"));
    const capsuleProject = join(capsuleRoot, "project");
    await ensureDirectory(capsuleProject);
    let started = false;
    let completedCall = false;
    let usageBeforeReservation: typeof project.usage | null = null;
    let callStartedAt: bigint | null = null;
    let usageSettled = false;
    let failureDiagnostic: Record<string, unknown> | null = null;
    let returnedResult: ExecutionResult | null = null;
    try {
      await copyPacketInputs(input.root, capsuleProject, packet, project.publicationPolicy!);
      await writeJsonAtomic(join(capsuleProject, "inputs/scientific-review-packet.json"), packet);
      const artifactViews = await writeArtifactViewIndex(capsuleProject, project.id);
      const persistedViews = await persistArtifactViewIndex(
        join(paths.projects, project.id),
        capsuleProject,
        artifactViews,
      );
      const prompt = await scientificReviewPrompt(
        capsuleProject,
        packet,
        config,
        project.publicationPolicy!,
        artifactViews,
      );
      const schema = scientificReviewSchema(input.role);
      const maxTurns = RESEARCH_PACKET_READ_MAX_TURNS;
      const reservation = calculateAgentCallTokenReservation({
        route: config.reviewer,
        primaryPayloadTokens: Math.ceil(
          Buffer.byteLength(prompt + JSON.stringify(schema)) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
        ),
        repairPayloadTokens: 0,
        maxTurns: researchStructuredOutputMaxTurns(config.reviewer),
        maxOutputTokens: config.budget.maxOutputTokens,
        maxToolContextTokens: RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS,
        maxRepairTokens: 0,
        reserveRepair: false,
      }).totalTokens;
      const reservedCostUsd = reservedAgentPackageCost(config.reviewer, reservation, config);
      const availableCostUsd = Math.max(0, config.budget.maxCostUsd - project.usage.costUsd);
      const timeoutSeconds = Math.min(
        config.budget.earlyScientificReviewMaxWallSeconds,
        config.budget.maxWallSeconds - project.usage.wallSeconds,
      );
      if (
        reservation > config.budget.earlyScientificReviewMaxTokens ||
        reservation > config.budget.maxTokens - project.usage.tokens ||
        reservedCostUsd > availableCostUsd ||
        timeoutSeconds <= 0
      ) {
        throw executionError(
          "RESEARCH_BUDGET_EXCEEDED",
          "The independent review reservation does not fit the reviewed token, cost, or time limits.",
        );
      }
      // Reserve before spawning. An interrupted call remains conservatively charged;
      // a returned result replaces that reservation with measured usage.
      const priorUsage = { ...project.usage };
      project.usage.tokens += reservation;
      project.usage.inputTokens += reservation;
      project.usage.costUsd += reservedCostUsd;
      project.usage.wallSeconds += timeoutSeconds;
      await saveProject(input.root, project);
      usageBeforeReservation = priorUsage;
      await appendJournalEvent(paths.journal, "scientific-review.execution.started", project.id, {
        role: input.role,
        packetSha256: packet.packetSha256,
        artifactViewIndexSha256: artifactViews.sha256,
        runId,
        attempt: attempts + 1,
        reservedTokens: reservation,
        reservedCostUsd,
        reservedWallSeconds: timeoutSeconds,
        transport: config.reviewerExecution.transport,
      });
      started = true;
      const execute =
        executor ??
        createReviewExecutor({ root: input.root, execution: config.reviewerExecution }).execute;
      callStartedAt = process.hrtime.bigint();
      const result = (returnedResult = await execute({
        route: config.reviewer,
        prompt,
        outputSchema: schema,
        requestId: runId,
        purpose: "primary",
        capsuleRoot,
        projectRoot: capsuleProject,
        workspaceRoot: input.root,
        timeoutSeconds,
        maxTurns,
        maxOutputTokens: config.budget.maxOutputTokens,
        maxToolContextTokens: RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS,
        maxCostUsd: availableCostUsd,
        expectedRuntime,
        toolPolicy: "packet-read",
        artifactViews: { index: artifactViews, packetSha256: packet.packetSha256 },
        brokerUrl: null,
        environment: input.environment,
      }));
      if (result.artifactReads?.length) {
        await persistArtifactReads(
          join(paths.projects, project.id),
          capsuleProject,
          artifactViews,
          packet.packetSha256,
          result.artifactReads,
        );
        await appendJournalEvent(
          paths.journal,
          "review.artifacts.read",
          project.id,
          sanitizeResearchValue(
            {
              requestId: runId,
              role: input.role,
              packetSha256: packet.packetSha256,
              indexSha256: artifactViews.sha256,
              receipts: result.artifactReads.map((receipt) => receipt.receiptSha256),
            },
            configuredResearchSecrets(input.environment),
          ) as Record<string, unknown>,
        );
      }
      const reportedUsage = checkedUsage(result);
      const usageKnown = reportedUsage.tokens > 0;
      const usage = usageKnown
        ? reportedUsage
        : {
            ...reportedUsage,
            tokens: reservation,
            inputTokens: reservation,
            costUsd: Math.max(reportedUsage.costUsd, reservedCostUsd),
          };
      project.usage.tokens = priorUsage.tokens + usage.tokens;
      project.usage.inputTokens = priorUsage.inputTokens + usage.inputTokens;
      project.usage.cachedInputTokens = priorUsage.cachedInputTokens + usage.cachedInputTokens;
      project.usage.outputTokens = priorUsage.outputTokens + usage.outputTokens;
      project.usage.costUsd = priorUsage.costUsd + usage.costUsd;
      project.usage.wallSeconds = priorUsage.wallSeconds + usage.wallSeconds;
      await saveProject(input.root, project);
      usageSettled = true;
      if (result.exitCode !== 0) {
        failureDiagnostic = reviewerFailureDiagnostic(result, input, capsuleRoot);
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED",
          "The isolated reviewer failed. No scientific review was submitted.",
          failureDiagnostic,
        );
      }
      if (
        usage.tokens >
          Math.min(
            config.budget.earlyScientificReviewMaxTokens,
            config.budget.maxTokens - priorUsage.tokens,
          ) ||
        usage.outputTokens > config.budget.maxOutputTokens ||
        usage.costUsd > availableCostUsd ||
        usage.wallSeconds > timeoutSeconds
      ) {
        throw executionError(
          "RESEARCH_BUDGET_EXCEEDED",
          "The reviewer exceeded an approved finite execution limit. No review was submitted.",
        );
      }
      if (
        !result.runtime ||
        result.runtime.agent !== config.reviewer.agent ||
        (config.reviewer.model !== null && result.model !== config.reviewer.model) ||
        result.isolation?.toolPolicy !== "packet-read" ||
        result.isolation.networkPolicy !== "reviewer-provider-and-local-artifacts" ||
        (config.reviewerExecution.transport === "sandbox-bridge" && !result.reviewAttestation)
      ) {
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
          "The reviewer result does not contain the expected model, runtime, and isolation proof.",
        );
      }
      const secrets = configuredResearchSecrets(input.environment);
      if (
        sanitizeResearchText(result.stdout, secrets) !== result.stdout ||
        Buffer.byteLength(result.stdout) > config.budget.maxOutputTokens * 16
      ) {
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE",
          "The reviewer output is unsafe or exceeds the bounded capture size.",
        );
      }
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_INVALID",
          "The reviewer did not return schema-valid JSON. No review was submitted.",
        );
      }
      if (canonicalJson(sanitizeResearchValue(output, secrets)) !== canonicalJson(output)) {
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE",
          "The reviewer output contains sensitive material.",
        );
      }
      const reviewPath = join(capsuleRoot, "review.json");
      await writeJsonAtomic(reviewPath, output);
      const review = await readScientificReviewOutput(reviewPath, input.role);
      if (
        review.packetSha256 !== packet.packetSha256 ||
        review.reviewerSessionSha256 !== packet.reviewer.sessionSha256
      ) {
        throw executionError(
          "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
          "The reviewer output does not bind the prepared packet and independent session.",
        );
      }
      const reviewBytes = JSON.stringify(review, null, 2) + "\n";
      const reviewSha256 = sha256Text(reviewBytes);
      const reviewLocator =
        "projects/" + project.id + "/scientific/execution-outputs/" + reviewSha256 + ".json";
      await writeJsonAtomic(resolveContained(paths.control, reviewLocator), review, 0o444);
      const core = sanitizeResearchValue(
        {
          schemaVersion: 1,
          projectId: project.id,
          role: input.role,
          packetSha256: packet.packetSha256,
          reviewerSessionSha256: packet.reviewer.sessionSha256,
          runId,
          attempt: attempts + 1,
          transport: config.reviewerExecution.transport,
          reviewerAgent: config.reviewer.agent,
          model: result.model,
          reviewLocator,
          reviewSha256,
          usage,
          accountingMode: usageKnown ? "measured" : "reserved-unknown-usage",
          runtime: result.runtime,
          isolation: result.isolation,
          reviewAttestation: result.reviewAttestation ?? null,
          artifactViews: persistedViews,
          artifactReads: result.artifactReads ?? [],
          stdoutSha256: sha256Text(result.stdout),
          stderrSha256: sha256Text(result.stderr),
        },
        secrets,
      ) as Record<string, unknown>;
      const receiptSha256 = sha256Text(JSON.stringify(core, null, 2) + "\n");
      const receiptLocator =
        "projects/" + project.id + "/scientific/execution-receipts/" + receiptSha256 + ".json";
      await writeJsonAtomic(resolveContained(paths.control, receiptLocator), core, 0o444);
      await appendJournalEvent(paths.journal, "scientific-review.execution.completed", project.id, {
        role: input.role,
        packetSha256: packet.packetSha256,
        runId,
        receiptLocator,
        receiptSha256,
        reviewSha256,
      });
      completedCall = true;
      return { packetSha256: packet.packetSha256, receipt: core, receiptSha256, replayed: false };
    } catch (error) {
      if (usageBeforeReservation && !usageSettled) {
        // A live process can measure elapsed time even if the executor throws.
        // SIGKILL cannot reach this settlement, so the durable timeout stays reserved.
        const elapsed =
          callStartedAt === null
            ? 0
            : Number(process.hrtime.bigint() - callStartedAt) / 1_000_000_000;
        project.usage.wallSeconds = usageBeforeReservation.wallSeconds + elapsed;
        if (callStartedAt === null) {
          project.usage = { ...usageBeforeReservation };
        }
        await saveProject(input.root, project);
      }
      if (started) {
        // Capture only the failure path: successful execution already has its
        // immutable output/receipt and must not pay for duplicate persistence.
        if (returnedResult) {
          let retention: Record<string, unknown>;
          try {
            retention = {
              executionRecord: await retainFailedExecution({
                root: input.root,
                projectId: project.id,
                packet,
                runId,
                result: returnedResult,
                failureCode:
                  error instanceof CliError
                    ? error.code
                    : "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED",
                config,
                environment: input.environment,
              }),
            };
          } catch {
            // Disk/namespace failure must not masquerade as a retained result
            // or hide the original budget/runtime rejection.
            retention = { outputRetention: "storage-unavailable" };
          }
          failureDiagnostic = { ...failureDiagnostic, ...retention };
        }
        await appendJournalEvent(paths.journal, "scientific-review.execution.failed", project.id, {
          role: input.role,
          packetSha256: packet.packetSha256,
          runId,
          attempt: attempts + 1,
          code:
            error instanceof CliError ? error.code : "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED",
          ...(failureDiagnostic ?? {}),
          capsuleDisposition: "retained-failed-execution",
        });
      }
      if (error instanceof CliError) {
        if (!failureDiagnostic) throw error;
        throw new CliError(error.message, {
          code: error.code,
          exitCode: error.exitCode,
          details: {
            ...(isObject(error.details) ? error.details : {}),
            ...failureDiagnostic,
          },
        });
      }
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED",
        "The isolated reviewer failed. Its packet and failed execution remain available for explicit recovery.",
        failureDiagnostic ?? undefined,
      );
    } finally {
      if (
        (completedCall || !started) &&
        !["workbuddy", "codebuddy"].includes(project.scientificDesign!.producer.agent)
      ) {
        await rm(capsuleRoot, { recursive: true, force: true });
      }
    }
  });
  const reviewLocator = prepared.receipt.reviewLocator;
  const reviewSha256 = prepared.receipt.reviewSha256;
  if (typeof reviewLocator !== "string" || typeof reviewSha256 !== "string") {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The execution receipt is missing its review binding.",
    );
  }
  const reviewPath = resolveContained(workspacePaths(input.root).control, reviewLocator);
  if ((await sha256File(reviewPath)) !== reviewSha256) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The saved reviewer output drifted after execution.",
    );
  }
  const submission = await submitScientificReview({
    ...input,
    reviewPath,
    executionBinding: { packetSha256: prepared.packetSha256, reviewSha256 },
  });
  return {
    ...submission,
    packetSha256: prepared.packetSha256,
    receiptSha256: prepared.receiptSha256,
    replayed: prepared.replayed,
  };
}

async function retainFailedExecution(input: {
  root: string;
  projectId: string;
  packet: ScientificReviewPacket;
  runId: string;
  result: ExecutionResult;
  failureCode: string;
  config: WorkspaceConfig;
  environment: NodeJS.ProcessEnv;
}): Promise<{ locator: string; sha256: string }> {
  const { result } = input;
  const secrets = configuredResearchSecrets(input.environment);
  const bytes = Buffer.byteLength(result.stdout);
  let disposition = "retained-json";
  if (bytes > Math.min(MAX_EXECUTION_RECEIPT_BYTES, input.config.budget.maxOutputTokens * 16)) {
    disposition = "omitted-oversized";
  } else if (sanitizeResearchText(result.stdout, secrets) !== result.stdout) {
    disposition = "omitted-unsafe";
  } else {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (canonicalJson(sanitizeResearchValue(parsed, secrets)) !== canonicalJson(parsed)) {
        disposition = "omitted-unsafe";
      }
    } catch {
      // Only inspectable JSON can pass the structured sensitive-field check.
      // Malformed output keeps its digest/size, not unchecked raw text.
      disposition = "omitted-invalid-json";
    }
  }
  let reportedUsage: ReturnType<typeof checkedUsage> | null = null;
  try {
    reportedUsage = checkedUsage(result);
  } catch {
    // Invalid reported usage is not zero usage or a settled invoice.
  }
  const reportedBinding = sanitizeResearchValue(
    {
      model: result.model,
      runtime: result.runtime ?? null,
      isolation: result.isolation ?? null,
      reviewAttestation: result.reviewAttestation ?? null,
    },
    secrets,
  );
  const bindingBytes = canonicalJson(reportedBinding);
  const record = {
    schemaVersion: 1,
    kind: "tiangong-scientific-review-failed-execution",
    acceptance: "not-submitted",
    projectId: input.projectId,
    role: input.packet.role,
    packetSha256: input.packet.packetSha256,
    reviewerSessionSha256: input.packet.reviewer.sessionSha256,
    runId: input.runId,
    failureCode: input.failureCode,
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
    reportedUsage,
    // Reported identities remain unverified observations, never acceptance proof.
    reportedBinding: Buffer.byteLength(bindingBytes) <= 64 * 1024 ? reportedBinding : null,
    reportedBindingSha256: sha256Text(bindingBytes),
    output: {
      disposition,
      bytes,
      sha256: sha256Text(result.stdout),
      stdout: disposition === "retained-json" ? result.stdout : null,
    },
    stderrSha256: sha256Text(result.stderr),
  };
  const sha256 = sha256Text(JSON.stringify(record, null, 2) + "\n");
  const locator = `projects/${input.projectId}/scientific/failed-executions/${sha256}.json`;
  const path = resolveContained(workspacePaths(input.root).control, locator);
  const parent = await lstat(dirname(dirname(path)));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe capture parent");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Unsafe capture directory");
  }
  await writeJsonAtomic(path, record, 0o444);
  return { locator, sha256 };
}

async function readReceipt(
  root: string,
  locator: unknown,
  digest: unknown,
  expected: {
    projectId: string;
    role: ScientificReviewRole;
    packetSha256: unknown;
    reviewerSessionSha256: unknown;
  },
): Promise<Record<string, unknown>> {
  if (
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    locator !== `projects/${expected.projectId}/scientific/execution-receipts/${digest}.json`
  ) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The completed execution has invalid receipt metadata.",
    );
  }
  const path = resolveContained(workspacePaths(root).control, String(locator));
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_EXECUTION_RECEIPT_BYTES) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The completed execution receipt failed its hash check.",
    );
  }
  let value: unknown;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size < 2 || opened.size > MAX_EXECUTION_RECEIPT_BYTES)
        throw new Error("invalid receipt size");
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (length !== opened.size || createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("receipt hash mismatch");
      value = JSON.parse(bytes.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The completed execution receipt failed its bounded snapshot check.",
    );
  }
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== expected.projectId ||
    value.role !== expected.role ||
    value.packetSha256 !== expected.packetSha256 ||
    value.reviewerSessionSha256 !== expected.reviewerSessionSha256 ||
    typeof value.reviewSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.reviewSha256) ||
    value.reviewLocator !==
      `projects/${expected.projectId}/scientific/execution-outputs/${value.reviewSha256}.json`
  ) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "The execution receipt does not match its project, packet, or review binding.",
    );
  }
  return value;
}

function checkedUsage(result: ExecutionResult) {
  const usage = {
    tokens: result.tokens,
    inputTokens: result.inputTokens,
    cachedInputTokens: result.cachedInputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    wallSeconds: result.wallSeconds,
  };
  if (
    Object.values(usage).some((value) => !Number.isFinite(value) || value < 0) ||
    usage.tokens !== usage.inputTokens + usage.cachedInputTokens + usage.outputTokens
  ) {
    throw executionError(
      "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID",
      "Reviewer usage metadata is invalid.",
    );
  }
  return usage;
}

async function scientificReviewPrompt(
  controlRoot: string,
  packet: ScientificReviewPacket,
  config: WorkspaceConfig,
  policy: ResearchPolicyBinding,
  index: OutputRecord,
) {
  const mandatory = [
    "Review the exact prepared scientific packet independently using only its packet-bound artifact tools. Read the design, assessment and approved Policy documents, then inspect relevant implementations, inputs, failed checks and counterevidence. Complete files are available, not assumed read.",
    "Return the supplied JSON schema with the exact packetSha256 and reviewerSessionSha256. A mechanical canPass=false cannot be upgraded by prose; return stop, handoff, or revise as appropriate.",
    `packetSha256=${packet.packetSha256}; reviewerSessionSha256=${packet.reviewer.sessionSha256}; role=${packet.role}`,
    artifactReadInstructions(index),
  ];
  const locators = [
    ...new Set([
      "inputs/scientific-review-packet.json",
      packet.design.objectLocator,
      packet.assessment.objectLocator,
      packet.policy.objectLocator,
      ...policy.documents.map((document) => document.objectLocator),
      ...packet.stageInputs.map((record) => record.path),
    ]),
  ];
  mandatory.push(
    await artifactPromptContext(
      controlRoot,
      index,
      locators,
      Math.min(8_000, config.budget.maxInputContextTokens) * RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
    ),
  );
  return mandatory.join("\n\n");
}

async function copyPacketInputs(
  root: string,
  capsuleProject: string,
  packet: ScientificReviewPacket,
  policy: ResearchPolicyBinding,
) {
  const paths = workspacePaths(root);
  const records = new Map(packet.stageInputs.map((record) => [record.path, record.sha256]));
  records.set(packet.design.objectLocator, packet.design.sha256);
  records.set(packet.assessment.objectLocator, packet.assessment.sha256);
  records.set(packet.policy.objectLocator, packet.policy.bindingSha256);
  for (const document of policy.documents) records.set(document.objectLocator, document.sha256);
  for (const [locator, digest] of records) {
    const source = resolveContained(paths.control, locator);
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
        "A scientific input is missing or unsafe.",
      );
    }
    const target = resolveContained(capsuleProject, locator);
    await ensureDirectory(dirname(target));
    await copyFile(source, target, constants.COPYFILE_EXCL);
    if ((await sha256File(target)) !== digest) {
      throw executionError(
        "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
        "A scientific input changed while staging the reviewer capsule.",
      );
    }
  }
  await writeJsonAtomic(join(capsuleProject, "packet.json"), packet);
}

function reviewerFailureDiagnostic(
  result: ExecutionResult,
  input: { root: string; environment: NodeJS.ProcessEnv },
  capsuleRoot: string,
): Record<string, unknown> {
  const secrets = configuredResearchSecrets(input.environment);
  let diagnostic = sanitizeResearchText(
    [result.telemetry?.providerErrors.join("; "), result.stderr.trim()]
      .filter(Boolean)
      .join("\n") ||
      "Reviewer exited without a textual diagnostic; inspect the configured runtime before retrying.",
    secrets,
  );
  for (const path of [
    capsuleRoot,
    input.root,
    input.environment.HOME,
    input.environment.CLAUDE_CONFIG_DIR,
    input.environment.CODEX_HOME,
  ]) {
    if (path) diagnostic = diagnostic.replaceAll(path, "[private-path]");
  }
  return sanitizeResearchValue(
    {
      exitCode: result.exitCode,
      diagnostic: diagnostic.slice(0, 2048),
      stdoutSha256: sha256Text(result.stdout),
      stderrSha256: sha256Text(result.stderr),
      minimumAction:
        "Correct the reported runtime or provider failure, then explicitly use --retry. No review was submitted.",
    },
    secrets,
  ) as Record<string, unknown>;
}

function executionError(code: string, message: string, details?: Record<string, unknown>) {
  return new CliError(message, { code, exitCode: 3, ...(details ? { details } : {}) });
}

import {
  createProjectBudget,
  projectBudgetAmount,
  projectBudgetView,
  projectCostExposure,
  isProjectBudgetState,
  inheritedProjectBudget,
  settleProjectCost,
  providerCostLimits,
} from "./project-budget.js";
import { randomUUID } from "node:crypto";
import { cp, lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import {
  freezeEvidenceContentSnapshot,
  loadCurrentEvidenceContentSnapshot,
  recordArtifactDecomposition,
  registerEvidenceAtom,
} from "./content-evidence.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import {
  assertProjectAuthority,
  projectAuthorityIndex,
  readProjectAuthorityIndex,
  visibleProjectIds,
  type ProjectAuthorityIndex,
} from "./project-authority.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { cloneProjectEvidenceReceipts } from "./evidence.js";
import {
  appendEvidenceLedgerEvent,
  cloneEvidenceLedger,
  registerProjectInputCandidates,
} from "./evidence-ledger.js";
import { cloneProjectArtifactRecords } from "./artifacts.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import {
  freezeEvidenceSnapshot,
  loadCurrentEvidenceSnapshot,
  loadImmutableEvidenceSnapshotChain,
} from "./acquisition.js";
import { projectInputsFromPlan, reverifyProjectInputPlan } from "./input-plan.js";
import { evaluateProjectPreflight } from "./preflight.js";
import {
  evaluateScientificDesign,
  scientificDesignPolicyGaps,
  type VerifiedScientificDesign,
} from "./scientific-design.js";
import { assertScientificDesignObjectBindings } from "./scientific-objects.js";
import {
  ensureDirectory,
  canonicalJson,
  fileRecord,
  fileSize,
  isObject,
  pathExists,
  readJsonFile,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type {
  AgentKind,
  ProjectEvidenceRequirements,
  ProjectInput,
  ProjectInputTrustStatus,
  ResearchPolicyBinding,
  ScientificDesignBinding,
  ScientificReviewRole,
  ProjectState,
  WorkPackage,
  WorkspaceConfig,
  VerifiedProjectInputPlan,
} from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";
import { inheritProjectTask } from "./task-contract.js";
import { isProjectStatus } from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function initializeProject(
  root: string,
  projectId: string,
  question: string,
  evidenceRequirements?: ProjectEvidenceRequirements,
  budgetConfirmed = false,
  inputPlan?: VerifiedProjectInputPlan,
  publicationPolicy?: ResearchPolicyBinding,
  scientificDesignInput?: {
    design: VerifiedScientificDesign;
    producerAgent: AgentKind;
    producerSessionId: string;
  },
  budgetInput?: { maxCostUsd: number },
): Promise<ProjectState> {
  validateProjectId(projectId);
  const requestedProjectCost = projectBudgetAmount(budgetInput?.maxCostUsd);
  const normalizedQuestion = question.trim();
  if (normalizedQuestion.length < 8 || normalizedQuestion.length > 4000) {
    throw new CliError("Research question must contain 8-4000 characters.", {
      code: "RESEARCH_QUESTION_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.init", async () => {
    const paths = workspacePaths(root);
    const projectRoot = join(paths.projects, projectId);
    const projectPath = join(projectRoot, "project.json");
    const existing = await lstat(projectRoot).catch(() => undefined);
    if (existing) {
      throw new CliError(`Research project already exists: ${projectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    if (config.mode === "production-research" && !evidenceRequirements) {
      throw new CliError("Production research requires explicit evidence requirements.", {
        code: "RESEARCH_EVIDENCE_REQUIREMENTS_REQUIRED",
        exitCode: 2,
      });
    }
    if (
      config.mode === "production-research" &&
      Math.min(config.budget.maxCostUsd, requestedProjectCost ?? config.budget.maxCostUsd) >
        config.budget.confirmationCostUsd &&
      !budgetConfirmed
    ) {
      throw new CliError(
        `Production budget requires explicit confirmation above $${config.budget.confirmationCostUsd}.`,
        {
          code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
          exitCode: 2,
          details: {
            maxCostUsd: config.budget.maxCostUsd,
            confirmationCostUsd: config.budget.confirmationCostUsd,
          },
        },
      );
    }
    const requirements = normalizeEvidenceRequirements(
      evidenceRequirements ?? defaultEvidenceRequirements(config),
    );
    if (publicationPolicy && !scientificDesignInput) {
      throw new CliError("Top-journal research requires an explicit scientific design contract.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REQUIRED",
        exitCode: 2,
      });
    }
    if (!publicationPolicy && scientificDesignInput) {
      throw new CliError("A scientific design contract requires an approved top-journal policy.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_REQUIRED",
        exitCode: 2,
      });
    }
    const scientificDesign = scientificDesignInput
      ? prepareScientificDesignBinding(projectId, publicationPolicy!, scientificDesignInput)
      : null;
    if (scientificDesignInput) {
      await assertScientificDesignObjectBindings(root, scientificDesignInput.design.contract);
    }
    const admittedInputPlan = inputPlan ? await reverifyProjectInputPlan(inputPlan) : undefined;
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        normalizedQuestion,
        requirements,
        admittedInputPlan ?? null,
        {
          publicationPolicy: publicationPolicy ?? null,
          scientificDesign: scientificDesignInput?.design ?? null,
          ...(requestedProjectCost === undefined
            ? {}
            : { projectMaxCostUsd: requestedProjectCost }),
        },
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Production project initialization was blocked by preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const now = new Date().toISOString();
    const project: ProjectState = {
      schemaVersion: 1,
      id: projectId,
      question: normalizedQuestion,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      budgetConfirmedAt: budgetConfirmed || requestedProjectCost !== undefined ? now : null,
      ...(requestedProjectCost === undefined
        ? {}
        : { budget: createProjectBudget(projectId, requestedProjectCost) }),
      inputs: admittedInputPlan ? projectInputsFromPlan(admittedInputPlan, now) : [],
      evidenceRequirements: requirements,
      publicationPolicy: publicationPolicy ?? null,
      scientificDesign,
      packages: defaultWorkPackages(config),
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: initialLineage("primary"),
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    await Promise.all([
      ensureDirectory(projectRoot),
      ensureDirectory(join(projectRoot, "outputs")),
      ensureDirectory(join(projectRoot, "runs")),
    ]);
    if (scientificDesign && scientificDesignInput) {
      await writeJsonAtomic(
        join(paths.control, scientificDesign.objectLocator),
        scientificDesignInput.design.contract,
      );
    }
    await writeJsonAtomic(projectPath, project);
    await registerProjectInputCandidates(root, projectId, project.inputs);
    await appendJournalEvent(paths.journal, "project.initialized", projectId, {
      projectId,
      questionSha256: await hashQuestion(normalizedQuestion),
      inputPlanSha256: admittedInputPlan?.sha256 ?? null,
      publicationPolicySha256: publicationPolicy?.resolvedPolicySha256 ?? null,
      scientificDesignSha256: scientificDesign?.designSha256 ?? null,
      scientificDesignProducerSessionSha256: scientificDesign?.producer.sessionSha256 ?? null,
      inputs: project.inputs.map((input) => ({
        id: input.id,
        role: input.role,
        sha256: input.sha256,
        bytes: input.bytes,
      })),
    });
    return project;
  });
}

export async function addProjectInput(
  root: string,
  projectId: string,
  inputPath: string,
  role: ProjectInput["role"],
  options: {
    trustStatus?: ProjectInputTrustStatus;
    independentlyReproduced?: boolean;
  } = {},
): Promise<ProjectInput> {
  validateProjectId(projectId);
  const canonicalInput = resolve(inputPath);
  if (canonicalInput !== inputPath) {
    throw new CliError(`Input path must be absolute: ${inputPath}`, {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  if (canonicalInput.split(sep).includes(RESEARCH_CONTROL_DIRECTORY)) {
    throw new CliError("Research inputs cannot come from a research control directory.", {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  const info = await lstat(canonicalInput).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError(`Research input must be a regular file: ${inputPath}`, {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.input.add", async () => {
    const project = await loadProject(root, projectId);
    const sha256 = await sha256File(canonicalInput);
    const existing = project.inputs.find((input) => input.sha256 === sha256 && input.role === role);
    if (existing) return existing;
    const input: ProjectInput = {
      id: `${slug(basename(canonicalInput))}-${sha256.slice(0, 12)}`,
      role,
      path: canonicalInput,
      sha256,
      bytes: await fileSize(canonicalInput),
      sourceType: "primary",
      dimensions: [],
      fullText: true,
      publicationDate: null,
      trustStatus: options.trustStatus ?? defaultInputTrustStatus(role),
      independentlyReproduced: options.independentlyReproduced ?? false,
      addedAt: new Date().toISOString(),
    };
    project.inputs.push(input);
    project.inputs.sort((left, right) => left.id.localeCompare(right.id));
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await registerProjectInputCandidates(root, projectId, [input]);
    await appendJournalEvent(workspacePaths(root).journal, "project.input.added", projectId, {
      projectId,
      inputId: input.id,
      role,
      sha256,
      bytes: input.bytes,
      trustStatus: input.trustStatus,
      independentlyReproduced: input.independentlyReproduced,
    });
    return input;
  });
}

function defaultInputTrustStatus(role: ProjectInput["role"]): ProjectInputTrustStatus {
  if (role === "reference") return "reference-only";
  if (role === "replication") return "replication-candidate";
  return "unverified-owner-input";
}

export async function loadProject(root: string, projectId: string): Promise<ProjectState> {
  validateProjectId(projectId);
  const project = await readJsonFile<ProjectState>(
    join(workspacePaths(root).projects, projectId, "project.json"),
    `Research project ${projectId}`,
  );
  validateProjectShape(project, projectId);
  return project;
}

export async function listProjects(
  root: string,
  authority?: ProjectAuthorityIndex,
): Promise<ProjectState[]> {
  const ids = await visibleProjectIds(root, authority ?? (await readProjectAuthorityIndex(root)));
  const projects: ProjectState[] = [];
  for (const id of ids) projects.push(await loadProject(root, id));
  return projects;
}

export async function saveProject(root: string, project: ProjectState): Promise<void> {
  validateProjectShape(project, project.id);
  await writeJsonAtomic(join(workspacePaths(root).projects, project.id, "project.json"), project);
}

export async function retryProjectPackage(
  root: string,
  projectId: string,
  packageId?: string,
): Promise<ProjectState> {
  validateProjectId(projectId);
  return withWorkspaceLock(root, "project.retry", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const requestSha256 = sha256Text(canonicalJson({ projectId, packageId: packageId ?? null }));
    const selected = packageId
      ? packageById(project, packageId)
      : project.packages.find((item) => item.status === "failed" || item.status === "retry");
    const review = project.packages.find((item) => item.stage === "review");
    const reviewerRevision = Boolean(
      selected?.stage === "synthesize" &&
      selected.status === "complete" &&
      review?.status === "failed" &&
      review.lastError === "Independent review requested revision.",
    );
    if (
      !selected ||
      (selected.status !== "failed" && selected.status !== "retry" && !reviewerRevision)
    ) {
      const replay = events.findLast(
        (event) =>
          event.type === "project.retry.requested" &&
          event.scope === projectId &&
          isObject(event.payload.mutation) &&
          event.payload.mutation.requestSha256 === requestSha256,
      );
      if (
        replay &&
        isObject(replay.payload.mutation) &&
        replay.payload.mutation.resultSha256 === sha256Text(canonicalJson(project))
      )
        return project;
      throw new CliError("Project retry requires a failed or retryable package.", {
        code: "RESEARCH_RETRY_NOT_AVAILABLE",
        exitCode: 2,
      });
    }
    let mutation = await beginProjectMutation(root, "retry", project, requestSha256);
    try {
      const archivedReport = reviewerRevision
        ? await archiveSynthesisRevision(root, projectId)
        : null;
      const selectedIndex = project.packages.indexOf(selected);
      const previous = {
        status: selected.status,
        attempts: selected.attempts,
        failureKind: selected.lastFailureKind,
      };
      for (const [index, workPackage] of project.packages.entries()) {
        if (index < selectedIndex) continue;
        workPackage.status = index === selectedIndex ? "ready" : "pending";
        workPackage.maxAttempts = Math.max(workPackage.maxAttempts, workPackage.attempts + 1);
        workPackage.startedAt = null;
        workPackage.completedAt = null;
        workPackage.lastError = null;
        workPackage.lastFailureKind = null;
        workPackage.retryNotBefore = null;
      }
      project.status = "ready";
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(root, mutation, project);
      await appendJournalEvent(workspacePaths(root).journal, "project.retry.requested", projectId, {
        projectId,
        packageId: selected.id,
        previous,
        preservedOutputs: true,
        reason: reviewerRevision ? "reviewer-revision" : "package-failure",
        archivedReport,
        mutation: projectMutationBinding(mutation),
      });
      await settleProjectMutation(root, mutation);
      return project;
    } catch (error) {
      if (await settleProjectMutation(root, mutation)) return loadProject(root, projectId);
      throw error;
    }
  });
}

async function archiveSynthesisRevision(
  root: string,
  projectId: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const reportPath = join(projectRoot, "outputs", "report.md");
  if (!(await pathExists(reportPath))) {
    throw new CliError("Reviewer-driven synthesis revision requires the current report output.", {
      code: "RESEARCH_REVISION_OUTPUT_REQUIRED",
      exitCode: 3,
      details: { projectId, path: "outputs/report.md" },
    });
  }
  const reportSha256 = await sha256File(reportPath);
  const logicalPath = `outputs/revisions/synthesize/${reportSha256}/report.md`;
  const archivePath = join(projectRoot, logicalPath);
  if (await pathExists(archivePath)) {
    if ((await sha256File(archivePath)) !== reportSha256) {
      throw new CliError("Archived synthesis revision failed its content-address binding.", {
        code: "RESEARCH_REVISION_ARCHIVE_INVALID",
        exitCode: 3,
        details: { projectId, path: logicalPath },
      });
    }
  } else {
    await writeTextAtomic(archivePath, await readFile(reportPath, "utf8"), 0o444);
  }
  return fileRecord(archivePath, logicalPath);
}

export async function forkProject(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
  resumeThrough?: "discover" | "acquire" | "analyze" | "synthesize",
  scientificReapproval?: {
    publicationPolicy: ResearchPolicyBinding;
    scientificDesign: {
      design: VerifiedScientificDesign;
      producerAgent: AgentKind;
      producerSessionId: string;
    };
  },
): Promise<ProjectState> {
  validateProjectId(sourceProjectId);
  validateProjectId(targetProjectId);
  if (sourceProjectId === targetProjectId) {
    throw new CliError("Fork target must use a different project ID.", {
      code: "RESEARCH_PROJECT_FORK_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.fork", async () => {
    const source = await loadProject(root, sourceProjectId);
    const authority = await readProjectAuthorityIndex(root);
    const requestSha256 = sha256Text(
      canonicalJson({
        sourceProjectId,
        targetProjectId,
        resumeThrough: resumeThrough ?? null,
        policy: scientificReapproval?.publicationPolicy ?? null,
        design: scientificReapproval?.scientificDesign.design.contract ?? null,
        producerAgent: scientificReapproval?.scientificDesign.producerAgent ?? null,
        producerSessionSha256: scientificReapproval
          ? sha256Text(scientificReapproval.scientificDesign.producerSessionId)
          : null,
      }),
    );
    const sourceRequiresScientificReapproval = Boolean(
      source.publicationPolicy || source.scientificDesign,
    );
    if (sourceRequiresScientificReapproval && !scientificReapproval) {
      throw new CliError(
        "A top-journal recovery fork requires a newly approved project-specific policy and scientific design.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!sourceRequiresScientificReapproval && scientificReapproval) {
      throw new CliError("Scientific reapproval is valid only for a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const previous = authority.forks.get(targetProjectId);
    if (previous) {
      const binding = isObject(previous.payload.mutation) ? previous.payload.mutation : null;
      const sameRequest = binding
        ? binding.requestSha256 === requestSha256
        : previous.payload.resumeThrough === (resumeThrough ?? null) &&
          previous.payload.publicationPolicySha256 ===
            (scientificReapproval?.publicationPolicy.resolvedPolicySha256 ?? null) &&
          previous.payload.scientificDesignSha256 ===
            (scientificReapproval?.scientificDesign.design.sha256 ?? null) &&
          previous.payload.scientificDesignProducerSessionSha256 ===
            (scientificReapproval
              ? sha256Text(scientificReapproval.scientificDesign.producerSessionId)
              : null);
      if (previous.payload.sourceProjectId !== sourceProjectId || !sameRequest) {
        throw new CliError("Fork target already belongs to a different committed request.", {
          code: "RESEARCH_PROJECT_FORK_CONFLICT",
          exitCode: 3,
          details: { sourceProjectId, targetProjectId },
        });
      }
      const target = await loadProject(root, targetProjectId);
      if (
        target.lineage.kind !== "fork" ||
        target.lineage.derivedFrom !== sourceProjectId ||
        target.lineage.supersedes !== sourceProjectId ||
        target.question !== source.question
      ) {
        throw new CliError("Committed fork target identity changed.", {
          code: "RESEARCH_PROJECT_FORK_CONFLICT",
          exitCode: 3,
          details: { sourceProjectId, targetProjectId },
        });
      }
      return target;
    }
    assertProjectAuthority(source, authority);
    if (source.status === "archived" || source.status === "abandoned") {
      throw new CliError(`Project ${sourceProjectId} is ${source.status} and cannot be forked.`, {
        code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
        exitCode: 3,
      });
    }
    if (source.handoff.state !== "agent-actionable") {
      throw new CliError(
        `Project ${sourceProjectId} has an unresolved ${source.handoff.state} handoff.`,
        { code: "RESEARCH_PROJECT_HANDOFF_REQUIRED", exitCode: 3 },
      );
    }
    const targetRoot = join(workspacePaths(root).projects, targetProjectId);
    if (
      authority.registered.has(targetProjectId) ||
      (await lstat(targetRoot).catch(() => undefined))
    ) {
      throw new CliError(`Research project already exists: ${targetProjectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const targetPolicy = scientificReapproval?.publicationPolicy ?? null;
    if (targetPolicy && targetPolicy.projectId !== targetProjectId) {
      throw new CliError("Recovery policy must be approved for the target project generation.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const targetScientificDesign = scientificReapproval
      ? prepareScientificDesignBinding(
          targetProjectId,
          scientificReapproval.publicationPolicy,
          scientificReapproval.scientificDesign,
        )
      : null;
    if (scientificReapproval) {
      await assertScientificDesignObjectBindings(
        root,
        scientificReapproval.scientificDesign.design.contract,
      );
    }
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        source.question,
        source.evidenceRequirements,
        null,
        {
          publicationPolicy: targetPolicy,
          scientificDesign: scientificReapproval?.scientificDesign.design ?? null,
        },
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Recovery generation was blocked by production preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const packages = defaultWorkPackages(config);
    const inheritedStages = resumeThrough
      ? ["discover", "acquire", "analyze", "synthesize"].slice(
          0,
          ["discover", "acquire", "analyze", "synthesize"].indexOf(resumeThrough) + 1,
        )
      : [];
    for (const stage of inheritedStages) {
      const sourcePackage = source.packages.find((item) => item.stage === stage);
      if (sourcePackage?.status !== "complete") {
        throw new CliError(`Cannot fork through incomplete package: ${stage}.`, {
          code: "RESEARCH_PROJECT_FORK_INVALID",
          exitCode: 2,
        });
      }
    }
    if (
      targetScientificDesign &&
      inheritedStages.some((stage) => stage === "analyze" || stage === "synthesize")
    ) {
      throw new CliError(
        "Top-journal recovery cannot inherit analysis before the target generation completes its own scientific reviews.",
        {
          code: "RESEARCH_PROJECT_FORK_RESUME_UNAVAILABLE",
          exitCode: 3,
          details: {
            requestedResumeThrough: resumeThrough ?? null,
            maximumResumeThrough: "acquire",
            requiredAction:
              "Fork through acquire, verify the rebuilt typed-content snapshot, and complete the target evidence-construct and pilot-methods reviews before analysis.",
          },
        },
      );
    }
    const sourceContentPath = join(
      workspacePaths(root).projects,
      sourceProjectId,
      "outputs",
      "content-snapshot.json",
    );
    const sourceContent =
      inheritedStages.includes("acquire") && (await pathExists(sourceContentPath))
        ? await loadCurrentEvidenceContentSnapshot(root, sourceProjectId)
        : null;
    const now = new Date().toISOString();
    for (const workPackage of packages) {
      if (inheritedStages.includes(workPackage.stage)) {
        workPackage.status = "complete";
        workPackage.completedAt = now;
      }
    }
    const project: ProjectState = {
      schemaVersion: 1,
      id: targetProjectId,
      question: source.question,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      budgetConfirmedAt: source.budgetConfirmedAt,
      ...(source.budget ? { budget: inheritedProjectBudget(source)! } : {}),
      inputs: source.inputs.map((input) => ({ ...input })),
      evidenceRequirements: {
        ...source.evidenceRequirements,
        dimensions: [...source.evidenceRequirements.dimensions],
        sourceTypes: [...source.evidenceRequirements.sourceTypes],
        requiredCapabilityIds: [...(source.evidenceRequirements.requiredCapabilityIds ?? [])],
        requiredCompanionIds: [...(source.evidenceRequirements.requiredCompanionIds ?? [])],
        requiredDiscoveryScopes: [...(source.evidenceRequirements.requiredDiscoveryScopes ?? [])],
      },
      publicationPolicy: targetPolicy,
      scientificDesign: targetScientificDesign,
      packages,
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: {
        ...initialLineage("fork"),
        derivedFrom: sourceProjectId,
        supersedes: sourceProjectId,
      },
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    let mutation = await beginProjectMutation(root, "fork", source, requestSha256, targetProjectId);
    try {
      await Promise.all([
        ensureDirectory(targetRoot),
        ensureDirectory(join(targetRoot, "outputs")),
        ensureDirectory(join(targetRoot, "runs")),
      ]);
      if (targetScientificDesign && scientificReapproval) {
        await writeJsonAtomic(
          join(workspacePaths(root).control, targetScientificDesign.objectLocator),
          scientificReapproval.scientificDesign.design.contract,
        );
      }
      const inheritedOutputs: Array<{ path: string; sha256: string; bytes: number }> = [];
      const stageOutput: Record<string, string> = {
        discover: "outputs/evidence.json",
        acquire: "outputs/acquisition.json",
        analyze: "outputs/analysis.json",
        synthesize: "outputs/report.md",
      };
      for (const stage of inheritedStages) {
        const logicalPath = stageOutput[stage]!;
        const sourcePath = join(workspacePaths(root).projects, sourceProjectId, logicalPath);
        const record = await fileRecord(sourcePath, logicalPath);
        const destination = join(targetRoot, logicalPath);
        await ensureDirectory(dirname(destination));
        await cp(sourcePath, destination, { errorOnExist: true, force: false });
        inheritedOutputs.push(record);
      }
      if (inheritedStages.includes("discover")) {
        await cloneProjectEvidenceReceipts(root, sourceProjectId, targetProjectId);
        await cloneEvidenceLedger(root, sourceProjectId, targetProjectId);
      }
      if (inheritedStages.includes("discover")) {
        const sourceDesign = source.scientificDesign
          ? await loadBoundAcquisitionDesign(root, source)
          : null;
        const inheritedArtifacts = await cloneProjectArtifactRecords(
          root,
          sourceProjectId,
          targetProjectId,
        );
        // Retain the original signed Download binding as historical provenance;
        // never pretend a recovery generation made a fresh network request.
        const provenanceDesigns = new Map([[source.id, sourceDesign]]);
        for (const artifact of inheritedArtifacts) {
          const binding = artifact.downloadBinding;
          if (!binding) continue;
          // A second recovery may retain an earlier ancestor's receipt. Validate
          // the plan that actually authorized that download, not a later plan.
          if (!provenanceDesigns.has(binding.projectId)) {
            const origin = await loadProject(root, binding.projectId);
            provenanceDesigns.set(
              origin.id,
              origin.scientificDesign ? await loadBoundAcquisitionDesign(root, origin) : null,
            );
          }
          const originDesign = provenanceDesigns.get(binding.projectId);
          if (!originDesign && binding.acquisitionRouteId === null) continue;
          const route = originDesign?.acquisitionPlan.routes.find(
            (item) => item.id === binding.acquisitionRouteId,
          );
          if (
            !route ||
            route.executor !== "agent" ||
            !["open-access-download", "authorized-browser"].includes(route.routeClass) ||
            !route.downloadBackends.includes(binding.backend)
          ) {
            throw new CliError(
              "Inherited artifact no longer binds its original acquisition route and download backend.",
              {
                code: "RESEARCH_PROJECT_FORK_ARTIFACT_ROUTE_INVALID",
                exitCode: 3,
                details: { artifactId: artifact.artifactId },
              },
            );
          }
        }
      }
      refreshProject(project);
      await writeJsonAtomic(join(targetRoot, "project.json"), project);
      if (inheritedStages.includes("acquire")) {
        await freezeEvidenceSnapshot(root, project);
        inheritedOutputs.push(
          await fileRecord(
            join(targetRoot, "outputs", "evidence-snapshot.json"),
            "outputs/evidence-snapshot.json",
          ),
        );
        await saveProject(root, project);
        if (sourceContent) {
          for (const decomposition of sourceContent.decompositions) {
            await recordArtifactDecomposition({
              root,
              projectId: targetProjectId,
              value: {
                schemaVersion: 1,
                sourceArtifactId: decomposition.sourceArtifactId,
                status: decomposition.status,
                parser: decomposition.parser,
                outputArtifactIds: decomposition.outputArtifactIds,
                contentClasses: decomposition.contentClasses,
                limitations: decomposition.limitations,
              },
            });
          }
          for (const atom of sourceContent.atoms) {
            await registerEvidenceAtom({
              root,
              projectId: targetProjectId,
              value: {
                schemaVersion: 1,
                atomId: atom.atomId,
                sourceId: atom.sourceId,
                candidateId: atom.candidateId,
                artifactId: atom.artifactId,
                locator: atom.locator,
                statement: atom.statement,
                evidenceRoleIds: atom.evidenceRoleIds,
                coverageDimensionIds: atom.coverageDimensionIds,
                evidenceFunction: atom.evidenceFunction,
                scope: atom.scope,
                limitations: atom.limitations,
              },
            });
          }
          await freezeEvidenceContentSnapshot(root, targetProjectId);
          inheritedOutputs.push(
            await fileRecord(
              join(targetRoot, "outputs", "content-snapshot.json"),
              "outputs/content-snapshot.json",
            ),
          );
        }
      }
      if (inheritedStages.includes("analyze")) {
        const { freezeClaimEvidenceGraph, freezeInferenceSnapshot } =
          await import("./inference.js");
        const inference = await freezeInferenceSnapshot(root, targetProjectId);
        const analysisPath = join(targetRoot, "outputs", "analysis.json");
        const analysis = await readJsonFile<Record<string, unknown>>(
          analysisPath,
          `Inherited analysis for ${targetProjectId}`,
        );
        analysis.inferenceSnapshotSha256 = inference.snapshotSha256;
        await writeJsonAtomic(analysisPath, analysis);
        await freezeClaimEvidenceGraph(root, targetProjectId, analysis);
        const priorAnalysisIndex = inheritedOutputs.findIndex(
          (record) => record.path === "outputs/analysis.json",
        );
        const reboundAnalysis = await fileRecord(analysisPath, "outputs/analysis.json");
        if (priorAnalysisIndex >= 0) inheritedOutputs[priorAnalysisIndex] = reboundAnalysis;
        else inheritedOutputs.push(reboundAnalysis);
        inheritedOutputs.push(
          await fileRecord(
            join(targetRoot, "outputs", "inference-snapshot.json"),
            "outputs/inference-snapshot.json",
          ),
          await fileRecord(
            join(targetRoot, "outputs", "claim-evidence-graph.json"),
            "outputs/claim-evidence-graph.json",
          ),
        );
      }
      source.lineage.supersededBy = targetProjectId;
      source.evidenceState.staleReason = `Superseded by recovery fork ${targetProjectId}.`;
      refreshProject(source);
      // All target bytes and metadata precede the single journal commit point.
      const taskContract = await inheritProjectTask(root, source, project);
      await saveProject(root, project);
      mutation = await prepareProjectMutation(root, mutation, source);
      await appendJournalEvent(workspacePaths(root).journal, "project.forked", targetProjectId, {
        sourceProjectId,
        targetProjectId,
        resumeThrough: resumeThrough ?? null,
        inheritedOutputs,
        inheritedUsage: false,
        sourceSuperseded: true,
        mutation: projectMutationBinding(mutation),
        taskContract,
        publicationPolicySha256: targetPolicy?.resolvedPolicySha256 ?? null,
        scientificDesignSha256: targetScientificDesign?.designSha256 ?? null,
        scientificDesignProducerSessionSha256:
          targetScientificDesign?.producer.sessionSha256 ?? null,
      });
      await settleProjectMutation(root, mutation);
      return project;
    } catch (error) {
      if (await settleProjectMutation(root, mutation)) return loadProject(root, targetProjectId);
      throw error;
    }
  });
}

export async function setProjectDisposition(
  root: string,
  projectId: string,
  disposition: "archived" | "abandoned",
  reason: string,
): Promise<ProjectState> {
  validateProjectId(projectId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 8 || normalizedReason.length > 500) {
    throw new CliError("Project disposition reason must contain 8-500 characters.", {
      code: "RESEARCH_PROJECT_DISPOSITION_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, `project.${disposition}`, async () => {
    const project = refreshProject(await loadProject(root, projectId));
    if (
      project.status === "running" ||
      project.packages.some((item) => item.status === "running")
    ) {
      throw new CliError(
        "Abort the active native stage before archiving or abandoning this project.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    if (project.status === "archived" || project.status === "abandoned") {
      if (project.status === disposition) return project;
      throw new CliError(`Project is already ${project.status}.`, {
        code: "RESEARCH_PROJECT_DISPOSITION_INVALID",
        exitCode: 3,
      });
    }
    if (disposition === "archived" && project.status !== "complete" && project.status !== "stale") {
      throw new CliError(
        "Archive is for complete or superseded history; use abandon for unfinished work.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    if (
      disposition === "abandoned" &&
      (project.status === "complete" || project.status === "stale")
    ) {
      throw new CliError(
        "Abandon is for unfinished work; archive complete or superseded history instead.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    project.status = disposition;
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await appendJournalEvent(workspacePaths(root).journal, `project.${disposition}`, projectId, {
      projectId,
      disposition,
      reason: normalizedReason,
      supersededBy: project.lineage.supersededBy,
    });
    return project;
  });
}

export async function createProjectAddendum(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
  scientificReapproval?: {
    publicationPolicy: ResearchPolicyBinding;
    scientificDesign: {
      design: VerifiedScientificDesign;
      producerAgent: AgentKind;
      producerSessionId: string;
    };
  },
): Promise<ProjectState> {
  validateProjectId(sourceProjectId);
  validateProjectId(targetProjectId);
  if (sourceProjectId === targetProjectId) {
    throw new CliError("Addendum target must use a different project ID.", {
      code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.addendum", async () => {
    const source = refreshProject(await loadProject(root, sourceProjectId));
    const sourceRequiresScientificReapproval = Boolean(
      source.publicationPolicy || source.scientificDesign,
    );
    if (sourceRequiresScientificReapproval && !scientificReapproval) {
      throw new CliError(
        "A top-journal addendum requires a newly approved project-specific policy and scientific design.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!sourceRequiresScientificReapproval && scientificReapproval) {
      throw new CliError("Scientific reapproval is valid only for a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    if (source.status !== "complete" || source.packages.at(-1)?.stage !== "close") {
      throw new CliError("An addendum requires a mechanically closed source project.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 3,
      });
    }
    if (source.lineage.supersededBy) {
      throw new CliError(
        `Project ${sourceProjectId} is already superseded by ${source.lineage.supersededBy}.`,
        { code: "RESEARCH_PROJECT_ADDENDUM_INVALID", exitCode: 3 },
      );
    }
    const snapshot = await loadCurrentEvidenceSnapshot(root, sourceProjectId);
    const closurePath = join(
      workspacePaths(root).projects,
      sourceProjectId,
      "outputs",
      "closure.json",
    );
    const closure = await readJsonFile<Record<string, unknown>>(
      closurePath,
      `Research closure ${sourceProjectId}`,
    ).catch(() => null);
    const closureSnapshot =
      closure?.evidenceSnapshot &&
      typeof closure.evidenceSnapshot === "object" &&
      !Array.isArray(closure.evidenceSnapshot)
        ? (closure.evidenceSnapshot as Record<string, unknown>)
        : null;
    if (
      closure?.projectId !== sourceProjectId ||
      closure?.status !== "complete" ||
      closureSnapshot?.snapshotId !== snapshot.snapshotId ||
      closureSnapshot?.snapshotSha256 !== snapshot.snapshotSha256 ||
      source.evidenceState.closureSnapshotId !== snapshot.snapshotId ||
      source.evidenceState.currentSnapshotSha256 !== snapshot.snapshotSha256
    ) {
      throw new CliError("Source closure is not bound to its current evidence snapshot.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 3,
      });
    }
    const targetRoot = join(workspacePaths(root).projects, targetProjectId);
    if (await lstat(targetRoot).catch(() => undefined)) {
      throw new CliError(`Research project already exists: ${targetProjectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const targetPolicy = scientificReapproval?.publicationPolicy ?? null;
    if (targetPolicy && targetPolicy.projectId !== targetProjectId) {
      throw new CliError("Addendum policy must be approved for the target project generation.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const targetScientificDesign = scientificReapproval
      ? prepareScientificDesignBinding(
          targetProjectId,
          scientificReapproval.publicationPolicy,
          scientificReapproval.scientificDesign,
        )
      : null;
    if (scientificReapproval) {
      await assertScientificDesignObjectBindings(
        root,
        scientificReapproval.scientificDesign.design.contract,
      );
    }
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        source.question,
        source.evidenceRequirements,
        null,
        {
          publicationPolicy: targetPolicy,
          scientificDesign: scientificReapproval?.scientificDesign.design ?? null,
        },
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Addendum generation was blocked by production preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const now = new Date().toISOString();
    const target: ProjectState = {
      schemaVersion: 1,
      id: targetProjectId,
      question: source.question,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      budgetConfirmedAt: source.budgetConfirmedAt,
      ...(source.budget ? { budget: inheritedProjectBudget(source)! } : {}),
      inputs: source.inputs.map((input) => ({ ...input })),
      evidenceRequirements: {
        ...source.evidenceRequirements,
        dimensions: [...source.evidenceRequirements.dimensions],
        sourceTypes: [...source.evidenceRequirements.sourceTypes],
        requiredCapabilityIds: [...(source.evidenceRequirements.requiredCapabilityIds ?? [])],
        requiredCompanionIds: [...(source.evidenceRequirements.requiredCompanionIds ?? [])],
        requiredDiscoveryScopes: [...(source.evidenceRequirements.requiredDiscoveryScopes ?? [])],
      },
      publicationPolicy: targetPolicy,
      scientificDesign: targetScientificDesign,
      packages: defaultWorkPackages(config),
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: {
        kind: "addendum",
        derivedFrom: sourceProjectId,
        supersedes: sourceProjectId,
        supersededBy: null,
        baseSnapshotId: snapshot.snapshotId,
        baseSnapshotSha256: snapshot.snapshotSha256,
      },
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    await Promise.all([
      ensureDirectory(targetRoot),
      ensureDirectory(join(targetRoot, "outputs")),
      ensureDirectory(join(targetRoot, "runs")),
      ensureDirectory(join(targetRoot, "evidence", "snapshots")),
    ]);
    if (targetScientificDesign && scientificReapproval) {
      await writeJsonAtomic(
        join(workspacePaths(root).control, targetScientificDesign.objectLocator),
        scientificReapproval.scientificDesign.design.contract,
      );
    }
    const inheritedOutputs: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const logicalPath of ["outputs/evidence.json", "outputs/acquisition.json"] as const) {
      const sourcePath = join(workspacePaths(root).projects, sourceProjectId, logicalPath);
      const destination = join(targetRoot, logicalPath);
      await cp(sourcePath, destination, { errorOnExist: true, force: false });
      inheritedOutputs.push(await fileRecord(destination, logicalPath));
    }
    const baseSnapshotLogicalPath = "outputs/base-evidence-snapshot.json";
    const sourceSnapshotPath = join(
      workspacePaths(root).projects,
      sourceProjectId,
      "evidence",
      "snapshots",
      `${snapshot.snapshotSha256}.json`,
    );
    const snapshotChain = await loadImmutableEvidenceSnapshotChain(
      root,
      sourceProjectId,
      snapshot.snapshotSha256,
    );
    for (const chainSnapshot of snapshotChain) {
      for (const record of [chainSnapshot.evidenceRecord, chainSnapshot.acquisitionRecord]) {
        const targetRecord = join(targetRoot, record.path);
        if (!(await pathExists(targetRecord))) {
          await ensureDirectory(dirname(targetRecord));
          await cp(
            join(workspacePaths(root).projects, sourceProjectId, record.path),
            targetRecord,
            {
              errorOnExist: true,
              force: false,
            },
          );
        }
      }
      await cp(
        join(
          workspacePaths(root).projects,
          sourceProjectId,
          "evidence",
          "snapshots",
          `${chainSnapshot.snapshotSha256}.json`,
        ),
        join(targetRoot, "evidence", "snapshots", `${chainSnapshot.snapshotSha256}.json`),
        { errorOnExist: true, force: false },
      );
    }
    await cp(sourceSnapshotPath, join(targetRoot, baseSnapshotLogicalPath), {
      errorOnExist: true,
      force: false,
    });
    inheritedOutputs.push(
      await fileRecord(join(targetRoot, baseSnapshotLogicalPath), baseSnapshotLogicalPath),
    );
    await cloneProjectEvidenceReceipts(root, sourceProjectId, targetProjectId);
    await cloneEvidenceLedger(root, sourceProjectId, targetProjectId);
    await cloneProjectArtifactRecords(root, sourceProjectId, targetProjectId);
    await appendEvidenceLedgerEvent(root, targetProjectId, "addendum.created", {
      sourceProjectId,
      targetProjectId,
      baseSnapshotId: snapshot.snapshotId,
      baseSnapshotSha256: snapshot.snapshotSha256,
    });
    await writeJsonAtomic(join(targetRoot, "project.json"), target);

    const taskContract = await inheritProjectTask(root, source, target);
    source.lineage.supersededBy = targetProjectId;
    source.evidenceState.staleReason = `Superseded by evidence addendum ${targetProjectId}.`;
    refreshProject(source);
    await saveProject(root, source);
    await appendEvidenceLedgerEvent(root, sourceProjectId, "project.superseded", {
      sourceProjectId,
      supersededBy: targetProjectId,
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
    });
    await appendJournalEvent(
      workspacePaths(root).journal,
      "project.addendum.created",
      targetProjectId,
      {
        sourceProjectId,
        targetProjectId,
        baseSnapshotId: snapshot.snapshotId,
        baseSnapshotSha256: snapshot.snapshotSha256,
        inheritedOutputs,
        originalClosurePreserved: true,
        taskContract,
        publicationPolicySha256: targetPolicy?.resolvedPolicySha256 ?? null,
        scientificDesignSha256: targetScientificDesign?.designSha256 ?? null,
        scientificDesignProducerSessionSha256:
          targetScientificDesign?.producer.sessionSha256 ?? null,
      },
    );
    return target;
  });
}

export function refreshProject(project: ProjectState): ProjectState {
  if (project.status === "archived" || project.status === "abandoned") return project;
  const now = Date.now();
  for (const workPackage of project.packages) {
    if (workPackage.status !== "pending" && workPackage.status !== "retry") continue;
    if (
      workPackage.status === "retry" &&
      workPackage.retryNotBefore &&
      Date.parse(workPackage.retryNotBefore) > now
    ) {
      continue;
    }
    const dependenciesComplete = workPackage.dependencies.every(
      (dependency) =>
        project.packages.find((candidate) => candidate.id === dependency)?.status === "complete",
    );
    if (dependenciesComplete) workPackage.status = "ready";
  }
  if (project.lineage.supersededBy || project.evidenceState.staleReason) project.status = "stale";
  else if (project.handoff.state === "user-action-required") project.status = "waiting-user";
  else if (project.handoff.state === "external-response-required")
    project.status = "waiting-external";
  else if (project.packages.some((item) => item.status === "failed")) project.status = "blocked";
  else if (project.packages.every((item) => item.status === "complete"))
    project.status = "complete";
  else if (blockingScientificGate(project)) project.status = "blocked";
  else if (project.packages.some((item) => item.status === "running")) project.status = "running";
  else project.status = "ready";
  project.updatedAt = new Date().toISOString();
  return project;
}

export function nextReadyPackage(project: ProjectState): WorkPackage | undefined {
  refreshProject(project);
  if (project.handoff.state !== "agent-actionable") return undefined;
  const candidate = project.packages.find((workPackage) => workPackage.status === "ready");
  if (!candidate) return undefined;
  if (blockingScientificGate(project)) return undefined;
  return candidate;
}

/** A future review obligation does not block the earlier evidence-gathering packages. */
export function blockingScientificGate(
  project: ProjectState,
): ReturnType<typeof nextScientificGate> {
  const gate = nextScientificGate(project);
  const unfinished = project.packages.find((workPackage) => workPackage.status !== "complete");
  if (!gate || !unfinished) return null;
  const packageOrder = ["discover", "acquire", "analyze", "synthesize", "review", "close"];
  return packageOrder.indexOf(unfinished.id) >= packageOrder.indexOf(gate.blocksPackage)
    ? gate
    : null;
}

export function scientificGateRecommendedAction(
  root: string,
  project: ProjectState,
  gate = blockingScientificGate(project),
): string | null {
  if (!gate) return null;
  if (gate.status === "stopped") {
    return `Scientific ${gate.role} review stopped the project; inspect the frozen review and request user or external action instead of continuing.`;
  }
  if (gate.status === "prepared") {
    return `Scientific ${gate.role} review is prepared. After approving its bounded review cost, explicitly execute the configured independent reviewer: tiangong-ai research project scientific review execute ${project.id} --role ${gate.role} --confirm-review-cost --workspace ${root}. Manual submission of an independently produced bound review remains available through scientific review submit; research run never launches this early review automatically.`;
  }
  const canaryOption =
    gate.role === "evidence-construct" ? " --canary-artifacts <absolute-json-array>" : "";
  const instruction =
    gate.status === "revision-required"
      ? `Revise the ${gate.role} assessment in the native producer App without editing frozen evidence, then prepare a fresh independent review`
      : `Use the native producer App to create a bounded ${gate.role} assessment from schema scientific-assessment-${gate.role}, then prepare an independent review`;
  return `${instruction}: tiangong-ai research project scientific review prepare ${project.id} --role ${gate.role} --assessment <absolute-json>${canaryOption} --reviewer-agent <codex|claude> --reviewer-session <fresh-opaque-id> --workspace ${root}`;
}

export function nextScientificGate(project: ProjectState): {
  role: ScientificReviewRole;
  blocksPackage: "discover" | "acquire" | "analyze";
  status: ScientificDesignBinding["gates"][ScientificReviewRole]["status"];
} | null {
  if (!project.scientificDesign) return null;
  const ordered: Array<{
    role: ScientificReviewRole;
    blocksPackage: "discover" | "acquire" | "analyze";
  }> = [
    { role: "research-design", blocksPackage: "discover" },
    { role: "evidence-construct", blocksPackage: "analyze" },
    { role: "pilot-methods", blocksPackage: "analyze" },
  ];
  for (const item of ordered) {
    const status = project.scientificDesign.gates[item.role].status;
    if (status !== "passed") return { ...item, status };
  }
  return null;
}

export function packageById(project: ProjectState, packageId: string): WorkPackage {
  const workPackage = project.packages.find((candidate) => candidate.id === packageId);
  if (!workPackage) {
    throw new CliError(`Unknown work package ${packageId} in project ${project.id}.`, {
      code: "RESEARCH_PACKAGE_INVALID",
      exitCode: 2,
    });
  }
  return workPackage;
}

function defaultWorkPackages(config: WorkspaceConfig): WorkPackage[] {
  const maxAttempts = config.budget.maxAttemptsPerPackage;
  return [
    workPackage(
      "discover",
      "discover",
      "agent",
      "producer",
      [],
      ["outputs/evidence.json"],
      maxAttempts,
    ),
    workPackage(
      "acquire",
      "acquire",
      "agent",
      "producer",
      ["discover"],
      ["outputs/acquisition.json"],
      maxAttempts,
    ),
    workPackage(
      "analyze",
      "analyze",
      "agent",
      "producer",
      ["acquire"],
      ["outputs/analysis.json"],
      maxAttempts,
    ),
    workPackage(
      "synthesize",
      "synthesize",
      "agent",
      "producer",
      ["analyze"],
      ["outputs/report.md"],
      maxAttempts,
    ),
    workPackage(
      "review",
      "review",
      "agent",
      "reviewer",
      ["synthesize"],
      ["outputs/review.json"],
      maxAttempts,
    ),
    workPackage("close", "close", "verify", "mechanical", ["review"], ["outputs/closure.json"], 1),
  ];
}

function workPackage(
  id: string,
  stage: WorkPackage["stage"],
  kind: WorkPackage["kind"],
  executor: WorkPackage["executor"],
  dependencies: string[],
  expectedOutputs: string[],
  maxAttempts: number,
): WorkPackage {
  return {
    id,
    stage,
    kind,
    executor,
    dependencies,
    expectedOutputs,
    status: dependencies.length ? "pending" : "ready",
    attempts: 0,
    maxAttempts,
    lastError: null,
    lastFailureKind: null,
    retryNotBefore: null,
    startedAt: null,
    completedAt: null,
  };
}

function validateProjectShape(project: ProjectState, expectedId: string): void {
  if (
    project.schemaVersion !== 1 ||
    project.id !== expectedId ||
    !PROJECT_ID_PATTERN.test(project.id) ||
    !isProjectStatus(project.status) ||
    typeof project.question !== "string" ||
    (project.budgetConfirmedAt !== null && typeof project.budgetConfirmedAt !== "string") ||
    (project.budget !== undefined && !isProjectBudgetState(project.budget)) ||
    !Array.isArray(project.inputs) ||
    !isEvidenceRequirements(project.evidenceRequirements) ||
    !isScientificDesignBinding(project.scientificDesign, expectedId) ||
    (Boolean(project.publicationPolicy) && project.scientificDesign === null) ||
    !Array.isArray(project.packages) ||
    !project.usage ||
    typeof project.usage.tokens !== "number" ||
    typeof project.usage.inputTokens !== "number" ||
    typeof project.usage.cachedInputTokens !== "number" ||
    typeof project.usage.outputTokens !== "number" ||
    typeof project.usage.costUsd !== "number" ||
    typeof project.usage.wallSeconds !== "number" ||
    !isProjectLineage(project.lineage) ||
    !isProjectHandoff(project.handoff) ||
    !isProjectEvidenceState(project.evidenceState)
  ) {
    throw new CliError(`Research project state is invalid: ${expectedId}`, {
      code: "RESEARCH_PROJECT_INVALID",
      exitCode: 2,
    });
  }
  const packageIds = new Set(project.packages.map((item) => item.id));
  if (
    packageIds.size !== project.packages.length ||
    project.packages.some(
      (item) =>
        !["agent", "verify"].includes(item.kind) ||
        !["producer", "reviewer", "mechanical"].includes(item.executor) ||
        item.dependencies.some((dependency) => !packageIds.has(dependency)) ||
        item.expectedOutputs.some((path) => !path.startsWith("outputs/")),
    )
  ) {
    throw new CliError(`Research project work packages are invalid: ${expectedId}`, {
      code: "RESEARCH_PROJECT_INVALID",
      exitCode: 2,
    });
  }
}

function initialLineage(kind: ProjectState["lineage"]["kind"]): ProjectState["lineage"] {
  return {
    kind,
    derivedFrom: null,
    supersedes: null,
    supersededBy: null,
    baseSnapshotId: null,
    baseSnapshotSha256: null,
  };
}

function initialEvidenceState(): ProjectState["evidenceState"] {
  return {
    currentSnapshotId: null,
    currentSnapshotSha256: null,
    closureSnapshotId: null,
    staleReason: null,
  };
}

function initialHandoffState(): ProjectState["handoff"] {
  return {
    state: "agent-actionable",
    kind: null,
    reasonCode: null,
    summary: null,
    requestedActions: [],
    evidenceGaps: [],
    exhaustion: null,
    accessRequests: [],
    requestedAt: null,
    resolvedAt: null,
    resolutionNote: null,
  };
}

function prepareScientificDesignBinding(
  projectId: string,
  policy: ResearchPolicyBinding,
  input: {
    design: VerifiedScientificDesign;
    producerAgent: AgentKind;
    producerSessionId: string;
  },
): ScientificDesignBinding {
  const contract = input.design.contract;
  const normalized = `${JSON.stringify(contract, null, 2)}\n`;
  if (
    contract.projectId !== projectId ||
    input.design.sha256 !== sha256Text(normalized) ||
    input.design.bytes !== Buffer.byteLength(normalized, "utf8")
  ) {
    throw new CliError("Scientific design does not match its verified project and hash binding.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_PROJECT_MISMATCH",
      exitCode: 2,
    });
  }
  if (!input.producerSessionId.trim()) {
    throw new CliError("Scientific design requires an opaque native producer session identifier.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_PRODUCER_INVALID",
      exitCode: 2,
    });
  }
  if (
    policy.targetJournal &&
    policy.targetJournal.trim().toLocaleLowerCase("en-US") !==
      contract.identity.targetJournals.primary.trim().toLocaleLowerCase("en-US")
  ) {
    throw new CliError("Scientific design primary journal does not match Research Policy.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
      exitCode: 2,
    });
  }
  const expectedJournalApprovalStatus = policy.targetJournal ? "policy-approved" : "candidate-only";
  if (contract.identity.targetJournals.approvalStatus !== expectedJournalApprovalStatus) {
    throw new CliError(
      policy.targetJournal
        ? "An exact-journal Research Policy requires a policy-approved scientific design target."
        : "A generic Research Policy may list exact journals only as candidates.",
      {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
        exitCode: 2,
        details: {
          expectedApprovalStatus: expectedJournalApprovalStatus,
          actualApprovalStatus: contract.identity.targetJournals.approvalStatus,
        },
      },
    );
  }
  const evaluation = evaluateScientificDesign(contract);
  if (!evaluation.readyForDesignReview) {
    throw new CliError("Scientific design has blocking mechanical issues.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_BLOCKED",
      exitCode: 3,
      details: { issueCodes: evaluation.issueCodes },
    });
  }
  const policyGaps = scientificDesignPolicyGaps(contract, policy);
  if (policyGaps.length) {
    throw new CliError("Scientific design does not discharge the approved Research Policy.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
      exitCode: 3,
      details: { gaps: policyGaps },
    });
  }
  const pendingGate = () => ({
    status: "pending" as const,
    packetSha256: null,
    assessmentSha256: null,
    reviewSha256: null,
    reviewerSessionSha256: null,
  });
  return {
    schemaVersion: 1,
    designSha256: input.design.sha256,
    objectLocator: `projects/${projectId}/scientific/design/objects/${input.design.sha256}.json`,
    centralStudyKind: contract.identity.centralStudyKind,
    producer: {
      agent: input.producerAgent,
      sessionSha256: sha256Text(input.producerSessionId),
    },
    mechanicalIssueCodes: evaluation.issueCodes,
    gates: {
      "research-design": pendingGate(),
      "evidence-construct": pendingGate(),
      "pilot-methods": pendingGate(),
    },
  };
}

function isScientificDesignBinding(
  value: unknown,
  projectId: string,
): value is ScientificDesignBinding | null {
  if (value === null) return true;
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (
    typeof value.designSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.designSha256) ||
    (value.fulfillmentSha256 !== undefined && !nullableSha256(value.fulfillmentSha256)) ||
    value.objectLocator !==
      `projects/${projectId}/scientific/design/objects/${value.designSha256}.json` ||
    typeof value.centralStudyKind !== "string" ||
    !isObject(value.producer) ||
    !["codex", "claude", "workbuddy", "codebuddy"].includes(String(value.producer.agent)) ||
    typeof value.producer.sessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.producer.sessionSha256) ||
    !Array.isArray(value.mechanicalIssueCodes) ||
    value.mechanicalIssueCodes.some((item) => typeof item !== "string") ||
    !isObject(value.gates)
  ) {
    return false;
  }
  const roles: ScientificReviewRole[] = ["research-design", "evidence-construct", "pilot-methods"];
  const gates = value.gates as Record<string, unknown>;
  return roles.every((role) => isScientificGateBinding(gates[role]));
}

function isScientificGateBinding(value: unknown): boolean {
  return (
    isObject(value) &&
    ["pending", "prepared", "passed", "revision-required", "stopped"].includes(
      String(value.status),
    ) &&
    nullableSha256(value.packetSha256) &&
    nullableSha256(value.assessmentSha256) &&
    nullableSha256(value.reviewSha256) &&
    nullableSha256(value.reviewerSessionSha256)
  );
}

function isProjectLineage(value: unknown): value is ProjectState["lineage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = value as Record<string, unknown>;
  return (
    ["primary", "fork", "addendum"].includes(String(lineage.kind)) &&
    nullableString(lineage.derivedFrom) &&
    nullableString(lineage.supersedes) &&
    nullableString(lineage.supersededBy) &&
    nullableString(lineage.baseSnapshotId) &&
    nullableSha256(lineage.baseSnapshotSha256)
  );
}

function isProjectEvidenceState(value: unknown): value is ProjectState["evidenceState"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    nullableString(state.currentSnapshotId) &&
    nullableSha256(state.currentSnapshotSha256) &&
    nullableString(state.closureSnapshotId) &&
    nullableString(state.staleReason)
  );
}

function isProjectHandoff(value: unknown): value is ProjectState["handoff"] {
  if (!isObject(value)) return false;
  return (
    ["agent-actionable", "user-action-required", "external-response-required"].includes(
      String(value.state),
    ) &&
    (value.kind === null ||
      ["interactive-challenge", "external-wait", "evidence-exhausted"].includes(
        String(value.kind),
      )) &&
    nullableString(value.reasonCode) &&
    nullableString(value.summary) &&
    Array.isArray(value.requestedActions) &&
    value.requestedActions.every((item) => typeof item === "string") &&
    Array.isArray(value.evidenceGaps) &&
    value.evidenceGaps.every((item) => typeof item === "string") &&
    isEvidenceExhaustion(value.exhaustion) &&
    Array.isArray(value.accessRequests) &&
    value.accessRequests.every(isAccessRequest) &&
    nullableString(value.requestedAt) &&
    nullableString(value.resolvedAt) &&
    nullableString(value.resolutionNote)
  );
}

function isEvidenceExhaustion(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    Array.isArray(value.missingEvidenceRoleIds) &&
    value.missingEvidenceRoleIds.every(isIdentifier) &&
    Array.isArray(value.routeAttempts) &&
    value.routeAttempts.every(
      (attempt) =>
        isObject(attempt) &&
        isIdentifier(attempt.routeId) &&
        Array.isArray(attempt.terminalEventHashes) &&
        attempt.terminalEventHashes.every(
          (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
        ) &&
        ["completed-insufficient", "access-blocked", "deterministic-unavailable"].includes(
          String(attempt.outcome),
        ),
    ) &&
    Array.isArray(value.remainingRouteIds) &&
    value.remainingRouteIds.every(isIdentifier)
  );
}

function isAccessRequest(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isIdentifier(value.id) &&
    isIdentifier(value.routeId) &&
    [
      "database-subscription",
      "article-purchase",
      "institutional-access",
      "licensed-dataset",
      "owner-provided-material",
      "external-data-request",
      "field-data-collection",
    ].includes(String(value.resourceType)) &&
    typeof value.resourceName === "string" &&
    nullableString(value.officialLocator) &&
    Array.isArray(value.evidenceRoleIds) &&
    value.evidenceRoleIds.every(isIdentifier) &&
    typeof value.rationale === "string" &&
    Array.isArray(value.alternativesTriedRouteIds) &&
    value.alternativesTriedRouteIds.every(isIdentifier) &&
    typeof value.requestedAction === "string" &&
    typeof value.resumeCriteria === "string" &&
    ["unknown", "provider-quote-required"].includes(String(value.costStatus))
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function defaultEvidenceRequirements(config: WorkspaceConfig): ProjectEvidenceRequirements {
  return config.mode === "production-research"
    ? {
        dimensions: ["research-question"],
        sourceTypes: ["primary"],
        requiredCapabilityIds: [],
        requiredCompanionIds: [],
        requiredDiscoveryScopes: [],
        minSources: 3,
        minFullTextSources: 1,
        minDatedSources: 1,
        publicationDateFrom: null,
        publicationDateTo: null,
      }
    : {
        dimensions: ["research-question"],
        sourceTypes: [],
        requiredCapabilityIds: [],
        requiredCompanionIds: [],
        requiredDiscoveryScopes: [],
        minSources: 1,
        minFullTextSources: 0,
        minDatedSources: 0,
        publicationDateFrom: null,
        publicationDateTo: null,
      };
}

export function normalizeEvidenceRequirements(
  value: ProjectEvidenceRequirements,
): ProjectEvidenceRequirements {
  const normalized = {
    dimensions: [...new Set(value.dimensions.map(normalizeRequirementId))].sort(),
    sourceTypes: [...new Set(value.sourceTypes.map(normalizeRequirementId))].sort(),
    requiredCapabilityIds: [
      ...new Set((value.requiredCapabilityIds ?? []).map(normalizeRequirementId)),
    ].sort(),
    requiredCompanionIds: [
      ...new Set((value.requiredCompanionIds ?? []).map(normalizeRequirementId)),
    ].sort(),
    requiredDiscoveryScopes: [
      ...new Set((value.requiredDiscoveryScopes ?? []).map(normalizeRequirementId)),
    ].sort(),
    minSources: value.minSources,
    minFullTextSources: value.minFullTextSources,
    minDatedSources: value.minDatedSources,
    publicationDateFrom: value.publicationDateFrom,
    publicationDateTo: value.publicationDateTo,
  };
  if (!isEvidenceRequirements(normalized)) {
    throw new CliError("Evidence requirements are invalid.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  return normalized;
}

function isEvidenceRequirements(value: unknown): value is ProjectEvidenceRequirements {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as ProjectEvidenceRequirements).dimensions) &&
    (value as ProjectEvidenceRequirements).dimensions.length > 0 &&
    (value as ProjectEvidenceRequirements).dimensions.every(validRequirementId) &&
    Array.isArray((value as ProjectEvidenceRequirements).sourceTypes) &&
    (value as ProjectEvidenceRequirements).sourceTypes.every(validRequirementId) &&
    ((value as ProjectEvidenceRequirements).requiredCapabilityIds === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredCapabilityIds) &&
        (value as ProjectEvidenceRequirements).requiredCapabilityIds!.every(validRequirementId))) &&
    ((value as ProjectEvidenceRequirements).requiredCompanionIds === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredCompanionIds) &&
        (value as ProjectEvidenceRequirements).requiredCompanionIds!.every(validRequirementId))) &&
    ((value as ProjectEvidenceRequirements).requiredDiscoveryScopes === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredDiscoveryScopes) &&
        (value as ProjectEvidenceRequirements).requiredDiscoveryScopes!.every(
          validRequirementId,
        ))) &&
    Number.isInteger((value as ProjectEvidenceRequirements).minSources) &&
    (value as ProjectEvidenceRequirements).minSources > 0 &&
    Number.isInteger((value as ProjectEvidenceRequirements).minFullTextSources) &&
    (value as ProjectEvidenceRequirements).minFullTextSources >= 0 &&
    (value as ProjectEvidenceRequirements).minFullTextSources <=
      (value as ProjectEvidenceRequirements).minSources &&
    Number.isInteger((value as ProjectEvidenceRequirements).minDatedSources) &&
    (value as ProjectEvidenceRequirements).minDatedSources >= 0 &&
    (value as ProjectEvidenceRequirements).minDatedSources <=
      (value as ProjectEvidenceRequirements).minSources &&
    validDateBoundary((value as ProjectEvidenceRequirements).publicationDateFrom) &&
    validDateBoundary((value as ProjectEvidenceRequirements).publicationDateTo) &&
    dateRangeOrdered(
      (value as ProjectEvidenceRequirements).publicationDateFrom,
      (value as ProjectEvidenceRequirements).publicationDateTo,
    )
  );
}

function validDateBoundary(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function dateRangeOrdered(from: string | null, to: string | null): boolean {
  return from === null || to === null || from <= to;
}

function normalizeRequirementId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
}

function validRequirementId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new CliError(
      "Project ID must contain 3-64 lowercase letters, digits, or hyphens and start with a letter or digit.",
      { code: "RESEARCH_PROJECT_ID_INVALID", exitCode: 2 },
    );
  }
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return result || randomUUID().slice(0, 8);
}

async function hashQuestion(question: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(question, "utf8").digest("hex");
}

export async function setProjectBudget(
  root: string,
  projectId: string,
  maxCostUsd: number,
  confirm: boolean,
  providerLimits?: Record<string, number>,
) {
  projectBudgetAmount(maxCostUsd);
  const checkedLimits =
    providerLimits === undefined ? undefined : providerCostLimits(providerLimits);
  return withWorkspaceLock(root, "project.budget.set", async () => {
    const authority = await readProjectAuthorityIndex(root);
    const project = await loadProject(root, projectId);
    assertProjectAuthority(project, authority);
    const config = await loadWorkspaceConfig(root);
    const existing = project.budget;
    const pricesChanged =
      checkedLimits !== undefined &&
      canonicalJson(checkedLimits) !==
        canonicalJson(existing?.authorization.providerOperationMaxCostUsd ?? {});
    if (pricesChanged && !confirm)
      throw new CliError("Changing declared provider cost maxima requires --confirm-budget.", {
        code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
        exitCode: 2,
      });
    if (existing?.authorization.maxCostUsd === maxCostUsd && !pricesChanged)
      return { projectId, budget: projectBudgetView(project, config), replayed: true };
    if (existing && maxCostUsd > existing.authorization.maxCostUsd && !confirm)
      throw new CliError("Increasing the project budget requires --confirm-budget.", {
        code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
        exitCode: 2,
      });
    if (
      !existing &&
      Math.min(config.budget.maxCostUsd, maxCostUsd) > config.budget.confirmationCostUsd &&
      !confirm
    )
      throw new CliError(
        "The project budget requires --confirm-budget above the configured threshold.",
        { code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED", exitCode: 2 },
      );
    const proposed = existing
      ? structuredClone(existing)
      : createProjectBudget(projectId, maxCostUsd, project.usage.costUsd);
    proposed.authorization.maxCostUsd = maxCostUsd;
    if (checkedLimits !== undefined)
      proposed.authorization.providerOperationMaxCostUsd = checkedLimits;
    if (!existing) {
      proposed.openingBasis = "legacy-accounting";
      // Reuse the validated native packet instead of inventing a zero pending cost.
      const { nativeStageBudgetReservation } = await import("./runtime.js");
      const native = await nativeStageBudgetReservation(root, projectId);
      if (native && !config.producer.pricing)
        throw new CliError(
          "The existing native operation has no declared pricing; its cost cannot be adopted as zero.",
          { code: "RESEARCH_PROJECT_BUDGET_PRICE_REQUIRED", exitCode: 3 },
        );
      if (native) {
        proposed.entries.push({
          ...native,
          authorizationRevision: 1,
          status: "reserved",
          accountedCostUsd: null,
          settlementBasis: null,
          settledAt: null,
        });
      }
    }
    const candidate = { ...project, budget: proposed };
    const limit = Math.min(config.budget.maxCostUsd, maxCostUsd);
    if (projectCostExposure(candidate) > limit + 1e-9)
      throw new CliError(
        "The new budget cannot cover existing accounted cost and outstanding reservations.",
        {
          code: "RESEARCH_BUDGET_RESERVATION_FAILED",
          exitCode: 3,
          details: {
            proposedMaxCostUsd: maxCostUsd,
            existingExposureUsd: projectCostExposure(candidate),
          },
        },
      );
    proposed.authorization.revision = existing ? existing.authorization.revision + 1 : 1;
    proposed.authorization.authorizedAt = new Date().toISOString();
    project.budget = proposed;
    project.budgetConfirmedAt = proposed.authorization.authorizedAt;
    await saveProject(root, project);
    await appendJournalEvent(
      workspacePaths(root).journal,
      "project.budget.authorized",
      project.id,
      {
        authorization: proposed.authorization,
        openingEstimateUsd: proposed.openingEstimateUsd,
        outstandingReservationIds: proposed.entries
          .filter((e) => e.status === "reserved")
          .map((e) => e.id),
      },
    );
    return { projectId, budget: projectBudgetView(project, config), replayed: false };
  });
}

export async function resolveProjectBudgetReservation(
  root: string,
  projectId: string,
  id: string,
  amount: number,
  reason: string,
  confirm: boolean,
) {
  if (!confirm)
    throw new CliError("Resolving unknown costs requires explicit --confirm-budget.", {
      code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
      exitCode: 2,
    });
  if (!Number.isFinite(amount) || amount < 0 || reason.trim().length < 8 || reason.length > 1000)
    throw new CliError(
      "Supply a nonnegative finite accounting estimate and a bounded explanation.",
      { code: "RESEARCH_BUDGET_INVALID", exitCode: 2 },
    );
  return withWorkspaceLock(root, "project.budget.resolve", async () => {
    const project = await loadProject(root, projectId);
    assertProjectAuthority(project, await readProjectAuthorityIndex(root));
    const entry = project.budget?.entries.find((item) => item.id === id);
    if (!entry)
      throw new CliError("The reservation does not exist in this project's budget authority.", {
        code: "RESEARCH_BUDGET_RESERVATION_MISSING",
        exitCode: 3,
      });
    const config = await loadWorkspaceConfig(root);
    if (entry.status === "settled") {
      if (
        entry.accountedCostUsd !== amount ||
        entry.settlementBasis !== "owner-estimate" ||
        entry.resolutionReason !== reason.trim()
      )
        throw new CliError("Settled cost evidence cannot be rewritten.", {
          code: "RESEARCH_BUDGET_RESERVATION_CONFLICT",
          exitCode: 3,
        });
      return { projectId, budget: projectBudgetView(project, config), replayed: true };
    }
    if (entry.kind === "native-stage") {
      validateProjectId(entry.sourceProjectId);
      const { nativeStageBudgetReservation } = await import("./runtime.js");
      const active = await nativeStageBudgetReservation(root, entry.sourceProjectId);
      if (active?.id === id)
        throw new CliError(
          "Complete or explicitly abort the native session before resolving its cost estimate.",
          { code: "RESEARCH_BUDGET_OPERATION_ACTIVE", exitCode: 3 },
        );
    }
    settleProjectCost(project, id, amount, "owner-estimate");
    entry.resolutionReason = reason.trim();
    await saveProject(root, project);
    await appendJournalEvent(
      workspacePaths(root).journal,
      "project.budget.reservation.resolved",
      project.id,
      {
        reservationId: id,
        sourceProjectId: entry.sourceProjectId,
        accountedCostUsd: amount,
        basis: "owner-estimate",
        reason: entry.resolutionReason,
        providerInvoiceVerified: false,
      },
    );
    return { projectId, budget: projectBudgetView(project, config), replayed: false };
  });
}

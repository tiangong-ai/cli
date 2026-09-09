import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { hostname, homedir, platform, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CliError } from "../../errors.js";
import { loadCapabilityDeclarations } from "./capabilities.js";
import { inspectResearchContext } from "./context.js";
import { inspectExactResearchCliRelease } from "./setup-release.js";
import {
  researchSetupRuntimeSha256,
  assertResearchSetupRuntimeIntegrity,
} from "./setup-runtime-integrity.js";
import {
  inspectCapabilityCredentialEnvironment,
  loadCapabilityCredentialMapForIds,
  reconcileCapabilityCredentialEnvironment,
  setCapabilityCredentialValue,
} from "./credentials.js";
import {
  configureExternalSkillProfile,
  configureTiangongDatabaseCapability,
  doctorExternalCapabilities,
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
  reconcileSetupManagedCapabilities,
} from "./external-skills.js";
import { appendJournalEvent } from "./journal.js";
import { researchPlatformCapabilities } from "./platform-capabilities.js";
import { validateResearchPolicyPack } from "./research-policy.js";
import {
  configuredResearchSecrets,
  isSensitiveEnvironmentName,
  sanitizeResearchRecord,
  sanitizeResearchText,
} from "./sanitization.js";
import {
  inspectResearchSetupCatalog,
  RESEARCH_SETUP_CREDENTIALS,
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SETTINGS,
  RESEARCH_SETUP_SKILLS,
  RESEARCH_SETUP_SOURCES,
  resolveSetupSkills,
  setupSkill,
  setupSource,
  setupTargetRoot,
  verifyResearchSetupRuntimeContract,
  type ResearchSetupAgent,
  type ResearchSetupCredential,
  type ResearchSetupScope,
  type ResearchSetupSkill,
} from "./setup-catalog.js";
import {
  inspectResearchSetupInstructionRouting,
  isResearchSetupInstructionRoutingPlan,
  planResearchSetupInstructionRouting,
  reconcileResearchSetupInstructionRouting,
  type ResearchSetupInstructionRoutingPlan,
} from "./setup-instructions.js";
import {
  acquireFileLock,
  canonicalJson,
  ensureDirectory,
  fileSize,
  hashRegularTree,
  isObject,
  pathExists,
  REGULAR_TREE_HASH_ALGORITHM,
  readJsonFile,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import {
  packageRoot,
  packageVersion,
  RESEARCH_PACKAGE_NAME,
  SETUP_UPGRADING_MARKER,
} from "./constants.js";
import { inspectReviewerBridgeStatus } from "./review-executor.js";
import {
  exactResearchCliCommand,
  pinResearchCliCommand,
  researchSetupApplyCommand,
  researchSetupRetryCommand,
} from "./setup-invocation.js";
import type {
  AgentKind,
  AgentPricing,
  AgentRoute,
  ResearchMode,
  ReviewExecutionConfig,
} from "./types.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
  type DoctorOptions,
} from "./workspace.js";

export type ResearchSetupEvidenceProfile =
  | "none"
  | typeof EXTERNAL_SKILL_PROFILE
  | typeof EXTERNAL_SKILL_CONTEXT_PROFILE
  | typeof EXTERNAL_SKILL_MEDIA_PROFILE;

const RECOVERY_SKILL_NAME = "tiangong-auto-research-recovery";
const RECOVERY_SHIM_MARKER = ".tiangong-recovery-shim.json";

export interface ResearchSetupAgentRoutePlan {
  producerAgent: AgentKind;
  reviewerAgent: AgentKind;
  producerModel: string | null;
  reviewerModel: string | null;
  producerPricing: AgentPricing | null;
  reviewerPricing: AgentPricing | null;
}

export interface ResearchSetupPlan {
  schemaVersion: 1;
  kind: "tiangong-research-setup-plan";
  planId: string;
  createdAt: string;
  cli: {
    package: "@tiangong-ai/cli";
    version: string;
  };
  workspace: {
    path: string;
    name: string;
    mode: ResearchMode;
  };
  install: {
    scope: ResearchSetupScope;
    agents: ResearchSetupAgent[];
    mode: "copy";
    installer: typeof RESEARCH_SETUP_INSTALLER;
    targets: Array<{
      agent: ResearchSetupAgent;
      root: string;
    }>;
  };
  instructionRouting: ResearchSetupInstructionRoutingPlan;
  selection: {
    evidenceProfile: ResearchSetupEvidenceProfile;
    skillIds: string[];
  };
  sources: Array<{
    id: string;
    repository: string;
    locator: string;
    immutableRef: string;
  }>;
  skills: Array<{
    id: string;
    skillName: string;
    sourceId: string;
    sourceRelativePath: string;
    expectedTreeSha256: string;
    role: ResearchSetupSkill["role"];
    licenseId: string;
  }>;
  acceptedLicenses: Array<{
    skillId: string;
    licenseId: string;
    accepted: true;
  }>;
  credentialSources: Array<{
    id: string;
    fromEnvironment: string;
    storage: ResearchSetupCredential["storage"];
  }>;
  settings: Record<string, string>;
  agentRoutes: ResearchSetupAgentRoutePlan;
  reviewerExecution: ReviewExecutionConfig;
  checks: {
    live: boolean;
    allowSyntheticUnstructureUpload: boolean;
    agentSmoke: boolean;
  };
  confirmations: {
    networkDownloads: true;
    globalMutation: boolean;
    agentSmokeCost: boolean;
  };
  mutations: Array<{
    step: string;
    target: string;
    reason: string;
  }>;
  upgrade?: ResearchSetupUpgradeBinding;
  planSha256: string;
}

export interface ResearchSetupUpgradeBinding {
  schemaVersion: 1;
  cliRuntimeSha256: string;
  parentPlanSha256: string;
  parentRuntimeLockSha256: string;
  parentConfigSha256: string;
  parentMarkerSha256: string;
}

export interface ResearchSetupState {
  schemaVersion: 1;
  planSha256: string;
  status: "pending" | "applying" | "partially-ready" | "ready" | "blocked";
  currentStep: string | null;
  completedSteps: string[];
  attempts: number;
  updatedAt: string;
  lastError: {
    code: string;
    step: string;
    reason: string;
    minimumAction: string;
    retryCommand: string;
    diagnostics?: Record<string, unknown>;
  } | null;
}

export interface ResearchSetupPlanInput {
  workspace: string;
  name?: string;
  mode: ResearchMode;
  evidenceProfile: ResearchSetupEvidenceProfile;
  skillIds: string[];
  scope?: ResearchSetupScope;
  agents?: ResearchSetupAgent[];
  acceptedLicenseIds: string[];
  credentialEnvironment?: Record<string, string>;
  settings?: Record<string, string>;
  agentRoutes?: Partial<ResearchSetupAgentRoutePlan>;
  reviewerExecution?: Partial<ReviewExecutionConfig>;
  liveChecks?: boolean;
  allowSyntheticUnstructureUpload?: boolean;
  agentSmoke?: boolean;
  confirmNetworkDownloads: boolean;
  confirmGlobalMutation?: boolean;
  confirmAgentSmokeCost?: boolean;
  replacePlan?: boolean;
  declarativeConfigurationSha256?: string;
  environment?: NodeJS.ProcessEnv;
  targetRoots?: Partial<Record<ResearchSetupAgent, string>>;
  /** Internal candidate creation; never a public bypass of plan verification. */
  upgrade?: ResearchSetupUpgradeBinding;
}

export interface SetupCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SetupCommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<SetupCommandResult>;

export interface ApplyResearchSetupOptions {
  environment?: NodeJS.ProcessEnv;
  runner?: SetupCommandRunner;
  fetcher?: typeof fetch;
  sleeper?: (milliseconds: number) => Promise<unknown>;
  executor?: DoctorOptions["executor"];
  skipDoctor?: boolean;
  upgradeCheckpoint?: (point: string) => Promise<void>;
  /** Setup-upgrade preparation only; no public CLI flag exposes these paths. */
  sourceCacheWorkspace?: string;
  installerCacheDirectory?: string;
}

export interface ApplyResearchSetupResult {
  schemaVersion: 1;
  plan: ResearchSetupPlan;
  state: ResearchSetupState;
  report: Awaited<ReturnType<typeof doctorResearchSetup>> | null;
}

export type ResearchSetupCompanionInput =
  | {
      workspace: string;
      skillId: "tiangong.document-granular-decompose";
      inputPath: string;
      outputPath: string;
      timeoutSeconds?: number;
    }
  | {
      workspace: string;
      skillId: "tiangong.academic-paper-download";
      outputDirectory: string;
      doi?: string;
      title?: string;
      author?: string;
      year?: number;
      timeoutSeconds?: number;
    };

export interface RunResearchSetupCompanionOptions {
  environment?: NodeJS.ProcessEnv;
  runner?: SetupCommandRunner;
}

const BRAVE_PROFILE_SKILLS: Record<ResearchSetupEvidenceProfile, string[]> = {
  none: [],
  [EXTERNAL_SKILL_PROFILE]: ["brave.web-search", "brave.news-search"],
  [EXTERNAL_SKILL_CONTEXT_PROFILE]: ["brave.web-search", "brave.news-search", "brave.llm-context"],
  [EXTERNAL_SKILL_MEDIA_PROFILE]: [
    "brave.web-search",
    "brave.news-search",
    "brave.llm-context",
    "brave.images-search",
    "brave.videos-search",
  ],
};

const ADAPTER_ENV_KEY = "TIANGONG_RESEARCH_ADAPTER_CREDENTIALS_JSON";
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export async function createResearchSetupPlan(
  input: ResearchSetupPlanInput,
): Promise<ResearchSetupPlan> {
  const root = await resolveResearchSetupWorkspacePath(input.workspace);
  const scope = input.scope ?? "project";
  const agents = normalizeAgents(input.agents ?? ["codex"]);
  const agentRoutes = normalizeAgentRoutes(input.agentRoutes);
  const reviewerExecution = normalizeReviewerExecution(input.reviewerExecution);
  if (
    input.declarativeConfigurationSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(input.declarativeConfigurationSha256)
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_DECLARATION_INVALID",
      step: "declarative-configuration",
      reason: "The declarative setup configuration digest is malformed.",
      minimumAction: "Regenerate or reload the workspace-local setup.yaml file.",
      retryCommand: "tiangong-ai research setup --help",
      exitCode: 2,
    });
  }
  if (
    !input.confirmNetworkDownloads &&
    input.skillIds.length + BRAVE_PROFILE_SKILLS[input.evidenceProfile].length
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      step: "plan",
      reason: "Pinned source and npm downloads were not explicitly confirmed.",
      minimumAction: "Review the catalog and pass the explicit network-download confirmation.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  if (scope === "global" && !input.confirmGlobalMutation) {
    throw setupError({
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      step: "plan",
      reason: "Global Skill installation requires a separate explicit confirmation.",
      minimumAction: "Prefer project scope, or explicitly confirm global mutation.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  if (input.agentSmoke && !input.confirmAgentSmokeCost) {
    throw setupError({
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      step: "plan",
      reason: "Agent smoke checks may consume provider quota and were not confirmed.",
      minimumAction: "Confirm agent-smoke cost, or defer the smoke check.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  if (input.allowSyntheticUnstructureUpload && !input.liveChecks) {
    throw setupError({
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      step: "plan",
      reason:
        "Synthetic Unstructure upload can be authorized only as part of explicit live checks.",
      minimumAction: "Enable live checks as well, or omit the synthetic-upload authorization.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  if (input.mode === "production-research" && input.evidenceProfile === "none") {
    throw setupError({
      code: "RESEARCH_SETUP_SELECTION_INVALID",
      step: "selection",
      reason: "Production research requires an independent public-internet evidence profile.",
      minimumAction: `Choose ${EXTERNAL_SKILL_PROFILE} or a broader explicit profile.`,
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
  const selected = resolveSetupSkills([
    ...new Set([...BRAVE_PROFILE_SKILLS[input.evidenceProfile], ...input.skillIds]),
  ]);
  if (
    (agentRoutes.producerAgent === "workbuddy" || agentRoutes.producerAgent === "codebuddy") &&
    selected.some((skill) => skill.id === "tiangong.auto-research") &&
    !selected.some((skill) => skill.id === "tiangong.auto-research-workbuddy")
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_SELECTION_INVALID",
      step: "selection",
      reason:
        "A WorkBuddy/CodeBuddy native producer requires the thin sandboxed-IDE adapter beside the canonical orchestrator.",
      minimumAction:
        "Select both tiangong.auto-research and tiangong.auto-research-workbuddy, or choose a Codex/Claude producer.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
  const producerInstallTarget = agentRoutes.producerAgent === "claude" ? "claude-code" : "codex";
  if (
    selected.some((skill) => skill.role === "orchestrator") &&
    !agents.includes(producerInstallTarget)
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_SELECTION_INVALID",
      step: "selection",
      reason: `The native ${agentRoutes.producerAgent} producer requires the orchestrator Skill in its project Skill root.`,
      minimumAction: `Include ${producerInstallTarget} in --agents, or choose the other native producer.`,
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  if (selected.some((skill) => skill.role === "evidence-capability") && !agents.includes("codex")) {
    throw setupError({
      code: "RESEARCH_SETUP_SELECTION_INVALID",
      step: "selection",
      reason: "Evidence capabilities must be copied to the Codex-compatible .agents/skills root.",
      minimumAction: "Include codex in --agents for any evidence-capability selection.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  validateEvidenceProfileSelection(input.evidenceProfile, selected);
  validateLicenseAcceptances(selected, input.acceptedLicenseIds);
  const settings = normalizedSettings(selected, input.settings ?? {});
  const credentialSources = normalizedCredentialSources(
    selected,
    input.credentialEnvironment ?? {},
  );
  const targets = plannedInstallTargets(
    root,
    scope,
    agents,
    input.environment ?? process.env,
    input.targetRoots,
  );
  const selectedSources = [...new Set(selected.map((skill) => skill.sourceId))]
    .map(setupSource)
    .sort((left, right) => left.id.localeCompare(right.id));
  const instructionRouting = planResearchSetupInstructionRouting({
    workspace: root,
    scope,
    agents,
    selectedSkillIds: selected.map((skill) => skill.id),
  });
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "tiangong-research-setup-plan" as const,
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    cli: { package: "@tiangong-ai/cli" as const, version: packageVersion() },
    workspace: {
      path: root,
      name: normalizedWorkspaceName(input.name ?? basename(root)),
      mode: input.mode,
    },
    install: {
      scope,
      agents,
      mode: "copy" as const,
      installer: RESEARCH_SETUP_INSTALLER,
      targets,
    },
    instructionRouting,
    selection: {
      evidenceProfile: input.evidenceProfile,
      skillIds: selected.map((skill) => skill.id),
    },
    sources: selectedSources.map((source) => ({
      id: source.id,
      repository: source.repository,
      locator: source.locator,
      immutableRef: source.immutableRef,
    })),
    skills: selected.map((skill) => ({
      id: skill.id,
      skillName: skill.skillName,
      sourceId: skill.sourceId,
      sourceRelativePath: skill.sourceRelativePath,
      expectedTreeSha256: skill.expectedTreeSha256,
      role: skill.role,
      licenseId: skill.license.id,
    })),
    acceptedLicenses: selected.map((skill) => ({
      skillId: skill.id,
      licenseId: skill.license.id,
      accepted: true as const,
    })),
    credentialSources,
    settings,
    agentRoutes,
    reviewerExecution,
    checks: {
      live: input.liveChecks === true,
      allowSyntheticUnstructureUpload: input.allowSyntheticUnstructureUpload === true,
      agentSmoke: input.agentSmoke === true,
    },
    confirmations: {
      networkDownloads: true as const,
      globalMutation: scope === "global",
      agentSmokeCost: input.agentSmoke === true,
    },
    mutations: setupMutations(root, targets, selected, instructionRouting),
    ...(input.upgrade ? { upgrade: input.upgrade } : {}),
  };
  const plan: ResearchSetupPlan = {
    ...unsigned,
    planSha256: sha256Text(canonicalJson(unsigned)),
  };
  const paths = workspacePaths(root);
  await ensureDirectory(paths.control);
  const release = await acquireFileLock(paths.setupLock, setupLockPayload(plan.planSha256));
  try {
    if (plan.upgrade) {
      await assertUpgradeParent(plan);
      const candidatePath = researchSetupUpgradeCandidatePath(plan);
      await assertNoSymlinkedExistingPath(dirname(candidatePath), root);
      await writeJsonAtomic(candidatePath, plan, 0o444);
      return plan;
    }
    if ((await pathExists(paths.setupPlan)) && !input.replacePlan) {
      throw setupError({
        code: "RESEARCH_SETUP_PLAN_EXISTS",
        step: "plan",
        reason: "A setup plan already exists and was not replaced implicitly.",
        minimumAction:
          "Inspect setup status, then explicitly request plan replacement if appropriate.",
        retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
        exitCode: 3,
      });
    }
    const priorPlanSha256 = (await pathExists(paths.setupPlan))
      ? await archiveSetupGeneration(root)
      : null;
    await writeJsonAtomic(paths.setupPlan, plan, 0o444);
    await writeJsonAtomic(paths.setupState, initialSetupState(plan.planSha256));
    if (input.declarativeConfigurationSha256) {
      await writeJsonAtomic(
        paths.setupDeclarationBinding,
        {
          schemaVersion: 1,
          kind: "tiangong-research-setup-declaration-binding",
          configurationSha256: input.declarativeConfigurationSha256,
          planSha256: plan.planSha256,
        },
        0o444,
      );
    } else {
      await rm(paths.setupDeclarationBinding, { force: true });
    }
    if (priorPlanSha256 && (await pathExists(paths.marker))) {
      await appendJournalEvent(paths.journal, "research.setup.plan.replaced", "workspace", {
        priorPlanSha256,
        planSha256: plan.planSha256,
      }).catch(() => undefined);
    }
  } finally {
    await release();
  }
  return plan;
}

export async function loadAndVerifyResearchSetupPlan(planPath: string): Promise<ResearchSetupPlan> {
  const plan = await loadHashVerifiedResearchSetupPlan(planPath);
  if (plan.cli.version !== packageVersion()) {
    throw setupError({
      code: "RESEARCH_SETUP_CLI_DRIFT",
      step: "plan-validation",
      reason: `Plan requires @tiangong-ai/cli@${plan.cli.version}; active version is ${packageVersion()}.`,
      minimumAction:
        "Use the plan's exact CLI version or generate a new plan and review its changes.",
      retryCommand: "tiangong-ai --version",
      exitCode: 3,
    });
  }
  assertPlanMatchesCatalog(plan);
  return plan;
}

export async function loadHashVerifiedResearchSetupPlan(
  planPath: string,
): Promise<ResearchSetupPlan> {
  if (!isAbsolute(planPath)) {
    throw setupError({
      code: "RESEARCH_SETUP_PLAN_INVALID",
      step: "plan-validation",
      reason: "Setup plan path must be absolute.",
      minimumAction: "Pass the absolute setup-plan.json path.",
      retryCommand: "tiangong-ai research setup apply --help",
      exitCode: 2,
    });
  }
  const info = await lstat(planPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw setupError({
      code: "RESEARCH_SETUP_PLAN_INVALID",
      step: "plan-validation",
      reason: "Setup plan must be a regular non-symlink file.",
      minimumAction: "Restore the immutable plan file at an absolute path.",
      retryCommand: "tiangong-ai research setup status --json",
      exitCode: 2,
    });
  }
  const raw = await readJsonFile<unknown>(planPath, "Research setup plan");
  const plan = parseResearchSetupPlan(raw);
  const { planSha256: _hash, ...unsigned } = plan;
  const expected = sha256Text(canonicalJson(unsigned));
  if (plan.planSha256 !== expected) {
    throw setupError({
      code: "RESEARCH_SETUP_PLAN_TAMPERED",
      step: "plan-validation",
      reason: "Setup plan hash does not match its content.",
      minimumAction: "Discard the changed plan and create a new reviewed plan.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 3,
    });
  }
  return plan;
}

export async function createResearchSetupUpgradePlan(input: {
  workspace: string;
  acceptedLicenseIds: string[];
  confirmUpgrade: boolean;
  environment?: NodeJS.ProcessEnv;
}): Promise<ResearchSetupPlan> {
  const root = requireAbsoluteWorkspace(input.workspace);
  if (!input.confirmUpgrade) {
    throw setupError({
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      step: "upgrade-plan",
      reason: "Setup upgrade plan generation requires an explicit confirmation.",
      minimumAction:
        "Run update --check, review current catalog licenses and pins, then pass --confirm-upgrade.",
      retryCommand: `tiangong-ai research setup update --check --workspace ${root} --json`,
      exitCode: 2,
    });
  }
  const prior = await loadHashVerifiedResearchSetupPlan(workspacePaths(root).setupPlan);
  const selected = resolveSetupSkills(prior.selection.skillIds);
  const acceptedLicenseIds = [
    ...new Set([
      ...input.acceptedLicenseIds,
      ...prior.acceptedLicenses
        .filter((accepted) =>
          selected.some(
            (skill) => skill.id === accepted.skillId && skill.license.id === accepted.licenseId,
          ),
        )
        .map((accepted) => accepted.licenseId),
    ]),
  ];
  validateLicenseAcceptances(selected, acceptedLicenseIds);
  const paths = workspacePaths(root);
  for (const path of [paths.runtimeLock, paths.config, paths.marker]) {
    await assertNoSymlinkedExistingPath(path, root);
  }
  const currentConfig = await loadWorkspaceConfig(root);
  const upgrade: ResearchSetupUpgradeBinding = {
    schemaVersion: 1,
    cliRuntimeSha256: await researchSetupRuntimeSha256(),
    parentPlanSha256: prior.planSha256,
    parentRuntimeLockSha256: await sha256File(paths.runtimeLock),
    parentConfigSha256: await sha256File(paths.config),
    parentMarkerSha256: await sha256File(paths.marker),
  };
  return createResearchSetupPlan({
    workspace: root,
    name: prior.workspace.name,
    mode: prior.workspace.mode,
    evidenceProfile: prior.selection.evidenceProfile,
    skillIds: prior.selection.skillIds.filter(
      (id) => !BRAVE_PROFILE_SKILLS[prior.selection.evidenceProfile].includes(id),
    ),
    scope: prior.install.scope,
    agents: prior.install.agents,
    acceptedLicenseIds,
    credentialEnvironment: Object.fromEntries(
      prior.credentialSources.map((credential) => [credential.id, credential.fromEnvironment]),
    ),
    settings: prior.settings,
    agentRoutes: {
      producerAgent: currentConfig.producer.agent,
      reviewerAgent: currentConfig.reviewer.agent,
      producerModel: currentConfig.producer.model,
      reviewerModel: currentConfig.reviewer.model,
      producerPricing: currentConfig.producer.pricing ?? null,
      reviewerPricing: currentConfig.reviewer.pricing ?? null,
    },
    reviewerExecution: currentConfig.reviewerExecution,
    liveChecks: prior.checks.live,
    allowSyntheticUnstructureUpload: prior.checks.allowSyntheticUnstructureUpload,
    agentSmoke: prior.checks.agentSmoke,
    confirmNetworkDownloads: true,
    confirmGlobalMutation: prior.install.scope === "global",
    confirmAgentSmokeCost: prior.checks.agentSmoke,
    replacePlan: true,
    upgrade,
    targetRoots: Object.fromEntries(
      prior.install.targets.map((target) => [target.agent, target.root]),
    ),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
}

export function researchSetupUpgradeCandidatePath(plan: ResearchSetupPlan): string {
  return join(
    workspacePaths(plan.workspace.path).control,
    "setup-candidates",
    `${plan.planSha256}.json`,
  );
}

export async function assertUpgradeParent(plan: ResearchSetupPlan): Promise<ResearchSetupPlan> {
  const paths = workspacePaths(plan.workspace.path);
  const prior = await loadHashVerifiedResearchSetupPlan(paths.setupPlan);
  if (
    !plan.upgrade ||
    prior.planSha256 !== plan.upgrade.parentPlanSha256 ||
    (await sha256File(paths.runtimeLock)) !== plan.upgrade.parentRuntimeLockSha256 ||
    (await sha256File(paths.config)) !== plan.upgrade.parentConfigSha256 ||
    (await sha256File(paths.marker)) !== plan.upgrade.parentMarkerSha256
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_UPGRADE_CONFLICT",
      step: "upgrade-parent",
      reason: "The active generation changed after this upgrade was planned.",
      minimumAction: "Inspect the current setup and create a new reviewed upgrade candidate.",
      retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
      exitCode: 3,
    });
  }
  return prior;
}

export async function applyResearchSetupPlan(
  planPath: string,
  options: ApplyResearchSetupOptions = {},
): Promise<ApplyResearchSetupResult> {
  const plan = await loadAndVerifyResearchSetupPlan(resolve(planPath));
  if (plan.upgrade) {
    await assertResearchSetupRuntimeIntegrity(plan.upgrade.cliRuntimeSha256);
    const { applyManagedSetupUpgrade } = await import("./setup-upgrade.js");
    return applyManagedSetupUpgrade(plan, options);
  }
  const root = plan.workspace.path;
  const paths = workspacePaths(root);
  const environment = options.environment ?? process.env;
  const runner = sanitizingSetupRunner(
    options.runner ?? runSetupCommand,
    setupSecretValues(plan, environment),
  );
  const release = await acquireFileLock(paths.setupLock, setupLockPayload(plan.planSha256));
  let installerCacheDirectory: string;
  try {
    installerCacheDirectory =
      options.installerCacheDirectory ??
      (await mkdtemp(join(tmpdir(), "tiangong-research-npm-cache-")));
    await ensureDirectory(installerCacheDirectory);
  } catch (error) {
    await release();
    throw error;
  }
  const setupInstallerEnvironment = installerEnvironment(environment, installerCacheDirectory);
  let state = await loadSetupState(root, plan.planSha256);
  state = await updateSetupState(root, {
    ...state,
    status: "applying",
    attempts: state.attempts + 1,
    currentStep: "workspace",
    lastError: null,
  });
  try {
    await ensureSetupWorkspace(plan);
    await configureAgentRoutes(plan);
    state = await completeSetupStep(root, state, "workspace");

    state = await startSetupStep(root, state, "credential-preflight");
    await assertRequiredCredentialPreflight(plan, environment);
    state = await completeSetupStep(root, state, "credential-preflight");

    // Persist an explicitly supplied credential before any installer or source
    // download. A later installation failure can then resume from the immutable
    // plan without asking the operator to expose the value again.
    state = await startSetupStep(root, state, "credentials");
    await configurePlanCredentials(plan, environment);
    state = await completeSetupStep(root, state, "credentials");

    if (plan.selection.skillIds.includes("tiangong.auto-research")) {
      state = await startSetupStep(root, state, "recovery-shim");
      await installResearchSetupRecoveryShims(plan);
      state = await completeSetupStep(root, state, "recovery-shim");
    }

    state = await startSetupStep(root, state, "installation-preflight");
    const selected = plan.selection.skillIds.map(setupSkill);
    const installInspection = await inspectSelectedInstallations(plan, selected, environment);
    const unsafe = installInspection.filter(
      (item) => item.status === "drifted" || item.status === "blocked",
    );
    if (unsafe.length) {
      throw setupError({
        code: "RESEARCH_SETUP_INSTALL_DESTINATION_UNSAFE",
        step: "installation-preflight",
        reason: `Existing install destinations are unsafe or drifted: ${unsafe
          .map((item) => `${item.agent}:${item.skillId}`)
          .join(", ")}.`,
        minimumAction:
          "Review the existing directories. The setup CLI will not overwrite, delete, or choose between ambiguous Skill bytes.",
        retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
        exitCode: 3,
      });
    }
    state = await completeSetupStep(root, state, "installation-preflight");

    const missing = installInspection.filter((item) => item.status === "missing");
    if (missing.length) {
      state = await startSetupStep(root, state, "source-checkout");
      await verifyInstallerPackage(runner, root, setupInstallerEnvironment);
      const requiredSourceIds = [
        ...new Set(missing.map((item) => setupSkill(item.skillId).sourceId)),
      ].sort();
      const sourceDirectories = new Map<string, string>();
      for (const sourceId of requiredSourceIds) {
        try {
          sourceDirectories.set(
            sourceId,
            await ensureSetupSourceCheckout(
              options.sourceCacheWorkspace
                ? { ...plan, workspace: { ...plan.workspace, path: options.sourceCacheWorkspace } }
                : plan,
              sourceId,
              runner,
              setupInstallerEnvironment,
            ),
          );
        } catch (error) {
          throw await annotateSetupSourceCheckoutFailure(error, plan, sourceId);
        }
      }
      state = await completeSetupStep(root, state, "source-checkout");

      state = await startSetupStep(root, state, "skill-install");
      for (const agent of plan.install.agents) {
        const missingForAgent = missing.filter((item) => item.agent === agent);
        const sourceIds = [
          ...new Set(missingForAgent.map((item) => setupSkill(item.skillId).sourceId)),
        ].sort();
        for (const sourceId of sourceIds) {
          const skills = missingForAgent
            .map((item) => setupSkill(item.skillId))
            .filter((skill) => skill.sourceId === sourceId)
            .sort((left, right) => left.id.localeCompare(right.id));
          await installSetupSkills({
            plan,
            agent,
            skills,
            sourceDirectory: sourceDirectories.get(sourceId)!,
            runner,
            environment: installerEnvironmentForTarget(
              plan,
              agent,
              environment,
              installerCacheDirectory,
            ),
          });
        }
      }
      const verified = await inspectSelectedInstallations(plan, selected, environment);
      const incomplete = verified.filter((item) => item.status !== "installed");
      if (incomplete.length) {
        throw setupError({
          code: "RESEARCH_SETUP_INSTALL_VERIFICATION_FAILED",
          step: "skill-install",
          reason: `The installer exited but ${incomplete.length} destination(s) did not match the reviewed hashes.`,
          minimumAction:
            "Inspect the reported destination status. File existence alone is not accepted as installation success.",
          retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
          exitCode: 3,
        });
      }
      state = await completeSetupStep(root, state, "skill-install");
    } else {
      state = await completeSetupStep(root, state, "skill-install");
    }

    state = await startSetupStep(root, state, "project-instruction-routing");
    const instructionRouting = await reconcileResearchSetupInstructionRouting({
      workspace: root,
      planSha256: plan.planSha256,
      routing: plan.instructionRouting,
    });
    state = await completeSetupStep(root, state, "project-instruction-routing");

    if (plan.selection.skillIds.includes("tiangong.auto-research")) {
      state = await startSetupStep(root, state, "recovery-shim-cleanup");
      await removeResearchSetupRecoveryShims(plan);
      state = await completeSetupStep(root, state, "recovery-shim-cleanup");
    }

    state = await startSetupStep(root, state, "capability-configuration");
    await configureSelectedCapabilities(plan, environment);
    await reconcilePlanCredentialStores(plan);
    state = await completeSetupStep(root, state, "capability-configuration");

    state = await startSetupStep(root, state, "settings");
    await writeJsonAtomic(paths.setupConfig, {
      schemaVersion: 1,
      planSha256: plan.planSha256,
      settings: plan.settings,
      selectedSkillIds: plan.selection.skillIds,
      updatedAt: new Date().toISOString(),
    });
    state = await completeSetupStep(root, state, "settings");

    await appendJournalEvent(paths.journal, "research.setup.applied", "workspace", {
      planSha256: plan.planSha256,
      selectedSkillIds: plan.selection.skillIds,
      sourcePins: plan.sources.map((source) => ({
        id: source.id,
        immutableRef: source.immutableRef,
      })),
      installer: {
        package: plan.install.installer.package,
        version: plan.install.installer.version,
        npmIntegrity: plan.install.installer.npmIntegrity,
      },
      configuredCredentialIds: plan.credentialSources.map((credential) => credential.id),
      instructionRouting: {
        policy: plan.instructionRouting.policy,
        targetAgents: plan.instructionRouting.targets.map((target) => target.agent),
        status: instructionRouting.status,
        restartRequired: instructionRouting.restartRequired,
      },
    });

    if (options.skipDoctor) {
      state = await updateSetupState(root, {
        ...state,
        status: "partially-ready",
        currentStep: null,
      });
      return { schemaVersion: 1 as const, plan, state, report: null };
    }
    state = await startSetupStep(root, state, "doctor");
    const report = await doctorResearchSetup(root, {
      live: plan.checks.live,
      allowSyntheticUnstructureUpload: plan.checks.allowSyntheticUnstructureUpload,
      agentSmoke: plan.checks.agentSmoke,
      environment,
      runner,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
      ...(options.executor === undefined ? {} : { executor: options.executor }),
    });
    state = await updateSetupState(root, {
      ...state,
      status:
        report.researchReadiness === "BLOCKED"
          ? "blocked"
          : report.overallReadiness === "PARTIALLY_READY"
            ? "partially-ready"
            : "ready",
      currentStep: null,
      completedSteps: [...new Set([...state.completedSteps, "doctor"])],
    });
    return { schemaVersion: 1 as const, plan, state, report };
  } catch (error) {
    const failure = setupFailure(error, state.currentStep ?? "apply", root);
    state = await updateSetupState(root, {
      ...state,
      status: "blocked",
      currentStep: null,
      lastError: failure,
    });
    if (error instanceof CliError) throw error;
    throw setupError({
      code: failure.code,
      step: failure.step,
      reason: failure.reason,
      minimumAction: failure.minimumAction,
      retryCommand: failure.retryCommand,
      exitCode: 3,
    });
  } finally {
    try {
      if (!options.installerCacheDirectory)
        await rm(installerCacheDirectory, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
}

export async function inspectResearchSetupStatus(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const requestedRoot = requireAbsoluteWorkspace(resolve(workspace));
  const requestedPaths = workspacePaths(requestedRoot);
  const marker: unknown = (await pathExists(requestedPaths.marker))
    ? await readJsonFile(requestedPaths.marker, "Research workspace marker")
    : null;
  if (isObject(marker) && marker.kind === SETUP_UPGRADING_MARKER) {
    const candidateHash = marker.setupUpgradePlanSha256;
    let recovery: Record<string, unknown> = {};
    if (typeof candidateHash === "string" && /^[a-f0-9]{64}$/.test(candidateHash)) {
      const planPath = join(requestedPaths.control, "setup-candidates", `${candidateHash}.json`);
      const candidate = await loadHashVerifiedResearchSetupPlan(planPath).catch(() => null);
      const canonicalRoot = await realpath(requestedRoot).catch(() => requestedRoot);
      if (
        candidate?.upgrade &&
        candidate.planSha256 === candidateHash &&
        candidate.workspace.path === canonicalRoot
      ) {
        recovery = {
          planPath,
          retryCommand: researchSetupApplyCommand({ version: candidate.cli.version, planPath }),
          rollbackCommand: exactResearchCliCommand(
            [
              "research",
              "setup",
              "upgrade",
              "--rollback",
              "--candidate",
              planPath,
              "--workspace",
              canonicalRoot,
              "--json",
            ],
            candidate.cli.version,
          ),
        };
      }
    }
    throw new CliError(
      "Complete or roll back the recorded setup upgrade before inspecting readiness.",
      {
        code: "RESEARCH_SETUP_UPGRADE_PENDING",
        exitCode: 3,
        details: recovery,
      },
    );
  }
  const plan = await loadAndVerifyResearchSetupPlan(requestedPaths.setupPlan);
  const canonicalRequestedRoot = await realpath(requestedRoot).catch(() => requestedRoot);
  if (canonicalRequestedRoot !== plan.workspace.path) {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_INVALID",
      step: "workspace",
      reason: "The setup plan is bound to a different canonical workspace path.",
      minimumAction: "Run setup status against the exact workspace recorded in the setup plan.",
      retryCommand: researchSetupApplyCommand({
        version: plan.cli.version,
        planPath: workspacePaths(plan.workspace.path).setupPlan,
      }),
      exitCode: 2,
    });
  }
  const root = plan.workspace.path;
  const paths = workspacePaths(root);
  const storedState = await loadSetupState(root, plan.planSha256);
  const state = setupStateForOutput(storedState, plan, root);
  const selected = plan.selection.skillIds.map(setupSkill);
  const installations = await inspectSelectedInstallations(plan, selected, environment);
  const instructionRouting = await inspectResearchSetupInstructionRouting({
    workspace: root,
    routing: plan.instructionRouting,
  });
  const credentialReadiness = await inspectSetupCredentialReadiness(plan);
  const provenance = await inspectSetupProvenance(plan, installations, environment);
  const report = (await pathExists(paths.setupReport))
    ? await readJsonFile<unknown>(paths.setupReport, "Research setup report")
    : null;
  return {
    schemaVersion: 1 as const,
    workspace: root,
    plan: {
      planId: plan.planId,
      planSha256: plan.planSha256,
      cliVersion: plan.cli.version,
      mode: plan.workspace.mode,
      scope: plan.install.scope,
      agents: plan.install.agents,
      selectedSkillIds: plan.selection.skillIds,
    },
    state,
    installations,
    instructionRouting,
    credentialReadiness,
    provenance,
    report,
    next: setupNextAction(plan, state, root),
  };
}

export async function resolveVerifiedResearchSetupSkillDirectory(
  workspace: string,
  skillId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = requireAbsoluteWorkspace(resolve(workspace));
  const status = await inspectResearchSetupStatus(root, environment);
  if (status.plan.scope !== "project") {
    throw setupError({
      code: "RESEARCH_SETUP_PROJECT_INSTALL_REQUIRED",
      step: "skill-resolution",
      reason: "This workflow requires a project-scoped Skill installation.",
      minimumAction: "Create and apply a reviewed project-scoped setup plan for this workspace.",
      retryCommand: `tiangong-ai research setup --workspace ${root}`,
      exitCode: 3,
    });
  }
  if (!status.plan.selectedSkillIds.includes(skillId)) {
    throw setupError({
      code: "RESEARCH_SETUP_SKILL_NOT_SELECTED",
      step: "skill-resolution",
      reason: `The reviewed setup plan did not select ${skillId}.`,
      minimumAction:
        "Create and apply a replacement setup plan that explicitly selects the required Skill.",
      retryCommand: `tiangong-ai research setup --workspace ${root}`,
      exitCode: 3,
    });
  }
  const report = status.report;
  const researchCoreReady =
    status.state.status === "ready" ||
    (status.state.status === "partially-ready" &&
      isObject(report) &&
      report.schemaVersion === 1 &&
      report.workspace === status.workspace &&
      report.planSha256 === status.plan.planSha256 &&
      report.researchReadiness === "READY" &&
      (report.overallReadiness === "READY" || report.overallReadiness === "PARTIALLY_READY"));
  if (!researchCoreReady) {
    throw setupError({
      code: "RESEARCH_SETUP_NOT_READY",
      step: "skill-resolution",
      reason: `Research-core setup is not ready (setup state: ${status.state.status}).`,
      minimumAction:
        "Complete setup apply and every research-core doctor check before using the orchestrator; optional companion readiness is reported separately.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  const installations = status.installations
    .filter((installation) => installation.skillId === skillId)
    .sort((left, right) => {
      if (left.agent === "codex" && right.agent !== "codex") return -1;
      if (right.agent === "codex" && left.agent !== "codex") return 1;
      return left.agent.localeCompare(right.agent);
    });
  const verified = installations.find((installation) => installation.status === "installed");
  if (!verified) {
    throw setupError({
      code: "RESEARCH_SETUP_SKILL_INSTALL_INVALID",
      step: "skill-resolution",
      reason: `${skillId} is missing, blocked, or differs from the reviewed tree hash.`,
      minimumAction:
        "Inspect setup status and re-apply the immutable plan; do not use an unverified Skill tree.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  return verified.path;
}

function setupStateForOutput(
  state: ResearchSetupState,
  plan: ResearchSetupPlan,
  root: string,
): ResearchSetupState {
  if (!state.lastError) return state;
  return {
    ...state,
    lastError: {
      ...state.lastError,
      retryCommand: researchSetupRetryCommand({
        version: plan.cli.version,
        workspace: root,
        step: state.lastError.step,
      }),
    },
  };
}

function setupNextAction(
  plan: ResearchSetupPlan,
  state: ResearchSetupState,
  root: string,
): {
  action: "apply" | "retry" | "doctor" | "inspect";
  minimumAction: string;
  retryCommand: string;
} | null {
  if (state.status === "ready") return null;
  if (state.status === "pending") {
    return {
      action: "apply",
      minimumAction: "Apply the reviewed immutable setup plan.",
      retryCommand: researchSetupApplyCommand({
        version: plan.cli.version,
        planPath: workspacePaths(root).setupPlan,
      }),
    };
  }
  if (state.status === "blocked" && state.lastError) {
    return {
      action: "retry",
      minimumAction: state.lastError.minimumAction,
      retryCommand: state.lastError.retryCommand,
    };
  }
  if (state.status === "applying") {
    return {
      action: "inspect",
      minimumAction: "Inspect the active setup attempt; do not start a competing apply.",
      retryCommand: exactResearchCliCommand(
        ["research", "setup", "status", "--workspace", root, "--json"],
        plan.cli.version,
      ),
    };
  }
  return {
    action: "doctor",
    minimumAction: "Run setup doctor and resolve every reported missing readiness item.",
    retryCommand: exactResearchCliCommand(
      ["research", "setup", "doctor", "--workspace", root, "--json"],
      plan.cli.version,
    ),
  };
}

async function inspectSetupCredentialReadiness(plan: ResearchSetupPlan): Promise<{
  valuesEmitted: false;
  configuredIds: string[];
  missingRequiredIds: string[];
  scopes: Array<"adapter" | "broker">;
}> {
  const definitions = selectedCredentialDefinitions(plan);
  const brokerIds = definitions
    .filter((definition) => definition.storage === "broker")
    .map((definition) => definition.id);
  const configuredBroker = new Set(
    (
      await loadCapabilityCredentialMapForIds(plan.workspace.path, brokerIds, {
        ignoreUndeclared: true,
      })
    ).keys(),
  );
  const configuredAdapter = await loadAdapterCredentials(plan.workspace.path, definitions, {
    ignoreUndeclared: true,
  });
  const configuredIds = definitions
    .filter((definition) =>
      definition.storage === "broker"
        ? configuredBroker.has(definition.id)
        : configuredAdapter.has(definition.id),
    )
    .map((definition) => definition.id)
    .sort();
  const configured = new Set(configuredIds);
  return {
    valuesEmitted: false,
    configuredIds,
    missingRequiredIds: definitions
      .filter((definition) => definition.required && !configured.has(definition.id))
      .map((definition) => definition.id)
      .sort(),
    scopes: [
      ...new Set(
        definitions
          .filter((definition) => configured.has(definition.id))
          .map((definition) => definition.storage),
      ),
    ].sort(),
  };
}

async function inspectSetupProvenance(
  plan: ResearchSetupPlan,
  installations: Awaited<ReturnType<typeof inspectSelectedInstallations>>,
  environment: NodeJS.ProcessEnv,
) {
  const orchestratorSelected = plan.selection.skillIds.includes("tiangong.auto-research");
  const orchestratorInstallations = installations
    .filter((installation) => installation.skillId === "tiangong.auto-research")
    .map((installation) => ({
      agent: installation.agent,
      path: installation.path,
      status: installation.status,
      observedTreeSha256: installation.observedTreeSha256,
    }));
  return {
    effectiveCli: {
      packageName: RESEARCH_PACKAGE_NAME,
      packageVersion: packageVersion(),
      packageRoot: packageRoot(),
      invocationMode: "exact-npx" as const,
      commandPrefix: exactResearchCliCommand([], plan.cli.version),
    },
    ambientCli: await findAmbientExecutable(environment, "tiangong-ai"),
    ambientSkillConflicts: await inspectAmbientProjectSkillConflicts(plan, environment),
    recoveryShims: await inspectResearchSetupRecoveryShims(plan),
    selectedOrchestrator: orchestratorSelected
      ? {
          skillId: "tiangong.auto-research" as const,
          scope: plan.install.scope,
          preferredPath:
            orchestratorInstallations.find((installation) => installation.status === "installed")
              ?.path ?? null,
          installations: orchestratorInstallations,
        }
      : null,
  };
}

interface RecoveryShimMarker {
  schemaVersion: 1;
  kind: "tiangong-auto-research-recovery-shim";
  planSha256: string;
  cliVersion: string;
  workspace: string;
  agent: ResearchSetupAgent;
}

function recoveryShimPath(plan: ResearchSetupPlan, agent: ResearchSetupAgent): string {
  return join(
    setupTargetRoot({
      workspace: plan.workspace.path,
      scope: "project",
      agent,
    }),
    RECOVERY_SKILL_NAME,
  );
}

function recoveryShimMarker(
  plan: ResearchSetupPlan,
  agent: ResearchSetupAgent,
): RecoveryShimMarker {
  return {
    schemaVersion: 1,
    kind: "tiangong-auto-research-recovery-shim",
    planSha256: plan.planSha256,
    cliVersion: plan.cli.version,
    workspace: plan.workspace.path,
    agent,
  };
}

function recoveryShimInstructions(marker: RecoveryShimMarker): string {
  const inspectCommand = exactResearchCliCommand(
    ["research", "context", "inspect", "--path", marker.workspace, "--json"],
    marker.cliVersion,
  );
  const statusCommand = exactResearchCliCommand(
    ["research", "setup", "status", "--workspace", marker.workspace, "--json"],
    marker.cliVersion,
  );
  return `---
name: ${RECOVERY_SKILL_NAME}
description: Recovery-only routing for an explicitly reviewed Tiangong Auto Research setup that is pending, applying, or blocked. Use when a research request occurs under this workspace before the full project orchestrator is installed. Never use for research execution or standalone evidence search.
---

# Tiangong Auto Research recovery-only shim

This CLI-generated Skill is bound to setup plan \`${marker.planSha256}\`. It exists only
until the full external \`tiangong-auto-research\` Skill matches its reviewed tree hash.

Never run research or standalone evidence from this shim. Do not read, copy, print, or
edit credentials, setup state, locks, manifests, or the immutable plan.

First run the exact-version read-only preflight:

\`\`\`bash
${inspectCommand}
\`\`\`

If the context is managed, inspect the structured setup state:

\`\`\`bash
${statusCommand}
\`\`\`

For \`pending\` or \`blocked\`, execute only the returned \`setup.next.retryCommand\`.
For \`applying\`, report the active step and do not start a competing apply. Stop after
reporting any new blocker. Never fall through to a global Skill, ambient CLI, or
standalone provider credential.
`;
}

function serializedRecoveryShimMarker(marker: RecoveryShimMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

async function inspectRecoveryShim(
  path: string,
  workspace: string,
  agent: ResearchSetupAgent,
  expectedPlanSha256: string,
): Promise<{
  status: "missing" | "installed" | "stale" | "drifted" | "blocked";
  marker: RecoveryShimMarker | null;
}> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return { status: "missing", marker: null };
  if (!info.isDirectory() || info.isSymbolicLink()) return { status: "blocked", marker: null };
  try {
    const entries = (await readdir(path)).sort();
    if (canonicalJson(entries) !== canonicalJson([RECOVERY_SHIM_MARKER, "SKILL.md"].sort())) {
      return { status: "drifted", marker: null };
    }
    const markerPath = join(path, RECOVERY_SHIM_MARKER);
    const skillPath = join(path, "SKILL.md");
    const [markerInfo, skillInfo, markerText, skillText] = await Promise.all([
      lstat(markerPath),
      lstat(skillPath),
      readFile(markerPath, "utf8"),
      readFile(skillPath, "utf8"),
    ]);
    if (
      !markerInfo.isFile() ||
      markerInfo.isSymbolicLink() ||
      !skillInfo.isFile() ||
      skillInfo.isSymbolicLink()
    ) {
      return { status: "blocked", marker: null };
    }
    const value = JSON.parse(markerText) as unknown;
    if (
      !isObject(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== "tiangong-auto-research-recovery-shim" ||
      typeof value.planSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.planSha256) ||
      typeof value.cliVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(value.cliVersion) ||
      value.workspace !== workspace ||
      value.agent !== agent
    ) {
      return { status: "drifted", marker: null };
    }
    const marker = value as unknown as RecoveryShimMarker;
    if (
      markerText !== serializedRecoveryShimMarker(marker) ||
      skillText !== recoveryShimInstructions(marker)
    ) {
      return { status: "drifted", marker: null };
    }
    return {
      status: marker.planSha256 === expectedPlanSha256 ? "installed" : "stale",
      marker,
    };
  } catch {
    return { status: "blocked", marker: null };
  }
}

async function writeRecoveryShimDirectory(
  path: string,
  marker: RecoveryShimMarker,
): Promise<string> {
  const temporary = join(
    dirname(path),
    `.${RECOVERY_SKILL_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeTextAtomic(join(temporary, "SKILL.md"), recoveryShimInstructions(marker), 0o444);
    await writeTextAtomic(
      join(temporary, RECOVERY_SHIM_MARKER),
      serializedRecoveryShimMarker(marker),
      0o444,
    );
    return temporary;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function installResearchSetupRecoveryShims(plan: ResearchSetupPlan): Promise<void> {
  for (const agent of plan.install.agents) {
    const path = recoveryShimPath(plan, agent);
    const parent = dirname(path);
    await assertNoSymlinkedExistingPath(parent, plan.workspace.path);
    await ensureDirectory(parent);
    await assertNoSymlinkedExistingPath(parent, plan.workspace.path);
    const inspection = await inspectRecoveryShim(path, plan.workspace.path, agent, plan.planSha256);
    if (inspection.status === "installed") continue;
    if (inspection.status === "drifted" || inspection.status === "blocked") {
      throw setupError({
        code: "RESEARCH_SETUP_RECOVERY_SHIM_UNSAFE",
        step: "recovery-shim",
        reason: `The recovery Skill destination is not an exact CLI-owned shim for ${agent}.`,
        minimumAction:
          "Review the reported project Skill directory. Setup will not overwrite or delete ambiguous bytes.",
        retryCommand: exactResearchCliCommand(
          ["research", "setup", "status", "--workspace", plan.workspace.path, "--json"],
          plan.cli.version,
        ),
        exitCode: 3,
      });
    }
    const temporary = await writeRecoveryShimDirectory(path, recoveryShimMarker(plan, agent));
    try {
      if (inspection.status === "missing") {
        await rename(temporary, path);
      } else {
        const backup = `${path}.${process.pid}.${randomUUID()}.previous`;
        await rename(path, backup);
        try {
          await rename(temporary, path);
          await rm(backup, { recursive: true, force: true });
        } catch (error) {
          if (!(await pathExists(path))) await rename(backup, path).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

async function removeResearchSetupRecoveryShims(plan: ResearchSetupPlan): Promise<void> {
  for (const agent of plan.install.agents) {
    const path = recoveryShimPath(plan, agent);
    const inspection = await inspectRecoveryShim(path, plan.workspace.path, agent, plan.planSha256);
    if (inspection.status === "missing") continue;
    if (inspection.status !== "installed") {
      throw setupError({
        code: "RESEARCH_SETUP_RECOVERY_SHIM_UNSAFE",
        step: "recovery-shim-cleanup",
        reason: `The recovery Skill changed before verified cleanup for ${agent}.`,
        minimumAction:
          "Review the recovery Skill directory. Setup removes only its exact plan-bound generated bytes.",
        retryCommand: exactResearchCliCommand(
          ["research", "setup", "status", "--workspace", plan.workspace.path, "--json"],
          plan.cli.version,
        ),
        exitCode: 3,
      });
    }
    await rm(path, { recursive: true, force: false });
  }
}

async function inspectResearchSetupRecoveryShims(plan: ResearchSetupPlan) {
  if (!plan.selection.skillIds.includes("tiangong.auto-research")) return [];
  const results = [];
  for (const agent of plan.install.agents) {
    const path = recoveryShimPath(plan, agent);
    const inspection = await inspectRecoveryShim(path, plan.workspace.path, agent, plan.planSha256);
    if (inspection.status === "missing") continue;
    results.push({
      agent,
      path,
      status: inspection.status === "stale" ? ("drifted" as const) : inspection.status,
      planSha256: inspection.marker?.planSha256 ?? null,
      cliVersion: inspection.marker?.cliVersion ?? null,
      recoveryOnly: true as const,
    });
  }
  return results;
}

async function inspectAmbientProjectSkillConflicts(
  plan: ResearchSetupPlan,
  environment: NodeJS.ProcessEnv,
) {
  if (plan.install.scope !== "project") return [];
  const conflicts = [];
  for (const agent of plan.install.agents) {
    const globalRoot = setupTargetRoot({
      workspace: plan.workspace.path,
      scope: "global",
      agent,
      environment,
    });
    for (const skillId of plan.selection.skillIds) {
      const skill = setupSkill(skillId);
      const path = join(globalRoot, skill.skillName);
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      let status: "matching" | "drifted" | "blocked" = "blocked";
      let observedTreeSha256: string | null = null;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        try {
          observedTreeSha256 = await hashRegularTree(path);
          status = observedTreeSha256 === skill.expectedTreeSha256 ? "matching" : "drifted";
        } catch {
          status = "blocked";
        }
      }
      conflicts.push({
        skillId: skill.id,
        skillName: skill.skillName,
        agent,
        path,
        status,
        observedTreeSha256,
        expectedTreeSha256: skill.expectedTreeSha256,
        unmanagedPathCliFallback: await containsUnmanagedPathCliFallback(path),
        ignoredByProjectScope: true as const,
      });
    }
  }
  return conflicts;
}

async function containsUnmanagedPathCliFallback(root: string): Promise<boolean> {
  const state = { inspectedFiles: 0 };
  const inspectDirectory = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > 4 || state.inspectedFiles >= 100) return false;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await inspectDirectory(path, depth + 1)) return true;
        continue;
      }
      if (!entry.isFile() || !/\.(?:c?js|mjs|py|sh)$/.test(entry.name)) continue;
      state.inspectedFiles += 1;
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) continue;
      const content = await readFile(path, "utf8").catch(() => "");
      if (content.includes("TIANGONG_AI_CLI:-tiangong-ai")) return true;
    }
    return false;
  };
  return inspectDirectory(root, 0);
}

async function findAmbientExecutable(
  environment: NodeJS.ProcessEnv,
  executable: string,
  options: { preserveLeafSymlink?: boolean } = {},
): Promise<{ path: string; ignoredByExactInvocation: true } | null> {
  const pathValue = environment.PATH;
  if (!pathValue) return null;
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${executable}${suffix}`);
      const info = await lstat(candidate).catch(() => undefined);
      if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
      const resolved = await realpath(candidate).catch(() => undefined);
      if (!resolved) continue;
      const resolvedInfo = await lstat(resolved).catch(() => undefined);
      if (resolvedInfo?.isFile() && !resolvedInfo.isSymbolicLink()) {
        const path = options.preserveLeafSymlink
          ? join(await realpath(dirname(candidate)), basename(candidate))
          : resolved;
        return { path, ignoredByExactInvocation: true };
      }
    }
  }
  return null;
}

export async function setResearchSetupCredentialFromEnvironment(input: {
  workspace: string;
  credentialId: string;
  environmentName: string;
  environment: NodeJS.ProcessEnv;
}) {
  const root = requireAbsoluteWorkspace(input.workspace);
  const { credential } = await selectedSetupCredential(root, input.credentialId);
  assertEnvironmentName(input.environmentName);
  const value = input.environment[input.environmentName];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < credential.minimumUtf8Bytes) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_INVALID",
      step: "credentials",
      reason: `Credential source environment variable is missing or too short: ${input.environmentName}.`,
      minimumAction: "Set the owner environment variable, then retry this exact credential step.",
      retryCommand: `tiangong-ai research setup credential set --id ${credential.id} --from-env ${input.environmentName} --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  return persistResearchSetupCredential({
    root,
    credentialId: input.credentialId,
    value,
    inputMethod: "environment",
    sourceEnvironmentName: input.environmentName,
  });
}

export async function setResearchSetupCredentialValue(input: {
  workspace: string;
  credentialId: string;
  value: string;
  inputMethod: "secure-input" | "stdin";
}) {
  const root = requireAbsoluteWorkspace(input.workspace);
  const { credential } = await selectedSetupCredential(root, input.credentialId);
  if (Buffer.byteLength(input.value, "utf8") < credential.minimumUtf8Bytes) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_INVALID",
      step: "credentials",
      reason: "Credential value is missing or does not meet the selected provider minimum.",
      minimumAction: "Retry with secure input, stdin, or a configured owner environment variable.",
      retryCommand: `tiangong-ai research setup credential set --id ${credential.id} --prompt --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  return persistResearchSetupCredential({
    root,
    credentialId: input.credentialId,
    value: input.value,
    inputMethod: input.inputMethod,
  });
}

async function selectedSetupCredential(root: string, credentialId: string) {
  const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
  const selected = selectedCredentialDefinitions(plan);
  const credential = selected.find((candidate) => candidate.id === credentialId);
  if (!credential) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_INVALID",
      step: "credentials",
      reason: `Credential is not declared by the selected setup plan: ${credentialId}.`,
      minimumAction: "Inspect the setup catalog and selected plan credential IDs.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 2,
    });
  }
  return { plan, selected, credential };
}

async function persistResearchSetupCredential(input: {
  root: string;
  credentialId: string;
  value: string;
  inputMethod: "secure-input" | "stdin" | "environment";
  sourceEnvironmentName?: string;
}) {
  const { selected, credential } = await selectedSetupCredential(input.root, input.credentialId);
  if (credential.storage === "broker") {
    const currentDeclarations = (await pathExists(
      workspacePaths(input.root).capabilityDeclarations,
    ))
      ? await loadCapabilityDeclarations(input.root)
      : { capabilities: [] };
    await setCapabilityCredentialValue({
      root: input.root,
      declaredCredentialIds: [
        ...new Set([
          ...currentDeclarations.capabilities.flatMap((capability) =>
            capability.credentials.map((candidate) => candidate.id),
          ),
          ...selected
            .filter((candidate) => candidate.storage === "broker")
            .map((candidate) => candidate.id),
        ]),
      ],
      credentialId: credential.id,
      value: input.value,
      minimumUtf8Bytes: credential.minimumUtf8Bytes,
    });
  } else {
    await setAdapterCredential(
      input.root,
      selected.filter((candidate) => candidate.storage === "adapter"),
      credential.id,
      input.value,
    );
  }
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "research.setup.credential.configured",
    "workspace",
    {
      credentialId: credential.id,
      inputMethod: input.inputMethod,
      ...(input.sourceEnvironmentName === undefined
        ? {}
        : { sourceEnvironmentNameSha256: sha256Text(input.sourceEnvironmentName) }),
      storage: credential.storage,
    },
  );
  return {
    schemaVersion: 1 as const,
    workspace: input.root,
    credentialId: credential.id,
    configured: true as const,
    storage: credential.storage,
    outputPolicy: "value-is-never-emitted" as const,
  };
}

export function runResearchSetupCompanion(
  input: Extract<ResearchSetupCompanionInput, { skillId: "tiangong.document-granular-decompose" }>,
  options?: RunResearchSetupCompanionOptions,
): ReturnType<typeof runDocumentGranularCompanion>;
export function runResearchSetupCompanion(
  input: Extract<ResearchSetupCompanionInput, { skillId: "tiangong.academic-paper-download" }>,
  options?: RunResearchSetupCompanionOptions,
): ReturnType<typeof runAcademicPaperCompanion>;
export async function runResearchSetupCompanion(
  input: ResearchSetupCompanionInput,
  options: RunResearchSetupCompanionOptions = {},
) {
  const root = requireAbsoluteWorkspace(input.workspace);
  const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
  if (!plan.selection.skillIds.includes(input.skillId)) {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_NOT_SELECTED",
      step: "companion-preflight",
      reason: `The immutable setup plan did not select ${input.skillId}.`,
      minimumAction:
        "Create and apply an explicit replacement setup plan that selects this companion Skill.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  const skill = setupSkill(input.skillId);
  if (skill.role !== "input-preprocessor" && skill.role !== "acquisition-adapter") {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_ROLE_INVALID",
      step: "companion-preflight",
      reason: `${skill.id} is not an input-preprocessor or acquisition-adapter.`,
      minimumAction:
        "Use evidence capabilities through the research broker and authoring Skills only after closure.",
      retryCommand: `tiangong-ai research setup catalog --workspace ${root} --json`,
      exitCode: 2,
    });
  }
  const skillDirectory = await verifiedCompanionSkillDirectory(plan, skill);
  const credentialDefinitions = selectedCredentialDefinitions(plan).filter((definition) =>
    skill.credentialIds.includes(definition.id),
  );
  const credentials = await loadAdapterCredentials(root, selectedCredentialDefinitions(plan));
  const environment = options.environment ?? process.env;
  const runner = sanitizingSetupRunner(options.runner ?? runSetupCommand, [
    ...setupSecretValues(plan, environment),
    ...credentials.values(),
  ]);

  return input.skillId === "tiangong.document-granular-decompose"
    ? runDocumentGranularCompanion({
        root,
        plan,
        skill,
        skillDirectory,
        credentialDefinitions,
        credentials,
        input,
        environment,
        runner,
      })
    : runAcademicPaperCompanion({
        root,
        plan,
        skill,
        skillDirectory,
        credentials,
        input,
        environment,
        runner,
      });
}

export async function doctorResearchSetup(
  workspace: string,
  options: {
    live?: boolean;
    allowSyntheticUnstructureUpload?: boolean;
    agentSmoke?: boolean;
    environment?: NodeJS.ProcessEnv;
    runner?: SetupCommandRunner;
    fetcher?: typeof fetch;
    sleeper?: (milliseconds: number) => Promise<unknown>;
    executor?: DoctorOptions["executor"];
  } = {},
) {
  const root = requireAbsoluteWorkspace(resolve(workspace));
  const environment = options.environment ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const sleeper = options.sleeper ?? sleep;
  const paths = workspacePaths(root);
  const plan = await loadAndVerifyResearchSetupPlan(paths.setupPlan);
  const runner = sanitizingSetupRunner(
    options.runner ?? runSetupCommand,
    setupSecretValues(plan, environment),
  );
  const checks: SetupDoctorCheck[] = [];

  await setupDoctorCheck(checks, "workspace", "workspace", async () => {
    const context = await inspectResearchContext(root);
    if (context.role !== "workspace") throw new Error(`workspace role is ${context.role}`);
    return `Workspace is initialized in ${plan.workspace.mode} mode.`;
  });
  await setupDoctorCheck(checks, "node", "runtime", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major !== 24) throw new Error(`Node ${process.versions.node} does not satisfy >=24 <25`);
    return `Node ${process.versions.node} matches the CLI runtime baseline.`;
  });
  for (const command of ["git", "npx"] as const) {
    await setupDoctorCheck(checks, command, "runtime", async () => {
      const result = await runner({
        command,
        args: ["--version"],
        cwd: root,
        environment: installerEnvironment(environment),
        timeoutMs: 15_000,
      });
      if (result.exitCode !== 0) throw new Error(`${command} is not executable`);
      return `${command} is executable (${sanitizeResearchText(result.stdout.trim()).slice(0, 120)}).`;
    });
  }
  const platformCapabilities = researchPlatformCapabilities(platform());
  if (!platformCapabilities.nativeReviewerExecution) {
    const production = plan.workspace.mode === "production-research";
    checks.push({
      id: "platform-sandbox",
      category: "runtime",
      scope: "research-core",
      status: production ? "fail" : "warn",
      detail: production
        ? `Production research execution is unsupported on ${platformCapabilities.platform} because no approved capsule sandbox is available.`
        : `${platformCapabilities.platform} is configuration/smoke-only; it can inspect setup state but cannot start a native reviewer or reviewer sidecar.`,
      minimumAction: production
        ? "Run production research on macOS with sandbox-exec or Linux with Bubblewrap."
        : "Use macOS or Linux before switching this workspace to production-research mode or starting a reviewer sidecar.",
      blocking: production,
      requiredFor: production ? ["setup", "research-core"] : [],
    });
  } else if (plan.reviewerExecution.transport === "sandbox-bridge") {
    await setupDoctorCheck(checks, "platform-sandbox", "runtime", async () => {
      const status = await inspectReviewerBridgeStatus(root);
      return `Owner-controlled reviewer sidecar is ready; version=${status.packageVersion}; key=${status.keyFingerprint.slice(0, 12)}.`;
    });
  } else {
    await setupDoctorCheck(checks, "platform-sandbox", "runtime", async () => {
      if (platformCapabilities.nativeIsolationProvider === "sandbox-exec") {
        const info = await lstat("/usr/bin/sandbox-exec").catch(() => undefined);
        if (!info?.isFile()) throw new Error("/usr/bin/sandbox-exec is unavailable");
        return "macOS sandbox-exec is available.";
      }
      if (platformCapabilities.nativeIsolationProvider === "bubblewrap") {
        const result = await runner({
          command: "bwrap",
          args: ["--version"],
          cwd: root,
          environment: installerEnvironment(environment),
          timeoutMs: 15_000,
        });
        if (result.exitCode !== 0) throw new Error("Bubblewrap is unavailable");
        return "Linux Bubblewrap is available.";
      }
      throw new Error(`Research execution is unsupported on ${platformCapabilities.platform}`);
    });
  }
  checks.push({
    id: "agent.native-producer",
    category: "agent",
    scope: "research-core",
    status: "pass",
    detail: `Producer work is bound to the current interactive ${plan.agentRoutes.producerAgent} host; setup will not launch it as a child process.`,
    minimumAction: null,
    blocking: true,
    requiredFor: ["setup", "research-core"],
  });
  const reviewerCommand = plan.agentRoutes.reviewerAgent;
  if (plan.reviewerExecution.transport === "sandbox-bridge") {
    await setupDoctorCheck(checks, `agent.${reviewerCommand}.reviewer`, "agent", async () => {
      const status = await inspectReviewerBridgeStatus(root);
      return `${reviewerCommand} reviewer is delegated to the exact-version owner-controlled sidecar (${status.keyFingerprint.slice(0, 12)}).`;
    });
  } else {
    await setupDoctorCheck(checks, `agent.${reviewerCommand}.reviewer`, "agent", async () => {
      const result = await runner({
        command: reviewerCommand,
        args: ["--version"],
        cwd: root,
        environment: agentDoctorEnvironment(environment),
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) throw new Error(`${reviewerCommand} is not executable`);
      return `${reviewerCommand} reviewer CLI is executable (${sanitizeResearchText(result.stdout.trim()).slice(0, 160)}).`;
    });
  }
  await setupDoctorCheck(checks, "agent-route-config", "agent", async () => {
    const config = await loadWorkspaceConfig(root);
    if (
      config.producer.executionMode !== "native-host" ||
      config.reviewer.executionMode !== "headless-cli" ||
      config.producer.agent === config.reviewer.agent
    ) {
      throw new Error(
        "Workspace must bind producer=native-host and reviewer=headless-cli on different agent families.",
      );
    }
    if (
      config.mode === "production-research" &&
      (!config.producer.model ||
        !config.reviewer.model ||
        !config.producer.pricing ||
        !config.reviewer.pricing)
    ) {
      throw new Error("Production agent models and reviewed pricing are incomplete.");
    }
    return `${config.producer.agent}(native-host) -> ${config.reviewer.agent}(headless-cli) via ${config.reviewerExecution.transport}.`;
  });

  const selected = plan.selection.skillIds.map(setupSkill);
  const installations = await inspectSelectedInstallations(plan, selected, environment);
  for (const installation of installations) {
    checks.push({
      id: `skill.${installation.agent}.${installation.skillId}`,
      category: "skill-installation",
      status: installation.status === "installed" ? "pass" : "fail",
      detail: installation.detail,
      minimumAction:
        installation.status === "installed"
          ? null
          : "Restore the pinned Skill bytes; setup will not overwrite a drifted or symlinked directory.",
    });
  }
  const instructionRouting = await inspectResearchSetupInstructionRouting({
    workspace: root,
    routing: plan.instructionRouting,
  });
  for (const target of instructionRouting.targets) {
    checks.push({
      id: `project-instruction-routing.${target.agent}`,
      category: "skill-installation",
      scope: "research-core",
      status: target.status === "installed" ? "pass" : "fail",
      detail:
        target.status === "installed"
          ? `${target.detail} Start a new ${target.agent} session before relying on this routing instruction.`
          : target.detail,
      minimumAction:
        target.status === "installed"
          ? null
          : "Resolve the reported project instruction conflict or drift, re-apply the exact setup plan, then start a new native-host session.",
      blocking: target.status !== "installed",
      requiredFor: ["setup", "research-core"],
    });
  }
  for (const installation of installations.filter(
    (candidate) => candidate.skillId === "tiangong.auto-research",
  )) {
    await setupDoctorCheck(
      checks,
      `top-journal-policy-pack.${installation.agent}`,
      "publication-policy",
      async () => {
        if (installation.status !== "installed" || !installation.observedTreeSha256) {
          throw new Error(
            `The pinned Auto Research orchestrator is ${installation.status}; its Policy pack cannot be validated.`,
          );
        }
        const validation = await validateResearchPolicyPack(installation.path);
        if (validation.sourceTreeSha256 !== installation.observedTreeSha256) {
          throw new Error(
            "The validated Policy pack does not match the installed orchestrator tree hash.",
          );
        }
        return `${validation.templateCount} pinned Top-Journal Policy templates are compatible with this CLI.`;
      },
      "Restore the CLI-compatible pinned Auto Research Policy pack, then rerun setup doctor; do not edit locked Skill bytes.",
    );
  }
  const provenance = await inspectSetupProvenance(plan, installations, environment);
  for (const conflict of provenance.ambientSkillConflicts) {
    const projectInstallation = installations.find(
      (installation) =>
        installation.agent === conflict.agent && installation.skillId === conflict.skillId,
    );
    const projectInstalled = projectInstallation?.status === "installed";
    checks.push({
      id: `skill-scope.${conflict.agent}.${conflict.skillId}`,
      category: "skill-installation",
      scope: "research-core",
      componentIds: [conflict.skillId],
      status: projectInstalled ? "warn" : "fail",
      detail: projectInstalled
        ? `A global same-name Skill exists at ${conflict.path}, but the verified project copy is authoritative and the global copy is ignored.`
        : `SKILL_SCOPE_FALLBACK_UNSAFE: the project copy is not verified while a global same-name Skill exists at ${conflict.path}${conflict.unmanagedPathCliFallback ? " and contains an unmanaged PATH CLI fallback" : ""}.`,
      minimumAction: projectInstalled
        ? "Remove or update the ignored global copy during separate owner-approved maintenance if it is no longer needed."
        : "Resume the exact setup plan until the project Skill matches its reviewed tree; do not use the global fallback.",
      blocking: !projectInstalled,
      requiredFor: projectInstalled ? [] : ["setup", "research-core"],
    });
  }

  for (const setting of requiredSettingsForSkills(selected)) {
    const configured = plan.settings[setting.id];
    checks.push({
      id: `setting.${setting.id}`,
      category: "configuration",
      status: configured || !setting.required ? "pass" : "fail",
      detail: configured
        ? "Declared non-secret setting is configured."
        : setting.required
          ? "Required setting is not configured."
          : "Optional setting was explicitly omitted.",
      minimumAction:
        configured || !setting.required
          ? null
          : `Create a reviewed replacement plan with the ${setting.id} setting.`,
    });
  }

  let brokerCredentialStatus: Awaited<
    ReturnType<typeof inspectCapabilityCredentialEnvironment>
  > | null = null;
  try {
    const declarations = await loadCapabilityDeclarations(root);
    brokerCredentialStatus = await inspectCapabilityCredentialEnvironment(
      root,
      declarations.capabilities,
    );
  } catch (error) {
    checks.push({
      id: "credential.broker-store",
      category: "credential",
      status: "fail",
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
      minimumAction: "Repair the owner-only broker credential file, then rerun setup doctor.",
    });
  }
  let adapterCredentials = new Map<string, string>();
  try {
    adapterCredentials = await loadAdapterCredentials(root, selectedCredentialDefinitions(plan));
  } catch (error) {
    checks.push({
      id: "credential.adapter-store",
      category: "credential",
      status: "fail",
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
      minimumAction: "Repair the owner-only adapter credential file, then rerun setup doctor.",
    });
  }
  for (const credential of selectedCredentialDefinitions(plan)) {
    const configured =
      credential.storage === "broker"
        ? (brokerCredentialStatus?.configuredIds.includes(credential.id) ?? false)
        : adapterCredentials.has(credential.id);
    checks.push({
      id: `credential.${credential.id}`,
      category: "credential",
      status: configured || !credential.required ? "pass" : "fail",
      detail: configured
        ? "Credential is present in an owner-only store; its value was not emitted."
        : credential.required
          ? "Required credential is not configured."
          : "Optional credential was explicitly omitted.",
      minimumAction:
        configured || !credential.required
          ? null
          : `Run research setup credential set --id ${credential.id} --prompt --workspace ${root}.`,
    });
  }

  const authoringRuntime = await resolveAuthoringRuntime(selected, environment);
  await appendDependencyChecks(checks, plan, selected, runner, root, environment, authoringRuntime);
  await appendAuthoringCanaryChecks(checks, {
    plan,
    selected,
    runner,
    root,
    environment,
    runtime: authoringRuntime,
  });

  let capabilityDoctor: Awaited<ReturnType<typeof doctorExternalCapabilities>> | null = null;
  const blockingBeforeLive = checks
    .map((check) => normalizeSetupDoctorCheck(check, selected))
    .filter((check) => check.blocking && check.status === "fail")
    .map((check) => check.id);
  const runRequiredLive = options.live === true && blockingBeforeLive.length === 0;
  if (selected.some((skill) => skill.role === "evidence-capability")) {
    try {
      capabilityDoctor = await doctorExternalCapabilities(root, {
        live: runRequiredLive,
        fetcher,
        sleeper,
      });
      checks.push({
        id: "capabilities",
        category: "evidence-capability",
        status: capabilityDoctor.status === "ready" ? "pass" : "fail",
        detail: `${capabilityDoctor.capabilities.length} capability declaration(s); mode=${capabilityDoctor.mode}.`,
        minimumAction:
          capabilityDoctor.status === "ready"
            ? null
            : "Resolve the exact static or live capability failures; no provider fallback is performed.",
      });
    } catch (error) {
      checks.push({
        id: "capabilities",
        category: "evidence-capability",
        status: "fail",
        detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
        minimumAction:
          "Apply the reviewed capability configuration, then rerun the exact static or live check.",
      });
    }
  }

  if (options.live === true && !runRequiredLive) {
    checks.push({
      id: "live.required-capabilities.skipped",
      category: "live-check",
      scope: "evidence",
      status: "fail",
      detail:
        "Required live capability probes were not started because a static blocking prerequisite failed.",
      minimumAction: "Resolve the static blocking prerequisites, then rerun live doctor checks.",
      blocking: true,
      requiredFor: ["setup", "research-core"],
      skippedBecause: blockingBeforeLive.join(", "),
    });
  }

  if (runRequiredLive) {
    await appendCompanionLiveChecks(checks, {
      plan,
      selected,
      adapterCredentials,
      fetcher,
      sleeper,
      allowSyntheticUnstructureUpload: options.allowSyntheticUnstructureUpload === true,
    });
  } else if (
    options.live === true &&
    selected.some((skill) =>
      ["input-preprocessor", "acquisition-adapter", "post-closure-authoring"].includes(skill.role),
    )
  ) {
    checks.push({
      id: "live.optional-components.skipped",
      category: "live-check",
      status: "warn",
      detail:
        "Optional component diagnostics were skipped after a static blocking prerequisite failed.",
      minimumAction: "Resolve the blocking prerequisites before retrying optional diagnostics.",
      blocking: false,
      requiredFor: [],
      skippedBecause: blockingBeforeLive.join(", "),
    });
  }

  let workspaceDoctor: Awaited<ReturnType<typeof doctorResearchWorkspace>> | null = null;
  const blockingPrerequisiteFailures = checks
    .map((check) => normalizeSetupDoctorCheck(check, selected))
    .filter((check) => check.blocking && check.status === "fail")
    .map((check) => check.id);
  const runAgentSmoke = options.agentSmoke === true && blockingPrerequisiteFailures.length === 0;
  if (options.agentSmoke === true && !runAgentSmoke) {
    checks.push({
      id: "agent-reviewer-smoke.skipped",
      category: "agent",
      scope: "review",
      status: "fail",
      detail:
        "The paid reviewer smoke was not started because a zero/low-cost blocking prerequisite failed.",
      minimumAction:
        "Resolve the listed blocking prerequisites, then rerun the explicitly confirmed reviewer smoke.",
      blocking: true,
      requiredFor: ["setup", "research-core"],
      skippedBecause: blockingPrerequisiteFailures.join(", "),
    });
  }
  try {
    workspaceDoctor = await doctorResearchWorkspace(root, {
      agentSmoke: runAgentSmoke,
      capabilitySmoke: runRequiredLive,
      environment,
      capabilityFetcher: fetcher,
      ...(capabilityDoctor === null ? {} : { capabilityDoctorResult: capabilityDoctor }),
      ...(options.executor === undefined ? {} : { executor: options.executor }),
    });
    const requiredRuntimeChecks = options.agentSmoke === true || options.live === true;
    const runtimeBlocked = workspaceDoctor.status !== "ready" && requiredRuntimeChecks;
    const failedWorkspaceChecks = workspaceDoctor.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.id);
    checks.push({
      id: "production-runtime",
      category: "research-runtime",
      status: workspaceDoctor.status === "ready" ? "pass" : runtimeBlocked ? "fail" : "warn",
      detail: `Workspace doctor reported ${workspaceDoctor.status}.`,
      minimumAction:
        workspaceDoctor.status === "ready"
          ? null
          : runtimeBlocked
            ? `Resolve the failed workspace doctor checks (${failedWorkspaceChecks.join(", ") || "unknown"}); an explicitly requested smoke failure blocks readiness.`
            : "Configure explicit production models/pricing and run the separately confirmed agent/capability smoke checks.",
    });
  } catch (error) {
    checks.push({
      id: "production-runtime",
      category: "research-runtime",
      status: "fail",
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
      minimumAction: "Repair workspace runtime state, then rerun setup doctor.",
    });
  }

  if (!options.live) {
    const attestedCapabilitySmoke = workspaceDoctor?.checks.some(
      (check) => check.id === "capability-live-smoke" && check.status === "pass",
    );
    checks.push({
      id: "live-provider-checks",
      category: "live-check",
      status: attestedCapabilitySmoke ? "pass" : "warn",
      detail: attestedCapabilitySmoke
        ? "Reused the unexpired, runtime-bound capability smoke attestation."
        : "Live provider checks were not requested and no reusable attestation is available.",
      minimumAction: attestedCapabilitySmoke
        ? null
        : `Run tiangong-ai research setup doctor --live --workspace ${root} --json after reviewing quota impact.`,
    });
  }

  const scopedChecks = checks.map((check) => normalizeSetupDoctorCheck(check, selected));
  const researchReadiness = scopedChecks.some((check) => check.blocking && check.status === "fail")
    ? "BLOCKED"
    : "READY";
  const preprocessingReadiness = setupDomainReadiness(scopedChecks, "preprocessing");
  const acquisitionReadiness = setupDomainReadiness(scopedChecks, "acquisition");
  const authoringReadiness = setupDomainReadiness(scopedChecks, "authoring");
  const overallReadiness =
    researchReadiness === "BLOCKED"
      ? "BLOCKED"
      : scopedChecks.some((check) => check.status !== "pass")
        ? "PARTIALLY_READY"
        : "READY";
  const setupSecrets = [
    ...new Set([
      ...configuredResearchSecrets(environment),
      ...plan.credentialSources
        .map((credential) => environment[credential.fromEnvironment])
        .filter((value): value is string => typeof value === "string" && value.length >= 8),
      ...adapterCredentials.values(),
    ]),
  ];
  const report = sanitizeResearchRecord(
    {
      schemaVersion: 1,
      workspace: root,
      planSha256: plan.planSha256,
      checkedAt: new Date().toISOString(),
      mode: options.live ? "live" : "static",
      readiness: researchReadiness,
      researchReadiness,
      preprocessingReadiness,
      acquisitionReadiness,
      authoringReadiness,
      overallReadiness,
      checks: scopedChecks,
      capabilityDoctor,
      workspaceDoctor,
      summary: {
        pass: scopedChecks.filter((check) => check.status === "pass").length,
        warn: scopedChecks.filter((check) => check.status === "warn").length,
        fail: scopedChecks.filter((check) => check.status === "fail").length,
      },
    },
    setupSecrets,
  );
  await writeJsonAtomic(paths.setupReport, report);
  return report as typeof report & {
    readiness: "READY" | "BLOCKED";
    researchReadiness: "READY" | "BLOCKED";
    preprocessingReadiness: SetupDomainReadiness;
    acquisitionReadiness: SetupDomainReadiness;
    authoringReadiness: SetupDomainReadiness;
    overallReadiness: "READY" | "PARTIALLY_READY" | "BLOCKED";
  };
}

export async function retryResearchSetup(input: {
  workspace: string;
  step: string;
  clearStaleLock?: boolean;
  options?: ApplyResearchSetupOptions;
}) {
  const root = requireAbsoluteWorkspace(resolve(input.workspace));
  const paths = workspacePaths(root);
  const plan = await loadAndVerifyResearchSetupPlan(paths.setupPlan);
  const state = await loadSetupState(root, plan.planSha256);
  if (!state.lastError || state.lastError.step !== input.step) {
    throw setupError({
      code: "RESEARCH_SETUP_RETRY_INVALID",
      step: "retry",
      reason: `Requested retry step does not match the recorded failure (${state.lastError?.step ?? "none"}).`,
      minimumAction: "Inspect setup status and retry only the exact recorded failed step.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 2,
    });
  }
  if (input.clearStaleLock) await clearStaleSetupLock(root);
  await appendJournalEvent(paths.journal, "research.setup.retry.requested", "workspace", {
    planSha256: plan.planSha256,
    step: input.step,
    priorErrorCode: state.lastError.code,
  }).catch(() => undefined);
  return applyResearchSetupPlan(paths.setupPlan, input.options);
}

export async function checkResearchSetupUpdates(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  candidateVersion?: string,
) {
  const root = requireAbsoluteWorkspace(resolve(workspace));
  const plan = await loadHashVerifiedResearchSetupPlan(workspacePaths(root).setupPlan);
  const catalog = await inspectResearchSetupCatalog({
    selectedPath: root,
    scope: plan.install.scope,
    agents: plan.install.agents,
    environment,
  });
  const drift: Array<
    | { skillId: string; status: "removed" }
    | {
        skillId: string;
        status: "catalog-updated";
        plannedTreeSha256: string;
        currentTreeSha256: string;
      }
  > = [];
  for (const planned of plan.skills) {
    const current = RESEARCH_SETUP_SKILLS.find((skill) => skill.id === planned.id);
    if (!current) {
      drift.push({ skillId: planned.id, status: "removed" });
    } else if (current.expectedTreeSha256 !== planned.expectedTreeSha256) {
      drift.push({
        skillId: planned.id,
        status: "catalog-updated",
        plannedTreeSha256: planned.expectedTreeSha256,
        currentTreeSha256: current.expectedTreeSha256,
      });
    }
  }
  const cliVersionDrift =
    plan.cli.version === packageVersion()
      ? null
      : { planned: plan.cli.version, active: packageVersion() };
  const releaseCandidate =
    candidateVersion === undefined
      ? null
      : await inspectExactResearchCliRelease(candidateVersion, {
          installedVersion: plan.cli.version,
          environment,
        });
  const candidateUpgradeCommand =
    releaseCandidate?.status === "newer"
      ? exactResearchCliCommand(
          [
            "research",
            "setup",
            "upgrade",
            "--plan",
            "--confirm-upgrade",
            "--workspace",
            root,
            "--json",
          ],
          releaseCandidate.requestedVersion,
        ).replace(
          /^npx /,
          "npx --registry=https://registry.npmjs.org --@tiangong-ai:registry=https://registry.npmjs.org --strict-ssl=true ",
        )
      : null;
  const updateAvailable =
    drift.length > 0 || cliVersionDrift !== null || releaseCandidate?.status === "newer";
  return {
    schemaVersion: 1 as const,
    workspace: root,
    checkedAt: new Date().toISOString(),
    updateAvailable,
    releaseCandidate,
    candidateUpgradeCommand,
    cliVersionDrift,
    drift,
    currentInstaller: RESEARCH_SETUP_INSTALLER,
    catalog,
    policy: {
      automaticUpdate: false,
      floatingUpdate: false,
      minimumAction: updateAvailable
        ? "Use the active exact CLI release to create, review, and apply a replacement immutable plan; upgrade never runs a floating CLI or Skills update."
        : "No catalog migration is required. Installed tree drift is reported separately by setup status/doctor.",
    },
  };
}

export async function clearStaleSetupLock(workspace: string): Promise<void> {
  const root = requireAbsoluteWorkspace(resolve(workspace));
  const lockPath = workspacePaths(root).setupLock;
  let release: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    release = await acquireFileLock(lockPath, {
      operation: "research.setup.lock-recovery",
      acquiredAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "RESEARCH_WORKSPACE_LOCKED") {
      const details = isObject(error.details) ? error.details : {};
      if (details.ownerState === "alive") {
        throw new CliError("Setup is already running in another live process.", {
          code: "RESEARCH_SETUP_LOCK_ACTIVE",
          exitCode: 3,
          details: {
            ownerState: "alive",
            operation: typeof details.operation === "string" ? details.operation : null,
            acquiredAt: typeof details.acquiredAt === "string" ? details.acquiredAt : null,
            minimumAction:
              "Wait for the active setup operation to finish, then retry; do not delete lock state manually.",
          },
        });
      }
      throw new CliError("Setup lock ownership cannot yet be verified safely.", {
        code: "RESEARCH_SETUP_LOCK_UNVERIFIABLE",
        exitCode: 3,
        details: {
          ownerState: "unknown",
          retryAfterSeconds:
            typeof details.retryAfterSeconds === "number" ? details.retryAfterSeconds : null,
          minimumAction:
            "Wait for the reported lease interval and retry; do not delete lock state manually.",
        },
      });
    }
    throw new CliError("Setup lock state is unreadable or unsafe.", {
      code: "RESEARCH_SETUP_LOCK_INVALID",
      exitCode: 3,
      details: {
        ownerState: "unknown",
        minimumAction:
          "Inspect workspace filesystem permissions and lock-state integrity; do not delete lock state manually.",
      },
    });
  }
  await release();
}

function parseResearchSetupPlan(value: unknown): ResearchSetupPlan {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-research-setup-plan" ||
    typeof value.planId !== "string" ||
    typeof value.createdAt !== "string" ||
    !isObject(value.cli) ||
    value.cli.package !== "@tiangong-ai/cli" ||
    typeof value.cli.version !== "string" ||
    !isObject(value.workspace) ||
    typeof value.workspace.path !== "string" ||
    typeof value.workspace.name !== "string" ||
    (value.workspace.mode !== "smoke-test" && value.workspace.mode !== "production-research") ||
    !isObject(value.install) ||
    (value.install.scope !== "project" && value.install.scope !== "global") ||
    value.install.mode !== "copy" ||
    !Array.isArray(value.install.agents) ||
    value.install.agents.some((agent) => agent !== "codex" && agent !== "claude-code") ||
    !isObject(value.install.installer) ||
    !Array.isArray(value.install.targets) ||
    value.install.targets.some(
      (target) =>
        !isObject(target) ||
        (target.agent !== "codex" && target.agent !== "claude-code") ||
        typeof target.root !== "string" ||
        !isAbsolute(target.root),
    ) ||
    new Set(value.install.agents).size !== value.install.agents.length ||
    value.install.targets.length !== value.install.agents.length ||
    !isResearchSetupInstructionRoutingPlan(value.instructionRouting) ||
    !isObject(value.selection) ||
    !validEvidenceProfile(value.selection.evidenceProfile) ||
    !Array.isArray(value.selection.skillIds) ||
    value.selection.skillIds.some((id) => typeof id !== "string") ||
    !Array.isArray(value.sources) ||
    value.sources.some(
      (source) =>
        !isObject(source) ||
        typeof source.id !== "string" ||
        typeof source.repository !== "string" ||
        typeof source.locator !== "string" ||
        typeof source.immutableRef !== "string" ||
        !/^[0-9a-f]{40}$/.test(source.immutableRef),
    ) ||
    !Array.isArray(value.skills) ||
    value.skills.some(
      (skill) =>
        !isObject(skill) ||
        typeof skill.id !== "string" ||
        typeof skill.skillName !== "string" ||
        typeof skill.sourceId !== "string" ||
        typeof skill.sourceRelativePath !== "string" ||
        typeof skill.expectedTreeSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(skill.expectedTreeSha256) ||
        ![
          "orchestrator",
          "evidence-capability",
          "input-preprocessor",
          "acquisition-adapter",
          "post-closure-authoring",
        ].includes(String(skill.role)) ||
        typeof skill.licenseId !== "string",
    ) ||
    !Array.isArray(value.acceptedLicenses) ||
    value.acceptedLicenses.some(
      (license) =>
        !isObject(license) ||
        typeof license.skillId !== "string" ||
        typeof license.licenseId !== "string" ||
        license.accepted !== true,
    ) ||
    !Array.isArray(value.credentialSources) ||
    value.credentialSources.some(
      (credential) =>
        !isObject(credential) ||
        typeof credential.id !== "string" ||
        typeof credential.fromEnvironment !== "string" ||
        (credential.storage !== "broker" && credential.storage !== "adapter"),
    ) ||
    !isObject(value.settings) ||
    Object.values(value.settings).some((item) => typeof item !== "string") ||
    !isObject(value.agentRoutes) ||
    !validAgentRoutes(value.agentRoutes) ||
    !isObject(value.reviewerExecution) ||
    (value.reviewerExecution.transport !== "native-direct" &&
      value.reviewerExecution.transport !== "sandbox-bridge") ||
    value.reviewerExecution.isolationProvider !== "platform-capsule" ||
    !isObject(value.checks) ||
    typeof value.checks.live !== "boolean" ||
    typeof value.checks.allowSyntheticUnstructureUpload !== "boolean" ||
    typeof value.checks.agentSmoke !== "boolean" ||
    (value.checks.allowSyntheticUnstructureUpload === true && value.checks.live !== true) ||
    !isObject(value.confirmations) ||
    value.confirmations.networkDownloads !== true ||
    typeof value.confirmations.globalMutation !== "boolean" ||
    typeof value.confirmations.agentSmokeCost !== "boolean" ||
    !Array.isArray(value.mutations) ||
    value.mutations.some(
      (mutation) =>
        !isObject(mutation) ||
        typeof mutation.step !== "string" ||
        typeof mutation.target !== "string" ||
        typeof mutation.reason !== "string",
    ) ||
    typeof value.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.planSha256) ||
    (value.upgrade !== undefined && !validUpgradeBinding(value.upgrade))
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_PLAN_INVALID",
      step: "plan-validation",
      reason: "Setup plan has an unsupported schema or field type.",
      minimumAction: "Create a new plan with the active CLI and review it before applying.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return value as unknown as ResearchSetupPlan;
}

function validUpgradeBinding(value: unknown): value is ResearchSetupUpgradeBinding {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  const keys = [
    "cliRuntimeSha256",
    "parentPlanSha256",
    "parentRuntimeLockSha256",
    "parentConfigSha256",
    "parentMarkerSha256",
  ];
  return (
    Object.keys(value).length === keys.length + 1 &&
    keys.every((key) => typeof value[key] === "string" && /^[0-9a-f]{64}$/.test(String(value[key])))
  );
}

function assertPlanMatchesCatalog(plan: ResearchSetupPlan): void {
  const selected = resolveSetupSkills(plan.selection.skillIds);
  if (canonicalJson(plan.selection.skillIds) !== canonicalJson(selected.map((skill) => skill.id))) {
    throw planCatalogDrift("Skill selection order or duplicates");
  }
  if (
    plan.workspace.path !== requireAbsoluteWorkspace(plan.workspace.path) ||
    plan.workspace.name !== normalizedWorkspaceName(plan.workspace.name) ||
    (plan.workspace.mode === "production-research" && plan.selection.evidenceProfile === "none")
  ) {
    throw planCatalogDrift("workspace identity or mode");
  }
  validateEvidenceProfileSelection(plan.selection.evidenceProfile, selected);
  if (canonicalJson(plan.install.installer) !== canonicalJson(RESEARCH_SETUP_INSTALLER)) {
    throw planCatalogDrift("installer identity");
  }
  const expectedSources = [...new Set(selected.map((skill) => skill.sourceId))]
    .map(setupSource)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => ({
      id: source.id,
      repository: source.repository,
      locator: source.locator,
      immutableRef: source.immutableRef,
    }));
  if (canonicalJson(plan.sources) !== canonicalJson(expectedSources)) {
    throw planCatalogDrift("source pins");
  }
  const expectedSkills = selected.map((skill) => ({
    id: skill.id,
    skillName: skill.skillName,
    sourceId: skill.sourceId,
    sourceRelativePath: skill.sourceRelativePath,
    expectedTreeSha256: skill.expectedTreeSha256,
    role: skill.role,
    licenseId: skill.license.id,
  }));
  if (canonicalJson(plan.skills) !== canonicalJson(expectedSkills)) {
    throw planCatalogDrift("Skill identities or tree hashes");
  }
  const expectedLicenses = selected.map((skill) => ({
    skillId: skill.id,
    licenseId: skill.license.id,
    accepted: true as const,
  }));
  if (canonicalJson(plan.acceptedLicenses) !== canonicalJson(expectedLicenses)) {
    throw planCatalogDrift("license acceptance bindings");
  }
  const expectedSettings = normalizedSettings(selected, plan.settings);
  if (canonicalJson(plan.settings) !== canonicalJson(expectedSettings)) {
    throw planCatalogDrift("settings");
  }
  const expectedCredentialSources = normalizedCredentialSources(
    selected,
    Object.fromEntries(plan.credentialSources.map((item) => [item.id, item.fromEnvironment])),
  );
  if (canonicalJson(plan.credentialSources) !== canonicalJson(expectedCredentialSources)) {
    throw planCatalogDrift("credential source bindings");
  }
  if (canonicalJson(plan.agentRoutes) !== canonicalJson(normalizeAgentRoutes(plan.agentRoutes))) {
    throw planCatalogDrift("agent routes");
  }
  if (
    canonicalJson(plan.reviewerExecution) !==
    canonicalJson(normalizeReviewerExecution(plan.reviewerExecution))
  ) {
    throw planCatalogDrift("reviewer execution transport");
  }
  if (canonicalJson(plan.install.agents) !== canonicalJson(normalizeAgents(plan.install.agents))) {
    throw planCatalogDrift("agent selection order or duplicates");
  }
  const expectedTargets = plannedInstallTargets(
    plan.workspace.path,
    plan.install.scope,
    plan.install.agents,
    process.env,
    Object.fromEntries(plan.install.targets.map((target) => [target.agent, target.root])),
  );
  if (canonicalJson(plan.install.targets) !== canonicalJson(expectedTargets)) {
    throw planCatalogDrift("install targets");
  }
  const expectedInstructionRouting = planResearchSetupInstructionRouting({
    workspace: plan.workspace.path,
    scope: plan.install.scope,
    agents: plan.install.agents,
    selectedSkillIds: selected.map((skill) => skill.id),
  });
  if (canonicalJson(plan.instructionRouting) !== canonicalJson(expectedInstructionRouting)) {
    throw planCatalogDrift("project instruction routing");
  }
  if ((plan.install.scope === "global") !== plan.confirmations.globalMutation) {
    throw planCatalogDrift("global mutation confirmation");
  }
  if (plan.checks.agentSmoke !== plan.confirmations.agentSmokeCost) {
    throw planCatalogDrift("agent smoke confirmation");
  }
  const expectedMutations = setupMutations(
    plan.workspace.path,
    plan.install.targets,
    selected,
    expectedInstructionRouting,
  );
  if (canonicalJson(plan.mutations) !== canonicalJson(expectedMutations)) {
    throw planCatalogDrift("declared mutations");
  }
}

function validAgentRoutes(value: Record<string, unknown>): boolean {
  const allowed = new Set([
    "producerAgent",
    "reviewerAgent",
    "producerModel",
    "reviewerModel",
    "producerPricing",
    "reviewerPricing",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !["codex", "claude", "workbuddy", "codebuddy"].includes(String(value.producerAgent)) ||
    (value.reviewerAgent !== "codex" && value.reviewerAgent !== "claude") ||
    value.producerAgent === value.reviewerAgent ||
    !(value.producerModel === null || typeof value.producerModel === "string") ||
    !(value.reviewerModel === null || typeof value.reviewerModel === "string")
  ) {
    return false;
  }
  return validNullablePricing(value.producerPricing) && validNullablePricing(value.reviewerPricing);
}

function validNullablePricing(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const keys = [
    "inputUsdPerMillionTokens",
    "cachedInputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        (value[key] as number) >= 0,
    )
  );
}

function validateEvidenceProfileSelection(
  profile: ResearchSetupEvidenceProfile,
  selected: ResearchSetupSkill[],
): void {
  const actual = selected
    .filter((skill) => skill.sourceId === "brave-search-skills")
    .map((skill) => skill.id)
    .sort();
  const expected = [...BRAVE_PROFILE_SKILLS[profile]].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw setupError({
      code: "RESEARCH_SETUP_SELECTION_INVALID",
      step: "selection",
      reason: `Brave evidence selection does not exactly match profile ${profile}.`,
      minimumAction:
        "Choose one named evidence profile; do not construct a silent partial provider fallback.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
}

function validateLicenseAcceptances(
  selected: ResearchSetupSkill[],
  acceptedLicenseIds: readonly string[],
): void {
  const accepted = new Set(acceptedLicenseIds);
  const missing = selected.filter((skill) => !accepted.has(skill.license.id));
  if (missing.length) {
    throw setupError({
      code: "RESEARCH_SETUP_LICENSE_NOT_ACCEPTED",
      step: "license",
      reason: `Explicit license review is missing for: ${missing.map((skill) => skill.id).join(", ")}.`,
      minimumAction:
        "Review each pinned license URL and explicitly accept only the Skills you choose to install.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
}

function normalizedSettings(
  selected: ResearchSetupSkill[],
  supplied: Record<string, string>,
): Record<string, string> {
  const definitions = requiredSettingsForSkills(selected);
  const allowed = new Set(definitions.map((setting) => setting.id));
  const unknown = Object.keys(supplied).filter((id) => !allowed.has(id));
  if (unknown.length) {
    throw setupError({
      code: "RESEARCH_SETUP_SETTING_INVALID",
      step: "configuration",
      reason: `Settings are not declared by selected Skills: ${unknown.join(", ")}.`,
      minimumAction: "Use only the setting IDs reported by setup catalog.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
  const normalized: Record<string, string> = {};
  for (const setting of definitions) {
    const candidate = supplied[setting.id]?.trim() || setting.defaultValue;
    if (!candidate) {
      if (setting.required) {
        throw setupError({
          code: "RESEARCH_SETUP_SETTING_REQUIRED",
          step: "configuration",
          reason: `Required non-secret setting is missing: ${setting.id}.`,
          minimumAction: `Provide ${setting.id} in the reviewed setup settings object.`,
          retryCommand: "tiangong-ai research setup plan --help",
          exitCode: 2,
        });
      }
      continue;
    }
    validateSetupSetting(setting.id, setting.validation, candidate);
    normalized[setting.id] = candidate;
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizedCredentialSources(
  selected: ResearchSetupSkill[],
  supplied: Record<string, string>,
): ResearchSetupPlan["credentialSources"] {
  const definitions = credentialDefinitionsForSkills(selected);
  const allowed = new Map(definitions.map((credential) => [credential.id, credential]));
  const unknown = Object.keys(supplied).filter((id) => !allowed.has(id));
  if (unknown.length) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_INVALID",
      step: "credentials",
      reason: `Credential IDs are not declared by selected Skills: ${unknown.join(", ")}.`,
      minimumAction: "Use only credential IDs reported by setup catalog.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 2,
    });
  }
  return Object.entries(supplied)
    .map(([id, fromEnvironment]) => {
      assertEnvironmentName(fromEnvironment);
      return { id, fromEnvironment, storage: allowed.get(id)!.storage };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeReviewerExecution(
  value: Partial<ReviewExecutionConfig> | undefined,
): ReviewExecutionConfig {
  const transport = value?.transport ?? "native-direct";
  const isolationProvider = value?.isolationProvider ?? "platform-capsule";
  if (
    (transport !== "native-direct" && transport !== "sandbox-bridge") ||
    isolationProvider !== "platform-capsule"
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_REVIEW_TRANSPORT_INVALID",
      step: "reviewer-execution",
      reason:
        "Reviewer execution must explicitly use native-direct or sandbox-bridge with the platform capsule.",
      minimumAction:
        "Choose native-direct on a normal host, or sandbox-bridge with an owner-started sidecar outside the IDE sandbox.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return { transport, isolationProvider };
}

function normalizeAgentRoutes(
  value: Partial<ResearchSetupAgentRoutePlan> | undefined,
): ResearchSetupAgentRoutePlan {
  const producerAgent = normalizeAgentKind(value?.producerAgent ?? "codex", "producer");
  const reviewerAgent = normalizeAgentKind(
    value?.reviewerAgent ?? (producerAgent === "codex" ? "claude" : "codex"),
    "reviewer",
  );
  if (producerAgent === reviewerAgent) {
    throw setupError({
      code: "RESEARCH_SETUP_AGENT_ROUTE_INVALID",
      step: "agent-route",
      reason: "The native producer and independent reviewer must use different agent families.",
      minimumAction: "Choose Codex + Claude Code in either producer/reviewer order.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return {
    producerAgent,
    reviewerAgent,
    producerModel: normalizeNullableIdentifier(value?.producerModel),
    reviewerModel: normalizeNullableIdentifier(value?.reviewerModel),
    producerPricing: normalizePricing(value?.producerPricing),
    reviewerPricing: normalizePricing(value?.reviewerPricing),
  };
}

function normalizeAgentKind(value: AgentKind, label: string): AgentKind {
  if (value === "codex" || value === "claude") return value;
  if (label === "producer" && (value === "workbuddy" || value === "codebuddy")) return value;
  throw setupError({
    code: "RESEARCH_SETUP_AGENT_ROUTE_INVALID",
    step: "agent-route",
    reason:
      label === "producer"
        ? "producer agent must be codex, claude, workbuddy, or codebuddy."
        : "reviewer agent must be codex or claude.",
    minimumAction:
      "Choose the current native producer host and keep the reviewer on an independent Codex or Claude CLI family.",
    retryCommand: "tiangong-ai research setup plan --help",
    exitCode: 2,
  });
}

function normalizePricing(value: AgentPricing | null | undefined): AgentPricing | null {
  if (value === undefined || value === null) return null;
  const numbers = [
    value.inputUsdPerMillionTokens,
    value.cachedInputUsdPerMillionTokens,
    value.outputUsdPerMillionTokens,
  ];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
    throw setupError({
      code: "RESEARCH_SETUP_AGENT_ROUTE_INVALID",
      step: "agent-route",
      reason: "Agent pricing must use finite non-negative USD-per-million-token values.",
      minimumAction: "Provide current reviewed provider pricing or defer production readiness.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return value;
}

function normalizeNullableIdentifier(value: string | null | undefined): string | null {
  if (value === undefined || value === null || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > 200 || /[\r\n\0]/.test(normalized)) {
    throw setupError({
      code: "RESEARCH_SETUP_AGENT_ROUTE_INVALID",
      step: "agent-route",
      reason: "Agent model identifier is malformed.",
      minimumAction: "Use an exact provider model identifier without control characters.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return normalized;
}

function normalizeAgents(values: ResearchSetupAgent[]): ResearchSetupAgent[] {
  const agents = [...new Set(values)];
  if (agents.length === 0 || agents.some((agent) => agent !== "codex" && agent !== "claude-code")) {
    throw setupError({
      code: "RESEARCH_SETUP_AGENT_INVALID",
      step: "selection",
      reason: "Setup agents must be an explicit non-empty subset of codex and claude-code.",
      minimumAction: "Choose codex, claude-code, or both.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return agents.sort();
}

function plannedInstallTargets(
  workspace: string,
  scope: ResearchSetupScope,
  agents: ResearchSetupAgent[],
  environment: NodeJS.ProcessEnv,
  overrides: Partial<Record<ResearchSetupAgent, string>> | undefined,
): ResearchSetupPlan["install"]["targets"] {
  const unknownOverride = Object.keys(overrides ?? {}).find(
    (agent) => agent !== "codex" && agent !== "claude-code",
  );
  if (unknownOverride) {
    throw setupError({
      code: "RESEARCH_SETUP_TARGET_INVALID",
      step: "selection",
      reason: `Unknown install target agent: ${unknownOverride}.`,
      minimumAction: "Use only the target roots bound to codex or claude-code.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  const canonicalWorkspace = resolve(workspace);
  const targets = agents.map((agent) => {
    const supplied = overrides?.[agent];
    const target = resolve(supplied ?? setupTargetRoot({ workspace, scope, agent, environment }));
    const globalBase = agent === "codex" ? dirname(dirname(target)) : dirname(target);
    const installerCompatibleGlobalTarget =
      scope !== "global" ||
      (globalBase !== dirname(globalBase) &&
        target ===
          (agent === "codex" ? join(globalBase, ".agents", "skills") : join(globalBase, "skills")));
    if (
      !isAbsolute(target) ||
      target === resolve(target, sep) ||
      /[\0\r\n]/.test(target) ||
      (scope === "project" && target !== setupTargetRoot({ workspace, scope: "project", agent })) ||
      !installerCompatibleGlobalTarget ||
      (scope === "global" &&
        (target === canonicalWorkspace || target.startsWith(`${canonicalWorkspace}${sep}`)))
    ) {
      throw setupError({
        code: "RESEARCH_SETUP_TARGET_INVALID",
        step: "selection",
        reason: `Install target is incompatible with ${scope} scope for ${agent}.`,
        minimumAction:
          "Use project scope for workspace-local copies, or an explicit global agent home outside the workspace.",
        retryCommand: "tiangong-ai research setup plan --help",
        exitCode: 2,
      });
    }
    return { agent, root: target };
  });
  if (new Set(targets.map((target) => target.root)).size !== targets.length) {
    throw setupError({
      code: "RESEARCH_SETUP_TARGET_CONFLICT",
      step: "selection",
      reason: "Multiple selected agents resolve to the same install root.",
      minimumAction: "Choose distinct agent homes or install for only one agent.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return targets;
}

function plannedTargetRoot(plan: ResearchSetupPlan, agent: ResearchSetupAgent): string {
  const target = plan.install.targets.find((candidate) => candidate.agent === agent);
  if (!target) throw planCatalogDrift(`missing install target for ${agent}`);
  return target.root;
}

function validEvidenceProfile(value: unknown): value is ResearchSetupEvidenceProfile {
  return Object.hasOwn(BRAVE_PROFILE_SKILLS, String(value));
}

function planCatalogDrift(label: string): CliError {
  return setupError({
    code: "RESEARCH_SETUP_PLAN_CATALOG_DRIFT",
    step: "plan-validation",
    reason: `Setup plan ${label} does not match the active immutable catalog.`,
    minimumAction:
      "Generate and review a replacement plan; the CLI will not reinterpret an old plan.",
    retryCommand: "tiangong-ai research setup update --check --json",
    exitCode: 3,
  });
}

async function ensureSetupWorkspace(plan: ResearchSetupPlan): Promise<void> {
  const context = await inspectResearchContext(plan.workspace.path);
  if (context.role === "workspace") {
    const config = await loadWorkspaceConfig(plan.workspace.path);
    if (config.mode !== plan.workspace.mode) {
      throw setupError({
        code: "RESEARCH_SETUP_WORKSPACE_CONFLICT",
        step: "workspace",
        reason: `Existing workspace mode ${config.mode} differs from plan mode ${plan.workspace.mode}.`,
        minimumAction:
          "Create a new reviewed plan for the existing mode or choose a different empty directory.",
        retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
        exitCode: 3,
      });
    }
    return;
  }
  if (context.role !== "setup" && context.role !== "unmanaged") {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_INVALID",
      step: "workspace",
      reason: `Target context is ${context.role}.`,
      minimumAction:
        "Use an empty regular directory or repair the reported partial workspace state.",
      retryCommand: `tiangong-ai research context inspect --path ${plan.workspace.path} --json`,
      exitCode: 3,
    });
  }
  await initializeResearchWorkspace(plan.workspace.path, plan.workspace.name, plan.workspace.mode);
}

async function configureAgentRoutes(plan: ResearchSetupPlan): Promise<void> {
  const paths = workspacePaths(plan.workspace.path);
  const config = await loadWorkspaceConfig(plan.workspace.path);
  const updated = {
    ...config,
    producer: setupAgentRoute(
      config.producer,
      plan.agentRoutes.producerAgent,
      "native-host",
      plan.agentRoutes.producerModel,
      plan.agentRoutes.producerPricing,
    ),
    reviewer: setupAgentRoute(
      config.reviewer,
      plan.agentRoutes.reviewerAgent,
      "headless-cli",
      plan.agentRoutes.reviewerModel,
      plan.agentRoutes.reviewerPricing,
    ),
    reviewerExecution: plan.reviewerExecution,
  };
  await writeJsonAtomic(paths.config, updated);
}

function setupAgentRoute(
  current: AgentRoute,
  agent: AgentKind,
  executionMode: "native-host" | "headless-cli",
  plannedModel: string | null,
  plannedPricing: AgentPricing | null,
): AgentRoute {
  const sameAgent = current.agent === agent;
  return {
    agent,
    executionMode,
    binary: sameAgent
      ? current.binary
      : agent === "codex"
        ? "codex"
        : agent === "claude"
          ? "claude"
          : `${agent}-native-host`,
    ...(sameAgent && current.wrapperTargetBinary !== undefined
      ? { wrapperTargetBinary: current.wrapperTargetBinary }
      : {}),
    model: plannedModel ?? (sameAgent ? current.model : null),
    effort: sameAgent ? (current.effort ?? "low") : "low",
    ...(agent === "codex" ? { verbosity: sameAgent ? (current.verbosity ?? "low") : "low" } : {}),
    ...((plannedPricing ?? (sameAgent ? current.pricing : undefined)) === undefined
      ? {}
      : { pricing: plannedPricing ?? current.pricing }),
  };
}

async function inspectSelectedInstallations(
  plan: ResearchSetupPlan,
  selected: ResearchSetupSkill[],
  _environment: NodeJS.ProcessEnv,
): Promise<
  Array<{
    skillId: string;
    skillName: string;
    agent: ResearchSetupAgent;
    path: string;
    status: "missing" | "installed" | "drifted" | "blocked";
    observedTreeSha256: string | null;
    detail: string;
  }>
> {
  const results = [];
  for (const agent of plan.install.agents) {
    const root = plannedTargetRoot(plan, agent);
    const boundary =
      plan.install.scope === "project"
        ? plan.workspace.path
        : agent === "codex"
          ? dirname(dirname(dirname(root)))
          : dirname(dirname(root));
    await assertNoSymlinkedExistingPath(root, boundary);
    for (const skill of selected) {
      const path = join(root, skill.skillName);
      if (!(await pathExists(path))) {
        results.push({
          skillId: skill.id,
          skillName: skill.skillName,
          agent,
          path,
          status: "missing" as const,
          observedTreeSha256: null,
          detail: "Skill is not installed.",
        });
        continue;
      }
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          results.push({
            skillId: skill.id,
            skillName: skill.skillName,
            agent,
            path,
            status: "blocked" as const,
            observedTreeSha256: null,
            detail: "Install destination is not a regular non-symlink directory.",
          });
          continue;
        }
        const observedTreeSha256 = await hashRegularTree(path);
        results.push({
          skillId: skill.id,
          skillName: skill.skillName,
          agent,
          path,
          status:
            observedTreeSha256 === skill.expectedTreeSha256
              ? ("installed" as const)
              : ("drifted" as const),
          observedTreeSha256,
          detail:
            observedTreeSha256 === skill.expectedTreeSha256
              ? "Installed bytes match the reviewed tree hash."
              : "Installed bytes differ from the reviewed tree hash.",
        });
      } catch (error) {
        results.push({
          skillId: skill.id,
          skillName: skill.skillName,
          agent,
          path,
          status: "blocked" as const,
          observedTreeSha256: null,
          detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
  }
  return results;
}

async function verifyInstallerPackage(
  runner: SetupCommandRunner,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await runner({
    command: "npm",
    args: [
      "view",
      `skills@${RESEARCH_SETUP_INSTALLER.version}`,
      "version",
      "dist.integrity",
      "gitHead",
      "--json",
    ],
    cwd,
    environment,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw commandFailure("installer-verification", "npm", result, cwd, environment);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    value = null;
  }
  if (
    !isObject(value) ||
    value.version !== RESEARCH_SETUP_INSTALLER.version ||
    value["dist.integrity"] !== RESEARCH_SETUP_INSTALLER.npmIntegrity ||
    value.gitHead !== RESEARCH_SETUP_INSTALLER.gitHead
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_INSTALLER_INTEGRITY_FAILED",
      step: "installer-verification",
      reason: "npm registry metadata did not match the pinned installer version and integrity.",
      minimumAction:
        "Stop and inspect the registry/source metadata; do not bypass installer verification.",
      retryCommand: `npm view skills@${RESEARCH_SETUP_INSTALLER.version} version dist.integrity gitHead --json`,
      exitCode: 3,
    });
  }
}

async function ensureSetupSourceCheckout(
  plan: ResearchSetupPlan,
  sourceId: string,
  runner: SetupCommandRunner,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const source = plan.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw planCatalogDrift(`missing source ${sourceId}`);
  const checkout = setupSourceCheckoutPath(plan, sourceId);
  await assertNoSymlinkedExistingPath(dirname(checkout), plan.workspace.path);
  let createdCheckout = false;
  if (!(await pathExists(checkout))) {
    await ensureDirectory(workspacePaths(plan.workspace.path).setupSources);
    await runChecked(
      runner,
      "git",
      ["init", "--quiet", checkout],
      plan.workspace.path,
      environment,
      "source-checkout",
    );
    createdCheckout = true;
    await configureDeterministicSourceCheckout(checkout, runner, plan.workspace.path, environment);
    await runChecked(
      runner,
      "git",
      ["-C", checkout, "remote", "add", "origin", source.locator],
      plan.workspace.path,
      environment,
      "source-checkout",
    );
  }
  const info = await lstat(checkout);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw setupError({
      code: "RESEARCH_SETUP_SOURCE_INVALID",
      step: "source-checkout",
      reason: `Source checkout is not a regular non-symlink directory: ${source.id}.`,
      minimumAction: "Inspect the source cache; setup will not replace or follow it.",
      retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
      exitCode: 3,
    });
  }
  let origin = await runner({
    command: "git",
    args: ["-C", checkout, "remote", "get-url", "origin"],
    cwd: plan.workspace.path,
    environment,
    timeoutMs: 30_000,
  });
  if (origin.exitCode !== 0) {
    const incompleteHead = await runner({
      command: "git",
      args: ["-C", checkout, "rev-parse", "HEAD"],
      cwd: plan.workspace.path,
      environment,
      timeoutMs: 30_000,
    });
    if (incompleteHead.exitCode === 0) {
      throw setupError({
        code: "RESEARCH_SETUP_SOURCE_DRIFT",
        step: "source-verification",
        reason: `Existing source checkout has a commit but no reviewed origin: ${source.id}.`,
        minimumAction: "Use a new empty source cache path; the CLI will not adopt this checkout.",
        retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
        exitCode: 3,
      });
    }
    await runChecked(
      runner,
      "git",
      ["-C", checkout, "remote", "add", "origin", source.locator],
      plan.workspace.path,
      environment,
      "source-checkout",
    );
    origin = await runChecked(
      runner,
      "git",
      ["-C", checkout, "remote", "get-url", "origin"],
      plan.workspace.path,
      environment,
      "source-verification",
    );
  }
  if (origin.stdout.trim() !== source.locator) {
    throw setupError({
      code: "RESEARCH_SETUP_SOURCE_DRIFT",
      step: "source-verification",
      reason: `Source checkout identity differs from the reviewed plan: ${source.id}.`,
      minimumAction:
        "Use a new empty source cache path; do not update or rewrite the existing checkout in place.",
      retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
      exitCode: 3,
    });
  }
  let head = await runner({
    command: "git",
    args: ["-C", checkout, "rev-parse", "HEAD"],
    cwd: plan.workspace.path,
    environment,
    timeoutMs: 30_000,
  });
  if (head.exitCode !== 0) {
    // A process may have been interrupted after git init/remote-add. Resume only
    // that exact incomplete checkout; never rewrite a checkout with a valid,
    // different HEAD.
    if (!createdCheckout) {
      await configureDeterministicSourceCheckout(
        checkout,
        runner,
        plan.workspace.path,
        environment,
      );
    }
    await runChecked(
      runner,
      "git",
      ["-C", checkout, "fetch", "--depth", "1", "origin", source.immutableRef],
      plan.workspace.path,
      environment,
      "source-checkout",
      180_000,
    );
    await runChecked(
      runner,
      "git",
      ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
      plan.workspace.path,
      environment,
      "source-checkout",
    );
    head = await runChecked(
      runner,
      "git",
      ["-C", checkout, "rev-parse", "HEAD"],
      plan.workspace.path,
      environment,
      "source-verification",
    );
  }
  if (head.stdout.trim().toLowerCase() !== source.immutableRef) {
    throw setupError({
      code: "RESEARCH_SETUP_SOURCE_DRIFT",
      step: "source-verification",
      reason: `Source checkout identity differs from the reviewed plan: ${source.id}.`,
      minimumAction:
        "Use a new empty source cache path; do not update or rewrite the existing checkout in place.",
      retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
      exitCode: 3,
    });
  }
  for (const skill of plan.skills.filter((candidate) => candidate.sourceId === source.id)) {
    const sourcePath = resolve(checkout, skill.sourceRelativePath);
    if (!sourcePath.startsWith(`${resolve(checkout)}${sep}`)) throw planCatalogDrift("source path");
    const observedTreeSha256 = await hashRegularTree(sourcePath);
    if (observedTreeSha256 !== skill.expectedTreeSha256) {
      throw setupError({
        code: "RESEARCH_SETUP_SOURCE_HASH_MISMATCH",
        step: "source-verification",
        reason: `Pinned source bytes failed the reviewed tree hash for ${skill.id}.`,
        minimumAction:
          "Regenerate the reviewed setup plan with the active CLI/catalog. If that exact plan still fails, inspect only its CLI-owned source cache; never bypass verification.",
        retryCommand: `tiangong-ai research setup update --check --workspace ${plan.workspace.path} --json`,
        exitCode: 3,
        diagnostics: {
          skillId: skill.id,
          sourceId: source.id,
          hashAlgorithm: REGULAR_TREE_HASH_ALGORITHM,
          expectedTreeSha256: skill.expectedTreeSha256,
          observedTreeSha256,
        },
      });
    }
    await verifyResearchSetupRuntimeContract(sourcePath, setupSkill(skill.id));
  }
  return checkout;
}

function setupSourceCheckoutPath(plan: ResearchSetupPlan, sourceId: string): string {
  const source = plan.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw planCatalogDrift(`missing source ${sourceId}`);
  return join(
    workspacePaths(plan.workspace.path).setupSources,
    `${source.id}-${source.immutableRef.slice(0, 12)}`,
  );
}

async function annotateSetupSourceCheckoutFailure(
  error: unknown,
  plan: ResearchSetupPlan,
  sourceId: string,
): Promise<unknown> {
  if (!(error instanceof CliError) || error.code !== "RESEARCH_SETUP_COMMAND_FAILED") return error;
  const source = plan.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return error;
  const details = isObject(error.details) ? error.details : {};
  const checkout = setupSourceCheckoutPath(plan, sourceId);
  return setupError({
    code: error.code,
    step: "source-checkout",
    reason:
      typeof details.reason === "string" ? details.reason : sanitizeResearchText(error.message),
    minimumAction:
      typeof details.minimumAction === "string"
        ? details.minimumAction
        : "Resolve the source transport failure, then retry only the recorded source-checkout step.",
    retryCommand: researchSetupRetryCommand({
      version: plan.cli.version,
      workspace: plan.workspace.path,
      step: "source-checkout",
    }),
    exitCode: error.exitCode,
    diagnostics: {
      sourceId: source.id,
      repository: source.repository,
      immutableRef: source.immutableRef,
      cacheState: (await pathExists(checkout)) ? "partial" : "absent",
      safeToRetry: true,
    },
  });
}

async function configureDeterministicSourceCheckout(
  checkout: string,
  runner: SetupCommandRunner,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
  ] as const) {
    await runChecked(
      runner,
      "git",
      ["-C", checkout, "config", "--local", key, value],
      cwd,
      environment,
      "source-checkout",
    );
  }
}

async function installSetupSkills(input: {
  plan: ResearchSetupPlan;
  agent: ResearchSetupAgent;
  skills: ResearchSetupSkill[];
  sourceDirectory: string;
  runner: SetupCommandRunner;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!input.skills.length) return;
  const args = [
    "--yes",
    "--package",
    `skills@${RESEARCH_SETUP_INSTALLER.version}`,
    "--",
    "skills",
    "add",
    input.sourceDirectory,
    "--skill",
    ...input.skills.map((skill) => skill.skillName),
    "--agent",
    input.agent,
    "--yes",
    "--copy",
    ...(input.plan.install.scope === "global" ? ["--global"] : []),
  ];
  const result = await input.runner({
    command: "npx",
    args,
    cwd: input.plan.workspace.path,
    environment: input.environment,
    timeoutMs: 5 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw commandFailure(
      "skill-install",
      "npx",
      result,
      input.plan.workspace.path,
      input.environment,
    );
  }
}

async function configureSelectedCapabilities(
  plan: ResearchSetupPlan,
  _environment: NodeJS.ProcessEnv,
): Promise<void> {
  const hasBraveProfile = plan.selection.evidenceProfile !== "none";
  const tiangongDatabases = [
    {
      kind: "sci" as const,
      skillId: "tiangong.kb-sci-search",
      settingPrefix: "tiangong.sci",
      catalogId: "first-party.tiangong.kb-sci-search",
      capabilityId: "database.tiangong.sci-search",
    },
    {
      kind: "report" as const,
      skillId: "tiangong.kb-report-search",
      settingPrefix: "tiangong.report",
      catalogId: "first-party.tiangong.kb-report-search",
      capabilityId: "database.tiangong.report-search",
    },
    {
      kind: "patent" as const,
      skillId: "tiangong.kb-patent-search",
      settingPrefix: "tiangong.patent",
      catalogId: "first-party.tiangong.kb-patent-search",
      capabilityId: "database.tiangong.patent-search",
    },
  ].filter((entry) => plan.selection.skillIds.includes(entry.skillId));
  const codexRoot =
    hasBraveProfile || tiangongDatabases.length ? plannedTargetRoot(plan, "codex") : null;
  if (plan.selection.evidenceProfile !== "none") {
    await configureExternalSkillProfile({
      workspace: plan.workspace.path,
      profile: plan.selection.evidenceProfile,
      skillRoot: codexRoot!,
    });
  }
  for (const database of tiangongDatabases) {
    const skill = setupSkill(database.skillId);
    const source = setupSource(skill.sourceId);
    await configureTiangongDatabaseCapability({
      kind: database.kind,
      workspace: plan.workspace.path,
      skillPath: join(codexRoot!, skill.skillName),
      source: {
        type: "git",
        locator: source.locator,
        immutableRef: source.immutableRef,
        expectedTreeSha256: skill.expectedTreeSha256,
        license: "MIT",
        catalogId: database.catalogId,
      },
      endpoint: plan.settings[`${database.settingPrefix}.endpoint`]!,
      ...(plan.settings[`${database.settingPrefix}.region`] === undefined
        ? {}
        : { region: plan.settings[`${database.settingPrefix}.region`] }),
    });
  }
  await reconcileSetupManagedCapabilities({
    workspace: plan.workspace.path,
    selectedCapabilityIds: [
      ...BRAVE_PROFILE_SKILLS[plan.selection.evidenceProfile].map(setupManagedCapabilityId),
      ...tiangongDatabases.map((database) => database.capabilityId),
    ],
  });
}

function setupManagedCapabilityId(skillId: string): string {
  const mapping: Record<string, string> = {
    "brave.web-search": "method.brave.web-search",
    "brave.news-search": "method.brave.news-search",
    "brave.llm-context": "method.brave.llm-context",
    "brave.images-search": "method.brave.images-search",
    "brave.videos-search": "method.brave.videos-search",
  };
  const capabilityId = mapping[skillId] ?? null;
  if (!capabilityId) {
    throw setupError({
      code: "RESEARCH_SETUP_CATALOG_DRIFT",
      step: "capability-configuration",
      reason: `Setup-managed evidence Skill has no capability mapping: ${skillId}.`,
      minimumAction: "Use the exact CLI/catalog release and regenerate the setup plan.",
      retryCommand: "tiangong-ai research setup catalog --json",
      exitCode: 3,
    });
  }
  return capabilityId;
}

async function reconcilePlanCredentialStores(plan: ResearchSetupPlan): Promise<void> {
  const declarations = await loadCapabilityDeclarations(plan.workspace.path);
  await reconcileCapabilityCredentialEnvironment(plan.workspace.path, declarations.capabilities);
  const adapterPath = workspacePaths(plan.workspace.path).setupAdapterEnv;
  if (!(await pathExists(adapterPath))) return;
  const definitions = selectedCredentialDefinitions(plan).filter(
    (credential) => credential.storage === "adapter",
  );
  const configured = await loadAdapterCredentials(plan.workspace.path, definitions, {
    ignoreUndeclared: true,
  });
  const serialized = Object.fromEntries(
    [...configured.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeTextAtomic(adapterPath, `${ADAPTER_ENV_KEY}=${JSON.stringify(serialized)}\n`, 0o600);
}

async function configurePlanCredentials(
  plan: ResearchSetupPlan,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const credential of plan.credentialSources) {
    const definition = RESEARCH_SETUP_CREDENTIALS.find(
      (candidate) => candidate.id === credential.id,
    );
    if (
      !definition ||
      Buffer.byteLength(environment[credential.fromEnvironment] ?? "", "utf8") <
        definition.minimumUtf8Bytes
    ) {
      // Credential preflight already proved that an owner-only stored value is
      // available. Do not require the source environment to remain populated.
      continue;
    }
    await setResearchSetupCredentialFromEnvironment({
      workspace: plan.workspace.path,
      credentialId: credential.id,
      environmentName: credential.fromEnvironment,
      environment,
    });
  }
}

async function assertRequiredCredentialPreflight(
  plan: ResearchSetupPlan,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const definitions = selectedCredentialDefinitions(plan);
  let adapterCredentials = new Map<string, string>();
  try {
    adapterCredentials = await loadAdapterCredentials(plan.workspace.path, definitions, {
      ignoreUndeclared: true,
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  const brokerDefinitions = definitions.filter((definition) => definition.storage === "broker");
  const configuredBrokerIds = new Set(
    (
      await loadCapabilityCredentialMapForIds(
        plan.workspace.path,
        brokerDefinitions.map((definition) => definition.id),
        { ignoreUndeclared: true },
      )
    ).keys(),
  );
  const failures: Array<{ id: string }> = [];
  for (const definition of definitions) {
    const planned = plan.credentialSources.find((candidate) => candidate.id === definition.id);
    const stored =
      definition.storage === "broker"
        ? configuredBrokerIds.has(definition.id)
        : adapterCredentials.has(definition.id);
    const supplied =
      planned !== undefined &&
      Buffer.byteLength(environment[planned.fromEnvironment] ?? "", "utf8") >=
        definition.minimumUtf8Bytes;
    if ((!planned && definition.required && !stored) || (planned && !supplied && !stored)) {
      failures.push({ id: definition.id });
    }
  }
  if (failures.length) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_PREFLIGHT_FAILED",
      step: "credential-preflight",
      reason: `Required or explicitly selected credentials are unavailable: ${failures
        .map((failure) => failure.id)
        .join(", ")}.`,
      minimumAction: `Configure each unavailable logical credential with research setup credential set --prompt, --from-stdin, or --from-env before any download (${failures
        .map((failure) => failure.id)
        .join(", ")}), then retry this exact step.`,
      retryCommand: `tiangong-ai research setup retry --step credential-preflight --workspace ${plan.workspace.path} --json`,
      exitCode: 3,
      diagnostics: {
        executionMode: "setup-preflight",
        credentialScope: [
          ...new Set(
            failures.map(
              (failure) => definitions.find((definition) => definition.id === failure.id)!.storage,
            ),
          ),
        ].join("+"),
        networkAttempted: false,
        missingCredentialIds: failures.map((failure) => failure.id),
      },
    });
  }
}

function selectedCredentialDefinitions(plan: ResearchSetupPlan): ResearchSetupCredential[] {
  return credentialDefinitionsForSkills(plan.selection.skillIds.map(setupSkill));
}

function credentialDefinitionsForSkills(selected: ResearchSetupSkill[]): ResearchSetupCredential[] {
  const ids = new Set(selected.flatMap((skill) => skill.credentialIds));
  return RESEARCH_SETUP_CREDENTIALS.filter((credential) => ids.has(credential.id)).sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

function requiredSettingsForSkills(selected: ResearchSetupSkill[]) {
  const ids = new Set(selected.flatMap((skill) => skill.settingIds));
  return RESEARCH_SETUP_SETTINGS.filter((setting) => ids.has(setting.id)).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

async function verifiedCompanionSkillDirectory(
  plan: ResearchSetupPlan,
  skill: ResearchSetupSkill,
): Promise<string> {
  const candidates = [...plan.install.targets].sort((left, right) => {
    if (left.agent === "codex" && right.agent !== "codex") return -1;
    if (right.agent === "codex" && left.agent !== "codex") return 1;
    return left.agent.localeCompare(right.agent);
  });
  for (const target of candidates) {
    const directory = join(target.root, skill.skillName);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    if ((await hashRegularTree(directory)) === skill.expectedTreeSha256) return directory;
  }
  throw setupError({
    code: "RESEARCH_SETUP_COMPANION_INSTALL_INVALID",
    step: "companion-preflight",
    reason: `${skill.id} is missing, symlinked, or does not match the reviewed tree hash.`,
    minimumAction:
      "Run setup status and apply the immutable plan; never execute a drifted companion tree.",
    retryCommand: `tiangong-ai research setup status --workspace ${plan.workspace.path} --json`,
    exitCode: 3,
  });
}

async function runDocumentGranularCompanion(input: {
  root: string;
  plan: ResearchSetupPlan;
  skill: ResearchSetupSkill;
  skillDirectory: string;
  credentialDefinitions: ResearchSetupCredential[];
  credentials: Map<string, string>;
  input: Extract<ResearchSetupCompanionInput, { skillId: "tiangong.document-granular-decompose" }>;
  environment: NodeJS.ProcessEnv;
  runner: SetupCommandRunner;
}) {
  const sourcePath = requireAbsoluteCompanionPath(input.input.inputPath, "--input");
  const destination = requireAbsoluteCompanionPath(input.input.outputPath, "--output");
  if (sourcePath === destination) {
    throw companionPathError(input.root, "Input and output paths must be different.");
  }
  const sourceInfo = await requireRegularCompanionFile(input.root, sourcePath, "input");
  if (sourceInfo.size <= 0) {
    throw companionPathError(input.root, "The input file is empty.");
  }
  await requireNewCompanionDestination(input.root, destination);
  const sourceSha256 = await sha256File(sourcePath);
  const tokenDefinition = input.credentialDefinitions.find(
    (definition) => definition.id === "tiangong.unstructure.auth-token",
  );
  const token = input.credentials.get("tiangong.unstructure.auth-token");
  if (!tokenDefinition || !token) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_MISSING",
      step: "companion-preflight",
      reason: "The selected document adapter has no configured authorization credential.",
      minimumAction:
        "Use research setup credential set with an owner environment variable, then retry.",
      retryCommand: `tiangong-ai research setup credential set --id tiangong.unstructure.auth-token --from-env <OWNER_ENV_NAME> --workspace ${input.root} --json`,
      exitCode: 3,
    });
  }
  const endpoint = input.plan.settings["tiangong.unstructure.base-url"];
  if (!endpoint) {
    throw setupError({
      code: "RESEARCH_SETUP_SETTING_MISSING",
      step: "companion-preflight",
      reason: "The immutable setup plan has no Tiangong Unstructure base URL.",
      minimumAction: "Create a replacement setup plan with the required HTTPS base URL.",
      retryCommand: `tiangong-ai research setup status --workspace ${input.root} --json`,
      exitCode: 3,
    });
  }
  const script = join(input.skillDirectory, "scripts", "mineru_fulltext_extract.py");
  await requireRegularCompanionFile(input.root, script, "adapter script");
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.part`,
  );
  const timeoutSeconds = normalizedCompanionTimeout(input.input.timeoutSeconds, 600, 3_600);
  const childEnvironment = companionEnvironment(input.environment);
  childEnvironment.UNSTRUCTURED_AUTH_TOKEN = token;
  childEnvironment.UNSTRUCTURED_API_BASE_URL = endpoint;
  const provider = input.plan.settings["tiangong.unstructure.provider"];
  const model = input.plan.settings["tiangong.unstructure.model"];
  if (provider) childEnvironment.UNSTRUCTURED_PROVIDER = provider;
  if (model) childEnvironment.UNSTRUCTURED_MODEL = model;
  let destinationLinked = false;
  let committed = false;
  try {
    await runChecked(
      input.runner,
      "python3",
      [script, "--file", sourcePath, "--output", temporary, "--timeout", String(timeoutSeconds)],
      input.root,
      childEnvironment,
      "companion-document-extract",
      (timeoutSeconds + 30) * 1_000,
    );
    if (
      (await sha256File(sourcePath)) !== sourceSha256 ||
      (await fileSize(sourcePath)) !== sourceInfo.size
    ) {
      throw setupError({
        code: "RESEARCH_SETUP_COMPANION_INPUT_CHANGED",
        step: "companion-document-extract",
        reason: "The source document changed while preprocessing was running.",
        minimumAction: "Retry with a stable, immutable input file.",
        retryCommand: `tiangong-ai research setup companion run --help`,
        exitCode: 3,
      });
    }
    const outputInfo = await requireRegularCompanionFile(input.root, temporary, "temporary output");
    if (outputInfo.size <= 0 || outputInfo.size > 128 * 1024 * 1024) {
      throw setupError({
        code: "RESEARCH_SETUP_COMPANION_OUTPUT_INVALID",
        step: "companion-document-extract",
        reason: "The extracted full text is empty or exceeds the 128 MiB adapter limit.",
        minimumAction:
          "Inspect the source and service response, then retry with a bounded document.",
        retryCommand: `tiangong-ai research setup companion run --help`,
        exitCode: 3,
      });
    }
    await requireNewCompanionDestination(input.root, destination);
    await link(temporary, destination).catch((error) => {
      throw setupError({
        code: "RESEARCH_SETUP_COMPANION_COMMIT_FAILED",
        step: "companion-document-commit",
        reason: `The no-overwrite atomic output commit failed (${sanitizeResearchText(
          error instanceof Error ? error.message : String(error),
        )}).`,
        minimumAction:
          "Choose a new explicit output path on the same filesystem and retry; existing files are never replaced.",
        retryCommand: `tiangong-ai research setup companion run --help`,
        exitCode: 3,
      });
    });
    destinationLinked = true;
    await chmod(destination, 0o600).catch(async (error) => {
      await rm(destination, { force: true });
      destinationLinked = false;
      throw error;
    });
    const outputSha256 = await sha256File(destination);
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "research.setup.companion.document.completed",
      "workspace",
      {
        planSha256: input.plan.planSha256,
        skillId: input.skill.id,
        skillTreeSha256: input.skill.expectedTreeSha256,
        sourceRef: setupSource(input.skill.sourceId).immutableRef,
        input: { sha256: sourceSha256, bytes: sourceInfo.size },
        output: { sha256: outputSha256, bytes: outputInfo.size },
      },
    );
    committed = true;
    return {
      schemaVersion: 1 as const,
      kind: "research-setup-companion-result" as const,
      status: "complete" as const,
      workspace: input.root,
      skillId: input.skill.id,
      role: input.skill.role,
      input: { path: sourcePath, sha256: sourceSha256, bytes: sourceInfo.size },
      output: { path: destination, sha256: outputSha256, bytes: outputInfo.size },
      provenance: companionProvenance(input.plan, input.skill),
      next: "Admit the exact output path as a declared research input; preprocessing does not itself admit evidence.",
    };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (destinationLinked && !committed) {
      await rm(destination, { force: true }).catch(() => undefined);
    }
  }
}

async function runAcademicPaperCompanion(input: {
  root: string;
  plan: ResearchSetupPlan;
  skill: ResearchSetupSkill;
  skillDirectory: string;
  credentials: Map<string, string>;
  input: Extract<ResearchSetupCompanionInput, { skillId: "tiangong.academic-paper-download" }>;
  environment: NodeJS.ProcessEnv;
  runner: SetupCommandRunner;
}) {
  const outputDirectory = requireAbsoluteCompanionPath(input.input.outputDirectory, "--out");
  const outputInfo = await lstat(outputDirectory).catch(() => undefined);
  if (!outputInfo?.isDirectory() || outputInfo.isSymbolicLink()) {
    throw companionPathError(
      input.root,
      "--out must be an existing regular non-symlink directory.",
    );
  }
  const doi = input.input.doi?.trim();
  const title = input.input.title?.trim();
  if (Boolean(doi) === Boolean(title)) {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_ARGUMENT_INVALID",
      step: "companion-preflight",
      reason: "Academic paper acquisition requires exactly one of --doi or --title.",
      minimumAction: "Provide one exact paper identifier and retry.",
      retryCommand: `tiangong-ai research setup companion run --help`,
      exitCode: 2,
    });
  }
  if ((input.input.author || input.input.year !== undefined) && !title) {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_ARGUMENT_INVALID",
      step: "companion-preflight",
      reason: "--author and --year may be used only together with --title.",
      minimumAction: "Provide --title, or remove the disambiguation options.",
      retryCommand: `tiangong-ai research setup companion run --help`,
      exitCode: 2,
    });
  }
  if (
    input.input.year !== undefined &&
    (!Number.isInteger(input.input.year) || input.input.year < 1000 || input.input.year > 9999)
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_ARGUMENT_INVALID",
      step: "companion-preflight",
      reason: "--year must be a four-digit integer.",
      minimumAction: "Correct the publication year and retry.",
      retryCommand: `tiangong-ai research setup companion run --help`,
      exitCode: 2,
    });
  }
  const runtimeScript = join(input.skillDirectory, "scripts", "runtime.py");
  await requireRegularCompanionFile(input.root, runtimeScript, "locked runtime script");
  const timeoutSeconds = normalizedCompanionTimeout(input.input.timeoutSeconds, 30, 600);
  const args = [runtimeScript, "fetch"];
  if (doi) args.push(doi);
  else args.push("--title", title!);
  if (input.input.author) args.push("--author", input.input.author);
  if (input.input.year !== undefined) args.push("--year", String(input.input.year));
  args.push("--out", outputDirectory, "--format", "json", "--timeout", String(timeoutSeconds));
  const childEnvironment = companionEnvironment(input.environment);
  const semanticScholarKey = input.credentials.get("semantic-scholar.api-key");
  if (semanticScholarKey) childEnvironment.SEMANTIC_SCHOLAR_API_KEY = semanticScholarKey;
  const unpaywallEmail = input.plan.settings["unpaywall.contact-email"];
  if (unpaywallEmail) childEnvironment.UNPAYWALL_EMAIL = unpaywallEmail;
  const execution = await input.runner({
    command: "python3",
    args,
    cwd: input.root,
    environment: childEnvironment,
    timeoutMs: (timeoutSeconds + 60) * 4 * 1_000,
  });
  const envelope = parseCompanionJson(execution.stdout, input.root, "academic-paper-download");
  if (execution.exitCode !== 0 && envelope.ok === false && isObject(envelope.error)) {
    const runtimeErrorCode = safeAcademicPaperRuntimeErrorCode(envelope.error.code);
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_RUNTIME_INVALID",
      step: "companion-runtime",
      reason: `The academic paper locked runtime failed preflight (${runtimeErrorCode}).`,
      minimumAction:
        "From the verified installed academic-paper-download Skill directory, run `python3 scripts/runtime.py bootstrap --locked --json`, review the result, then rerun setup doctor and the companion command.",
      retryCommand: `tiangong-ai research setup doctor --workspace ${input.root} --json`,
      exitCode: 3,
      diagnostics: { runtimeErrorCode },
    });
  }
  const results =
    isObject(envelope.data) && Array.isArray(envelope.data.results) ? envelope.data.results : [];
  if (results.length !== 1 || !isObject(results[0])) {
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_OUTPUT_INVALID",
      step: "companion-paper-download",
      reason: "The pinned paper adapter did not return exactly one structured result.",
      minimumAction: "Verify the pinned Python dependencies and rerun setup doctor.",
      retryCommand: `tiangong-ai research setup doctor --workspace ${input.root} --json`,
      exitCode: 3,
    });
  }
  const result = results[0];
  if (execution.exitCode !== 0 || result.success !== true) {
    const sourcesTried = Array.isArray(result.sources_tried)
      ? result.sources_tried
          .filter((source): source is string => typeof source === "string")
          .map((source) => sanitizeResearchText(source).slice(0, 100))
      : [];
    const adapterError = sanitizeResearchRecord(isObject(result.error) ? result.error : {});
    if (
      result.success === false &&
      isObject(result.browser_handoff) &&
      result.file === null &&
      result.manifest === null
    ) {
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "research.setup.companion.paper.handoff-required",
        "workspace",
        {
          planSha256: input.plan.planSha256,
          skillId: input.skill.id,
          skillTreeSha256: input.skill.expectedTreeSha256,
          querySha256: sha256Text(doi ?? title!),
          sourcesTried,
          artifactCommitted: false,
        },
      );
      return {
        schemaVersion: 1 as const,
        kind: "research-setup-companion-result" as const,
        status: "browser-handoff-required" as const,
        workspace: input.root,
        skillId: input.skill.id,
        role: input.skill.role,
        artifactCommitted: false,
        sourcesTried,
        error: adapterError,
        provenance: companionProvenance(input.plan, input.skill),
        next: "Automatic legal OA sources were exhausted. Follow the installed academic-paper-download browser-handoff reference explicitly; no browser is launched or selected automatically.",
      };
    }
    const adapterCode =
      typeof adapterError.code === "string"
        ? sanitizeResearchText(adapterError.code).trim().slice(0, 100)
        : "unknown-adapter-error";
    const adapterMessage =
      typeof adapterError.message === "string"
        ? sanitizeResearchText(adapterError.message).trim().slice(0, 500)
        : "";
    throw setupError({
      code: "RESEARCH_SETUP_COMPANION_COMMAND_FAILED",
      step: "companion-paper-download",
      reason: `The pinned paper adapter failed (${adapterCode}; exit status ${execution.exitCode}).`,
      minimumAction:
        adapterMessage ||
        sanitizeResearchText(execution.stderr).trim().slice(0, 500) ||
        "Inspect the structured adapter error and verify its pinned Python dependencies.",
      retryCommand: `tiangong-ai research setup doctor --workspace ${input.root} --json`,
      exitCode: 3,
      diagnostics: {
        adapterError,
        sourcesTried,
        artifactCommitted: false,
      },
    });
  }
  const artifactPath = requireContainedArtifactPath(result.file, outputDirectory, "file");
  const manifestPath = requireContainedArtifactPath(result.manifest, outputDirectory, "manifest");
  const artifactInfo = await requireRegularCompanionFile(input.root, artifactPath, "PDF artifact");
  const manifestInfo = await requireRegularCompanionFile(input.root, manifestPath, "PDF manifest");
  if (artifactInfo.size <= 0 || artifactInfo.size > 100 * 1024 * 1024) {
    throw companionArtifactError(
      input.root,
      "The committed PDF size is outside the adapter limit.",
    );
  }
  const artifactSha256 = await sha256File(artifactPath);
  if (result.sha256 !== artifactSha256 || result.size !== artifactInfo.size) {
    throw companionArtifactError(
      input.root,
      "The result metadata does not bind the committed PDF bytes.",
    );
  }
  const manifest = await readJsonFile<Record<string, unknown>>(manifestPath, "Paper manifest");
  if (
    manifest.schema_version !== "academic-paper-download.artifact.v2" ||
    manifest.file !== artifactPath ||
    manifest.sha256 !== artifactSha256 ||
    manifest.size !== artifactInfo.size
  ) {
    throw companionArtifactError(input.root, "The manifest does not bind the exact committed PDF.");
  }
  await verifyPdfEnvelope(artifactPath, artifactInfo.size, input.root);
  const manifestSha256 = await sha256File(manifestPath);
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "research.setup.companion.paper.completed",
    "workspace",
    {
      planSha256: input.plan.planSha256,
      skillId: input.skill.id,
      skillTreeSha256: input.skill.expectedTreeSha256,
      sourceRef: setupSource(input.skill.sourceId).immutableRef,
      querySha256: sha256Text(doi ?? title!),
      source: typeof manifest.source === "string" ? manifest.source : null,
      artifact: { sha256: artifactSha256, bytes: artifactInfo.size },
      manifest: { sha256: manifestSha256, bytes: manifestInfo.size },
    },
  );
  return {
    schemaVersion: 1 as const,
    kind: "research-setup-companion-result" as const,
    status: "complete" as const,
    workspace: input.root,
    skillId: input.skill.id,
    role: input.skill.role,
    artifact: { path: artifactPath, sha256: artifactSha256, bytes: artifactInfo.size },
    manifest: { path: manifestPath, sha256: manifestSha256, bytes: manifestInfo.size },
    source: typeof manifest.source === "string" ? manifest.source : null,
    provenance: companionProvenance(input.plan, input.skill),
    validation: [
      "pinned-adapter-pypdf",
      "pdf-header",
      "pdf-eof",
      "size",
      "sha256",
      "atomic-artifact-and-manifest",
    ],
    next: "Admit the exact PDF or a derived hash-bound view as a declared research input.",
  };
}

function safeAcademicPaperRuntimeErrorCode(value: unknown): string {
  const allowed = new Set([
    "python_incompatible",
    "lock_missing",
    "lock_invalid",
    "runtime_missing",
    "runtime_invalid",
    "runtime_io_error",
    "dependency_install_failed",
  ]);
  return typeof value === "string" && allowed.has(value) ? value : "runtime_error";
}

function companionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = installerEnvironment(source);
  delete result.CI;
  return result;
}

function normalizedCompanionTimeout(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new CliError(`Companion timeout must be an integer from 1 to ${maximum} seconds.`, {
      code: "RESEARCH_SETUP_COMPANION_ARGUMENT_INVALID",
      exitCode: 2,
    });
  }
  return resolved;
}

function requireAbsoluteCompanionPath(value: string, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    throw new CliError(`${label} must be an absolute canonical path.`, {
      code: "RESEARCH_SETUP_COMPANION_PATH_INVALID",
      exitCode: 2,
    });
  }
  return value;
}

async function requireRegularCompanionFile(root: string, path: string, label: string) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw companionPathError(root, `The ${label} must be a regular non-symlink file.`);
  }
  return info;
}

async function requireNewCompanionDestination(root: string, destination: string): Promise<void> {
  const parentInfo = await lstat(dirname(destination)).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw companionPathError(root, "The output parent must be an existing regular directory.");
  }
  if (await pathExists(destination)) {
    throw companionPathError(
      root,
      "The explicit output path already exists and will not be replaced.",
    );
  }
  const dangling = await lstat(destination).catch(() => undefined);
  if (dangling) {
    throw companionPathError(root, "The explicit output path is occupied, including by a symlink.");
  }
}

function requireContainedArtifactPath(value: unknown, root: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw companionArtifactError(root, `The adapter returned an invalid ${label} path.`);
  }
  const rel = relative(root, value);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw companionArtifactError(root, `The adapter returned a ${label} outside --out.`);
  }
  return value;
}

function parseCompanionJson(stdout: string, root: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (isObject(parsed)) return parsed;
  } catch {
    // Fall through to the structured error below without echoing untrusted output.
  }
  throw setupError({
    code: "RESEARCH_SETUP_COMPANION_OUTPUT_INVALID",
    step: "companion-output",
    reason: `${label} did not emit one valid JSON object.`,
    minimumAction: "Verify the pinned Skill tree and its locked dependencies, then retry.",
    retryCommand: `tiangong-ai research setup doctor --workspace ${root} --json`,
    exitCode: 3,
  });
}

async function verifyPdfEnvelope(path: string, size: number, root: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, 5, 0);
    const tailLength = Math.min(8_192, size);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    if (header.toString("ascii") !== "%PDF-" || !tail.includes(Buffer.from("%%EOF"))) {
      throw companionArtifactError(root, "The committed artifact failed PDF envelope validation.");
    }
  } finally {
    await handle.close();
  }
}

function companionProvenance(plan: ResearchSetupPlan, skill: ResearchSetupSkill) {
  return {
    planSha256: plan.planSha256,
    sourceId: skill.sourceId,
    sourceRef: setupSource(skill.sourceId).immutableRef,
    skillTreeSha256: skill.expectedTreeSha256,
  };
}

function companionPathError(root: string, reason: string): CliError {
  return setupError({
    code: "RESEARCH_SETUP_COMPANION_PATH_INVALID",
    step: "companion-preflight",
    reason,
    minimumAction: "Use explicit regular paths with no symlink at the input, output, or parent.",
    retryCommand: `tiangong-ai research setup companion run --help`,
    exitCode: 2,
  });
}

function companionArtifactError(root: string, reason: string): CliError {
  return setupError({
    code: "RESEARCH_SETUP_COMPANION_ARTIFACT_INVALID",
    step: "companion-paper-verify",
    reason,
    minimumAction:
      "Do not admit the file. Inspect the pinned adapter environment and rerun acquisition to a clean directory.",
    retryCommand: `tiangong-ai research setup doctor --workspace ${root} --json`,
    exitCode: 3,
  });
}

async function loadAdapterCredentials(
  root: string,
  definitions: ResearchSetupCredential[],
  options: { ignoreUndeclared?: boolean } = {},
): Promise<Map<string, string>> {
  const path = workspacePaths(root).setupAdapterEnv;
  if (!(await pathExists(path))) return new Map();
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
      step: "credentials",
      reason: "Adapter credential store must be a regular non-symlink file.",
      minimumAction:
        "Repair the owner-only adapter credential store; do not follow or replace a symlink.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
      step: "credentials",
      reason: "Adapter credential store must have owner-only permissions.",
      minimumAction: `Run chmod 600 on ${path}, then retry doctor.`,
      retryCommand: `tiangong-ai research setup doctor --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  if (info.size > 64 * 1024) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
      step: "credentials",
      reason: "Adapter credential store exceeds the supported size.",
      minimumAction: "Remove unrelated material from the credential store.",
      retryCommand: `tiangong-ai research setup doctor --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  const content = await readFile(path, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1 || !lines[0]!.startsWith(`${ADAPTER_ENV_KEY}=`)) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
      step: "credentials",
      reason: "Adapter credential store has unsupported keys or duplicate configuration.",
      minimumAction: "Use research setup credential set to create the supported owner-only format.",
      retryCommand: `tiangong-ai research setup credential set --help`,
      exitCode: 3,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!.slice(ADAPTER_ENV_KEY.length + 1)) as unknown;
  } catch {
    value = null;
  }
  if (!isObject(value)) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
      step: "credentials",
      reason: "Adapter credential JSON is invalid.",
      minimumAction: "Use research setup credential set to rewrite the owner-only store.",
      retryCommand: `tiangong-ai research setup credential set --help`,
      exitCode: 3,
    });
  }
  const allowed = new Map(definitions.map((definition) => [definition.id, definition]));
  const result = new Map<string, string>();
  for (const [id, credentialValue] of Object.entries(value)) {
    const definition = allowed.get(id);
    if (!definition && options.ignoreUndeclared) continue;
    if (
      !definition ||
      typeof credentialValue !== "string" ||
      Buffer.byteLength(credentialValue, "utf8") < definition.minimumUtf8Bytes
    ) {
      throw setupError({
        code: "RESEARCH_SETUP_CREDENTIAL_STORE_INVALID",
        step: "credentials",
        reason: `Adapter credential entry is undeclared or invalid: ${id}.`,
        minimumAction:
          "Create a new setup plan or repair credentials through the supported command.",
        retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
        exitCode: 3,
      });
    }
    result.set(id, credentialValue);
  }
  return result;
}

async function setAdapterCredential(
  root: string,
  definitions: ResearchSetupCredential[],
  credentialId: string,
  value: string,
): Promise<void> {
  const configured = await loadAdapterCredentials(root, definitions, { ignoreUndeclared: true });
  configured.set(credentialId, value);
  const serialized = Object.fromEntries(
    [...configured.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeTextAtomic(
    workspacePaths(root).setupAdapterEnv,
    `${ADAPTER_ENV_KEY}=${JSON.stringify(serialized)}\n`,
    0o600,
  );
}

function initialSetupState(planSha256: string): ResearchSetupState {
  return {
    schemaVersion: 1,
    planSha256,
    status: "pending",
    currentStep: null,
    completedSteps: [],
    attempts: 0,
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
}

async function loadSetupState(root: string, planSha256: string): Promise<ResearchSetupState> {
  const path = workspacePaths(root).setupState;
  if (!(await pathExists(path))) return initialSetupState(planSha256);
  const value = await readJsonFile<unknown>(path, "Research setup state");
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.planSha256 !== planSha256 ||
    !["pending", "applying", "partially-ready", "ready", "blocked"].includes(
      String(value.status),
    ) ||
    !(value.currentStep === null || typeof value.currentStep === "string") ||
    !Array.isArray(value.completedSteps) ||
    value.completedSteps.some((step) => typeof step !== "string") ||
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    typeof value.updatedAt !== "string" ||
    !(
      value.lastError === null ||
      (isObject(value.lastError) &&
        typeof value.lastError.code === "string" &&
        typeof value.lastError.step === "string" &&
        typeof value.lastError.reason === "string" &&
        typeof value.lastError.minimumAction === "string" &&
        typeof value.lastError.retryCommand === "string" &&
        (value.lastError.diagnostics === undefined || isObject(value.lastError.diagnostics)))
    )
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_STATE_INVALID",
      step: "state",
      reason: "Setup state is malformed or belongs to a different plan.",
      minimumAction: "Inspect the immutable plan and state; do not continue from unbound state.",
      retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
      exitCode: 3,
    });
  }
  return value as unknown as ResearchSetupState;
}

async function updateSetupState(
  root: string,
  state: ResearchSetupState,
): Promise<ResearchSetupState> {
  const next = sanitizeResearchRecord({
    ...state,
    updatedAt: new Date().toISOString(),
  }) as unknown as ResearchSetupState;
  await writeJsonAtomic(workspacePaths(root).setupState, next);
  return next;
}

async function startSetupStep(
  root: string,
  state: ResearchSetupState,
  step: string,
): Promise<ResearchSetupState> {
  return updateSetupState(root, { ...state, status: "applying", currentStep: step });
}

async function completeSetupStep(
  root: string,
  state: ResearchSetupState,
  step: string,
): Promise<ResearchSetupState> {
  return updateSetupState(root, {
    ...state,
    status: "applying",
    currentStep: null,
    completedSteps: [...new Set([...state.completedSteps, step])],
  });
}

async function archiveSetupGeneration(root: string): Promise<string> {
  const paths = workspacePaths(root);
  const prior = await loadHashVerifiedResearchSetupPlan(paths.setupPlan);
  const archiveRoot = join(paths.control, "setup-history", prior.planSha256);
  await assertNoSymlinkedExistingPath(dirname(archiveRoot), root);
  await ensureDirectory(archiveRoot);
  const files = [
    [paths.setupPlan, "setup-plan.json"],
    [paths.setupState, "setup-state.json"],
    [paths.setupReport, "setup-report.json"],
    [paths.setupDeclarationBinding, "setup-declaration.json"],
  ] as const;
  for (const [source, name] of files) {
    if (!(await pathExists(source))) continue;
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw setupError({
        code: "RESEARCH_SETUP_ARCHIVE_INVALID",
        step: "upgrade-plan",
        reason: `Setup generation file is not a regular non-symlink file: ${name}.`,
        minimumAction: "Inspect the current generation before creating an upgrade plan.",
        retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
        exitCode: 3,
      });
    }
    const destination = join(archiveRoot, name);
    const content = await readFile(source, "utf8");
    if (await pathExists(destination)) {
      const destinationInfo = await lstat(destination);
      if (
        !destinationInfo.isFile() ||
        destinationInfo.isSymbolicLink() ||
        (await readFile(destination, "utf8")) !== content
      ) {
        throw setupError({
          code: "RESEARCH_SETUP_ARCHIVE_INVALID",
          step: "upgrade-plan",
          reason: `Existing setup history does not match the generation being archived: ${name}.`,
          minimumAction: "Stop and audit setup-history; the CLI will not overwrite it.",
          retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
          exitCode: 3,
        });
      }
      continue;
    }
    await writeTextAtomic(destination, content, 0o444);
  }
  return prior.planSha256;
}

type SetupDoctorCheck = {
  id: string;
  category: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  minimumAction: string | null;
  scope?: SetupDoctorScope;
  componentIds?: string[];
  requiredFor?: string[];
  blocking?: boolean;
  componentGate?: boolean;
  skippedBecause?: string;
  diagnostics?: {
    code: string;
    executionMode: "setup-doctor" | "broker" | "standalone";
    credentialScope: "adapter" | "broker" | "ambient-or-explicit-owner-env";
    networkAttempted: boolean;
    httpStatus?: number;
    retryAfterSeconds?: number | null;
  };
};

export type SetupDoctorScope =
  | "research-core"
  | "evidence"
  | "preprocessing"
  | "acquisition"
  | "authoring"
  | "review";

export type SetupDomainReadiness = "READY" | "DEGRADED" | "BLOCKED" | "NOT_REQUIRED";

function normalizeSetupDoctorCheck(
  check: SetupDoctorCheck,
  selected: ResearchSetupSkill[],
): Required<Pick<SetupDoctorCheck, "id" | "category" | "status" | "detail" | "minimumAction">> &
  Omit<
    SetupDoctorCheck,
    "scope" | "componentIds" | "requiredFor" | "blocking" | "componentGate"
  > & {
    scope: SetupDoctorScope;
    componentIds: string[];
    requiredFor: string[];
    blocking: boolean;
    componentGate: boolean;
  } {
  const componentIds = check.componentIds ?? setupCheckComponentIds(check, selected);
  const scope = check.scope ?? setupCheckScope(check, selected, componentIds);
  const blocking = check.blocking ?? ["research-core", "evidence", "review"].includes(scope);
  return {
    ...check,
    scope,
    componentIds,
    requiredFor:
      check.requiredFor ??
      (blocking
        ? ["setup", "research-core"]
        : componentIds.map((componentId) => `component:${componentId}`)),
    blocking,
    componentGate: check.componentGate ?? check.id !== "live.semantic-scholar",
  };
}

function setupCheckComponentIds(check: SetupDoctorCheck, selected: ResearchSetupSkill[]): string[] {
  if (check.id === "live.semantic-scholar") return ["tiangong.academic-paper-download"];
  if (check.id.startsWith("top-journal-policy-pack.")) return ["tiangong.auto-research"];
  if (check.id === "live.tiangong-unstructure") {
    return ["tiangong.document-granular-decompose"];
  }
  if (check.id.startsWith("skill.")) {
    return selected.filter((skill) => check.id.endsWith(`.${skill.id}`)).map((skill) => skill.id);
  }
  if (check.id.startsWith("setting.")) {
    const id = check.id.slice("setting.".length);
    const setting = RESEARCH_SETUP_SETTINGS.find((candidate) => candidate.id === id);
    return selected
      .filter((skill) => setting?.requiredBy.includes(skill.id))
      .map((skill) => skill.id);
  }
  if (check.id.startsWith("credential.")) {
    const id = check.id.slice("credential.".length);
    const credential = RESEARCH_SETUP_CREDENTIALS.find((candidate) => candidate.id === id);
    return selected
      .filter((skill) => credential?.requiredBy.includes(skill.id))
      .map((skill) => skill.id);
  }
  if (check.id.startsWith("dependency.")) {
    const id = check.id.slice("dependency.".length);
    return selected
      .filter((skill) => skill.dependencies.some((item) => item.id === id))
      .map((skill) => skill.id);
  }
  return [];
}

function setupCheckScope(
  check: SetupDoctorCheck,
  selected: ResearchSetupSkill[],
  componentIds: string[],
): SetupDoctorScope {
  if (check.id === "live.semantic-scholar") return "acquisition";
  if (check.id === "live.tiangong-unstructure") return "preprocessing";
  if (check.category === "evidence-capability" || check.id.includes("capability")) {
    return "evidence";
  }
  if (check.category === "agent" || check.id.includes("attestation")) return "review";
  const roles = componentIds
    .map((id) => selected.find((skill) => skill.id === id)?.role)
    .filter((role): role is ResearchSetupSkill["role"] => Boolean(role));
  if (roles.includes("evidence-capability")) return "evidence";
  if (roles.includes("input-preprocessor")) return "preprocessing";
  if (roles.includes("acquisition-adapter")) return "acquisition";
  if (roles.includes("post-closure-authoring")) return "authoring";
  return "research-core";
}

function setupDomainReadiness(
  checks: Array<ReturnType<typeof normalizeSetupDoctorCheck>>,
  scope: Extract<SetupDoctorScope, "preprocessing" | "acquisition" | "authoring">,
): SetupDomainReadiness {
  const matching = checks.filter((check) => check.scope === scope);
  if (matching.length === 0) return "NOT_REQUIRED";
  if (matching.some((check) => check.blocking && check.status === "fail")) return "BLOCKED";
  if (
    scope === "authoring" &&
    matching.some((check) => check.componentGate && check.status === "fail")
  ) {
    return "BLOCKED";
  }
  return matching.some((check) => check.status !== "pass") ? "DEGRADED" : "READY";
}

function requireAbsoluteWorkspace(value: string): string {
  if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_INVALID",
      step: "workspace",
      reason: "Setup workspace must be an explicit absolute path.",
      minimumAction: "Choose or create an absolute workspace directory, then retry.",
      retryCommand: "tiangong-ai research setup --help",
      exitCode: 2,
    });
  }
  return resolve(value);
}

export async function resolveResearchSetupWorkspacePath(
  value: string,
  options: { allowMissingLeaf?: boolean } = {},
): Promise<string> {
  const root = requireAbsoluteWorkspace(value);
  const info = await lstat(root).catch(() => undefined);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw setupError({
        code: "RESEARCH_SETUP_WORKSPACE_INVALID",
        step: "workspace",
        reason: "Setup workspace must exist as a regular non-symlink directory.",
        minimumAction: `Create the directory explicitly, then retry with --workspace ${root}.`,
        retryCommand: "tiangong-ai research setup --help",
        exitCode: 2,
      });
    }
    const canonicalRoot = await realpath(root);
    await assertNoSymlinkedExistingPath(canonicalRoot);
    return canonicalRoot;
  }
  if (!options.allowMissingLeaf) {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_INVALID",
      step: "workspace",
      reason: "Setup workspace must exist as a regular non-symlink directory.",
      minimumAction: `Create the directory explicitly, then retry with --workspace ${root}.`,
      retryCommand: "tiangong-ai research setup --help",
      exitCode: 2,
    });
  }

  const requestedParent = dirname(root);
  const canonicalParent = await realpath(requestedParent).catch(() => undefined);
  const parentInfo = canonicalParent
    ? await lstat(canonicalParent).catch(() => undefined)
    : undefined;
  if (!canonicalParent || !parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_INVALID",
      step: "workspace",
      reason: "The parent of a new setup workspace must exist as a regular directory.",
      minimumAction: `Create the parent directory explicitly, then retry with --workspace ${root}.`,
      retryCommand: "tiangong-ai research setup --help",
      exitCode: 2,
    });
  }
  const canonicalRoot = join(canonicalParent, basename(root));
  await assertNoSymlinkedExistingPath(canonicalRoot);
  return canonicalRoot;
}

function normalizedWorkspaceName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f]/.test(normalized)) {
    throw setupError({
      code: "RESEARCH_SETUP_WORKSPACE_NAME_INVALID",
      step: "workspace",
      reason: "Workspace name must contain 1-100 printable characters.",
      minimumAction: "Choose a short printable workspace name.",
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
  return normalized;
}

function assertEnvironmentName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw setupError({
      code: "RESEARCH_SETUP_CREDENTIAL_INVALID",
      step: "credentials",
      reason: "Credential source must be the name of one environment variable.",
      minimumAction:
        "Use a variable name such as BRAVE_API_KEY; never put the credential value in CLI arguments.",
      retryCommand: "tiangong-ai research setup credential set --help",
      exitCode: 2,
    });
  }
}

function validateSetupSetting(
  id: string,
  validation: "https-url" | "email" | "identifier",
  value: string,
): void {
  let valid = false;
  if (validation === "https-url") {
    try {
      const url = new URL(value);
      valid =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.search &&
        url.hostname.length > 0;
    } catch {
      valid = false;
    }
  } else if (validation === "email") {
    valid =
      value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/[\r\n\0]/.test(value);
  } else {
    valid =
      value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) && !value.includes("..");
  }
  if (!valid) {
    throw setupError({
      code: "RESEARCH_SETUP_SETTING_INVALID",
      step: "configuration",
      reason: `Setup setting failed ${validation} validation: ${id}.`,
      minimumAction: `Provide a non-secret ${validation} value for ${id}; URLs may not contain credentials, queries, or fragments.`,
      retryCommand: "tiangong-ai research setup plan --help",
      exitCode: 2,
    });
  }
}

function setupMutations(
  root: string,
  targets: ResearchSetupPlan["install"]["targets"],
  selected: ResearchSetupSkill[],
  instructionRouting: ResearchSetupInstructionRoutingPlan,
): ResearchSetupPlan["mutations"] {
  const mutations: ResearchSetupPlan["mutations"] = [
    {
      step: "workspace",
      target: workspacePaths(root).control,
      reason: "Initialize or verify the auditable research workspace control plane.",
    },
  ];
  if (selected.some((skill) => skill.id === "tiangong.auto-research")) {
    for (const target of targets) {
      mutations.push({
        step: "recovery-shim",
        target: join(
          setupTargetRoot({ workspace: root, scope: "project", agent: target.agent }),
          RECOVERY_SKILL_NAME,
        ),
        reason:
          "Create a plan-bound recovery-only routing Skill until the full external orchestrator is verified.",
      });
    }
  }
  for (const target of targets) {
    for (const skill of selected) {
      mutations.push({
        step: "skill-install",
        target: join(target.root, skill.skillName),
        reason: `Copy pinned ${skill.id} bytes for ${target.agent}.`,
      });
    }
  }
  for (const target of instructionRouting.targets) {
    mutations.push({
      step: "project-instruction-routing",
      target: target.path,
      reason:
        target.strategy === "managed-block"
          ? "Install or verify the bounded Auto Research routing block without replacing owner AGENTS.md content."
          : "Install or verify the dedicated Auto Research Claude project rule without replacing owner CLAUDE.md content.",
    });
  }
  mutations.push({
    step: "capability-configuration",
    target: workspacePaths(root).capabilityDeclarations,
    reason:
      "Reconcile and lock the explicitly selected setup-managed evidence capabilities while preserving custom declarations.",
  });
  mutations.push({
    step: "credentials",
    target: workspacePaths(root).env,
    reason: "Reconcile selected broker credentials in the owner-only workspace environment file.",
  });
  mutations.push({
    step: "credentials",
    target: workspacePaths(root).setupAdapterEnv,
    reason: "Reconcile selected companion-adapter credentials in an owner-only file.",
  });
  return mutations.sort((left, right) =>
    `${left.step}\0${left.target}`.localeCompare(`${right.step}\0${right.target}`),
  );
}

function setupLockPayload(planSha256: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: "research.setup",
    planSha256,
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };
}

async function assertNoSymlinkedExistingPath(path: string, boundary?: string): Promise<void> {
  const target = resolve(path);
  const policyRoot = boundary === undefined ? dirname(target) : resolve(boundary);
  if (
    boundary !== undefined &&
    target !== policyRoot &&
    !target.startsWith(`${policyRoot}${sep}`)
  ) {
    throw setupError({
      code: "RESEARCH_SETUP_PATH_INVALID",
      step: "path-validation",
      reason: "Setup target escapes its reviewed workspace boundary.",
      minimumAction: "Use a target contained by the selected workspace.",
      retryCommand: "tiangong-ai research setup status --json",
      exitCode: 3,
    });
  }

  const relativeParts = target.slice(policyRoot.length).split(sep).filter(Boolean);
  let current = policyRoot;
  for (const part of ["", ...relativeParts]) {
    if (part) current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw setupError({
        code: "RESEARCH_SETUP_SYMLINK_BLOCKED",
        step: "path-validation",
        reason: `Setup will not follow a symbolic link in a mutation path: ${current}.`,
        minimumAction:
          "Choose a regular directory path or inspect and remove the indirection manually.",
        retryCommand: "tiangong-ai research setup status --json",
        exitCode: 3,
      });
    }
    if (current !== target && !info.isDirectory()) {
      throw setupError({
        code: "RESEARCH_SETUP_PATH_INVALID",
        step: "path-validation",
        reason: `A setup mutation path has a non-directory parent: ${current}.`,
        minimumAction: "Choose a regular directory path and retry.",
        retryCommand: "tiangong-ai research setup status --json",
        exitCode: 3,
      });
    }
  }
}

function installerEnvironment(
  source: NodeJS.ProcessEnv,
  npmCacheDirectory?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const exact = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SHELL",
    "USER",
    "LOGNAME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NODE_PATH",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "VIRTUAL_ENV",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if ((exact.has(key) || key.startsWith("LC_")) && !isSensitiveEnvironmentName(key)) {
      result[key] = value;
    }
  }
  result.PATH ??= process.env.PATH ?? "/usr/bin:/bin";
  result.HOME ??= homedir();
  result.DO_NOT_TRACK = "1";
  result.CI = "1";
  result.npm_config_yes = "true";
  result.npm_config_update_notifier = "false";
  result.npm_config_fund = "false";
  result.npm_config_audit = "false";
  if (npmCacheDirectory) result.npm_config_cache = npmCacheDirectory;
  return result;
}

function installerEnvironmentForTarget(
  plan: ResearchSetupPlan,
  agent: ResearchSetupAgent,
  source: NodeJS.ProcessEnv,
  npmCacheDirectory?: string,
): NodeJS.ProcessEnv {
  const result = installerEnvironment(source, npmCacheDirectory);
  if (plan.install.scope !== "global") return result;
  const target = plannedTargetRoot(plan, agent);
  if (agent === "codex") {
    // skills@1.5.22 treats Codex as a universal agent and installs globally to
    // $HOME/.agents/skills, independently of CODEX_HOME.
    result.HOME = dirname(dirname(target));
    delete result.CODEX_HOME;
  } else {
    // The upstream installer resolves Claude Code's global target from
    // CLAUDE_CONFIG_DIR/skills when that variable is present.
    result.CLAUDE_CONFIG_DIR = dirname(target);
  }
  return result;
}

function agentDoctorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = installerEnvironment(source);
  delete result.CI;
  return result;
}

function setupSecretValues(plan: ResearchSetupPlan, environment: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([
      ...configuredResearchSecrets(environment),
      ...plan.credentialSources
        .map((credential) => environment[credential.fromEnvironment])
        .filter((value): value is string => typeof value === "string" && value.length >= 8),
    ]),
  ];
}

function sanitizingSetupRunner(
  runner: SetupCommandRunner,
  secrets: readonly string[],
): SetupCommandRunner {
  return async (input) => {
    const result = await runner(input);
    return {
      exitCode: result.exitCode,
      stdout: sanitizeResearchText(result.stdout, secrets),
      stderr: sanitizeResearchText(result.stderr, secrets),
    };
  };
}

async function runSetupCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SetupCommandResult> {
  return new Promise((resolvePromise) => {
    const secrets = configuredResearchSecrets(input.environment);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (
      existing: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike> | string,
    ): Buffer<ArrayBufferLike> => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_COMMAND_OUTPUT_BYTES - existing.length;
      if (remaining <= 0) {
        truncated = true;
        return existing;
      }
      if (bytes.length > remaining) truncated = true;
      return Buffer.concat([existing, bytes.subarray(0, remaining)]);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
      if (truncated) child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
      if (truncated) child.kill("SIGTERM");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    timer.unref();
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const suffix = timedOut
        ? "\n[command timed out]"
        : truncated
          ? "\n[command output limit exceeded]"
          : "";
      resolvePromise({
        exitCode: timedOut || truncated ? 124 : exitCode,
        stdout: sanitizeResearchText(stdout.toString("utf8"), secrets),
        stderr: sanitizeResearchText(`${stderr.toString("utf8")}${suffix}`, secrets),
      });
    };
    child.on("error", (error) => {
      stderr = capture(stderr, error.message);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

async function runChecked(
  runner: SetupCommandRunner,
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  step: string,
  timeoutMs = 60_000,
): Promise<SetupCommandResult> {
  const result = await runner({ command, args, cwd, environment, timeoutMs });
  if (result.exitCode !== 0) throw commandFailure(step, command, result, cwd, environment);
  return result;
}

function commandFailure(
  step: string,
  command: string,
  result: SetupCommandResult,
  root: string,
  environment: NodeJS.ProcessEnv,
): CliError {
  const diagnostic = sanitizeResearchText(
    result.stderr || result.stdout,
    configuredResearchSecrets(environment),
  )
    .trim()
    .slice(0, 1_000);
  return setupError({
    code: "RESEARCH_SETUP_COMMAND_FAILED",
    step,
    reason: `${command} exited with status ${result.exitCode}.`,
    minimumAction: diagnostic
      ? `Resolve the reported command failure (${diagnostic}), then retry the recorded step.`
      : "Resolve the command availability or network failure, then retry the recorded step.",
    retryCommand: `tiangong-ai research setup status --workspace ${root} --json`,
    exitCode: 3,
  });
}

async function setupDoctorCheck(
  checks: SetupDoctorCheck[],
  id: string,
  category: string,
  callback: () => Promise<string>,
  failureMinimumAction = `Resolve ${id}, then rerun research setup doctor.`,
): Promise<void> {
  try {
    checks.push({
      id,
      category,
      status: "pass",
      detail: sanitizeResearchText(await callback()),
      minimumAction: null,
    });
  } catch (error) {
    checks.push({
      id,
      category,
      status: "fail",
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
      minimumAction: failureMinimumAction,
    });
  }
}

type AuthoringRuntimeBinding = {
  python: string | null;
  node: string | null;
  pandoc: string | null;
  soffice: string | null;
  pdftoppm: string | null;
  zip: string | null;
  unzip: string | null;
};

const AUTHORING_PYTHON_PROBES: Record<
  string,
  { distribution: string; module: string; exactVersion: string | null }
> = {
  "authoring:defusedxml": {
    distribution: "defusedxml",
    module: "defusedxml",
    exactVersion: "0.7.1",
  },
  "authoring:lxml": { distribution: "lxml", module: "lxml.etree", exactVersion: null },
  "authoring:pillow": { distribution: "Pillow", module: "PIL", exactVersion: null },
  "authoring:python-pptx": {
    distribution: "python-pptx",
    module: "pptx",
    exactVersion: null,
  },
  "authoring:markitdown": {
    distribution: "markitdown",
    module: "markitdown",
    exactVersion: "0.1.7",
  },
  "authoring:pypdf": { distribution: "pypdf", module: "pypdf", exactVersion: null },
  "authoring:pdfplumber": {
    distribution: "pdfplumber",
    module: "pdfplumber",
    exactVersion: null,
  },
  "authoring:reportlab": {
    distribution: "reportlab",
    module: "reportlab",
    exactVersion: null,
  },
  "authoring:pdf2image": {
    distribution: "pdf2image",
    module: "pdf2image",
    exactVersion: null,
  },
  "authoring:openpyxl": {
    distribution: "openpyxl",
    module: "openpyxl",
    exactVersion: null,
  },
  "authoring:pandas": { distribution: "pandas", module: "pandas", exactVersion: null },
};

const AUTHORING_NODE_PROBES: Record<string, string> = {
  "authoring:node-docx": "docx",
  "authoring:node-pptxgenjs": "pptxgenjs",
};

const AUTHORING_COMMAND_PROBES: Record<
  string,
  Extract<keyof AuthoringRuntimeBinding, "pandoc" | "soffice" | "pdftoppm" | "zip" | "unzip">
> = {
  "authoring:pandoc": "pandoc",
  "authoring:libreoffice": "soffice",
  "authoring:poppler": "pdftoppm",
  "authoring:zip": "zip",
  "authoring:unzip": "unzip",
};

async function resolveAuthoringRuntime(
  selected: ResearchSetupSkill[],
  environment: NodeJS.ProcessEnv,
): Promise<AuthoringRuntimeBinding | null> {
  if (!selected.some((skill) => skill.role === "post-closure-authoring")) return null;
  const resolveCommand = async (name: string): Promise<string | null> =>
    (
      await findAmbientExecutable(environment, name, {
        preserveLeafSymlink: name === "python3",
      })
    )?.path ?? null;
  const [python, node, pandoc, soffice, pdftoppm, zip, unzip] = await Promise.all([
    resolveCommand("python3"),
    resolveCommand("node"),
    resolveCommand("pandoc"),
    resolveCommand("soffice"),
    resolveCommand("pdftoppm"),
    resolveCommand("zip"),
    resolveCommand("unzip"),
  ]);
  return { python, node, pandoc, soffice, pdftoppm, zip, unzip };
}

function requireAuthoringRuntimeExecutable(value: string | null, minimumAction: string): string {
  if (!value) throw new Error(minimumAction);
  return value;
}

function authoringEnvironment(
  source: NodeJS.ProcessEnv,
  runtime: AuthoringRuntimeBinding | null,
): NodeJS.ProcessEnv {
  const result = installerEnvironment(source);
  const commandDirectories = [
    runtime?.soffice,
    runtime?.pdftoppm,
    runtime?.pandoc,
    runtime?.zip,
    runtime?.unzip,
  ]
    .filter((value): value is string => Boolean(value))
    .map(dirname);
  if (commandDirectories.length) {
    result.PATH = [...new Set(commandDirectories), result.PATH ?? ""]
      .filter(Boolean)
      .join(delimiter);
  }
  return result;
}

async function appendDependencyChecks(
  checks: SetupDoctorCheck[],
  plan: ResearchSetupPlan,
  selected: ResearchSetupSkill[],
  runner: SetupCommandRunner,
  root: string,
  environment: NodeJS.ProcessEnv,
  authoringRuntime: AuthoringRuntimeBinding | null,
): Promise<void> {
  const dependencies = [
    ...new Map(
      selected
        .flatMap((skill) => skill.dependencies)
        .map((dependency) => [dependency.id, dependency]),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  for (const dependency of dependencies) {
    if (dependency.kind === "manual") {
      checks.push({
        id: `dependency.${dependency.id}`,
        category: "dependency",
        status: "warn",
        detail: `${dependency.requirement}; setup intentionally does not install or resolve it.`,
        minimumAction: dependency.minimumAction,
      });
      continue;
    }
    await setupDoctorCheck(
      checks,
      `dependency.${dependency.id}`,
      "dependency",
      async () => {
        if (dependency.id === "python-3.10") {
          const result = await runner({
            command: authoringRuntime?.python ?? "python3",
            args: ["--version"],
            cwd: root,
            environment: installerEnvironment(environment),
            timeoutMs: 15_000,
          });
          if (result.exitCode !== 0) throw new Error(dependency.minimumAction);
          const versionText = `${result.stdout} ${result.stderr}`;
          const match = versionText.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
          if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
            throw new Error(
              `Detected ${versionText.trim() || "unknown Python version"}; ${dependency.requirement} is required.`,
            );
          }
          return `${versionText.trim()} satisfies ${dependency.requirement}.`;
        }
        if (dependency.id === "academic-paper-download:pypdf") {
          const skill = setupSkill("tiangong.academic-paper-download");
          const skillDirectory = await verifiedCompanionSkillDirectory(plan, skill);
          const runtimeScript = join(skillDirectory, "scripts", "runtime.py");
          await requireRegularCompanionFile(root, runtimeScript, "locked runtime script");
          const result = await runner({
            command: "python3",
            args: [runtimeScript, "doctor", "--json"],
            cwd: root,
            environment: installerEnvironment(environment),
            timeoutMs: 15_000,
          });
          const envelope = parseCompanionJson(
            result.stdout,
            root,
            "academic-paper-download locked runtime doctor",
          );
          const data = isObject(envelope.data) ? envelope.data : {};
          if (result.exitCode !== 0 || envelope.ok !== true || data.pypdf !== "6.14.2") {
            throw new Error("The verified academic paper locked runtime is not ready.");
          }
          return `${dependency.requirement} is ready.`;
        }
        const pythonProbe = AUTHORING_PYTHON_PROBES[dependency.id];
        if (pythonProbe) {
          const python = requireAuthoringRuntimeExecutable(
            authoringRuntime?.python ?? null,
            dependency.minimumAction,
          );
          const result = await runner({
            command: python,
            args: [
              "-c",
              `import importlib.metadata as m; import ${pythonProbe.module}; print(m.version(${JSON.stringify(pythonProbe.distribution)}))`,
            ],
            cwd: root,
            environment: installerEnvironment(environment),
            timeoutMs: 15_000,
          });
          const observed = result.stdout.trim();
          if (
            result.exitCode !== 0 ||
            !observed ||
            (pythonProbe.exactVersion !== null && observed !== pythonProbe.exactVersion)
          ) {
            throw new Error(
              `${dependency.requirement} is not active in the bound authoring Python.`,
            );
          }
          return `${dependency.requirement} is active (version ${observed}).`;
        }
        const nodeProbe = AUTHORING_NODE_PROBES[dependency.id];
        if (nodeProbe) {
          const node = requireAuthoringRuntimeExecutable(
            authoringRuntime?.node ?? null,
            dependency.minimumAction,
          );
          const result = await runner({
            command: node,
            args: [
              "-e",
              `const resolved=require.resolve(${JSON.stringify(nodeProbe)}); process.stdout.write(resolved);`,
            ],
            cwd: root,
            environment: authoringEnvironment(environment, authoringRuntime),
            timeoutMs: 15_000,
          });
          if (result.exitCode !== 0 || !result.stdout.trim()) {
            throw new Error(
              `${dependency.requirement} is not resolvable by the bound authoring Node.`,
            );
          }
          return `${dependency.requirement} is resolvable.`;
        }
        const commandKey = AUTHORING_COMMAND_PROBES[dependency.id];
        if (commandKey) {
          const command = requireAuthoringRuntimeExecutable(
            authoringRuntime?.[commandKey] ?? null,
            dependency.minimumAction,
          );
          const result = await runner({
            command,
            args: ["pdftoppm", "zip", "unzip"].includes(commandKey) ? ["-v"] : ["--version"],
            cwd: root,
            environment: authoringEnvironment(environment, authoringRuntime),
            timeoutMs: 15_000,
          });
          if (result.exitCode !== 0) throw new Error(`${dependency.requirement} is unavailable.`);
          return `${dependency.requirement} is executable.`;
        }
        throw new Error(
          `No automatic dependency check is declared for ${dependency.id}. ${dependency.minimumAction}`,
        );
      },
      dependency.minimumAction,
    );
  }
}

async function appendAuthoringCanaryChecks(
  checks: SetupDoctorCheck[],
  input: {
    plan: ResearchSetupPlan;
    selected: ResearchSetupSkill[];
    runner: SetupCommandRunner;
    root: string;
    environment: NodeJS.ProcessEnv;
    runtime: AuthoringRuntimeBinding | null;
  },
): Promise<void> {
  for (const skill of input.selected.filter(
    (candidate) =>
      candidate.role === "post-closure-authoring" &&
      ["anthropic.docx", "anthropic.pdf", "anthropic.pptx", "anthropic.xlsx"].includes(
        candidate.id,
      ),
  )) {
    const failedPrerequisites = checks.filter(
      (check) =>
        check.id.startsWith("dependency.") &&
        check.status === "fail" &&
        setupCheckComponentIds(check, input.selected).includes(skill.id),
    );
    if (failedPrerequisites.length) {
      checks.push({
        id: `authoring-canary.${skill.id}`,
        category: "authoring-canary",
        scope: "authoring",
        componentIds: [skill.id],
        status: "fail",
        detail: `Functional canary was not started because prerequisite checks failed: ${failedPrerequisites.map((check) => check.id).join(", ")}.`,
        minimumAction:
          "Resolve every declared runtime and dependency prerequisite, then rerun setup doctor; setup never installs them.",
        blocking: false,
        componentGate: true,
        requiredFor: [`component:${skill.id}`],
        skippedBecause: failedPrerequisites.map((check) => check.id).join(", "),
      });
      continue;
    }
    await setupDoctorCheck(
      checks,
      `authoring-canary.${skill.id}`,
      "authoring-canary",
      async () => {
        const temporary = await mkdtemp(join(tmpdir(), `tiangong-authoring-${skill.skillName}-`));
        try {
          await runAuthoringCanary({ ...input, skill, temporary });
          return `${skill.id} completed its exact-file synthetic functional canary.`;
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
      "Inspect the failed pinned helper/package/command step, repair the explicit authoring runtime outside this CLI, and rerun setup doctor.",
    );
    Object.assign(checks.at(-1)!, {
      scope: "authoring" as const,
      componentIds: [skill.id],
      blocking: false,
      componentGate: true,
      requiredFor: [`component:${skill.id}`],
    });
  }
}

async function runAuthoringCanary(input: {
  plan: ResearchSetupPlan;
  skill: ResearchSetupSkill;
  runner: SetupCommandRunner;
  root: string;
  environment: NodeJS.ProcessEnv;
  runtime: AuthoringRuntimeBinding | null;
  temporary: string;
}): Promise<void> {
  const environment = authoringEnvironment(input.environment, input.runtime);
  environment.PYTHONDONTWRITEBYTECODE = "1";
  if (input.skill.id === "anthropic.docx") return runDocxAuthoringCanary(input, environment);
  if (input.skill.id === "anthropic.pdf") return runPdfAuthoringCanary(input, environment);
  if (input.skill.id === "anthropic.pptx") return runPptxAuthoringCanary(input, environment);
  if (input.skill.id === "anthropic.xlsx") return runXlsxAuthoringCanary(input, environment);
  throw new Error("Unsupported authoring canary.");
}

async function runDocxAuthoringCanary(
  input: Parameters<typeof runAuthoringCanary>[0],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const node = requireAuthoringRuntimeExecutable(input.runtime?.node ?? null, "Node is missing.");
  const python = requireAuthoringRuntimeExecutable(
    input.runtime?.python ?? null,
    "Python is missing.",
  );
  const pandoc = requireAuthoringRuntimeExecutable(
    input.runtime?.pandoc ?? null,
    "Pandoc is missing.",
  );
  const pdftoppm = requireAuthoringRuntimeExecutable(
    input.runtime?.pdftoppm ?? null,
    "Poppler is missing.",
  );
  const skillDirectory = await verifiedCompanionSkillDirectory(input.plan, input.skill);
  const validator = join(skillDirectory, "scripts", "office", "validate.py");
  const soffice = join(skillDirectory, "scripts", "office", "soffice.py");
  await Promise.all([
    requireRegularCompanionFile(input.root, validator, "DOCX validator"),
    requireRegularCompanionFile(input.root, soffice, "DOCX LibreOffice helper"),
  ]);
  const document = join(input.temporary, "docx-canary.docx");
  await authoringStep(input, environment, "docx.create", node, [
    "-e",
    DOCX_CANARY_SCRIPT,
    document,
  ]);
  await requireAuthoringArtifact(document, 128);
  await authoringStep(input, environment, "docx.validate", python, [validator, document]);
  const text = await authoringStep(input, environment, "docx.extract", pandoc, [
    "-t",
    "plain",
    document,
  ]);
  if (!text.stdout.includes("TIANGONG_DOCX_CANARY")) {
    throw new Error("DOCX text extraction did not return the exact canary sentinel.");
  }
  await authoringStep(
    input,
    environment,
    "docx.render",
    python,
    [soffice, "--headless", "--convert-to", "pdf", "--outdir", input.temporary, document],
    60_000,
  );
  const pdf = join(input.temporary, "docx-canary.pdf");
  await requireAuthoringArtifact(pdf, 128);
  const renderPrefix = join(input.temporary, "docx-page");
  await authoringStep(input, environment, "docx.rasterize", pdftoppm, [
    "-f",
    "1",
    "-singlefile",
    "-png",
    pdf,
    renderPrefix,
  ]);
  await requireAuthoringArtifact(`${renderPrefix}.png`, 64);
}

async function runPdfAuthoringCanary(
  input: Parameters<typeof runAuthoringCanary>[0],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const python = requireAuthoringRuntimeExecutable(
    input.runtime?.python ?? null,
    "Python is missing.",
  );
  const pdftoppm = requireAuthoringRuntimeExecutable(
    input.runtime?.pdftoppm ?? null,
    "Poppler is missing.",
  );
  const skillDirectory = await verifiedCompanionSkillDirectory(input.plan, input.skill);
  const converter = join(skillDirectory, "scripts", "convert_pdf_to_images.py");
  const validationImage = join(skillDirectory, "scripts", "create_validation_image.py");
  await Promise.all([
    requireRegularCompanionFile(input.root, converter, "PDF image converter"),
    requireRegularCompanionFile(input.root, validationImage, "PDF validation image helper"),
  ]);
  const pdf = join(input.temporary, "pdf-canary.pdf");
  await authoringStep(input, environment, "pdf.create", python, ["-c", PDF_CANARY_SCRIPT, pdf]);
  await requireAuthoringArtifact(pdf, 128);
  const parsed = await authoringStep(input, environment, "pdf.parse", python, [
    "-c",
    PDF_VERIFY_SCRIPT,
    pdf,
  ]);
  if (!parsed.stdout.includes("TIANGONG_PDF_CANARY")) {
    throw new Error("PDF parser did not return the exact canary sentinel.");
  }
  const renderPrefix = join(input.temporary, "pdf-page");
  await authoringStep(input, environment, "pdf.rasterize", pdftoppm, [
    "-f",
    "1",
    "-singlefile",
    "-png",
    pdf,
    renderPrefix,
  ]);
  await requireAuthoringArtifact(`${renderPrefix}.png`, 64);
  const pages = join(input.temporary, "pdf-pages");
  await mkdir(pages);
  await authoringStep(input, environment, "pdf.convert-images", python, [converter, pdf, pages]);
  const page = join(pages, "page_1.png");
  await requireAuthoringArtifact(page, 64);
  const fields = join(input.temporary, "pdf-fields.json");
  await writeJsonAtomic(fields, { form_fields: [] });
  const annotated = join(input.temporary, "pdf-validation.png");
  await authoringStep(input, environment, "pdf.validation-image", python, [
    validationImage,
    "1",
    fields,
    page,
    annotated,
  ]);
  await requireAuthoringArtifact(annotated, 64);
}

async function runPptxAuthoringCanary(
  input: Parameters<typeof runAuthoringCanary>[0],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const node = requireAuthoringRuntimeExecutable(input.runtime?.node ?? null, "Node is missing.");
  const python = requireAuthoringRuntimeExecutable(
    input.runtime?.python ?? null,
    "Python is missing.",
  );
  const skillDirectory = await verifiedCompanionSkillDirectory(input.plan, input.skill);
  const validator = join(skillDirectory, "scripts", "office", "validate.py");
  const thumbnail = join(skillDirectory, "scripts", "thumbnail.py");
  await Promise.all([
    requireRegularCompanionFile(input.root, validator, "PPTX validator"),
    requireRegularCompanionFile(input.root, thumbnail, "PPTX thumbnail helper"),
  ]);
  const presentation = join(input.temporary, "pptx-canary.pptx");
  await authoringStep(input, environment, "pptx.create", node, [
    "-e",
    PPTX_CANARY_SCRIPT,
    presentation,
  ]);
  await requireAuthoringArtifact(presentation, 128);
  await authoringStep(input, environment, "pptx.validate", python, [validator, presentation]);
  const text = await authoringStep(input, environment, "pptx.extract", python, [
    "-m",
    "markitdown",
    presentation,
  ]);
  if (!text.stdout.includes("TIANGONG_PPTX_CANARY")) {
    throw new Error("PPTX MarkItDown did not return the exact canary sentinel.");
  }
  const thumbnailPrefix = join(input.temporary, "pptx-grid");
  await authoringStep(
    input,
    environment,
    "pptx.thumbnail",
    python,
    [thumbnail, presentation, thumbnailPrefix, "--cols", "1"],
    60_000,
  );
  await requireAuthoringArtifact(`${thumbnailPrefix}.jpg`, 64);
}

async function runXlsxAuthoringCanary(
  input: Parameters<typeof runAuthoringCanary>[0],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const python = requireAuthoringRuntimeExecutable(
    input.runtime?.python ?? null,
    "Python is missing.",
  );
  const skillDirectory = await verifiedCompanionSkillDirectory(input.plan, input.skill);
  const recalc = join(skillDirectory, "scripts", "recalc.py");
  await requireRegularCompanionFile(input.root, recalc, "XLSX recalculation helper");
  const workbook = join(input.temporary, "xlsx-canary.xlsx");
  await authoringStep(input, environment, "xlsx.create", python, [
    "-c",
    XLSX_CANARY_SCRIPT,
    workbook,
  ]);
  await requireAuthoringArtifact(workbook, 128);
  const recalculated = await authoringStep(
    input,
    environment,
    "xlsx.recalculate",
    python,
    [recalc, workbook, "60"],
    75_000,
  );
  let result: unknown;
  try {
    result = JSON.parse(recalculated.stdout) as unknown;
  } catch {
    throw new Error("XLSX recalculation helper did not return JSON.");
  }
  if (!isObject(result) || result.status !== "success" || result.total_errors !== 0) {
    throw new Error("XLSX recalculation helper did not complete without formula errors.");
  }
  const cached = await authoringStep(input, environment, "xlsx.verify-cache", python, [
    "-c",
    XLSX_VERIFY_SCRIPT,
    workbook,
  ]);
  if (cached.stdout.trim() !== "5") {
    throw new Error("XLSX recalculation did not persist the exact cached formula value.");
  }
  const markdown = await authoringStep(input, environment, "xlsx.extract", python, [
    "-m",
    "markitdown",
    workbook,
  ]);
  const normalizedMarkdown = markdown.stdout.replaceAll("\\_", "_");
  if (
    !normalizedMarkdown.includes("TIANGONG_XLSX_CANARY") ||
    !/(?:^|\D)5(?:\D|$)/u.test(normalizedMarkdown)
  ) {
    throw new Error("XLSX MarkItDown did not return the exact canary sentinel and value.");
  }
}

async function authoringStep(
  input: Parameters<typeof runAuthoringCanary>[0],
  environment: NodeJS.ProcessEnv,
  step: string,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<SetupCommandResult> {
  const result = await input.runner({
    command,
    args,
    cwd: input.root,
    environment,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Authoring canary step failed (${step}).`);
  }
  return result;
}

async function requireAuthoringArtifact(path: string, minimumBytes: number): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < minimumBytes) {
    throw new Error("Authoring canary did not create its exact expected regular artifact.");
  }
}

const DOCX_CANARY_SCRIPT = String.raw`
const fs=require("node:fs"); const {Document,Packer,Paragraph}=require("docx");
(async()=>{const out=process.argv[1]; const doc=new Document({sections:[{children:[new Paragraph("TIANGONG_DOCX_CANARY")]}]}); fs.writeFileSync(out,await Packer.toBuffer(doc));})().catch(()=>process.exit(1));`;

const PDF_CANARY_SCRIPT = String.raw`
import sys
from reportlab.pdfgen import canvas
c=canvas.Canvas(sys.argv[1]); c.drawString(72,720,"TIANGONG_PDF_CANARY"); c.save()`;

const PDF_VERIFY_SCRIPT = String.raw`
import sys, pdfplumber
from pypdf import PdfReader
assert len(PdfReader(sys.argv[1]).pages)==1
with pdfplumber.open(sys.argv[1]) as p: print(p.pages[0].extract_text())`;

const PPTX_CANARY_SCRIPT = String.raw`
const pptxgen=require("pptxgenjs");
(async()=>{const p=new pptxgen(); p.addSlide().addText("TIANGONG_PPTX_CANARY",{x:1,y:1,w:6,h:1}); await p.writeFile({fileName:process.argv[1]});})().catch(()=>process.exit(1));`;

const XLSX_CANARY_SCRIPT = String.raw`
import sys
from openpyxl import Workbook
w=Workbook(); s=w.active; s["A1"]="TIANGONG_XLSX_CANARY"; s["A2"]=2; s["A3"]=3; s["A4"]="=SUM(A2:A3)"; w.save(sys.argv[1])`;

const XLSX_VERIFY_SCRIPT = String.raw`
import sys
from openpyxl import load_workbook
w=load_workbook(sys.argv[1],data_only=True,read_only=True); print(w.active["A4"].value); w.close()`;

async function appendCompanionLiveChecks(
  checks: SetupDoctorCheck[],
  input: {
    plan: ResearchSetupPlan;
    selected: ResearchSetupSkill[];
    adapterCredentials: Map<string, string>;
    fetcher: typeof fetch;
    sleeper: (milliseconds: number) => Promise<unknown>;
    allowSyntheticUnstructureUpload: boolean;
  },
): Promise<void> {
  if (input.selected.some((skill) => skill.id === "tiangong.academic-paper-download")) {
    await appendSemanticScholarLiveCheck(checks, input);
    const semanticScholar = checks.findLast((check) => check.id === "live.semantic-scholar");
    checks.push({
      id: "companion.tiangong.academic-paper-download",
      category: "live-check",
      scope: "acquisition",
      componentIds: ["tiangong.academic-paper-download"],
      status: semanticScholar?.status === "pass" ? "pass" : "warn",
      detail:
        semanticScholar?.status === "pass"
          ? "OA resolver diagnostics: Unpaywall=unknown, Semantic Scholar=ready, arXiv=unknown; the deterministic resolver order is unchanged."
          : "OA resolver diagnostics: Unpaywall=unknown, Semantic Scholar=degraded, arXiv=unknown. The adapter remains available and actual acquisition will stop or request explicit browser handoff only after its ordered OA sources are exhausted.",
      minimumAction:
        semanticScholar?.status === "pass"
          ? null
          : "Retry the resolver diagnostic later or configure its optional key; unrelated research remains authorized and no standalone evidence fallback is permitted.",
      blocking: false,
      componentGate: false,
      requiredFor: ["component:tiangong.academic-paper-download"],
    });
  }

  if (input.selected.some((skill) => skill.id === "tiangong.document-granular-decompose")) {
    if (!input.allowSyntheticUnstructureUpload) {
      checks.push({
        id: "live.tiangong-unstructure",
        category: "live-check",
        scope: "preprocessing",
        componentIds: ["tiangong.document-granular-decompose"],
        status: "warn",
        detail: "Synthetic document upload was not explicitly authorized, so no document was sent.",
        minimumAction:
          "Rerun setup doctor with the separate synthetic-upload confirmation after reviewing service cost and data policy.",
        blocking: false,
        componentGate: true,
      });
    } else {
      await setupDoctorCheck(checks, "live.tiangong-unstructure", "live-check", async () => {
        const baseUrl = input.plan.settings["tiangong.unstructure.base-url"];
        const token = input.adapterCredentials.get("tiangong.unstructure.auth-token");
        if (!baseUrl || !token)
          throw new Error("Unstructure URL or owner-only credential is missing.");
        const form = new FormData();
        form.set(
          "file",
          new Blob([syntheticPdfText()], { type: "application/pdf" }),
          "tiangong-setup-doctor.pdf",
        );
        const provider = input.plan.settings["tiangong.unstructure.provider"];
        const model = input.plan.settings["tiangong.unstructure.model"];
        if (provider) form.set("provider", provider);
        if (model) form.set("model", model);
        const response = await input.fetcher(
          `${baseUrl.replace(/\/+$/, "")}/mineru_with_images?return_txt=true`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            body: form,
            redirect: "manual",
            signal: AbortSignal.timeout(120_000),
          },
        );
        if (response.status >= 300 && response.status < 400) {
          throw new Error("Unstructure returned a redirect; Authorization is never forwarded.");
        }
        if (!response.ok) {
          const detail = await boundedResponseText(response, 2_000, [token]);
          throw new Error(
            `Unstructure live check returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        return "Unstructure accepted and processed the explicitly authorized synthetic PDF.";
      });
    }
  }
}

async function appendSemanticScholarLiveCheck(
  checks: SetupDoctorCheck[],
  input: {
    adapterCredentials: Map<string, string>;
    fetcher: typeof fetch;
    sleeper: (milliseconds: number) => Promise<unknown>;
  },
): Promise<void> {
  const apiKey = input.adapterCredentials.get("semantic-scholar.api-key");
  const headers = new Headers({ Accept: "application/json" });
  if (apiKey) headers.set("x-api-key", apiKey);
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/s41586-020-2649-2?fields=paperId";
  try {
    let response!: Response;
    let retryAfterSeconds: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await input.fetcher(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 429 || attempt === 1) break;
      retryAfterSeconds = setupRetryAfterSeconds(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      await input.sleeper(Math.min(5, retryAfterSeconds ?? 1) * 1_000);
    }
    retryAfterSeconds ??= setupRetryAfterSeconds(response.headers.get("retry-after"));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      checks.push({
        id: "live.semantic-scholar",
        category: "live-check",
        scope: "acquisition",
        componentIds: ["tiangong.academic-paper-download"],
        status: "fail",
        detail:
          "Semantic Scholar returned a redirect; credential-bearing redirects are not followed.",
        minimumAction:
          "Verify the fixed Semantic Scholar endpoint and network policy before relying on that resolver; do not fall back to a standalone evidence wrapper.",
        blocking: false,
        componentGate: false,
        diagnostics: {
          code: "PROVIDER_REDIRECT_REJECTED",
          executionMode: "setup-doctor",
          credentialScope: "adapter",
          networkAttempted: true,
          httpStatus: response.status,
        },
      });
      return;
    }
    if (!response.ok) {
      const authenticationFailure = response.status === 401 || response.status === 403;
      const rateLimited = response.status === 429;
      const detail = authenticationFailure
        ? ""
        : await boundedResponseText(response, 2_000, apiKey ? [apiKey] : []);
      checks.push({
        id: "live.semantic-scholar",
        category: "live-check",
        scope: "acquisition",
        componentIds: ["tiangong.academic-paper-download"],
        status: "fail",
        detail: sanitizeResearchText(
          `Semantic Scholar live check returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
          apiKey ? [apiKey] : [],
        ),
        minimumAction: rateLimited
          ? `Wait for the provider quota window${retryAfterSeconds === null ? "" : ` (Retry-After ${retryAfterSeconds}s)`}, then rerun this optional resolver diagnostic. Unrelated research remains available and must not downgrade to standalone search.`
          : authenticationFailure
            ? "Replace or remove the optional Semantic Scholar API key, verify provider entitlement, and rerun setup doctor; do not expose the key in output."
            : "Verify Semantic Scholar availability and the fixed API contract before relying on that resolver; do not downgrade the research workflow.",
        blocking: false,
        componentGate: false,
        diagnostics: {
          code: authenticationFailure
            ? "PROVIDER_AUTHENTICATION_FAILED"
            : rateLimited
              ? "PROVIDER_RATE_LIMITED"
              : "PROVIDER_REQUEST_FAILED",
          executionMode: "setup-doctor",
          credentialScope: "adapter",
          networkAttempted: true,
          httpStatus: response.status,
          retryAfterSeconds,
        },
      });
      return;
    }
    await response.body?.cancel().catch(() => undefined);
    checks.push({
      id: "live.semantic-scholar",
      category: "live-check",
      scope: "acquisition",
      componentIds: ["tiangong.academic-paper-download"],
      status: "pass",
      detail: apiKey
        ? "Semantic Scholar accepted the configured optional API key."
        : "Semantic Scholar public API is reachable without an optional API key.",
      minimumAction: null,
      blocking: false,
      componentGate: false,
    });
  } catch (error) {
    checks.push({
      id: "live.semantic-scholar",
      category: "live-check",
      scope: "acquisition",
      componentIds: ["tiangong.academic-paper-download"],
      status: "fail",
      detail: sanitizeResearchText(
        error instanceof Error ? error.message : String(error),
        apiKey ? [apiKey] : [],
      ),
      minimumAction:
        "Restore provider connectivity before relying on Semantic Scholar; unrelated research remains available and no standalone fallback is authorized.",
      blocking: false,
      componentGate: false,
      diagnostics: {
        code: "PROVIDER_TRANSPORT_FAILED",
        executionMode: "setup-doctor",
        credentialScope: "adapter",
        networkAttempted: true,
      },
    });
  }
}

function setupRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  secrets: readonly string[],
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maximumBytes) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maximumBytes - bytes;
      const chunk = next.value.subarray(0, remaining);
      chunks.push(chunk);
      bytes += chunk.length;
      if (next.value.length > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return sanitizeResearchText(Buffer.concat(chunks).toString("utf8"), secrets)
    .replace(/\s+/g, " ")
    .trim();
}

function syntheticPdfText(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 53 >>\nstream\nBT /F1 12 Tf 36 72 Td (Tiangong setup doctor) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

function setupFailure(
  error: unknown,
  fallbackStep: string,
  root: string,
): NonNullable<ResearchSetupState["lastError"]> {
  if (error instanceof CliError && isObject(error.details)) {
    const details = sanitizeResearchRecord(error.details);
    const step = typeof details.step === "string" ? details.step : fallbackStep;
    return {
      code: error.code,
      step,
      reason:
        typeof details.reason === "string" ? details.reason : sanitizeResearchText(error.message),
      minimumAction:
        typeof details.minimumAction === "string"
          ? details.minimumAction
          : "Resolve the reported setup error and retry the exact recorded step.",
      retryCommand: researchSetupRetryCommand({
        version: packageVersion(),
        workspace: root,
        step,
      }),
      ...(isObject(details.diagnostics) ? { diagnostics: details.diagnostics } : {}),
    };
  }
  return {
    code: "RESEARCH_SETUP_UNEXPECTED_FAILURE",
    step: fallbackStep,
    reason: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
    minimumAction:
      "Inspect the sanitized setup status, correct the failure, and retry the exact recorded step.",
    retryCommand: researchSetupRetryCommand({
      version: packageVersion(),
      workspace: root,
      step: fallbackStep,
    }),
  };
}

function setupError(input: {
  code: string;
  step: string;
  reason: string;
  minimumAction: string;
  retryCommand: string;
  exitCode: number;
  diagnostics?: Record<string, unknown>;
}): CliError {
  const details = sanitizeResearchRecord({
    step: input.step,
    reason: input.reason,
    minimumAction: input.minimumAction,
    retryCommand: pinResearchCliCommand(input.retryCommand),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });
  return new CliError(sanitizeResearchText(input.reason), {
    code: input.code,
    exitCode: input.exitCode,
    details,
  });
}

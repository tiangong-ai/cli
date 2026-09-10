export type ContextRole = "workspace" | "setup" | "unmanaged" | "invalid";

export const PROJECT_STATUSES = [
  "ready",
  "running",
  "blocked",
  "complete",
  "stale",
  "waiting-user",
  "waiting-external",
  "archived",
  "abandoned",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.some((status) => status === value);
}

export type PackageStatus = "pending" | "ready" | "running" | "retry" | "failed" | "complete";

export type PackageKind = "agent" | "verify";

export type AgentKind = "codex" | "claude" | "workbuddy" | "codebuddy";

export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentVerbosity = "low" | "medium" | "high";

export type ResearchMode = "smoke-test" | "production-research";

export type ReviewTransport = "native-direct" | "sandbox-bridge";

export interface ReviewExecutionConfig {
  transport: ReviewTransport;
  isolationProvider: "platform-capsule";
}

export type AgentPackageStage = "discover" | "acquire" | "analyze" | "synthesize" | "review";

export interface AgentPricing {
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface AgentRoute {
  agent: AgentKind;
  /**
   * Producer reasoning belongs to the current interactive host. Only the
   * independent reviewer is allowed to run as a child CLI process.
   */
  executionMode?: "native-host" | "headless-cli";
  binary: string;
  wrapperTargetBinary?: string;
  model: string | null;
  effort?: AgentReasoningEffort;
  verbosity?: AgentVerbosity;
  pricing?: AgentPricing;
}

export interface ResearchBudget {
  maxTokens: number;
  maxCostUsd: number;
  maxWallSeconds: number;
  maxFilesPerPackage: number;
  maxBytesPerPackage: number;
  maxBytesPerArtifact: number;
  maxAttemptsPerPackage: number;
  confirmationCostUsd: number;
  packageMaxTokens: Record<AgentPackageStage, number>;
  packageMaxWallSeconds: Record<AgentPackageStage, number>;
  maxOutputTokens: number;
  maxRepairTokens: number;
  maxBrokerResponseBytes: number;
  maxBrokerContextTokens: number;
  maxBrokerCalls: number;
  maxBrokerItems: number;
  maxInputContextTokens: number;
  earlyScientificReviewMaxTokens: number;
  finalPublicationReviewMaxTokens: number;
  revisionReserveTokens: number;
  earlyScientificReviewMaxWallSeconds: number;
  finalPublicationReviewMaxWallSeconds: number;
  revisionReserveWallSeconds: number;
}

export interface WorkspaceMarker {
  schemaVersion: 1;
  kind: "tiangong-research-workspace";
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceConfig {
  schemaVersion: 1;
  mode: ResearchMode;
  producer: AgentRoute;
  reviewer: AgentRoute;
  reviewerExecution: ReviewExecutionConfig;
  budget: ResearchBudget;
}

export interface RuntimeLock {
  schemaVersion: 1;
  protocolVersion: 1;
  packageName: "@tiangong-ai/cli";
  packageVersion: string;
  workspaceId: string;
}

export interface CapabilityCredentialDeclaration {
  id: string;
  allowedHosts: string[];
  headerName: string;
  prefix: string;
}

export interface CapabilitySourceDeclaration {
  type: "git" | "registry" | "local";
  locator: string;
  immutableRef: string;
  expectedTreeSha256: string;
  license: string;
  catalogId: string | null;
}

export interface CapabilityHealthCheckDeclaration {
  url: string;
  credentialId: string | null;
  expectedContentTypes: string[];
  method: "GET" | "POST";
  body: Record<string, unknown> | null;
}

export interface CapabilityDeclaration {
  id: string;
  skillPath: string;
  source: CapabilitySourceDeclaration | null;
  requiredForDiscovery: boolean;
  permissions: string[];
  allowedHosts: string[];
  http: {
    endpoint: string;
    method: "GET" | "POST";
    accept: string;
    allowedContentTypes: string[];
    staticHeaders: Record<string, string>;
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxItems: number;
  } | null;
  coverage: {
    dimensions: string[];
    sourceTypes: string[];
    discoveryScopes: string[];
    fullText: boolean;
    publicationDates: boolean;
  } | null;
  credentials: CapabilityCredentialDeclaration[];
  healthCheck: CapabilityHealthCheckDeclaration | null;
}

export interface CapabilityDeclarations {
  schemaVersion: 1;
  capabilities: CapabilityDeclaration[];
}

export interface CapabilityLockRecord {
  id: string;
  skillName: string;
  skillPath: string;
  treeSha256: string;
  policySha256: string;
  source: CapabilitySourceDeclaration | null;
  requiredForDiscovery: boolean;
  permissions: string[];
  credentialIds: string[];
  discoveryScopes: string[];
  healthTargetSha256: string | null;
}

export interface CapabilityLock {
  schemaVersion: 1;
  generatedAt: string;
  capabilities: CapabilityLockRecord[];
}

export interface ProjectInput {
  id: string;
  role: "primary" | "reference" | "replication";
  path: string;
  sha256: string;
  bytes: number;
  contextPath?: string;
  contextSha256?: string;
  contextBytes?: number;
  contextRanges?: ProjectInputLineRange[];
  sourceType?: string;
  dimensions?: string[];
  fullText?: boolean;
  publicationDate?: string | null;
  trustStatus?: ProjectInputTrustStatus;
  independentlyReproduced?: boolean;
  addedAt: string;
}

export type ProjectInputTrustStatus =
  | "verified-owner-input"
  | "unverified-owner-input"
  | "reference-only"
  | "replication-candidate";

export interface ProjectInputLineRange {
  startLine: number;
  endLine: number;
}

export interface ProjectInputPlanEntry {
  path: string;
  contextPath?: string | null;
  contextRanges?: ProjectInputLineRange[] | null;
  role: ProjectInput["role"];
  dimensions: string[];
  sourceType: string;
  fullText: boolean;
  publicationDate: string | null;
  trustStatus?: ProjectInputTrustStatus;
  independentlyReproduced?: boolean;
}

export interface ProjectInputPlan {
  schemaVersion: 1;
  inputs: ProjectInputPlanEntry[];
}

export interface VerifiedProjectInputPlanEntry extends ProjectInputPlanEntry {
  id: string;
  sha256: string;
  bytes: number;
  contextSha256: string | null;
  contextBytes: number | null;
}

export interface VerifiedProjectInputPlan {
  schemaVersion: 1;
  sha256: string;
  inputs: VerifiedProjectInputPlanEntry[];
}

export interface ProjectEvidenceRequirements {
  dimensions: string[];
  sourceTypes: string[];
  requiredCapabilityIds?: string[];
  requiredCompanionIds?: string[];
  requiredDiscoveryScopes?: string[];
  minSources: number;
  minFullTextSources: number;
  minDatedSources: number;
  publicationDateFrom: string | null;
  publicationDateTo: string | null;
}

export type ResearchVerdictCeiling =
  | "top-journal-feasibility-complete"
  | "top-journal-candidate"
  | "top-journal-class-ready"
  | "target-journal-submission-ready";

export interface ResearchPolicyBinding {
  goal: "top-journal";
  projectId: string;
  articleType: string;
  field: string;
  journalClass: string;
  targetJournal: string | null;
  resolvedPolicySha256: string;
  approvalSha256: string;
  verdictCeiling: ResearchVerdictCeiling;
  documents: Array<{
    id: string;
    kind: string;
    logicalPath: string;
    sha256: string;
    sourceClass: "bundled-default" | "human-customized";
    objectLocator: string;
  }>;
  resolvedRules: string[];
  resolvedConstraints?: Record<string, boolean | number | string | string[]>;
  requiredReviewers: string[];
  approvedAt: string;
  expiresAt: string;
}

export interface WorkPackage {
  id: string;
  stage: "discover" | "acquire" | "analyze" | "synthesize" | "review" | "close";
  kind: PackageKind;
  executor: "producer" | "reviewer" | "mechanical";
  dependencies: string[];
  expectedOutputs: string[];
  status: PackageStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lastFailureKind: FailureKind | null;
  retryNotBefore: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type ScientificReviewRole = "research-design" | "evidence-construct" | "pilot-methods";

export type ScientificGateStatus =
  | "pending"
  | "prepared"
  | "passed"
  | "revision-required"
  | "stopped";

export interface ScientificDesignBinding {
  schemaVersion: 1;
  designSha256: string;
  fulfillmentSha256?: string | null;
  objectLocator: string;
  centralStudyKind: string;
  producer: {
    agent: AgentKind;
    sessionSha256: string;
  };
  mechanicalIssueCodes: string[];
  gates: Record<
    ScientificReviewRole,
    {
      status: ScientificGateStatus;
      packetSha256: string | null;
      assessmentSha256: string | null;
      reviewSha256: string | null;
      reviewerSessionSha256: string | null;
    }
  >;
}

export interface ProjectBudgetAuthorization {
  revision: number;
  maxCostUsd: number;
  authorizedAt: string;
  originProjectId: string;
  providerOperationMaxCostUsd: Record<string, number>;
}

export interface ProjectBudgetEntry {
  id: string;
  sourceProjectId: string;
  kind: "native-stage" | "review" | "provider-operation";
  reference: string;
  authorizationRevision: number;
  maxCostUsd: number;
  status: "reserved" | "settled";
  accountedCostUsd: number | null;
  settlementBasis: "reported-usage" | "allocated-upper-bound" | "owner-estimate" | null;
  resolutionReason?: string;
  createdAt: string;
  settledAt: string | null;
}

export interface ProjectBudgetState {
  schemaVersion: 1;
  authorization: ProjectBudgetAuthorization;
  openingEstimateUsd: number;
  openingBasis: "new-project" | "legacy-accounting" | "recovery-exposure";
  openingSourceProjectId: string | null;
  entries: ProjectBudgetEntry[];
}

export interface ProjectUsage {
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallSeconds: number;
}

export type ResearchHandoffKind = "interactive-challenge" | "external-wait" | "evidence-exhausted";

export interface ResearchEvidenceRouteAttempt {
  routeId: string;
  terminalEventHashes: string[];
  outcome: "completed-insufficient" | "access-blocked" | "deterministic-unavailable";
}

export interface ResearchEvidenceExhaustion {
  missingEvidenceRoleIds: string[];
  routeAttempts: ResearchEvidenceRouteAttempt[];
  remainingRouteIds: string[];
}

export interface ResearchAccessRequest {
  id: string;
  routeId: string;
  resourceType:
    | "database-subscription"
    | "article-purchase"
    | "institutional-access"
    | "licensed-dataset"
    | "owner-provided-material"
    | "external-data-request"
    | "field-data-collection";
  resourceName: string;
  officialLocator: string | null;
  evidenceRoleIds: string[];
  rationale: string;
  alternativesTriedRouteIds: string[];
  requestedAction: string;
  resumeCriteria: string;
  costStatus: "unknown" | "provider-quote-required";
}

export interface ProjectState {
  schemaVersion: 1;
  id: string;
  question: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  budgetConfirmedAt: string | null;
  budget?: ProjectBudgetState;
  inputs: ProjectInput[];
  evidenceRequirements: ProjectEvidenceRequirements;
  publicationPolicy?: ResearchPolicyBinding | null;
  scientificDesign: ScientificDesignBinding | null;
  packages: WorkPackage[];
  usage: ProjectUsage;
  lineage: {
    kind: "primary" | "fork" | "addendum";
    derivedFrom: string | null;
    supersedes: string | null;
    supersededBy: string | null;
    baseSnapshotId: string | null;
    baseSnapshotSha256: string | null;
  };
  handoff: {
    state: "agent-actionable" | "user-action-required" | "external-response-required";
    kind: ResearchHandoffKind | null;
    reasonCode: string | null;
    summary: string | null;
    requestedActions: string[];
    evidenceGaps: string[];
    exhaustion: ResearchEvidenceExhaustion | null;
    accessRequests: ResearchAccessRequest[];
    requestedAt: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
  };
  evidenceState: {
    currentSnapshotId: string | null;
    currentSnapshotSha256: string | null;
    closureSnapshotId: string | null;
    staleReason: string | null;
  };
}

export interface OutputRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallSeconds: number;
  model: string | null;
  runtime: AgentRuntimeFingerprint | null;
  isolation?: ReviewIsolationFingerprint | undefined;
  reviewAttestation?: ReviewExecutionAttestation | undefined;
  telemetry?: AgentExecutionTelemetry | undefined;
  artifactReads?: import("./artifact-views.js").ArtifactReadReceipt[];
}

export interface ReviewIsolationFingerprint {
  provider: "sandbox-exec" | "bubblewrap";
  policySha256: string;
  readScopes: Array<"platform-runtime" | "agent-runtime" | "private-capsule">;
  writeScopes: ["private-capsule"];
  networkPolicy: "reviewer-provider-only" | "reviewer-provider-and-local-artifacts";
  toolPolicy: "none" | "packet-read";
}

export interface ReviewExecutionAttestation {
  schemaVersion: 1;
  protocolVersion: 1;
  transport: "sandbox-bridge";
  isolationProvider: ReviewIsolationFingerprint["provider"];
  toolPolicy: "none" | "packet-read";
  workspaceId: string;
  requestId: string;
  requestSha256: string;
  resultSha256: string;
  capsuleSha256: string;
  runtimeLockSha256: string;
  configSha256: string;
  policySha256: string;
  signerKeyFingerprint: string;
  attestationSha256: string;
  signature: string;
}

export interface AgentExecutionTelemetry {
  eventCounts: Record<string, number>;
  itemCounts: Record<string, number>;
  toolCalls: number;
  packetReadViolations?: number;
  providerTurns: number | null;
  reasoningOutputTokens: number;
  providerErrors: string[];
}

export interface AgentRuntimeFingerprint {
  agent: AgentKind;
  model: string | null;
  effort?: AgentReasoningEffort;
  verbosity?: AgentVerbosity | null;
  binarySha256: string;
  wrapperSha256: string;
  adapterSha256: string;
  binaryVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  /** Absent on legacy records; configured routing is not upstream attestation. */
  providerRouting?: AgentProviderRouting;
}

export interface AgentProviderRouting {
  schemaVersion: 1;
  configurationSha256: string;
  endpointOrigin: string | null;
  endpointSource: "process-environment" | "claude-settings-env" | "runtime-default";
  modelMappingSources: Record<string, "process-environment" | "claude-settings-env">;
  identityVerification: "unverified";
  scope: "configured-routing-only";
}

export type FailureKind =
  | "configuration"
  | "authentication"
  | "rate-limit"
  | "server"
  | "structured-output"
  | "budget"
  | "transient"
  | "deterministic";

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  packageId: string;
  executor: AgentKind | "mechanical";
  startedAt: string;
  completedAt: string;
  exitCode: number;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallSeconds: number;
  outputs: OutputRecord[];
  stdoutSha256: string;
  stderrSha256: string;
  failureKind: FailureKind | null;
  failureDetails?: Record<string, unknown> | null | undefined;
  runtime: AgentRuntimeFingerprint | null;
  isolation?: ReviewIsolationFingerprint | undefined;
  reviewAttestation?: ReviewExecutionAttestation | undefined;
  telemetry?: AgentExecutionTelemetry | undefined;
  accountingMode?: "measured" | "reserved-native-host" | "mechanical";
}

export interface JournalEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  type: string;
  scope: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface ContextInspection {
  role: ContextRole;
  selectedPath: string;
  root: string | null;
  allowedOperations: string[];
  violations: Array<{ code: string; message: string }>;
  setup?: {
    status: "pending" | "applying" | "partially-ready" | "ready" | "blocked";
    currentStep: string | null;
    blocker: {
      code: string;
      step: string;
      reason: string;
      minimumAction: string;
      retryCommand: string;
      diagnostics?: Record<string, unknown>;
    } | null;
    runtime: {
      packageName: "@tiangong-ai/cli";
      packageVersion: string;
      source: "runtime-lock" | "setup-plan";
    };
    next: {
      action: "apply" | "retry" | "doctor" | "inspect";
      retryCommand: string;
    } | null;
  };
}

export interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface WorkspaceDoctorResult {
  workspace: string;
  status: "ready" | "blocked";
  checks: DoctorCheck[];
}

export interface WorkspaceDoctorAttestation {
  schemaVersion: 1;
  workspaceId: string;
  checkedAt: string;
  expiresAt: string;
  configSha256: string;
  runtimeLockSha256: string;
  capabilityDeclarationsSha256: string;
  capabilityLockSha256: string;
  doctorSchemaSha256: string;
  reviewerExecution: {
    transport: ReviewTransport;
    isolationProvider: ReviewIsolationFingerprint["provider"];
    policySha256: string;
    signerKeyFingerprint: string | null;
  };
  runtimes: AgentRuntimeFingerprint[];
  capabilitySmoke: Array<{
    id: string;
    status: "pass" | "not-applicable";
    code: string;
    host: string | null;
    targetSha256: string | null;
    httpStatus: number | null;
  }>;
  smokeUsage: Array<{
    agent: AgentKind;
    tokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number;
    wallSeconds: number;
    telemetry?: AgentExecutionTelemetry | undefined;
  }>;
  attestationSha256: string;
}

export interface WorkspacePaths {
  root: string;
  control: string;
  marker: string;
  config: string;
  runtimeLock: string;
  capabilityDeclarations: string;
  capabilityLock: string;
  doctorAttestation: string;
  setupPlan: string;
  setupState: string;
  setupReport: string;
  setupDeclaration: string;
  setupDeclarationEnv: string;
  setupDeclarationEnvExample: string;
  setupDeclarationBinding: string;
  setupConfig: string;
  setupAdapterEnv: string;
  setupSources: string;
  setupLock: string;
  env: string;
  envExample: string;
  journal: string;
  evidence: string;
  evidenceCache: string;
  evidenceObjects: string;
  projects: string;
  runtime: string;
  locks: string;
}

export interface ResearchProgressEvent {
  schemaVersion: 1;
  type:
    | "run.started"
    | "package.started"
    | "package.heartbeat"
    | "package.completed"
    | "package.failed"
    | "run.completed";
  timestamp: string;
  requestId: string;
  projectId: string | null;
  packageId: string | null;
  remainingBudget: {
    tokens: number;
    costUsd: number;
    wallSeconds: number;
  } | null;
  detail?: Record<string, unknown>;
}

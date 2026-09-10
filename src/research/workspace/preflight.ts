import { projectBudgetAmount } from "./project-budget.js";
import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { projectResearchDataCapabilities } from "./data-evidence-adapter.js";
import { hasPublicInternetCapability } from "./external-skills.js";
import { deriveDiscoveryPlan } from "./discovery-planning.js";
import { declaredSourceTypes } from "./evidence-role-coverage.js";
import {
  evaluateScientificDesign,
  scientificDesignPolicyGaps,
  type ScientificDesignContract,
  type VerifiedScientificDesign,
} from "./scientific-design.js";
import { inspectScientificDesignObjectBindings } from "./scientific-objects.js";
import { schemaForStage } from "./schemas.js";
import { canonicalJson, sha256Text } from "./storage.js";
import type {
  AgentPackageStage,
  AgentRoute,
  ProjectEvidenceRequirements,
  ResearchPolicyBinding,
  VerifiedProjectInputPlan,
  WorkspaceConfig,
} from "./types.js";
import { loadWorkspaceConfig, verifyDoctorAttestation } from "./workspace.js";
import { evaluateRequiredResearchCompanions } from "./companion-readiness.js";

export const RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS: Record<AgentRoute["agent"], number> = {
  codex: 5_000,
  claude: 12_000,
  workbuddy: 12_000,
  codebuddy: 12_000,
};
export const RESEARCH_ESTIMATED_BYTES_PER_TOKEN = 3;
export const RESEARCH_MAX_REPAIR_SOURCE_BYTES = 32_000;
export const RESEARCH_CODEX_STRUCTURED_OUTPUT_MAX_TURNS = 2;
export const RESEARCH_CLAUDE_STRUCTURED_OUTPUT_MAX_TURNS = 3;
export const RESEARCH_BROKER_MAX_TURNS = 6;
export const RESEARCH_REPAIR_MAX_TURNS = 1;
export const RESEARCH_PACKET_READ_MAX_TURNS = 64;
// Rough reservation inputs, not corpus, page-count or provider-context limits.
export const RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS = 16_000;
const RESEARCH_PREFLIGHT_PROMPT_ALLOWANCE_TOKENS = 3_000;

export interface EvidenceCoverageGap {
  kind: "capability-unavailable" | "discovery-scope-uncovered";
  requirement: string;
  affectedDimensions: string[];
  affectedSourceTypes: string[];
  alternativeCanSatisfyMinimumCoverage: boolean;
  minimumAction: string;
}

export async function evaluateProjectPreflight(
  root: string,
  question: string,
  requirements: ProjectEvidenceRequirements | null,
  inputPlan: VerifiedProjectInputPlan | null,
  options: {
    publicationPolicy?: ResearchPolicyBinding | null;
    scientificDesign?: VerifiedScientificDesign | null;
    projectMaxCostUsd?: number;
  } = {},
) {
  const config = await loadWorkspaceConfig(root);
  const requestedProjectCost = projectBudgetAmount(options.projectMaxCostUsd);
  const effectiveMaxCostUsd = Math.min(
    config.budget.maxCostUsd,
    requestedProjectCost ?? config.budget.maxCostUsd,
  );
  const capabilities = await loadCapabilityDeclarations(root);
  const capabilityVerification = await verifyCapabilities(root);
  const doctorAttestation =
    config.mode === "production-research" ? await verifyDoctorAttestation(root) : null;
  const companionReadiness = await evaluateRequiredResearchCompanions(
    root,
    requirements?.requiredCompanionIds ?? [],
  );
  const networkCapabilities = capabilities.capabilities
    .filter((capability) => capability.permissions.includes("brokered-network"))
    .map((capability) => ({
      id: capability.id,
      allowedHosts: capability.allowedHosts,
      endpoint: capability.http?.endpoint ?? null,
      accept: capability.http?.accept ?? null,
      maxResponseBytes: capability.http?.maxResponseBytes ?? null,
      maxItems: capability.http?.maxItems ?? null,
      requiredForDiscovery: capability.requiredForDiscovery,
      coverage: capability.coverage,
    }));
  const dataCapabilities = projectResearchDataCapabilities().capabilities.map((capability) => ({
    id: capability.id,
    allowedHosts: [] as string[],
    endpoint: null,
    accept: "application/json",
    maxResponseBytes: null,
    maxItems: null,
    requiredForDiscovery: false,
    coverage: null,
    kind: "data-runtime" as const,
    capabilityId: capability.capabilityId,
    operationId: capability.operationId,
    summary: capability.summary,
    manifestDigest: capability.manifestDigest,
  }));
  const researchCapabilities = [...networkCapabilities, ...dataCapabilities];
  const selectedDataCapabilityIds = new Set(
    (requirements?.requiredCapabilityIds ?? []).filter((capabilityId) =>
      dataCapabilities.some((capability) => capability.id === capabilityId),
    ),
  );
  const hasSelectedDataCapability = selectedDataCapabilityIds.size > 0;
  const discoveryPlan = requirements
    ? deriveDiscoveryPlan(
        requirements,
        config,
        researchCapabilities.map((capability) => capability.id),
      )
    : null;
  const packageTokens = config.budget.packageMaxTokens;
  const tokenReservation = Object.values(packageTokens).reduce((sum, value) => sum + value, 0);
  const wallReservation = Object.values(config.budget.packageMaxWallSeconds).reduce(
    (sum, value) => sum + value,
    0,
  );
  const estimatedMaxCostUsd =
    config.producer.pricing && config.reviewer.pricing
      ? roundMoney(
          reservedAgentPackageCost(config.producer, packageTokens.discover, config) +
            reservedAgentPackageCost(config.producer, packageTokens.acquire, config) +
            reservedAgentPackageCost(config.producer, packageTokens.analyze, config) +
            reservedAgentPackageCost(config.producer, packageTokens.synthesize, config) +
            reservedAgentPackageCost(config.reviewer, packageTokens.review, config),
        )
      : null;
  const lifecycleEnabled = Boolean(options.publicationPolicy);
  const earlyScientificReviewCount = lifecycleEnabled ? 3 : 0;
  const finalPublicationReviewCount = lifecycleEnabled ? 4 : 0;
  const revisionCount = lifecycleEnabled ? 1 : 0;
  const lifecycleTokenReservation =
    tokenReservation +
    earlyScientificReviewCount * config.budget.earlyScientificReviewMaxTokens +
    finalPublicationReviewCount * config.budget.finalPublicationReviewMaxTokens +
    revisionCount * config.budget.revisionReserveTokens;
  const lifecycleWallReservation =
    wallReservation +
    earlyScientificReviewCount * config.budget.earlyScientificReviewMaxWallSeconds +
    finalPublicationReviewCount * config.budget.finalPublicationReviewMaxWallSeconds +
    revisionCount * config.budget.revisionReserveWallSeconds;
  const lifecycleEstimatedMaxCostUsd =
    !lifecycleEnabled || estimatedMaxCostUsd === null
      ? estimatedMaxCostUsd
      : roundMoney(
          estimatedMaxCostUsd +
            earlyScientificReviewCount *
              reservedAgentPackageCost(
                config.reviewer,
                config.budget.earlyScientificReviewMaxTokens,
                config,
              ) +
            finalPublicationReviewCount *
              reservedAgentPackageCost(
                config.reviewer,
                config.budget.finalPublicationReviewMaxTokens,
                config,
              ) +
            revisionCount *
              Math.max(
                reservedAgentPackageCost(
                  config.producer,
                  config.budget.revisionReserveTokens,
                  config,
                ),
                reservedAgentPackageCost(
                  config.reviewer,
                  config.budget.revisionReserveTokens,
                  config,
                ),
              ),
        );
  const gaps: string[] = [];
  const coverageGaps: EvidenceCoverageGap[] = [];
  const designEvaluation = options.scientificDesign
    ? evaluateScientificDesign(options.scientificDesign.contract)
    : null;
  if (options.publicationPolicy && !options.scientificDesign) {
    gaps.push("scientific-design-missing");
  }
  if (options.scientificDesign && !options.publicationPolicy) {
    gaps.push("scientific-design-policy-missing");
  }
  if (
    options.publicationPolicy &&
    options.scientificDesign &&
    options.publicationPolicy.projectId !== options.scientificDesign.contract.projectId
  ) {
    gaps.push("scientific-design-policy-project-mismatch");
  }
  if (
    options.publicationPolicy?.targetJournal &&
    options.scientificDesign &&
    options.publicationPolicy.targetJournal.trim().toLocaleLowerCase("en-US") !==
      options.scientificDesign.contract.identity.targetJournals.primary
        .trim()
        .toLocaleLowerCase("en-US")
  ) {
    gaps.push("scientific-design-policy-journal-mismatch");
  }
  if (designEvaluation) {
    gaps.push(...designEvaluation.issueCodes.map((code) => `scientific-design:${code}`));
  }
  if (options.scientificDesign) {
    const objectIssues = await inspectScientificDesignObjectBindings(
      root,
      options.scientificDesign.contract,
    );
    gaps.push(
      ...objectIssues.map(
        (issue) => `scientific-object:${issue.modelId}:${issue.artifactKind}:${issue.reason}`,
      ),
    );
  }
  if (options.publicationPolicy && options.scientificDesign) {
    appendScientificDesignContractGaps(
      gaps,
      options.scientificDesign.contract,
      options.publicationPolicy,
      requirements,
      new Set(researchCapabilities.map((capability) => capability.id)),
    );
  }
  if (config.mode === "production-research" && !requirements) {
    gaps.push("explicit-evidence-requirements-missing");
  }
  if (config.mode === "production-research" && (!config.producer.model || !config.reviewer.model)) {
    gaps.push("explicit-agent-models-missing");
  }
  if (
    config.mode === "production-research" &&
    (!config.producer.effort || !config.reviewer.effort)
  ) {
    gaps.push("explicit-agent-effort-missing");
  }
  const codexRoute = [config.producer, config.reviewer].find((route) => route.agent === "codex");
  if (config.mode === "production-research" && codexRoute && !codexRoute.verbosity) {
    gaps.push("explicit-codex-verbosity-missing");
  }
  if (
    config.mode === "production-research" &&
    (!config.producer.pricing || !config.reviewer.pricing)
  ) {
    gaps.push("explicit-agent-pricing-missing");
  }
  if (config.producer.agent === config.reviewer.agent) {
    gaps.push("independent-review-route-missing");
  }
  if (!networkCapabilities.length && !hasSelectedDataCapability && !inputPlan) {
    gaps.push("no-evidence-acquisition-plan");
  }
  if (
    config.mode === "production-research" &&
    !hasPublicInternetCapability(capabilities) &&
    !hasSelectedDataCapability
  ) {
    gaps.push("production-public-internet-capability-missing");
  }
  if (capabilityVerification.status !== "verified") {
    gaps.push("capability-lock-missing-or-drifted");
  }
  if (doctorAttestation && doctorAttestation.status !== "verified") {
    gaps.push(`doctor-attestation-${doctorAttestation.status}`);
  }
  gaps.push(...companionReadiness.gaps);
  if (discoveryPlan) {
    gaps.push(...discoveryPlan.constraintGaps.map((gap) => `discovery-plan-constraint:${gap}`));
  }
  if (tokenReservation > config.budget.maxTokens) {
    gaps.push(
      `package-token-reservations-exceed-total:${tokenReservation}/${config.budget.maxTokens}`,
    );
  }
  if (wallReservation > config.budget.maxWallSeconds) {
    gaps.push(
      `package-wall-reservations-exceed-total:${wallReservation}/${config.budget.maxWallSeconds}`,
    );
  }
  if (estimatedMaxCostUsd !== null && estimatedMaxCostUsd > effectiveMaxCostUsd) {
    gaps.push(
      `package-cost-reservations-exceed-total:${estimatedMaxCostUsd}/${effectiveMaxCostUsd}`,
    );
  }
  if (lifecycleEnabled && lifecycleTokenReservation > config.budget.maxTokens) {
    gaps.push(
      `full-lifecycle-token-reservation-exceeds-total:${lifecycleTokenReservation}/${config.budget.maxTokens}`,
    );
  }
  if (lifecycleEnabled && lifecycleWallReservation > config.budget.maxWallSeconds) {
    gaps.push(
      `full-lifecycle-wall-reservation-exceeds-total:${lifecycleWallReservation}/${config.budget.maxWallSeconds}`,
    );
  }
  if (
    lifecycleEnabled &&
    lifecycleEstimatedMaxCostUsd !== null &&
    lifecycleEstimatedMaxCostUsd > effectiveMaxCostUsd
  ) {
    gaps.push(
      `full-lifecycle-cost-reservation-exceeds-total:${lifecycleEstimatedMaxCostUsd}/${effectiveMaxCostUsd}`,
    );
  }
  const discoverOutputTokens =
    discoveryPlan?.recommendedOutputTokens ?? config.budget.maxOutputTokens;
  const stageOutputReservations: Record<AgentPackageStage, number> = {
    discover: discoverOutputTokens,
    acquire: config.budget.maxOutputTokens,
    analyze: config.budget.maxOutputTokens,
    synthesize: config.budget.maxOutputTokens,
    review: config.budget.maxOutputTokens,
  };
  for (const [stage, tokens] of Object.entries(packageTokens)) {
    const outputAndRepairReservation =
      stageOutputReservations[stage as AgentPackageStage] + config.budget.maxRepairTokens;
    if (tokens < outputAndRepairReservation) {
      gaps.push(
        `package-output-repair-reservation-exceeds-${stage}:${outputAndRepairReservation}/${tokens}`,
      );
    }
  }
  const stageContextTokenReservations = {
    acquire: researchStageContextTokenEstimate(config, "acquire"),
    analyze: researchStageContextTokenEstimate(config, "analyze"),
    synthesize: researchStageContextTokenEstimate(config, "synthesize"),
    review: researchStageContextTokenEstimate(config, "review"),
  };
  const producerStructuredOutputMaxTurns = researchStructuredOutputMaxTurns(config.producer);
  const reviewerStructuredOutputMaxTurns = researchStructuredOutputMaxTurns(config.reviewer);
  const embeddedStageContextReservation = stageContextTokenReservations.synthesize;
  const recommendedDiscoverOutputTokens = discoveryPlan?.recommendedOutputTokens ?? null;
  if (
    config.mode === "production-research" &&
    recommendedDiscoverOutputTokens !== null &&
    config.budget.maxOutputTokens < recommendedDiscoverOutputTokens
  ) {
    gaps.push(
      `discover-output-reservation-below-schema-recommendation:${config.budget.maxOutputTokens}/${recommendedDiscoverOutputTokens}`,
    );
  }
  const estimatedInputContextTokens =
    inputPlan?.inputs.reduce(
      (sum, input) => sum + Math.ceil((input.contextBytes ?? input.bytes) / 4),
      0,
    ) ?? 0;
  const maxTurns = {
    // The native producer receives one prepared packet and submits one closeout.
    // Broker fetches are separately bounded CLI operations, not repeated nested
    // agent turns; their complete context allowance is reserved below.
    discover:
      config.producer.executionMode === "native-host" ? 1 : producerStructuredOutputMaxTurns,
    acquire: producerStructuredOutputMaxTurns,
    analyze: producerStructuredOutputMaxTurns,
    synthesize: producerStructuredOutputMaxTurns,
    review: reviewerStructuredOutputMaxTurns,
    repair: RESEARCH_REPAIR_MAX_TURNS,
  };
  const schemaTokens = Object.fromEntries(
    (["discover", "acquire", "analyze", "synthesize", "review"] as const).map((stage) => [
      stage,
      Math.ceil(
        Buffer.byteLength(
          JSON.stringify(
            schemaForStage(
              stage,
              null,
              stage === "discover" && networkCapabilities.length === 0 && !hasSelectedDataCapability
                ? { inputOnlyProvenanceIds: inputPlan?.inputs.map((input) => input.id) ?? [] }
                : {},
            ),
          ),
          "utf8",
        ) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
      ),
    ]),
  ) as Record<AgentPackageStage, number>;
  const capabilityDocumentationReservation = researchCapabilities.length
    ? config.budget.maxInputContextTokens
    : 0;
  const preCallTokenReservations = {
    discover: estimatedStageTokenReservation(
      config.producer,
      Math.min(estimatedInputContextTokens, 8_000) +
        Math.min(capabilityDocumentationReservation, 8_000),
      schemaTokens.discover,
      maxTurns.discover,
      config,
      config.budget.maxBrokerContextTokens *
        (discoveryPlan?.maxCalls ?? config.budget.maxBrokerCalls),
      discoverOutputTokens,
    ),
    acquire: estimatedStageTokenReservation(
      config.producer,
      stageContextTokenReservations.acquire,
      schemaTokens.acquire,
      producerStructuredOutputMaxTurns,
      config,
    ),
    analyze: estimatedStageTokenReservation(
      config.producer,
      stageContextTokenReservations.analyze,
      schemaTokens.analyze,
      producerStructuredOutputMaxTurns,
      config,
    ),
    synthesize: estimatedStageTokenReservation(
      config.producer,
      stageContextTokenReservations.synthesize,
      schemaTokens.synthesize,
      producerStructuredOutputMaxTurns,
      config,
    ),
    review: estimatedStageTokenReservation(
      config.reviewer,
      stageContextTokenReservations.review,
      schemaTokens.review,
      reviewerStructuredOutputMaxTurns,
      config,
      RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS,
    ),
  };
  for (const [stage, reservation] of Object.entries(preCallTokenReservations)) {
    const configured = packageTokens[stage as AgentPackageStage];
    if (reservation > configured) {
      gaps.push(`package-precall-reservation-exceeds-${stage}:${reservation}/${configured}`);
    }
  }
  if (requirements) {
    appendEvidencePlanGaps(gaps, coverageGaps, requirements, inputPlan, [
      ...networkCapabilities,
      ...dataCapabilities.filter((capability) => selectedDataCapabilityIds.has(capability.id)),
    ]);
  }
  const result = {
    schemaVersion: 1 as const,
    mode: config.mode,
    questionSha256: sha256Text(question),
    evidenceRequirements: requirements,
    scientificDesign:
      options.scientificDesign === null || options.scientificDesign === undefined
        ? null
        : {
            sha256: options.scientificDesign.sha256,
            projectId: options.scientificDesign.contract.projectId,
            evaluation: designEvaluation,
          },
    capabilities: researchCapabilities,
    inputPlan:
      inputPlan === null
        ? null
        : {
            sha256: inputPlan.sha256,
            inputs: inputPlan.inputs.map((input) => ({
              id: input.id,
              role: input.role,
              sha256: input.sha256,
              bytes: input.bytes,
              contextSha256: input.contextSha256,
              contextBytes: input.contextBytes,
              contextRanges: input.contextRanges ?? null,
              dimensions: input.dimensions,
              sourceType: input.sourceType,
              fullText: input.fullText,
              publicationDate: input.publicationDate,
            })),
          },
    capabilityVerification,
    doctorAttestation:
      doctorAttestation === null
        ? null
        : {
            status: doctorAttestation.status,
            errors: doctorAttestation.errors,
            attestationSha256: doctorAttestation.attestation?.attestationSha256 ?? null,
            checkedAt: doctorAttestation.attestation?.checkedAt ?? null,
            expiresAt: doctorAttestation.attestation?.expiresAt ?? null,
          },
    companionReadiness,
    gaps,
    coverageGaps,
    budget: {
      tokenReservation,
      wallReservation,
      maxTokens: config.budget.maxTokens,
      maxCostUsd: effectiveMaxCostUsd,
      workspaceMaxCostUsd: config.budget.maxCostUsd,
      projectMaxCostUsd: requestedProjectCost ?? null,
      maxWallSeconds: config.budget.maxWallSeconds,
      packageMaxTokens: config.budget.packageMaxTokens,
      confirmationCostUsd: config.budget.confirmationCostUsd,
      confirmationRequired: effectiveMaxCostUsd > config.budget.confirmationCostUsd,
      estimatedMaxCostUsd,
      maxBrokerContextTokens: config.budget.maxBrokerContextTokens,
      maxBrokerCalls: config.budget.maxBrokerCalls,
      plannedBrokerCalls: discoveryPlan?.maxCalls ?? config.budget.maxBrokerCalls,
      maxOutputTokens: config.budget.maxOutputTokens,
      maxRepairTokens: config.budget.maxRepairTokens,
      estimatedInputContextTokens,
      maxInputContextTokens: config.budget.maxInputContextTokens,
      inputContextTokenLimit: null,
      contextReservationBasis: "initial-inline-plus-on-demand-estimate",
      estimatedReviewReadTokens: RESEARCH_EXPECTED_ARTIFACT_READ_TOKENS,
      reviewerTurnLimit: config.reviewer.agent === "claude" ? RESEARCH_PACKET_READ_MAX_TURNS : null,
      embeddedStageContextReservation,
      stageContextTokenReservations,
      recommendedDiscoverOutputTokens,
      discoveryPlan,
      outputTokenLimitEnforcement: {
        producer: "reserved-native-host-on-submit",
        reviewer: "post-execution",
      },
      preCallTokenReservations,
      maxTurns,
      lifecycleReservation: {
        enabled: lifecycleEnabled,
        reviewCounts: {
          earlyScientific: earlyScientificReviewCount,
          finalPublication: finalPublicationReviewCount,
          revisions: revisionCount,
        },
        phaseTokens: {
          baseResearch: tokenReservation,
          earlyScientificReviews:
            earlyScientificReviewCount * config.budget.earlyScientificReviewMaxTokens,
          finalPublicationReviews:
            finalPublicationReviewCount * config.budget.finalPublicationReviewMaxTokens,
          revision: revisionCount * config.budget.revisionReserveTokens,
        },
        phaseWallSeconds: {
          baseResearch: wallReservation,
          earlyScientificReviews:
            earlyScientificReviewCount * config.budget.earlyScientificReviewMaxWallSeconds,
          finalPublicationReviews:
            finalPublicationReviewCount * config.budget.finalPublicationReviewMaxWallSeconds,
          revision: revisionCount * config.budget.revisionReserveWallSeconds,
        },
        totalTokens: lifecycleTokenReservation,
        totalWallSeconds: lifecycleWallReservation,
        estimatedMaxCostUsd: lifecycleEstimatedMaxCostUsd,
      },
    },
    executionPolicy: {
      producer: {
        agent: config.producer.agent,
        executionMode: config.producer.executionMode,
        model: config.producer.model,
        effort: config.producer.effort ?? null,
        verbosity: config.producer.verbosity ?? null,
        wrapperTargetPinned: Boolean(config.producer.wrapperTargetBinary),
        turnLimitEnforcement: "native-host-instruction-and-reserved-accounting",
      },
      reviewer: {
        agent: config.reviewer.agent,
        executionMode: config.reviewer.executionMode,
        transport: config.reviewerExecution.transport,
        isolationProvider: config.reviewerExecution.isolationProvider,
        model: config.reviewer.model,
        effort: config.reviewer.effort ?? null,
        verbosity: config.reviewer.verbosity ?? null,
        wrapperTargetPinned: Boolean(config.reviewer.wrapperTargetBinary),
        turnLimitEnforcement:
          config.reviewer.agent === "claude" ? "provider" : "reservation-and-post-execution",
      },
    },
    readyToInitialize:
      capabilityVerification.status === "verified" &&
      (config.mode === "smoke-test" || Boolean(requirements)) &&
      gaps.length === 0,
  };
  return { ...result, preflightSha256: sha256Text(canonicalJson(result)) };
}

export function researchStructuredOutputMaxTurns(route: Pick<AgentRoute, "agent">): number {
  return route.agent === "claude"
    ? RESEARCH_CLAUDE_STRUCTURED_OUTPUT_MAX_TURNS
    : RESEARCH_CODEX_STRUCTURED_OUTPUT_MAX_TURNS;
}

/** Legacy-named planning estimate, not a stage admission or corpus-length limit. */
export function researchStageContextTokenEstimate(
  config: Pick<WorkspaceConfig, "budget">,
  stage: AgentPackageStage | "close",
  addendum = false,
): number {
  if (stage === "close" || (stage === "discover" && !addendum)) return 0;
  return Math.min(config.budget.maxInputContextTokens, 8_000) * (stage === "review" ? 3 : 1);
}

function estimatedStageTokenReservation(
  route: AgentRoute,
  embeddedContextTokens: number,
  schemaTokens: number,
  primaryMaxTurns: number,
  config: WorkspaceConfig,
  potentialToolContextTokens = 0,
  maxOutputTokens = config.budget.maxOutputTokens,
): number {
  return calculateAgentCallTokenReservation({
    route,
    primaryPayloadTokens:
      embeddedContextTokens + schemaTokens + RESEARCH_PREFLIGHT_PROMPT_ALLOWANCE_TOKENS,
    repairPayloadTokens:
      schemaTokens +
      Math.ceil((RESEARCH_MAX_REPAIR_SOURCE_BYTES + 2_048) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN),
    maxTurns: primaryMaxTurns,
    maxOutputTokens,
    maxToolContextTokens: potentialToolContextTokens,
    maxRepairTokens: config.budget.maxRepairTokens,
    reserveRepair: true,
  }).totalTokens;
}

export function calculateAgentCallTokenReservation(input: {
  route: Pick<AgentRoute, "agent">;
  primaryPayloadTokens: number;
  repairPayloadTokens: number;
  maxTurns: number;
  maxOutputTokens: number;
  maxToolContextTokens: number;
  maxRepairTokens: number;
  reserveRepair: boolean;
  alreadyUsedTokens?: number;
}) {
  const protocolOverhead = RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS[input.route.agent];
  const alreadyUsedTokens = input.alreadyUsedTokens ?? 0;
  const estimatedCallInputTokensPerTurn = protocolOverhead + input.primaryPayloadTokens;
  const estimatedCallInputTokens = estimatedCallInputTokensPerTurn * input.maxTurns;
  const potentialRepairTokens = input.reserveRepair
    ? (protocolOverhead + input.repairPayloadTokens) * RESEARCH_REPAIR_MAX_TURNS +
      input.maxRepairTokens
    : 0;
  return {
    alreadyUsedTokens,
    maxTurns: input.maxTurns,
    estimatedCallInputTokensPerTurn,
    estimatedCallInputTokens,
    outputTokens: input.maxOutputTokens,
    potentialToolContextTokens: input.maxToolContextTokens,
    potentialRepairTokens,
    totalTokens:
      alreadyUsedTokens +
      estimatedCallInputTokens +
      input.maxToolContextTokens +
      input.maxOutputTokens +
      potentialRepairTokens,
  };
}

export function reservedAgentPackageCost(
  route: AgentRoute,
  tokens: number,
  config: Pick<WorkspaceConfig, "budget">,
): number {
  if (!route.pricing) return 0;
  const maximumOutputTokens = Math.min(
    tokens,
    config.budget.maxOutputTokens + config.budget.maxRepairTokens,
  );
  const maximumInputTokens = Math.max(0, tokens - maximumOutputTokens);
  const inputRate = Math.max(
    route.pricing.inputUsdPerMillionTokens,
    route.pricing.cachedInputUsdPerMillionTokens,
  );
  return (
    (maximumInputTokens * inputRate +
      maximumOutputTokens * route.pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

function appendEvidencePlanGaps(
  gaps: string[],
  coverageGaps: EvidenceCoverageGap[],
  requirements: ProjectEvidenceRequirements,
  inputPlan: VerifiedProjectInputPlan | null,
  networkCapabilities: Array<{
    id: string;
    coverage: {
      dimensions: string[];
      sourceTypes: string[];
      discoveryScopes: string[];
      fullText: boolean;
      publicationDates: boolean;
    } | null;
  }>,
): void {
  const capabilityIds = new Set(networkCapabilities.map((capability) => capability.id));
  for (const requiredCapabilityId of requirements.requiredCapabilityIds ?? []) {
    if (capabilityIds.has(requiredCapabilityId)) continue;
    gaps.push(`evidence-plan-capability-unavailable:${requiredCapabilityId}`);
    coverageGaps.push({
      kind: "capability-unavailable",
      requirement: requiredCapabilityId,
      affectedDimensions: [...requirements.dimensions],
      affectedSourceTypes: [...requirements.sourceTypes],
      alternativeCanSatisfyMinimumCoverage: false,
      minimumAction: capabilityMinimumAction(requiredCapabilityId),
    });
  }
  const discoveryScopes = new Set(
    networkCapabilities.flatMap((capability) => capability.coverage?.discoveryScopes ?? []),
  );
  for (const requiredDiscoveryScope of requirements.requiredDiscoveryScopes ?? []) {
    if (discoveryScopes.has(requiredDiscoveryScope)) continue;
    gaps.push(`evidence-plan-discovery-scope-uncovered:${requiredDiscoveryScope}`);
    coverageGaps.push({
      kind: "discovery-scope-uncovered",
      requirement: requiredDiscoveryScope,
      affectedDimensions: [...requirements.dimensions],
      affectedSourceTypes: [...requirements.sourceTypes],
      alternativeCanSatisfyMinimumCoverage: false,
      minimumAction:
        "Have the workspace owner select or import a reviewed capability that declares this exact discovery scope, configure its logical credential and license, rebuild the capability lock, and pass live doctor before initializing the project.",
    });
  }
  const declaredCoverage = networkCapabilities.flatMap((capability) =>
    capability.coverage ? [capability.coverage] : [],
  );
  const dimensions = new Set([
    ...declaredCoverage.flatMap((coverage) => coverage.dimensions),
    ...(inputPlan?.inputs.flatMap((input) => input.dimensions) ?? []),
  ]);
  const sourceTypes = new Set([
    ...declaredCoverage.flatMap((coverage) => coverage.sourceTypes),
    ...(inputPlan?.inputs.map((input) => input.sourceType) ?? []),
  ]);
  for (const dimension of requirements.dimensions) {
    if (!dimensions.has("*") && !dimensions.has(dimension)) {
      gaps.push(`evidence-plan-dimension-uncovered:${dimension}`);
    }
  }
  for (const sourceType of requirements.sourceTypes) {
    if (!sourceTypes.has("*") && !sourceTypes.has(sourceType)) {
      gaps.push(`evidence-plan-source-type-uncovered:${sourceType}`);
    }
  }
  const canDiscoverFullText = declaredCoverage.some((coverage) => coverage.fullText);
  const canDiscoverDates = declaredCoverage.some((coverage) => coverage.publicationDates);
  const plannedInputCount = inputPlan?.inputs.length ?? 0;
  const plannedFullTextCount = inputPlan?.inputs.filter((input) => input.fullText).length ?? 0;
  const plannedDatedCount =
    inputPlan?.inputs.filter(
      (input) =>
        input.publicationDate !== null &&
        (requirements.publicationDateFrom === null ||
          input.publicationDate >= requirements.publicationDateFrom) &&
        (requirements.publicationDateTo === null ||
          input.publicationDate <= requirements.publicationDateTo),
    ).length ?? 0;
  if (!networkCapabilities.length && plannedInputCount < requirements.minSources) {
    gaps.push(
      `evidence-plan-min-sources-insufficient:${plannedInputCount}/${requirements.minSources}`,
    );
  }
  if (requirements.minFullTextSources > plannedFullTextCount && !canDiscoverFullText) {
    gaps.push(
      `evidence-plan-full-text-insufficient:${plannedFullTextCount}/${requirements.minFullTextSources}`,
    );
  }
  if (requirements.minDatedSources > plannedDatedCount && !canDiscoverDates) {
    gaps.push(
      `evidence-plan-dated-sources-insufficient:${plannedDatedCount}/${requirements.minDatedSources}`,
    );
  }
}

function appendScientificDesignContractGaps(
  gaps: string[],
  design: ScientificDesignContract,
  policy: ResearchPolicyBinding,
  requirements: ProjectEvidenceRequirements | null,
  availableCapabilityIds: Set<string>,
): void {
  const prefix = "scientific-design-contract:";
  gaps.push(...scientificDesignPolicyGaps(design, policy).map((gap) => `${prefix}${gap}`));
  if (policy.targetJournal) {
    if (design.identity.targetJournals.approvalStatus !== "policy-approved") {
      gaps.push(`${prefix}policy-journal-unapproved`);
    }
  } else if (design.identity.targetJournals.approvalStatus !== "candidate-only") {
    gaps.push(`${prefix}policy-journal-approval-unbound`);
  }

  const requiredRoles = design.evidenceRoles.filter((role) => role.required);
  const requiredRoleIds = new Set(requiredRoles.map((role) => role.id));
  const requiredBrokerRoutes = design.acquisitionPlan.routes.filter(
    (route) =>
      route.required &&
      route.executor === "agent" &&
      route.routeClass === "broker-capability" &&
      route.evidenceRoleIds.some((roleId) => requiredRoleIds.has(roleId)),
  );
  for (const route of requiredBrokerRoutes) {
    if (route.capabilityId && !availableCapabilityIds.has(route.capabilityId)) {
      gaps.push(`${prefix}acquisition-capability-unavailable:${route.id}:${route.capabilityId}`);
    }
  }
  if (requirements) {
    const mappedCapabilityIds = new Set(
      requiredBrokerRoutes.flatMap((route) => (route.capabilityId ? [route.capabilityId] : [])),
    );
    for (const capabilityId of requirements.requiredCapabilityIds ?? []) {
      if (!mappedCapabilityIds.has(capabilityId)) {
        gaps.push(`${prefix}required-capability-route-unmapped:${capabilityId}`);
      }
    }
    const mappedDimensions = new Set(requiredRoles.flatMap((role) => role.coverageDimensionIds));
    const mappedSourceTypes = new Set(
      requiredRoles.flatMap((role) => declaredSourceTypes(role.sourceTypeRequirements)),
    );
    for (const dimension of requirements.dimensions) {
      if (!mappedDimensions.has(dimension)) {
        gaps.push(`${prefix}evidence-dimension-uncovered:${dimension}`);
      }
    }
    for (const sourceType of requirements.sourceTypes) {
      if (!mappedSourceTypes.has(sourceType)) {
        gaps.push(`${prefix}evidence-source-type-uncovered:${sourceType}`);
      }
    }
    const independentFloor = requiredRoles.reduce(
      (sum, role) => sum + role.minimumIndependentSources,
      0,
    );
    const fullTextFloor = requiredRoles.reduce((sum, role) => sum + role.minimumFullText, 0);
    const datedFloor = requiredRoles.reduce((sum, role) => sum + role.minimumDatedSources, 0);
    if (independentFloor < requirements.minSources) {
      gaps.push(
        `${prefix}evidence-source-floor-insufficient:${independentFloor}/${requirements.minSources}`,
      );
    }
    if (fullTextFloor < requirements.minFullTextSources) {
      gaps.push(
        `${prefix}evidence-fulltext-floor-insufficient:${fullTextFloor}/${requirements.minFullTextSources}`,
      );
    }
    if (datedFloor < requirements.minDatedSources) {
      gaps.push(
        `${prefix}evidence-dated-floor-insufficient:${datedFloor}/${requirements.minDatedSources}`,
      );
    }
  }

  if (policy.resolvedRules.includes("independent-validation-required")) {
    const centralClaimIds = new Set(
      design.claims.filter((claim) => claim.role === "central").map((claim) => claim.id),
    );
    const centralPlans = design.validationPlans.filter((plan) =>
      plan.claimIds.some((claimId) => centralClaimIds.has(claimId)),
    );
    for (const plan of centralPlans) {
      if (!["available", "unavailable-scope-bounded"].includes(plan.independentValidation.status)) {
        gaps.push(`${prefix}independent-validation-undispositioned:${plan.id}`);
      }
    }
    for (const claimId of centralClaimIds) {
      if (!centralPlans.some((plan) => plan.claimIds.includes(claimId))) {
        gaps.push(`${prefix}independent-validation-unplanned:${claimId}`);
      }
    }
  }
}

function capabilityMinimumAction(capabilityId: string): string {
  if (capabilityId === "database.tiangong.report-search") {
    return "Rerun the setup Wizard, select tiangong.kb-report-search, review its license and exact endpoint, securely configure tiangong.report.api-key, apply the replacement immutable plan, and pass capability live doctor.";
  }
  if (capabilityId === "database.tiangong.patent-search") {
    return "Rerun the setup Wizard, select tiangong.kb-patent-search, review its license and exact endpoint, securely configure tiangong.patent.api-key, apply the replacement immutable plan, and pass capability live doctor.";
  }
  if (capabilityId === "database.tiangong.sci-search") {
    return "Rerun the setup Wizard, select tiangong.kb-sci-search, review its license and exact endpoint, securely configure tiangong.sci.api-key, apply the replacement immutable plan, and pass capability live doctor.";
  }
  return "Have the workspace owner select or import the exact reviewed capability, configure its logical credential and license, rebuild the capability lock, and pass live doctor before initializing the project.";
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

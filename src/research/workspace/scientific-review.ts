import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { scientificAmendmentLocator } from "./scientific-amendment.js";
import { CliError } from "../../errors.js";
import { taskContext } from "./task-contract.js";
import { nativeRunArtifactRecords } from "./native-run.js";
import { loadEvidenceArtifactRecords } from "./artifacts.js";
import { sourceTypeRequirementGaps } from "./evidence-role-coverage.js";
import { appendJournalEvent, verifyJournal } from "./journal.js";
import { loadProject, nextScientificGate, saveProject } from "./projects.js";
import { projectWithEffectiveAuthority, readProjectAuthorityIndex } from "./project-authority.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import {
  evaluateScientificDesign,
  parseScientificDesign,
  scientificDesignPolicyGaps,
  type ScientificDesignContract,
} from "./scientific-design.js";
import { resolveScientificObjectBinding, type ScientificObjectKind } from "./scientific-objects.js";
import {
  loadScientificFulfillmentView,
  scientificFulfillmentLocator,
} from "./scientific-fulfillment.js";
import { sanitizeResearchValue } from "./sanitization.js";
import {
  canonicalJson,
  fileRecord,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeBytesAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type {
  AgentKind,
  ProjectState,
  ScientificReviewRole,
  ScientificGateStatus,
} from "./types.js";
import { loadWorkspaceConfig, verifyDoctorAttestation, withWorkspaceLock } from "./workspace.js";

const MAX_SCIENTIFIC_REVIEW_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = "^[a-f0-9]{64}$";

type ReviewDisposition = "pass" | "revise" | "stop" | "handoff";

interface ScientificFinding {
  code: string;
  severity: "blocking" | "warning" | "note";
  message: string;
  evidenceIds: string[];
}

interface ResearchDesignAssessment {
  schemaVersion: 1;
  role: "research-design";
  designSha256: string;
  recommendation: ReviewDisposition;
  checks: {
    identityCoherent: boolean;
    estimandObservable: boolean;
    claimGraphComplete: boolean;
    endpointTruthRolesCorrect: boolean;
    quantityOntologyComplete: boolean;
    validationSemanticsCorrect: boolean;
    knownGapDispositionComplete: boolean;
    lifecycleFeasible: boolean;
  };
  findings: ScientificFinding[];
}

interface EvidenceConstructAssessment {
  schemaVersion: 1;
  role: "evidence-construct";
  designSha256: string;
  recommendation: ReviewDisposition;
  constructCanary: {
    usesRealRecords: boolean;
    outcomeBlind: boolean;
    resultValuesInspected: boolean;
    rowCount: number;
    constructedEdgeIds: string[];
    failedEdgeIds: string[];
    artifactSha256s: string[];
  };
  evidenceRoleCoverage: Array<{
    roleId: string;
    fullTextSourceIds: string[];
    independentSourceIds: string[];
    datedSourceIds: string[];
    peerReviewedSourceIds: string[];
    dimensionIds: string[];
    sourceTypes: string[];
  }>;
  closestWorkDispositionComplete: boolean;
  centralEvidenceFitsContext: boolean;
  findings: ScientificFinding[];
}

interface PilotMethodsAssessment {
  schemaVersion: 1;
  role: "pilot-methods";
  designSha256: string;
  recommendation: ReviewDisposition;
  checks: {
    noDataLeakage: boolean;
    noCircularValidation: boolean;
    endpointComparisonsCompatible: boolean;
    baselineFair: boolean;
    unitsAndDenominatorsVerified: boolean;
    thresholdsTyped: boolean;
    decisionLossMetricsComputed: boolean;
  };
  validationAudits: Array<{
    validationPlanId: string;
    outcomeBlind: boolean;
    originalUnitCount: number;
    independentClusterCount: number;
    effectiveIndependentUnits: number;
    clusterKeyIds: string[];
    independenceJustification: string;
    resamplingUnit: string;
    resamplingIterations: number;
    resamplingMethod: "exact-enumeration" | "cluster-bootstrap" | "none";
    resamplingStateSpaceSize: number;
    reportingPrecision: string;
    minimumDetectableDifference: string | null;
    independentValidationStatus:
      | "available"
      | "planned"
      | "unavailable-scope-bounded"
      | "not-required";
    independentValidationGapId: string | null;
  }>;
  decisionLossMetricIds: string[];
  findings: ScientificFinding[];
}

type ScientificGateAssessment =
  | ResearchDesignAssessment
  | EvidenceConstructAssessment
  | PilotMethodsAssessment;

interface ScientificReview {
  schemaVersion: 1;
  role: ScientificReviewRole;
  packetSha256: string;
  reviewerSessionSha256: string;
  decision: ReviewDisposition;
  findings: ScientificFinding[];
  boundedRecommendation: string;
}

interface ScientificMechanicalIssue {
  code: string;
  message: string;
  objectIds: string[];
}

interface EvidenceConstructSource {
  id: string;
  sourceType: string | null;
  publicationDate: string | null;
  fullTextAvailable: boolean;
  coverageDimensions: string[];
}

interface EvidenceConstructContext {
  sources: Map<string, EvidenceConstructSource>;
  canaryArtifactSha256s: Set<string>;
  contentGate: { decision: "pass" | "stop"; reasons: string[] } | null;
  contentRoleSourceIds: Map<string, Set<string>>;
}

interface ScientificFutureGateObligation {
  code:
    | "UNCERTAINTY_STATE_VALUES_NOT_FROZEN"
    | "MODEL_IMPLEMENTATION_NOT_FROZEN"
    | "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN"
    | "POLICY_RULE_DUE_UNRESOLVED";
  dueGate: "evidence-construct" | "pilot-methods" | "publication-freeze";
  objectIds: string[];
  policyRuleIds: string[];
}

interface ScientificReviewStageInput {
  path: string;
  sha256: string;
  bytes: number;
  purpose:
    | "construct-canary"
    | "inherited-gap"
    | "model-implementation"
    | "model-environment-lock"
    | "scientific-fulfillment"
    | "scientific-amendment"
    | "effective-scientific-design"
    | "original-request-source"
    | "native-calculation"
    | "acquired-evidence"
    | "stage-output";
  ownerId: string;
  sourceLocator: string;
  hashBasis: "raw-file-bytes";
  mediaType: string;
  objectKind: ScientificObjectKind | null;
  registrationRecordSha256: string | null;
}

export interface ScientificReviewPacket {
  schemaVersion: 1;
  kind: "tiangong-scientific-review-packet";
  projectId: string;
  role: ScientificReviewRole;
  design: {
    sha256: string;
    objectLocator: string;
    fulfillment?: { headSha256: string | null; effectiveSha256: string };
    amendmentSha256?: string | null;
  };
  policy: {
    resolvedPolicySha256: string;
    approvalSha256: string;
    targetJournal: string | null;
    bindingSha256: string;
    objectLocator: string;
  };
  reviewer: {
    agent: AgentKind;
    sessionSha256: string;
  };
  preparedAt: string;
  stageInputs: ScientificReviewStageInput[];
  taskContract: Awaited<ReturnType<typeof taskContext>>;
  assessment: {
    sha256: string;
    objectLocator: string;
  };
  mechanicalAssessment: {
    canPass: boolean;
    issueCodes: string[];
    issues: ScientificMechanicalIssue[];
    futureGateObligations: ScientificFutureGateObligation[];
    designEvaluation: {
      readyForDesignReview: boolean;
      issueCodes: string[];
      effectiveIndependentUnits: number;
      requiredEvidenceRoles: number;
    };
  };
  lifecycle: {
    producerExecution: "native-host-app";
    baseStages: Array<"discover" | "acquire" | "analyze" | "synthesize" | "review" | "close">;
    earlyScientificReviews: ScientificReviewRole[];
    finalPublicationReviews: string[];
    finalManuscriptFreezeRequired: true;
    newGenerationOnMaterialChange: true;
    revisionReserveIncluded: true;
  };
  instructions: string[];
  packetSha256: string;
}

export interface ScientificReviewStatus {
  projectId: string;
  reviewState: "not-required" | "awaiting-review" | "revision-required" | "stopped" | "complete";
  nextGate: ReturnType<typeof nextScientificGate>;
  gates: NonNullable<ProjectState["scientificDesign"]>["gates"] | null;
}

interface ReviewerSessionRegistry {
  schemaVersion: 1;
  sessions: Array<{
    sessionSha256: string;
    role: ScientificReviewRole;
    agent: AgentKind;
    packetSha256: string;
    usedAt: string;
  }>;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const assessmentValidators = new Map<ScientificReviewRole, ValidateFunction>();
const reviewValidators = new Map<ScientificReviewRole, ValidateFunction>();

export function scientificGateAssessmentSchema(
  role: ScientificReviewRole,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    schemaVersion: { const: 1 },
    role: { const: role },
    designSha256: { type: "string", pattern: SHA256_PATTERN },
    recommendation: { enum: ["pass", "revise", "stop", "handoff"] },
    findings: findingsSchema(),
  };
  let roleRequired: string[];
  if (role === "research-design") {
    properties.checks = closedObject(
      [
        "identityCoherent",
        "estimandObservable",
        "claimGraphComplete",
        "endpointTruthRolesCorrect",
        "quantityOntologyComplete",
        "validationSemanticsCorrect",
        "knownGapDispositionComplete",
        "lifecycleFeasible",
      ],
      {
        identityCoherent: { type: "boolean" },
        estimandObservable: { type: "boolean" },
        claimGraphComplete: { type: "boolean" },
        endpointTruthRolesCorrect: { type: "boolean" },
        quantityOntologyComplete: { type: "boolean" },
        validationSemanticsCorrect: { type: "boolean" },
        knownGapDispositionComplete: { type: "boolean" },
        lifecycleFeasible: { type: "boolean" },
      },
    );
    roleRequired = ["checks"];
  } else if (role === "evidence-construct") {
    properties.constructCanary = closedObject(
      [
        "usesRealRecords",
        "outcomeBlind",
        "resultValuesInspected",
        "rowCount",
        "constructedEdgeIds",
        "failedEdgeIds",
        "artifactSha256s",
      ],
      {
        usesRealRecords: { type: "boolean" },
        outcomeBlind: { type: "boolean" },
        resultValuesInspected: { type: "boolean" },
        rowCount: { type: "integer", minimum: 0 },
        constructedEdgeIds: stringSetSchema(),
        failedEdgeIds: stringSetSchema(),
        artifactSha256s: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: SHA256_PATTERN },
        },
      },
    );
    properties.evidenceRoleCoverage = {
      type: "array",
      items: closedObject(
        [
          "roleId",
          "fullTextSourceIds",
          "independentSourceIds",
          "datedSourceIds",
          "peerReviewedSourceIds",
          "dimensionIds",
          "sourceTypes",
        ],
        {
          roleId: boundedStringSchema(),
          fullTextSourceIds: stringSetSchema(),
          independentSourceIds: stringSetSchema(),
          datedSourceIds: stringSetSchema(),
          peerReviewedSourceIds: stringSetSchema(),
          dimensionIds: stringSetSchema(),
          sourceTypes: stringSetSchema(),
        },
      ),
    };
    properties.closestWorkDispositionComplete = { type: "boolean" };
    properties.centralEvidenceFitsContext = { type: "boolean" };
    roleRequired = [
      "constructCanary",
      "evidenceRoleCoverage",
      "closestWorkDispositionComplete",
      "centralEvidenceFitsContext",
    ];
  } else {
    properties.checks = closedObject(
      [
        "noDataLeakage",
        "noCircularValidation",
        "endpointComparisonsCompatible",
        "baselineFair",
        "unitsAndDenominatorsVerified",
        "thresholdsTyped",
        "decisionLossMetricsComputed",
      ],
      {
        noDataLeakage: { type: "boolean" },
        noCircularValidation: { type: "boolean" },
        endpointComparisonsCompatible: { type: "boolean" },
        baselineFair: { type: "boolean" },
        unitsAndDenominatorsVerified: { type: "boolean" },
        thresholdsTyped: { type: "boolean" },
        decisionLossMetricsComputed: { type: "boolean" },
      },
    );
    properties.validationAudits = {
      type: "array",
      minItems: 1,
      items: closedObject(
        [
          "validationPlanId",
          "outcomeBlind",
          "originalUnitCount",
          "independentClusterCount",
          "effectiveIndependentUnits",
          "clusterKeyIds",
          "independenceJustification",
          "resamplingUnit",
          "resamplingIterations",
          "resamplingMethod",
          "resamplingStateSpaceSize",
          "reportingPrecision",
          "minimumDetectableDifference",
          "independentValidationStatus",
          "independentValidationGapId",
        ],
        {
          validationPlanId: boundedStringSchema(),
          outcomeBlind: { type: "boolean" },
          originalUnitCount: { type: "integer", minimum: 0 },
          independentClusterCount: { type: "integer", minimum: 0 },
          effectiveIndependentUnits: { type: "number", minimum: 0 },
          clusterKeyIds: stringSetSchema(),
          independenceJustification: boundedStringSchema(),
          resamplingUnit: boundedStringSchema(),
          resamplingIterations: { type: "integer", minimum: 0 },
          resamplingMethod: { enum: ["exact-enumeration", "cluster-bootstrap", "none"] },
          resamplingStateSpaceSize: { type: "integer", minimum: 0 },
          reportingPrecision: boundedStringSchema(),
          minimumDetectableDifference: { type: ["string", "null"] },
          independentValidationStatus: {
            enum: ["available", "planned", "unavailable-scope-bounded", "not-required"],
          },
          independentValidationGapId: { type: ["string", "null"] },
        },
      ),
    };
    properties.decisionLossMetricIds = stringSetSchema();
    roleRequired = ["checks", "validationAudits", "decisionLossMetricIds"];
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "role",
      "designSha256",
      "recommendation",
      ...roleRequired,
      "findings",
    ],
    properties,
  };
}

export function scientificReviewSchema(role: ScientificReviewRole): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "role",
      "packetSha256",
      "reviewerSessionSha256",
      "decision",
      "findings",
      "boundedRecommendation",
    ],
    properties: {
      schemaVersion: { const: 1 },
      role: { const: role },
      packetSha256: { type: "string", pattern: SHA256_PATTERN },
      reviewerSessionSha256: { type: "string", pattern: SHA256_PATTERN },
      decision: { enum: ["pass", "revise", "stop", "handoff"] },
      findings: findingsSchema(),
      boundedRecommendation: { type: "string", minLength: 1, maxLength: 8000 },
    },
  };
}

export async function prepareScientificReview(input: {
  root: string;
  projectId: string;
  role: ScientificReviewRole;
  assessmentPath: string;
  reviewerAgent: AgentKind;
  reviewerSessionId: string;
  canaryArtifactPaths?: string[];
}): Promise<ScientificReviewPacket> {
  return withWorkspaceLock(input.root, "research.scientific-review.prepare", async () => {
    const paths = workspacePaths(input.root);
    await verifyJournal(paths.journal);
    const [config, project] = await Promise.all([
      loadWorkspaceConfig(input.root),
      loadProject(input.root, input.projectId),
    ]);
    if (!project.scientificDesign || !project.publicationPolicy) {
      throw scientificGateError("This project does not have a scientific design review route.");
    }
    const next = nextScientificGate(project);
    if (!next || next.role !== input.role) {
      throw new CliError("Scientific review role is not the next blocking gate.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_ORDER_INVALID",
        exitCode: 3,
        details: { requestedRole: input.role, nextRole: next?.role ?? null },
      });
    }
    if (!["pending", "revision-required"].includes(next.status)) {
      throw new CliError("The current scientific gate already has an active review packet.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_STATE_INVALID",
        exitCode: 3,
        details: { role: input.role, status: next.status },
      });
    }
    if (config.reviewer.agent !== input.reviewerAgent) {
      throw new CliError("Scientific review must use the configured independent reviewer route.", {
        code: "RESEARCH_SCIENTIFIC_REVIEWER_MISMATCH",
        exitCode: 3,
        details: {
          configuredReviewer: config.reviewer.agent,
          requestedReviewer: input.reviewerAgent,
        },
      });
    }
    if (input.reviewerAgent === project.scientificDesign.producer.agent) {
      throw new CliError("Scientific review must use a different agent family from the producer.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_NOT_INDEPENDENT",
        exitCode: 3,
      });
    }
    const sessionId = input.reviewerSessionId.trim();
    if (!sessionId) {
      throw new CliError("Scientific review requires an opaque reviewer session identifier.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_SESSION_INVALID",
        exitCode: 2,
      });
    }
    const reviewerSessionSha256 = sha256Text(sessionId);
    if (reviewerSessionSha256 === project.scientificDesign.producer.sessionSha256) {
      throw new CliError("Producer and reviewer session identities must be independent.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_NOT_INDEPENDENT",
        exitCode: 3,
      });
    }
    const projectRoot = join(paths.projects, project.id);
    const registryPath = join(projectRoot, "scientific", "reviewer-sessions.json");
    const registry = await loadReviewerSessionRegistry(registryPath);
    if (registry.sessions.some((entry) => entry.sessionSha256 === reviewerSessionSha256)) {
      throw new CliError("A reviewer session may be used for only one scientific review packet.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_SESSION_REUSED",
        exitCode: 3,
      });
    }
    const fulfillment = await loadScientificFulfillmentView(input.root, project, input.role);
    const design = fulfillment.contract;
    const assessment = await readAssessment(input.assessmentPath, input.role);
    if (assessment.designSha256 !== project.scientificDesign.designSha256) {
      throw new CliError("Scientific assessment does not match the frozen design.", {
        code: "RESEARCH_SCIENTIFIC_ASSESSMENT_DESIGN_MISMATCH",
        exitCode: 3,
      });
    }
    const stageInputs = await stageInputRecords(
      input.root,
      project,
      input.role,
      design,
      assessment,
      input.canaryArtifactPaths ?? [],
    );
    const currentTask = await taskContext(input.root, project.id);
    if (currentTask) {
      for (const record of await nativeRunArtifactRecords(input.root, project.id)) {
        const locator = `projects/${project.id}/${record.path}`;
        stageInputs.push({
          ...record,
          path: locator,
          sourceLocator: locator,
          purpose: "native-calculation",
          ownerId: project.id,
          hashBasis: "raw-file-bytes",
          mediaType: record.path.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
          objectKind: null,
          registrationRecordSha256: null,
        });
      }
    }
    const requestSource = currentTask?.requestProvenance.source;
    if (requestSource) {
      const locator = `projects/${project.id}/task/request-sources/${requestSource.objectSha256}.json`;
      stageInputs.push({
        ...(await fileRecord(resolveContained(paths.control, locator), locator)),
        purpose: "original-request-source",
        ownerId: project.id,
        sourceLocator: locator,
        hashBasis: "raw-file-bytes",
        mediaType: "application/json",
        objectKind: null,
        registrationRecordSha256: null,
      });
    }
    if (input.role !== "research-design")
      stageInputs.push(...(await modelObjectInputs(input.root, project.id, design)));
    const amendmentInputs = new Set<string>();
    for (const record of fulfillment.amendments) {
      for (const locator of [
        scientificAmendmentLocator(project.id, record.recordSha256),
        record.amendmentAuthorization.sourceLocator,
        record.design.objectLocator,
      ]) {
        if (amendmentInputs.has(locator)) continue;
        amendmentInputs.add(locator);
        stageInputs.push({
          ...(await fileRecord(resolveContained(paths.control, locator), locator)),
          purpose: "scientific-amendment",
          ownerId: project.id,
          sourceLocator: locator,
          hashBasis: "raw-file-bytes",
          mediaType: locator.endsWith(".txt") ? "text/plain" : "application/json",
          objectKind: null,
          registrationRecordSha256: null,
        });
      }
    }
    if (fulfillment.records.length || fulfillment.amendments.length) {
      for (const record of fulfillment.records) {
        const locator = scientificFulfillmentLocator(project.id, record.recordSha256);
        stageInputs.push({
          ...(await fileRecord(resolveContained(paths.control, locator), locator)),
          purpose: "scientific-fulfillment",
          ownerId: project.id,
          sourceLocator: locator,
          hashBasis: "raw-file-bytes",
          mediaType: "application/json",
          objectKind: null,
          registrationRecordSha256: null,
        });
      }
      const locator = `projects/${project.id}/scientific/design/views/${fulfillment.effectiveSha256}.json`;
      await writeImmutableJson(resolveContained(paths.control, locator), design);
      stageInputs.push({
        ...(await fileRecord(resolveContained(paths.control, locator), locator)),
        purpose: "effective-scientific-design",
        ownerId: project.id,
        sourceLocator: locator,
        hashBasis: "raw-file-bytes",
        mediaType: "application/json",
        objectKind: null,
        registrationRecordSha256: null,
      });
    }
    const assessmentSha256 = exactJsonSha256(assessment);
    const assessmentLocator = `projects/${project.id}/scientific/assessments/${input.role}/${assessmentSha256}.json`;
    await writeImmutableJson(join(paths.control, assessmentLocator), assessment);
    const policyBindingSha256 = exactJsonSha256(project.publicationPolicy);
    const policyObjectLocator = `projects/${project.id}/scientific/policy/objects/${policyBindingSha256}.json`;
    await writeImmutableJson(
      resolveContained(paths.control, policyObjectLocator),
      project.publicationPolicy,
    );
    const packetPolicy: ScientificReviewPacket["policy"] = {
      resolvedPolicySha256: project.publicationPolicy.resolvedPolicySha256,
      approvalSha256: project.publicationPolicy.approvalSha256,
      targetJournal: project.publicationPolicy.targetJournal,
      bindingSha256: policyBindingSha256,
      objectLocator: policyObjectLocator,
    };
    await assertBoundPolicyObject(input.root, project, packetPolicy);
    const designEvaluation = evaluateScientificDesign(design);
    const issues = evaluateAssessment(
      input.role,
      assessment,
      design,
      project.evidenceRequirements,
      project.publicationPolicy,
      await assessmentEvidenceContext(input.root, project, input.role, stageInputs),
      fulfillment.deferredObjectRuleIds,
    );
    const futureGateObligations = scientificFutureGateObligations(design, input.role);
    const packetCore = {
      schemaVersion: 1 as const,
      kind: "tiangong-scientific-review-packet" as const,
      projectId: project.id,
      role: input.role,
      design: {
        sha256: project.scientificDesign.designSha256,
        objectLocator: project.scientificDesign.objectLocator,
        amendmentSha256: project.scientificDesign.amendmentSha256 ?? null,
        fulfillment: {
          headSha256: fulfillment.headSha256,
          effectiveSha256: fulfillment.effectiveSha256,
        },
      },
      policy: packetPolicy,
      reviewer: { agent: input.reviewerAgent, sessionSha256: reviewerSessionSha256 },
      preparedAt: new Date().toISOString(),
      stageInputs,
      taskContract: currentTask,
      assessment: { sha256: assessmentSha256, objectLocator: assessmentLocator },
      mechanicalAssessment: {
        canPass: issues.length === 0 && assessment.recommendation === "pass",
        issueCodes: issues.map((issue) => issue.code),
        issues,
        futureGateObligations,
        designEvaluation: {
          readyForDesignReview: designEvaluation.readyForDesignReview,
          issueCodes: designEvaluation.issueCodes,
          effectiveIndependentUnits: designEvaluation.effectiveIndependentUnits,
          requiredEvidenceRoles: designEvaluation.requiredEvidenceRoles,
        },
      },
      lifecycle: {
        producerExecution: "native-host-app" as const,
        baseStages: ["discover", "acquire", "analyze", "synthesize", "review", "close"] as Array<
          "discover" | "acquire" | "analyze" | "synthesize" | "review" | "close"
        >,
        earlyScientificReviews: [
          "research-design",
          "evidence-construct",
          "pilot-methods",
        ] as ScientificReviewRole[],
        finalPublicationReviews: [...project.publicationPolicy.requiredReviewers],
        finalManuscriptFreezeRequired: true as const,
        newGenerationOnMaterialChange: true as const,
        revisionReserveIncluded: true as const,
      },
      instructions: [
        ...reviewInstructions(input.role),
        "Scientific fulfillment files supply only previously declared pending object slots. Original design bytes remain immutable. Owner-authorized lifecycle/binding amendments, when present, are staged with their exact changes, new design version and supplied authorization source. Review the current effective design; supplied confirmation does not authenticate human identity or establish scientific satisfaction. Discharging an object-filing blocker does not establish calibration, justification or scientific correctness: independently assess the actual code, locks and source-bound values under every original policy rule.",
      ],
    };
    const packetSha256 = sha256Text(canonicalJson(packetCore));
    const packet: ScientificReviewPacket = { ...packetCore, packetSha256 };
    const packetLocator = `projects/${project.id}/scientific/review-packets/${input.role}/${packetSha256}.json`;
    await writeImmutableJson(join(paths.control, packetLocator), packet);
    registry.sessions.push({
      sessionSha256: reviewerSessionSha256,
      role: input.role,
      agent: input.reviewerAgent,
      packetSha256,
      usedAt: packet.preparedAt,
    });
    await writeJsonAtomic(registryPath, registry);
    const gate = project.scientificDesign.gates[input.role];
    gate.status = "prepared";
    gate.packetSha256 = packetSha256;
    gate.assessmentSha256 = assessmentSha256;
    gate.reviewSha256 = null;
    gate.reviewerSessionSha256 = reviewerSessionSha256;
    project.updatedAt = packet.preparedAt;
    await saveProject(input.root, project);
    await appendJournalEvent(paths.journal, "scientific-review.prepared", project.id, {
      projectId: project.id,
      role: input.role,
      designSha256: project.scientificDesign.designSha256,
      assessmentSha256,
      packetSha256,
      policyBindingSha256,
      reviewerAgent: input.reviewerAgent,
      reviewerSessionSha256,
      mechanicalIssueCodes: packet.mechanicalAssessment.issueCodes,
      futureGateObligations,
      stageInputs,
    });
    return packet;
  });
}

export async function submitScientificReview(input: {
  root: string;
  projectId: string;
  role: ScientificReviewRole;
  reviewPath: string;
  /** Internal execution recovery: exact matching terminal submissions are read-only replays. */
  executionBinding?: { packetSha256: string; reviewSha256: string };
}): Promise<{ status: ScientificGateStatus; reviewSha256: string; issueCodes: string[] }> {
  return withWorkspaceLock(input.root, "research.scientific-review.submit", async () => {
    const paths = workspacePaths(input.root);
    await verifyJournal(paths.journal);
    const project = await loadProject(input.root, input.projectId);
    const gate = project.scientificDesign?.gates[input.role];
    if (!gate) throw scientificGateError("Project does not have a scientific design binding.");
    if (
      gate.status === "prepared" &&
      (project.lineage.supersededBy ||
        ["archived", "abandoned"].includes(project.status) ||
        project.handoff.state !== "agent-actionable")
    ) {
      throw new CliError("Only an active authoritative project may submit a scientific review.", {
        code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
        exitCode: 3,
      });
    }
    const { packet, assessment } = await loadScientificReviewProof(
      input.root,
      project,
      input.role,
      Boolean(input.executionBinding),
    );
    const review = await readReview(input.reviewPath, input.role);
    const reviewSha256 = exactJsonSha256(review);
    if (
      review.packetSha256 !== packet.packetSha256 ||
      review.reviewerSessionSha256 !== packet.reviewer.sessionSha256 ||
      review.reviewerSessionSha256 !== gate.reviewerSessionSha256 ||
      (input.executionBinding &&
        (input.executionBinding.packetSha256 !== packet.packetSha256 ||
          input.executionBinding.reviewSha256 !== reviewSha256)) ||
      (gate.status !== "prepared" && gate.reviewSha256 !== reviewSha256)
    ) {
      throw new CliError("Scientific review does not match its packet and reviewer binding.", {
        code: "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
        exitCode: 3,
      });
    }
    if (gate.status !== "prepared") {
      return {
        status: gate.status,
        reviewSha256,
        issueCodes: packet.mechanicalAssessment.issueCodes,
      };
    }
    if (input.executionBinding) {
      const config = await loadWorkspaceConfig(input.root);
      if (config.mode === "production-research") {
        await assertResearchPolicyBinding(input.root, project.publicationPolicy!);
        const doctor = await verifyDoctorAttestation(input.root);
        if (doctor.status !== "verified") {
          throw new CliError("Refresh the reviewer attestation before recovered submission.", {
            code: "RESEARCH_DOCTOR_ATTESTATION_REQUIRED",
            exitCode: 3,
          });
        }
      }
    }
    const reviewLocator = `projects/${project.id}/scientific/reviews/${input.role}/${reviewSha256}.json`;
    await writeImmutableJson(join(paths.control, reviewLocator), review);
    const mechanicsPass =
      packet.mechanicalAssessment.issueCodes.length === 0 &&
      packet.mechanicalAssessment.canPass &&
      assessment.recommendation === "pass";
    let status: ScientificGateStatus;
    if (review.decision === "pass" && mechanicsPass) status = "passed";
    else if (review.decision === "stop" || review.decision === "handoff") status = "stopped";
    else status = "revision-required";
    gate.status = status;
    gate.reviewSha256 = reviewSha256;
    project.updatedAt = new Date().toISOString();
    await saveProject(input.root, project);
    await appendJournalEvent(paths.journal, "scientific-review.submitted", project.id, {
      projectId: project.id,
      role: input.role,
      packetSha256: packet.packetSha256,
      assessmentSha256: packet.assessment.sha256,
      reviewSha256,
      reviewerSessionSha256: review.reviewerSessionSha256,
      reviewerDecision: review.decision,
      mechanicalIssueCodes: packet.mechanicalAssessment.issueCodes,
      status,
    });
    return { status, reviewSha256, issueCodes: packet.mechanicalAssessment.issueCodes };
  });
}

/** Revalidate the immutable prepared packet before an explicit isolated execution. */
export async function loadPreparedScientificReview(
  root: string,
  projectId: string,
  role: ScientificReviewRole,
) {
  const project = await loadProject(root, projectId);
  return { project, ...(await loadScientificReviewProof(root, project, role, false)) };
}

async function loadScientificReviewProof(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  allowSubmitted: boolean,
) {
  const gate = project.scientificDesign?.gates[role];
  if (
    !gate ||
    (gate.status !== "prepared" &&
      !(allowSubmitted && ["passed", "stopped", "revision-required"].includes(gate.status))) ||
    !gate.packetSha256 ||
    !gate.assessmentSha256 ||
    !gate.reviewerSessionSha256
  ) {
    throw new CliError("Scientific review execution requires the current prepared packet.", {
      code: "RESEARCH_SCIENTIFIC_REVIEW_STATE_INVALID",
      exitCode: 3,
      details: { role, status: gate?.status ?? "absent" },
    });
  }
  await loadBoundScientificDesign(root, project);
  const packet = await loadBoundPacket(root, project, role, gate.packetSha256);
  const assessment = await loadBoundAssessment(root, project, role, packet);
  if (
    packet.design.sha256 !== project.scientificDesign!.designSha256 ||
    packet.design.objectLocator !== project.scientificDesign!.objectLocator ||
    packet.assessment.sha256 !== gate.assessmentSha256 ||
    packet.reviewer.sessionSha256 !== gate.reviewerSessionSha256
  ) {
    throw scientificGateError(
      "Scientific review proof does not match its current gate binding.",
      role,
    );
  }
  if (gate.status !== "prepared") {
    if (!gate.reviewSha256)
      throw scientificGateError("Submitted scientific review is missing its proof.", role);
    const review = await loadBoundReview(root, project, role, gate.reviewSha256);
    const expectedStatus =
      review.decision === "stop" || review.decision === "handoff"
        ? "stopped"
        : review.decision === "pass" &&
            packet.mechanicalAssessment.canPass &&
            packet.mechanicalAssessment.issueCodes.length === 0 &&
            assessment.recommendation === "pass"
          ? "passed"
          : "revision-required";
    if (
      review.packetSha256 !== packet.packetSha256 ||
      review.reviewerSessionSha256 !== packet.reviewer.sessionSha256 ||
      gate.status !== expectedStatus
    ) {
      throw scientificGateError(
        "Submitted scientific review does not match its immutable proof.",
        role,
      );
    }
  }
  return { packet, assessment };
}

export { readReview as readScientificReviewOutput };

export async function assertScientificGateForStage(
  root: string,
  project: ProjectState,
  stage: "discover" | "acquire" | "analyze" | "synthesize" | "review" | "close",
): Promise<void> {
  if (!project.scientificDesign) return;
  for (const role of requiredGateRoles(stage)) {
    const fulfillment = await loadScientificFulfillmentView(root, project, role);
    const design = fulfillment.contract;
    const gate = project.scientificDesign.gates[role];
    if (gate.status !== "passed" || !gate.packetSha256 || !gate.reviewSha256) {
      throw new CliError(`Scientific ${role} review must pass before ${stage}.`, {
        code: "RESEARCH_SCIENTIFIC_GATE_REQUIRED",
        exitCode: 3,
        details: { role, stage, status: gate.status },
      });
    }
    const packet = await loadBoundPacket(root, project, role, gate.packetSha256);
    const review = await loadBoundReview(root, project, role, gate.reviewSha256);
    const assessment = await loadBoundAssessment(root, project, role, packet);
    const currentIssues = evaluateAssessment(
      role,
      assessment,
      design,
      project.evidenceRequirements,
      project.publicationPolicy!,
      await assessmentEvidenceContext(root, project, role, packet.stageInputs),
      fulfillment.deferredObjectRuleIds,
    ).map((issue) => issue.code);
    if (
      packet.assessment.sha256 !== gate.assessmentSha256 ||
      packet.reviewer.sessionSha256 !== gate.reviewerSessionSha256 ||
      review.packetSha256 !== packet.packetSha256 ||
      review.reviewerSessionSha256 !== packet.reviewer.sessionSha256 ||
      review.decision !== "pass" ||
      assessment.recommendation !== "pass" ||
      packet.mechanicalAssessment.issueCodes.length !== 0 ||
      currentIssues.length !== 0
    ) {
      throw scientificGateError(
        "Scientific gate bindings or mechanical results are invalid.",
        role,
      );
    }
  }
}

export async function inspectScientificReviewStatus(
  root: string,
  projectId: string,
  knownProject?: ProjectState,
): Promise<ScientificReviewStatus> {
  const project =
    knownProject ??
    projectWithEffectiveAuthority(
      await loadProject(root, projectId),
      await readProjectAuthorityIndex(root),
    );
  if (!project.scientificDesign) {
    return { projectId, reviewState: "not-required", nextGate: null, gates: null };
  }
  const nextGate = nextScientificGate(project);
  const reviewState = !nextGate
    ? "complete"
    : nextGate.status === "revision-required"
      ? "revision-required"
      : nextGate.status === "stopped"
        ? "stopped"
        : "awaiting-review";
  return {
    projectId,
    reviewState,
    nextGate,
    gates: structuredClone(project.scientificDesign.gates),
  };
}

function evaluateAssessment(
  role: ScientificReviewRole,
  assessment: ScientificGateAssessment,
  design: ScientificDesignContract,
  requirements: ProjectState["evidenceRequirements"],
  policy: NonNullable<ProjectState["publicationPolicy"]>,
  evidenceContext: EvidenceConstructContext | null = null,
  deferredObjectRuleIds: string[] = [],
): ScientificMechanicalIssue[] {
  const issues = new Map<string, ScientificMechanicalIssue>();
  const add = (code: string, message: string, objectIds: string[] = []) => {
    if (!issues.has(code)) issues.set(code, { code, message, objectIds });
  };
  const gateRank: Record<ScientificReviewRole | "publication-freeze", number> = {
    "research-design": 0,
    "evidence-construct": 1,
    "pilot-methods": 2,
    "publication-freeze": 3,
  };
  for (const gap of scientificDesignPolicyGaps(design, policy)) {
    add(
      `POLICY_${gap.replaceAll(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`,
      "The frozen scientific design no longer matches its approved Research Policy disposition contract.",
      [gap],
    );
  }
  const duePolicyRules = design.policyRuleDispositions.filter(
    (disposition) =>
      disposition.status === "planned" &&
      !deferredObjectRuleIds.includes(disposition.ruleId) &&
      disposition.dueGate !== "publication-freeze" &&
      gateRank[disposition.dueGate] <= gateRank[role],
  );
  if (duePolicyRules.length) {
    add(
      "POLICY_RULE_DUE_UNRESOLVED",
      "A planned Research Policy rule reached its early-review gate without its declared object fulfillment or reviewed design resolution.",
      duePolicyRules.map((disposition) => disposition.ruleId),
    );
  }
  const dueUncertaintyFreezes = design.uncertaintyParameters.filter(
    (parameter) =>
      parameter.stateValueStatus === "pending-source-acquisition" &&
      gateRank[parameter.freezeBeforeGate] <= gateRank[role],
  );
  if (dueUncertaintyFreezes.length) {
    add(
      "UNCERTAINTY_STATE_VALUES_NOT_FROZEN",
      "Source-derived uncertainty values reached their freeze gate without exact states and admitted source bindings.",
      dueUncertaintyFreezes.map((parameter) => parameter.id),
    );
  }
  const dueModelImplementations = design.identity.modelStructures.filter(
    (model) =>
      model.implementationStatus === "pending-source-acquisition" &&
      gateRank[model.implementationFreezeBeforeGate] <= gateRank[role],
  );
  if (dueModelImplementations.length) {
    add(
      "MODEL_IMPLEMENTATION_NOT_FROZEN",
      "A model implementation reached its freeze gate without binding the declared executable bytes.",
      dueModelImplementations.map((model) => model.id),
    );
  }
  const dueModelEnvironmentLocks = design.identity.modelStructures.filter(
    (model) =>
      model.environmentLockStatus === "pending-runtime-lock" &&
      gateRank[model.environmentLockFreezeBeforeGate] <= gateRank[role],
  );
  if (dueModelEnvironmentLocks.length) {
    add(
      "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN",
      "A model environment reached its freeze gate without an exact runtime and dependency lock.",
      dueModelEnvironmentLocks.map((model) => model.id),
    );
  }
  if (role === "research-design") {
    const value = assessment as ResearchDesignAssessment;
    for (const issue of evaluateScientificDesign(design).issues) {
      add(issue.code, issue.message, issue.objectIds);
    }
    for (const [key, passed] of Object.entries(value.checks)) {
      if (!passed) add(`DESIGN_CHECK_${camelToCode(key)}_FAILED`, `Design check ${key} failed.`);
    }
  } else if (role === "evidence-construct") {
    const value = assessment as EvidenceConstructAssessment;
    const canary = value.constructCanary;
    if (evidenceContext?.contentGate?.decision === "stop") {
      add(
        "EVIDENCE_CONTENT_GATE_STOPPED",
        "The frozen typed-content snapshot found blocking decomposition, atom, or evidence-role gaps.",
        evidenceContext.contentGate.reasons,
      );
    }
    if (
      !canary.usesRealRecords ||
      !canary.outcomeBlind ||
      canary.resultValuesInspected ||
      canary.rowCount < 1 ||
      canary.artifactSha256s.length < 1
    ) {
      add("CANARY_NOT_REAL", "Construct canary must use real records without inspecting outcomes.");
    }
    const declaredCanarySha256s = new Set(canary.artifactSha256s);
    if (
      !evidenceContext ||
      declaredCanarySha256s.size !== canary.artifactSha256s.length ||
      declaredCanarySha256s.size !== evidenceContext.canaryArtifactSha256s.size ||
      [...declaredCanarySha256s].some(
        (sha256) => !evidenceContext.canaryArtifactSha256s.has(sha256),
      )
    ) {
      add(
        "CANARY_ARTIFACT_UNBOUND",
        "Every construct-canary digest must bind one exact promoted artifact and no undeclared artifact is permitted.",
      );
    }
    const centralEdges = design.edges
      .filter((edge) => edge.role === "central")
      .map((edge) => edge.id);
    const knownEdgeIds = new Set(design.edges.map((edge) => edge.id));
    const unknownCanaryEdgeIds = [...canary.constructedEdgeIds, ...canary.failedEdgeIds].filter(
      (edgeId) => !knownEdgeIds.has(edgeId),
    );
    if (unknownCanaryEdgeIds.length) {
      add(
        "CANARY_EDGE_ID_UNKNOWN",
        "Construct-canary edge IDs must exist in the frozen scientific design.",
        [...new Set(unknownCanaryEdgeIds)],
      );
    }
    const unconstructed = centralEdges.filter(
      (edgeId) =>
        !canary.constructedEdgeIds.includes(edgeId) || canary.failedEdgeIds.includes(edgeId),
    );
    if (unconstructed.length) {
      add(
        "CENTRAL_EDGE_UNCONSTRUCTED",
        "Every central claim edge must survive a real-record construct canary.",
        unconstructed,
      );
    }
    const expectedRoleIds = new Set(
      design.evidenceRoles.filter((item) => item.required).map((item) => item.id),
    );
    const providedRoleIds = value.evidenceRoleCoverage.map((coverage) => coverage.roleId);
    if (
      new Set(providedRoleIds).size !== providedRoleIds.length ||
      providedRoleIds.some((roleId) => !expectedRoleIds.has(roleId))
    ) {
      add(
        "EVIDENCE_ROLE_COVERAGE_INVALID",
        "Evidence-role coverage must contain only distinct required roles from the frozen design.",
      );
    }
    const allIndependentSourceIds = new Set<string>();
    const allFullTextSourceIds = new Set<string>();
    const allDatedSourceIds = new Set<string>();
    for (const required of design.evidenceRoles.filter((item) => item.required)) {
      const coverage = value.evidenceRoleCoverage.find((item) => item.roleId === required.id);
      const independentIds = new Set(coverage?.independentSourceIds ?? []);
      const fullTextIds = new Set(coverage?.fullTextSourceIds ?? []);
      const datedIds = new Set(coverage?.datedSourceIds ?? []);
      const peerReviewedIds = new Set(coverage?.peerReviewedSourceIds ?? []);
      const referencedIds = new Set([
        ...independentIds,
        ...fullTextIds,
        ...datedIds,
        ...peerReviewedIds,
      ]);
      const unknownIds = [...referencedIds].filter(
        (sourceId) => !evidenceContext?.sources.has(sourceId),
      );
      const atomBoundRoleSources = evidenceContext?.contentRoleSourceIds.get(required.id);
      if (
        atomBoundRoleSources &&
        [...independentIds].some((sourceId) => !atomBoundRoleSources.has(sourceId))
      ) {
        add(
          "EVIDENCE_ROLE_ATOM_BINDING_INVALID",
          "Evidence-role coverage may use only sources with exact atoms assigned to that role in the typed-content snapshot.",
          [required.id],
        );
      }
      if (unknownIds.length) {
        add(
          "EVIDENCE_SOURCE_ID_UNKNOWN",
          "Evidence-role coverage may reference only source IDs from the frozen post-acquisition snapshot.",
          unknownIds,
        );
      }
      const knownIndependent = [...independentIds].filter((sourceId) =>
        evidenceContext?.sources.has(sourceId),
      );
      const validFullText = [...fullTextIds].filter(
        (sourceId) => evidenceContext?.sources.get(sourceId)?.fullTextAvailable === true,
      );
      const validDated = [...datedIds].filter((sourceId) =>
        Boolean(evidenceContext?.sources.get(sourceId)?.publicationDate),
      );
      const validPeerReviewed = [...peerReviewedIds].filter((sourceId) => {
        const source = evidenceContext?.sources.get(sourceId);
        return source?.fullTextAvailable === true;
      });
      for (const sourceId of knownIndependent) allIndependentSourceIds.add(sourceId);
      for (const sourceId of validFullText) allFullTextSourceIds.add(sourceId);
      for (const sourceId of validDated) allDatedSourceIds.add(sourceId);
      if ([...fullTextIds].some((sourceId) => !validFullText.includes(sourceId))) {
        add(
          "EVIDENCE_SOURCE_FULLTEXT_INVALID",
          "A claimed full-text source is not producer-readable in the frozen evidence snapshot.",
          [required.id],
        );
      }
      if ([...datedIds].some((sourceId) => !validDated.includes(sourceId))) {
        add(
          "EVIDENCE_SOURCE_DATE_INVALID",
          "A claimed dated source has no publication date in the frozen evidence snapshot.",
          [required.id],
        );
      }
      if ([...peerReviewedIds].some((sourceId) => !validPeerReviewed.includes(sourceId))) {
        add(
          "EVIDENCE_SOURCE_PEER_REVIEW_INVALID",
          "A claimed peer-reviewed source must be full text in the frozen evidence snapshot; the independent reviewer verifies its publication status.",
          [required.id],
        );
      }
      if (
        !coverage ||
        new Set(validFullText).size < required.minimumFullText ||
        new Set(knownIndependent).size < required.minimumIndependentSources
      ) {
        add(
          "EVIDENCE_ROLE_FULLTEXT_INSUFFICIENT",
          "A required evidence role lacks its frozen full-text or independence minimum.",
          [required.id],
        );
      }
      if (!coverage || new Set(validDated).size < required.minimumDatedSources) {
        add(
          "EVIDENCE_ROLE_DATED_INSUFFICIENT",
          "A required evidence role lacks its frozen dated-source minimum.",
          [required.id],
        );
      }
      if (
        required.peerReviewedRequired &&
        (!coverage || new Set(validPeerReviewed).size < required.minimumFullText)
      ) {
        add(
          "EVIDENCE_ROLE_PEER_REVIEWED_INSUFFICIENT",
          "A peer-reviewed evidence role lacks its required frozen peer-reviewed full texts.",
          [required.id],
        );
      }
      const dimensions = new Set(
        knownIndependent.flatMap(
          (sourceId) => evidenceContext?.sources.get(sourceId)?.coverageDimensions ?? [],
        ),
      );
      if (coverage?.dimensionIds.some((dimension) => !dimensions.has(dimension))) {
        add(
          "EVIDENCE_ROLE_DIMENSION_CLAIM_INVALID",
          "Declared role dimensions must be supported by the role's frozen snapshot sources.",
          [required.id],
        );
      }
      if (required.coverageDimensionIds.some((dimension) => !dimensions.has(dimension))) {
        add(
          "EVIDENCE_ROLE_DIMENSION_UNCOVERED",
          "A required evidence role did not demonstrate every declared research dimension.",
          [required.id],
        );
      }
      const sourceTypes = new Set(
        knownIndependent.flatMap((sourceId) => {
          const sourceType = evidenceContext?.sources.get(sourceId)?.sourceType;
          return sourceType ? [sourceType] : [];
        }),
      );
      if (coverage?.sourceTypes.some((sourceType) => !sourceTypes.has(sourceType))) {
        add(
          "EVIDENCE_ROLE_SOURCE_TYPE_CLAIM_INVALID",
          "Declared role source types must be present among the role's frozen snapshot sources.",
          [required.id],
        );
      }
      if (sourceTypeRequirementGaps(required.sourceTypeRequirements, sourceTypes).length) {
        add(
          "EVIDENCE_ROLE_SOURCE_TYPE_UNCOVERED",
          "A required evidence role did not satisfy its declared source-type constraint groups.",
          [required.id],
        );
      }
      if (coverage) {
        if (
          coverage.fullTextSourceIds.some((sourceId) => !independentIds.has(sourceId)) ||
          coverage.datedSourceIds.some((sourceId) => !independentIds.has(sourceId)) ||
          coverage.peerReviewedSourceIds.some(
            (sourceId) => !independentIds.has(sourceId) || !fullTextIds.has(sourceId),
          )
        ) {
          add(
            "EVIDENCE_ROLE_SOURCE_ID_INCONSISTENT",
            "Full-text, dated, and peer-reviewed IDs must refer to sources in the same role's independent source set.",
            [required.id],
          );
        }
      }
    }
    if (allIndependentSourceIds.size < requirements.minSources) {
      add(
        "EVIDENCE_UNIQUE_SOURCE_COVERAGE_INSUFFICIENT",
        "Unique evidence sources across roles do not meet the project minimum.",
      );
    }
    if (allFullTextSourceIds.size < requirements.minFullTextSources) {
      add(
        "EVIDENCE_UNIQUE_FULLTEXT_COVERAGE_INSUFFICIENT",
        "Unique full-text sources across roles do not meet the project minimum.",
      );
    }
    if (allDatedSourceIds.size < requirements.minDatedSources) {
      add(
        "EVIDENCE_UNIQUE_DATED_COVERAGE_INSUFFICIENT",
        "Unique dated sources across roles do not meet the project minimum.",
      );
    }
    if (!value.closestWorkDispositionComplete) {
      add(
        "CLOSEST_WORK_DISPOSITION_INCOMPLETE",
        "Closest prior work must be obtained, compared, and dispositioned before analysis.",
      );
    }
    if (!value.centralEvidenceFitsContext) {
      add(
        "CENTRAL_CONTEXT_OVERFLOW",
        "Central evidence does not fit the planned context and extraction route.",
      );
    }
  } else {
    const value = assessment as PilotMethodsAssessment;
    for (const [key, passed] of Object.entries(value.checks)) {
      if (!passed) add(`PILOT_CHECK_${camelToCode(key)}_FAILED`, `Pilot check ${key} failed.`);
    }
    const auditIds = value.validationAudits.map((audit) => audit.validationPlanId);
    const knownPlanIds = new Set(design.validationPlans.map((plan) => plan.id));
    const missingOrUnknownPlans = [
      ...design.validationPlans
        .map((plan) => plan.id)
        .filter((planId) => !auditIds.includes(planId)),
      ...auditIds.filter((planId) => !knownPlanIds.has(planId)),
    ];
    if (new Set(auditIds).size !== auditIds.length || missingOrUnknownPlans.length) {
      add(
        "VALIDATION_PLAN_UNVERIFIED",
        "Every declared validation plan requires exactly one pilot audit and undeclared plans are forbidden.",
        [...new Set(missingOrUnknownPlans)],
      );
    }
    for (const audit of value.validationAudits) {
      if (
        audit.independentClusterCount > audit.originalUnitCount ||
        audit.effectiveIndependentUnits > audit.independentClusterCount
      ) {
        add(
          "EFFECTIVE_SAMPLE_SIZE_INFLATED",
          "Resampling cannot create independent units beyond the original independent clusters.",
          [audit.validationPlanId],
        );
      }
      const repeatedWithinCluster = audit.originalUnitCount > audit.independentClusterCount;
      if (
        repeatedWithinCluster &&
        /^(cell|row|record|observation|measurement)s?$/iu.test(audit.resamplingUnit.trim())
      ) {
        add(
          "RESAMPLING_UNIT_INVALID",
          "Resampling must preserve the independent cluster when observations repeat within clusters.",
          [audit.validationPlanId],
        );
      }
      const plan = design.validationPlans.find(
        (candidate) => candidate.id === audit.validationPlanId,
      );
      if (!plan) continue;
      if (
        audit.originalUnitCount !== plan.originalUnitCount ||
        audit.independentClusterCount !== plan.independentClusterCount ||
        audit.effectiveIndependentUnits !== plan.effectiveIndependentUnits
      ) {
        add(
          "PILOT_SAMPLE_DEFINITION_DRIFT",
          "Pilot sample counts differ from the frozen validation plan and require a new design generation.",
          [plan.id],
        );
      }
      if (
        !sameStringSet(audit.clusterKeyIds, plan.clusterKeyIds) ||
        audit.independenceJustification !== plan.independenceJustification ||
        audit.resamplingUnit !== plan.resamplingUnit
      ) {
        add(
          "PILOT_CLUSTER_DEFINITION_DRIFT",
          "Pilot cluster keys, independence justification, or resampling unit differ from the frozen validation plan.",
          [plan.id],
        );
      }
      if (
        audit.resamplingIterations !== plan.resamplingIterations ||
        audit.resamplingMethod !== plan.resamplingMethod ||
        audit.resamplingStateSpaceSize !== plan.resamplingStateSpaceSize
      ) {
        add(
          "PILOT_RESAMPLING_PLAN_DRIFT",
          "Pilot resampling method, iterations, or state space differ from the frozen validation plan.",
          [plan.id],
        );
      }
      if (
        audit.reportingPrecision !== plan.reportingPrecision ||
        audit.minimumDetectableDifference !== plan.minimumDetectableDifference
      ) {
        add(
          "PILOT_PRECISION_PLAN_DRIFT",
          "Pilot reporting precision or minimum detectable difference differs from the frozen validation plan.",
          [plan.id],
        );
      }
      if (audit.outcomeBlind !== plan.outcomeBlind) {
        add(
          "PILOT_OUTCOME_BLINDING_DRIFT",
          "Pilot outcome blinding differs from the frozen validation plan.",
          [plan.id],
        );
      }
      if (
        audit.independentValidationStatus !== plan.independentValidation.status ||
        audit.independentValidationGapId !== plan.independentValidation.gapId
      ) {
        add(
          "PILOT_VALIDATION_DISPOSITION_DRIFT",
          "Pilot independent-validation status or gap binding differs from the frozen validation plan.",
          [plan.id],
        );
      }
    }
    const missingLoss = design.baselinePlan.decisionLossMetrics.filter(
      (metric) => !value.decisionLossMetricIds.includes(metric.id),
    );
    if (missingLoss.length) {
      add(
        "DECISION_LOSS_METRIC_MISSING",
        "Every frozen decision-loss metric must be computed in the pilot.",
        missingLoss.map((metric) => metric.id),
      );
    }
  }
  return [...issues.values()];
}

async function stageInputRecords(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  design: ScientificDesignContract,
  assessment: ScientificGateAssessment,
  canaryArtifactPaths: string[],
): Promise<ScientificReviewStageInput[]> {
  const paths = workspacePaths(root);
  const projectRoot = join(paths.projects, project.id);
  if (role === "research-design") {
    const records: ScientificReviewStageInput[] = [];
    const promoteLegacyJson = async (input: {
      sourceLocator: string;
      sha256: string;
      purpose: Exclude<ScientificReviewStageInput["purpose"], "stage-output">;
      ownerId: string;
      onFailure: (
        reason:
          | "unavailable-or-unsafe"
          | "oversized"
          | "content-hash-mismatch"
          | "not-reviewable-json",
      ) => CliError;
    }) => {
      const source = resolveContained(paths.control, input.sourceLocator);
      const info = await lstat(source).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw input.onFailure("unavailable-or-unsafe");
      }
      if (info.size > MAX_SCIENTIFIC_REVIEW_BYTES) {
        throw input.onFailure("oversized");
      }
      if ((await sha256File(source)) !== input.sha256) {
        throw input.onFailure("content-hash-mismatch");
      }
      const sourceBytes = await readFile(source, "utf8");
      try {
        JSON.parse(sourceBytes);
      } catch {
        throw input.onFailure("not-reviewable-json");
      }
      const promotedLocator = `projects/${project.id}/scientific/lineage/objects/${input.sha256}.json`;
      const promoted = resolveContained(paths.control, promotedLocator);
      if (await pathExists(promoted)) {
        const promotedInfo = await lstat(promoted).catch(() => undefined);
        if (
          !promotedInfo?.isFile() ||
          promotedInfo.isSymbolicLink() ||
          promotedInfo.size !== info.size ||
          (await sha256File(promoted)) !== input.sha256
        ) {
          throw scientificGateError(
            "A promoted scientific design object failed its immutable binding.",
            role,
          );
        }
      } else {
        await writeTextAtomic(promoted, sourceBytes);
      }
      records.push({
        path: promotedLocator,
        sha256: input.sha256,
        bytes: info.size,
        purpose: input.purpose,
        ownerId: input.ownerId,
        sourceLocator: input.sourceLocator,
        hashBasis: "raw-file-bytes",
        mediaType: "application/json",
        objectKind: null,
        registrationRecordSha256: null,
      });
    };
    records.push(...(await modelObjectInputs(root, project.id, design)));
    for (const gap of design.knownGaps) {
      for (const artifact of gap.sourceArtifacts) {
        await promoteLegacyJson({
          sourceLocator: artifact.objectLocator,
          sha256: artifact.sha256,
          purpose: "inherited-gap",
          ownerId: gap.id,
          onFailure: (reason) => inheritedGapObjectError(role, gap.id, artifact.kind, reason),
        });
      }
    }
    return records;
  }
  const requiredPackage = "acquire";
  const packageState = project.packages.find((item) => item.id === requiredPackage);
  if (packageState?.status !== "complete") {
    throw new CliError(`Scientific ${role} review requires completed ${requiredPackage}.`, {
      code: "RESEARCH_SCIENTIFIC_REVIEW_PREREQUISITE_MISSING",
      exitCode: 3,
      details: { role, requiredPackage, status: packageState?.status ?? null },
    });
  }
  const relativeOutputs = ["outputs/acquisition.json", "outputs/evidence-snapshot.json"];
  if (await pathExists(join(projectRoot, "outputs", "content-snapshot.json"))) {
    relativeOutputs.push("outputs/content-snapshot.json");
  }
  const stageOutputs: ScientificReviewStageInput[] = await Promise.all(
    relativeOutputs.map(async (relativePath) => {
      const sourceLocator = `projects/${project.id}/${relativePath}`;
      return {
        ...(await fileRecord(join(projectRoot, relativePath), sourceLocator)),
        purpose: "stage-output" as const,
        ownerId: requiredPackage,
        sourceLocator,
        hashBasis: "raw-file-bytes" as const,
        mediaType: "application/json",
        objectKind: null,
        registrationRecordSha256: null,
      };
    }),
  );
  const snapshot = await readExactJson(
    join(projectRoot, "outputs/evidence-snapshot.json"),
    "Scientific evidence snapshot",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  if (!isObject(snapshot) || !Array.isArray(snapshot.artifacts))
    throw scientificGateError("Scientific evidence snapshot has no exact artifact set.", role);
  if (snapshot.artifacts.length) {
    const registered = new Map(
      (await loadEvidenceArtifactRecords(root, project.id)).map((artifact) => [
        artifact.artifactId,
        artifact,
      ]),
    );
    for (const selected of snapshot.artifacts) {
      const artifact =
        isObject(selected) && typeof selected.artifactId === "string"
          ? registered.get(selected.artifactId)
          : undefined;
      if (
        !artifact ||
        !isObject(selected) ||
        artifact.sha256 !== selected.sha256 ||
        artifact.bytes !== selected.bytes ||
        artifact.locator !== selected.locator ||
        artifact.mediaType !== selected.mediaType
      )
        throw scientificGateError(
          "Scientific review source is not the exact frozen registered artifact.",
          role,
        );
      let directory = projectRoot;
      for (const part of ["scientific", "evidence-objects", artifact.sha256]) {
        directory = join(directory, part);
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw scientificGateError(
            "Scientific evidence directories cannot redirect through links.",
            role,
          );
      }
      const path = `projects/${project.id}/scientific/evidence-objects/${artifact.sha256}/blob`;
      const target = resolveContained(paths.control, path);
      if (!(await pathExists(target))) {
        await copyFile(
          resolveContained(paths.control, artifact.locator),
          target,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
        await chmod(target, 0o444);
      }
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== artifact.bytes ||
        (await sha256File(target)) !== artifact.sha256
      )
        throw scientificGateError("Scientific review source bytes changed while staging.", role);
      stageOutputs.push({
        path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        purpose: "acquired-evidence",
        ownerId: artifact.artifactId,
        sourceLocator: artifact.locator,
        hashBasis: "raw-file-bytes",
        mediaType: artifact.mediaType,
        objectKind: null,
        registrationRecordSha256: null,
      });
    }
  }
  if (role !== "evidence-construct") {
    if (canaryArtifactPaths.length)
      throw canaryArtifactError("Only evidence-construct accepts canary artifacts.");
    return stageOutputs;
  }
  const expectedSha256s = new Set(
    (assessment as EvidenceConstructAssessment).constructCanary.artifactSha256s,
  );
  const seenSha256s = new Set<string>();
  const canaryRecords: ScientificReviewStageInput[] = [];
  const controlRoot = resolve(paths.control);
  for (const selected of canaryArtifactPaths) {
    if (!isAbsolute(selected) || resolve(selected) !== selected) {
      throw canaryArtifactError("Canary artifact paths must be absolute and canonical.");
    }
    const sourcePath = resolve(selected);
    const relation = relative(controlRoot, sourcePath);
    if (sourcePath === controlRoot || (!relation.startsWith(`..${sep}`) && relation !== "..")) {
      throw canaryArtifactError("Canary artifacts must originate outside .tiangong-research.");
    }
    const info = await lstat(sourcePath).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > MAX_SCIENTIFIC_REVIEW_BYTES
    ) {
      throw canaryArtifactError("Canary artifacts must be bounded regular non-symlink files.");
    }
    const sourceBytes = await readFile(sourcePath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(sourceBytes) as unknown;
    } catch {
      throw canaryArtifactError("Canary artifacts must contain reviewable JSON.");
    }
    if (containsSensitiveCanaryField(value)) {
      throw canaryArtifactError("Canary artifacts cannot contain credential-like fields.");
    }
    const sha256 = await sha256File(sourcePath);
    if (!expectedSha256s.has(sha256)) {
      throw canaryArtifactError("A supplied canary artifact is not declared by the assessment.");
    }
    if (seenSha256s.has(sha256)) {
      throw canaryArtifactError("Canary artifacts must have distinct content hashes.");
    }
    seenSha256s.add(sha256);
    const locator = `projects/${project.id}/scientific/canary-artifacts/evidence-construct/${sha256}.json`;
    const promoted = resolveContained(paths.control, locator);
    if (await pathExists(promoted)) {
      const promotedInfo = await lstat(promoted).catch(() => undefined);
      if (
        !promotedInfo?.isFile() ||
        promotedInfo.isSymbolicLink() ||
        promotedInfo.size !== info.size ||
        (await sha256File(promoted)) !== sha256
      ) {
        throw scientificGateError(
          "A promoted construct-canary artifact failed its immutable binding.",
          role,
        );
      }
    } else {
      await writeTextAtomic(promoted, sourceBytes);
    }
    canaryRecords.push({
      path: locator,
      sha256,
      bytes: info.size,
      purpose: "construct-canary",
      ownerId: "evidence-construct",
      sourceLocator: `native-canary:${sha256}`,
      hashBasis: "raw-file-bytes",
      mediaType: "application/json",
      objectKind: null,
      registrationRecordSha256: null,
    });
  }
  return [...stageOutputs, ...canaryRecords];
}

async function modelObjectInputs(
  root: string,
  projectId: string,
  design: ScientificDesignContract,
): Promise<ScientificReviewStageInput[]> {
  const records: ScientificReviewStageInput[] = [];
  for (const model of design.identity.modelStructures) {
    if (model.implementationStatus === "executable-frozen")
      records.push(
        await promoteRegisteredModelObject({
          root,
          projectId,
          objectKind: "model-implementation",
          sourceLocator: model.implementationArtifactLocator!,
          sha256: model.implementationArtifactSha256!,
          purpose: "model-implementation",
          ownerId: model.id,
        }),
      );
    if (model.environmentLockStatus === "exact-frozen")
      records.push(
        await promoteRegisteredModelObject({
          root,
          projectId,
          objectKind: "environment-lock",
          sourceLocator: model.environmentLockLocator!,
          sha256: model.environmentLockSha256!,
          purpose: "model-environment-lock",
          ownerId: model.id,
        }),
      );
  }
  return records;
}

async function promoteRegisteredModelObject(input: {
  root: string;
  projectId: string;
  objectKind: ScientificObjectKind;
  sourceLocator: string;
  sha256: string;
  purpose: "model-implementation" | "model-environment-lock";
  ownerId: string;
}): Promise<ScientificReviewStageInput> {
  const resolvedObject = await resolveScientificObjectBinding({
    root: input.root,
    objectKind: input.objectKind,
    objectLocator: input.sourceLocator,
    expectedSha256: input.sha256,
  });
  const promotedLocator = `projects/${input.projectId}/scientific/lineage/objects/${input.sha256}/blob`;
  const promotedPath = resolveContained(workspacePaths(input.root).control, promotedLocator);
  if (await pathExists(promotedPath)) {
    const promotedInfo = await lstat(promotedPath).catch(() => undefined);
    if (
      !promotedInfo?.isFile() ||
      promotedInfo.isSymbolicLink() ||
      promotedInfo.size !== resolvedObject.bytes ||
      (await sha256File(promotedPath)) !== input.sha256
    ) {
      throw scientificGateError(
        "A promoted scientific design object failed its immutable binding.",
        "research-design",
      );
    }
  } else {
    await writeBytesAtomic(promotedPath, await readFile(resolvedObject.sourcePath), 0o444);
  }
  return {
    path: promotedLocator,
    sha256: input.sha256,
    bytes: resolvedObject.bytes,
    purpose: input.purpose,
    ownerId: input.ownerId,
    sourceLocator: resolvedObject.sourceLocator,
    hashBasis: "raw-file-bytes",
    mediaType: resolvedObject.mediaType,
    objectKind: input.objectKind,
    registrationRecordSha256: resolvedObject.record.recordSha256,
  };
}

async function assessmentEvidenceContext(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  stageInputs: ScientificReviewStageInput[],
): Promise<EvidenceConstructContext | null> {
  if (role !== "evidence-construct") return null;
  const snapshotRecord = stageInputs.find(
    (record) =>
      record.purpose === "stage-output" &&
      record.sourceLocator === `projects/${project.id}/outputs/evidence-snapshot.json`,
  );
  if (!snapshotRecord) {
    throw scientificGateError(
      "Evidence-construct review requires the frozen post-acquisition evidence snapshot.",
      role,
    );
  }
  const snapshot = await readExactJson(
    resolveContained(workspacePaths(root).control, snapshotRecord.path),
    "Evidence snapshot",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  if (
    !isObject(snapshot) ||
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "tiangong-evidence-snapshot" ||
    snapshot.projectId !== project.id ||
    !Array.isArray(snapshot.sources)
  ) {
    throw scientificGateError("Evidence snapshot is malformed for scientific review.", role);
  }
  const snapshotSha256 = typeof snapshot.snapshotSha256 === "string" ? snapshot.snapshotSha256 : "";
  const snapshotId = typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : "";
  const { snapshotSha256: _recordedSnapshotSha256, ...snapshotCore } = snapshot;
  const immutableSnapshot = resolveContained(
    workspacePaths(root).projects,
    `${project.id}/evidence/snapshots/${snapshotSha256}.json`,
  );
  const snapshotBytes = normalizedJson(snapshot);
  if (
    !new RegExp(SHA256_PATTERN).test(snapshotSha256) ||
    !snapshotId ||
    sha256Text(canonicalJson(snapshotCore)) !== snapshotSha256 ||
    project.evidenceState.currentSnapshotId !== snapshotId ||
    project.evidenceState.currentSnapshotSha256 !== snapshotSha256 ||
    !(await pathExists(immutableSnapshot)) ||
    (await readFile(immutableSnapshot, "utf8")) !== snapshotBytes
  ) {
    throw scientificGateError(
      "Evidence-construct review requires the current immutable evidence snapshot binding.",
      role,
    );
  }
  const sources = new Map<string, EvidenceConstructSource>();
  for (const item of snapshot.sources) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id) {
      throw scientificGateError("Evidence snapshot contains a malformed source.", role);
    }
    if (sources.has(item.id)) {
      throw scientificGateError("Evidence snapshot contains duplicate source IDs.", role);
    }
    sources.set(item.id, {
      id: item.id,
      sourceType: typeof item.sourceType === "string" ? item.sourceType : null,
      publicationDate: typeof item.publicationDate === "string" ? item.publicationDate : null,
      fullTextAvailable: item.fullTextAvailable === true,
      coverageDimensions: Array.isArray(item.coverageDimensions)
        ? item.coverageDimensions.filter((value): value is string => typeof value === "string")
        : [],
    });
  }
  const contentRecord = stageInputs.find(
    (record) =>
      record.purpose === "stage-output" &&
      record.sourceLocator === `projects/${project.id}/outputs/content-snapshot.json`,
  );
  let contentGate: EvidenceConstructContext["contentGate"] = null;
  const contentRoleSourceIds = new Map<string, Set<string>>();
  if (contentRecord) {
    const contentSnapshot = await readExactJson(
      resolveContained(workspacePaths(root).control, contentRecord.path),
      "Evidence content snapshot",
      "RESEARCH_SCIENTIFIC_GATE_INVALID",
    );
    if (
      !isObject(contentSnapshot) ||
      contentSnapshot.schemaVersion !== 1 ||
      contentSnapshot.kind !== "tiangong-evidence-content-snapshot" ||
      contentSnapshot.projectId !== project.id ||
      contentSnapshot.acquisitionSnapshotId !== snapshotId ||
      contentSnapshot.acquisitionSnapshotSha256 !== snapshotSha256 ||
      typeof contentSnapshot.snapshotSha256 !== "string" ||
      !new RegExp(SHA256_PATTERN).test(contentSnapshot.snapshotSha256) ||
      !isObject(contentSnapshot.gate) ||
      !["pass", "stop"].includes(String(contentSnapshot.gate.decision)) ||
      !Array.isArray(contentSnapshot.gate.reasons) ||
      contentSnapshot.gate.reasons.some((reason) => typeof reason !== "string") ||
      !Array.isArray(contentSnapshot.roleCoverage)
    ) {
      throw scientificGateError("Evidence content snapshot is malformed for review.", role);
    }
    const { snapshotSha256: contentSnapshotSha256, ...contentCore } = contentSnapshot;
    const immutableContentSnapshot = resolveContained(
      workspacePaths(root).projects,
      `${project.id}/evidence/content-snapshots/${contentSnapshotSha256}.json`,
    );
    const contentBytes = normalizedJson(contentSnapshot);
    if (
      sha256Text(canonicalJson(contentCore)) !== contentSnapshotSha256 ||
      !(await pathExists(immutableContentSnapshot)) ||
      (await readFile(immutableContentSnapshot, "utf8")) !== contentBytes
    ) {
      throw scientificGateError(
        "Evidence-construct review requires the current immutable content snapshot binding.",
        role,
      );
    }
    contentGate = {
      decision: contentSnapshot.gate.decision as "pass" | "stop",
      reasons: contentSnapshot.gate.reasons as string[],
    };
    for (const coverage of contentSnapshot.roleCoverage) {
      if (
        !isObject(coverage) ||
        typeof coverage.roleId !== "string" ||
        !Array.isArray(coverage.sourceIds) ||
        coverage.sourceIds.some((sourceId) => typeof sourceId !== "string")
      ) {
        throw scientificGateError("Evidence content role coverage is malformed for review.", role);
      }
      contentRoleSourceIds.set(coverage.roleId, new Set(coverage.sourceIds as string[]));
    }
  }
  return {
    sources,
    canaryArtifactSha256s: new Set(
      stageInputs
        .filter((record) => record.purpose === "construct-canary")
        .map((record) => record.sha256),
    ),
    contentGate,
    contentRoleSourceIds,
  };
}

async function loadBoundScientificDesign(
  root: string,
  project: ProjectState,
): Promise<ScientificDesignContract> {
  return (await loadScientificFulfillmentView(root, project)).contract;
}

async function loadBoundPacket(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  packetSha256: string,
): Promise<ScientificReviewPacket> {
  const path = join(
    workspacePaths(root).projects,
    project.id,
    "scientific",
    "review-packets",
    role,
    `${packetSha256}.json`,
  );
  const value = await readExactJson(
    path,
    "Scientific review packet",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  if (
    !isScientificReviewPacket(
      value,
      project.id,
      role,
      project.publicationPolicy?.requiredReviewers ?? [],
    )
  ) {
    throw scientificGateError("Scientific review packet is malformed.", role);
  }
  const { packetSha256: recorded, ...core } = value;
  if (
    recorded !== packetSha256 ||
    sha256Text(canonicalJson(core)) !== packetSha256 ||
    (await readFile(path, "utf8")) !== normalizedJson(value)
  ) {
    throw scientificGateError("Scientific review packet failed its immutable hash binding.", role);
  }
  await assertBoundPolicyObject(root, project, value.policy);
  const fulfillment = await loadScientificFulfillmentView(root, project, role);
  if (
    (value.design.amendmentSha256 ?? null) !== (project.scientificDesign?.amendmentSha256 ?? null)
  )
    throw scientificGateError("Scientific review has a stale amendment generation.", role);
  if (value.design.fulfillment) {
    if (
      value.design.fulfillment.effectiveSha256 !== fulfillment.effectiveSha256 ||
      (value.design.fulfillment.headSha256 !== null &&
        !fulfillment.records.some(
          (record) => record.recordSha256 === value.design.fulfillment!.headSha256,
        ))
    ) {
      throw scientificGateError(
        "Scientific review has a stale or uncommitted fulfillment view.",
        role,
      );
    }
  } else if (canonicalJson(fulfillment.contract) !== canonicalJson(fulfillment.base)) {
    throw scientificGateError(
      "Scientific review does not bind the fulfilled scientific objects.",
      role,
    );
  }
  if (
    canonicalJson(value.taskContract ?? null) !== canonicalJson(await taskContext(root, project.id))
  ) {
    throw scientificGateError(
      "Scientific review no longer binds the current authorized task scope.",
      role,
    );
  }
  await assertBoundStageInputs(root, value.stageInputs, role);
  return value;
}

async function assertBoundStageInputs(
  root: string,
  records: ScientificReviewPacket["stageInputs"],
  role: ScientificReviewRole,
): Promise<void> {
  const paths = workspacePaths(root);
  for (const record of records) {
    const path = resolveContained(paths.control, record.path);
    const info = await lstat(path).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== record.bytes ||
      (await sha256File(path)) !== record.sha256
    ) {
      throw scientificGateError(
        "A scientific review stage input failed its immutable binding.",
        role,
      );
    }
  }
}

async function assertBoundPolicyObject(
  root: string,
  project: ProjectState,
  packetPolicy: ScientificReviewPacket["policy"],
): Promise<void> {
  const binding = project.publicationPolicy;
  if (!binding) throw scientificGateError("Project has no publication policy binding.");
  const expectedSha256 = exactJsonSha256(binding);
  const expectedLocator = `projects/${project.id}/scientific/policy/objects/${expectedSha256}.json`;
  if (
    packetPolicy.bindingSha256 !== expectedSha256 ||
    packetPolicy.objectLocator !== expectedLocator ||
    packetPolicy.resolvedPolicySha256 !== binding.resolvedPolicySha256 ||
    packetPolicy.approvalSha256 !== binding.approvalSha256 ||
    packetPolicy.targetJournal !== binding.targetJournal
  ) {
    throw scientificGateError("Scientific review policy binding does not match the project.");
  }
  const paths = workspacePaths(root);
  const policyPath = resolveContained(paths.control, expectedLocator);
  const value = await readExactJson(
    policyPath,
    "Scientific review policy binding",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  if (
    exactJsonSha256(value) !== expectedSha256 ||
    (await readFile(policyPath, "utf8")) !== normalizedJson(binding)
  ) {
    throw scientificGateError("Scientific review policy object failed its immutable binding.");
  }
  for (const document of binding.documents) {
    const documentPath = resolveContained(paths.control, document.objectLocator);
    const info = await lstat(documentPath).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      (await sha256File(documentPath)) !== document.sha256
    ) {
      throw scientificGateError(
        "A policy document referenced by the review packet is unavailable or drifted.",
      );
    }
  }
}

async function loadBoundAssessment(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  packet: ScientificReviewPacket,
): Promise<ScientificGateAssessment> {
  const expectedLocator = `projects/${project.id}/scientific/assessments/${role}/${packet.assessment.sha256}.json`;
  if (packet.assessment.objectLocator !== expectedLocator) {
    throw scientificGateError("Scientific assessment locator is not canonical.", role);
  }
  const path = join(workspacePaths(root).control, expectedLocator);
  const value = await readExactJson(
    path,
    "Scientific assessment",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  const assessment = parseAssessment(value, role, "RESEARCH_SCIENTIFIC_GATE_INVALID");
  if (
    assessment.designSha256 !== project.scientificDesign?.designSha256 ||
    exactJsonSha256(assessment) !== packet.assessment.sha256 ||
    (await readFile(path, "utf8")) !== normalizedJson(assessment)
  ) {
    throw scientificGateError("Scientific assessment failed its immutable binding.", role);
  }
  return assessment;
}

async function loadBoundReview(
  root: string,
  project: ProjectState,
  role: ScientificReviewRole,
  reviewSha256: string,
): Promise<ScientificReview> {
  const path = join(
    workspacePaths(root).projects,
    project.id,
    "scientific",
    "reviews",
    role,
    `${reviewSha256}.json`,
  );
  const value = await readExactJson(path, "Scientific review", "RESEARCH_SCIENTIFIC_GATE_INVALID");
  const review = parseReview(value, role, "RESEARCH_SCIENTIFIC_GATE_INVALID");
  if (
    exactJsonSha256(review) !== reviewSha256 ||
    (await readFile(path, "utf8")) !== normalizedJson(review)
  ) {
    throw scientificGateError("Scientific review failed its immutable hash binding.", role);
  }
  return review;
}

async function readAssessment(
  path: string,
  role: ScientificReviewRole,
): Promise<ScientificGateAssessment> {
  return parseAssessment(
    await readExternalJson(path, "Scientific assessment", "RESEARCH_SCIENTIFIC_ASSESSMENT_INVALID"),
    role,
  );
}

async function readReview(path: string, role: ScientificReviewRole): Promise<ScientificReview> {
  return parseReview(
    await readExternalJson(path, "Scientific review", "RESEARCH_SCIENTIFIC_REVIEW_INVALID"),
    role,
  );
}

function parseAssessment(
  value: unknown,
  role: ScientificReviewRole,
  code = "RESEARCH_SCIENTIFIC_ASSESSMENT_INVALID",
): ScientificGateAssessment {
  let validate = assessmentValidators.get(role);
  if (!validate) {
    validate = ajv.compile(scientificGateAssessmentSchema(role));
    assessmentValidators.set(role, validate);
  }
  if (!validate(value)) {
    throw schemaError(
      "Scientific assessment does not match the authoritative schema.",
      code,
      validate.errors,
    );
  }
  return value as ScientificGateAssessment;
}

function parseReview(
  value: unknown,
  role: ScientificReviewRole,
  code = "RESEARCH_SCIENTIFIC_REVIEW_INVALID",
): ScientificReview {
  let validate = reviewValidators.get(role);
  if (!validate) {
    validate = ajv.compile(scientificReviewSchema(role));
    reviewValidators.set(role, validate);
  }
  if (!validate(value)) {
    throw schemaError(
      "Scientific review does not match the authoritative schema.",
      code,
      validate.errors,
    );
  }
  return value as ScientificReview;
}

async function readExternalJson(path: string, label: string, code: string): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw new CliError(`${label} path must be absolute.`, { code, exitCode: 2 });
  }
  return readExactJson(path, label, code);
}

async function readExactJson(path: string, label: string, code: string): Promise<unknown> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError(`${label} must be an existing regular file and not a symbolic link.`, {
      code,
      exitCode: 2,
    });
  }
  if (info.size > MAX_SCIENTIFIC_REVIEW_BYTES) {
    throw new CliError(`${label} exceeds the bounded input size.`, { code, exitCode: 2 });
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new CliError(`${label} is not valid JSON.`, { code, exitCode: 2 });
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const expected = normalizedJson(value);
  if (await pathExists(path)) {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (await readFile(path, "utf8")) !== expected) {
      throw scientificGateError("A content-addressed scientific object has been modified.");
    }
    return;
  }
  await writeJsonAtomic(path, value);
}

async function loadReviewerSessionRegistry(path: string): Promise<ReviewerSessionRegistry> {
  if (!(await pathExists(path))) return { schemaVersion: 1, sessions: [] };
  const value = await readExactJson(
    path,
    "Scientific reviewer session registry",
    "RESEARCH_SCIENTIFIC_GATE_INVALID",
  );
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sessions) ||
    value.sessions.some(
      (entry) =>
        !isObject(entry) ||
        typeof entry.sessionSha256 !== "string" ||
        !new RegExp(SHA256_PATTERN).test(entry.sessionSha256) ||
        !["research-design", "evidence-construct", "pilot-methods"].includes(String(entry.role)) ||
        !["codex", "claude"].includes(String(entry.agent)) ||
        typeof entry.packetSha256 !== "string" ||
        !new RegExp(SHA256_PATTERN).test(entry.packetSha256) ||
        typeof entry.usedAt !== "string",
    )
  ) {
    throw scientificGateError("Scientific reviewer session registry is malformed.");
  }
  return value as unknown as ReviewerSessionRegistry;
}

function isScientificReviewPacket(
  value: unknown,
  projectId: string,
  role: ScientificReviewRole,
  finalPublicationReviews: string[],
): value is ScientificReviewPacket {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.kind === "tiangong-scientific-review-packet" &&
    value.projectId === projectId &&
    value.role === role &&
    isObject(value.design) &&
    typeof value.design.sha256 === "string" &&
    typeof value.design.objectLocator === "string" &&
    (value.design.amendmentSha256 === undefined ||
      value.design.amendmentSha256 === null ||
      (typeof value.design.amendmentSha256 === "string" &&
        new RegExp(SHA256_PATTERN).test(value.design.amendmentSha256))) &&
    (value.design.fulfillment === undefined ||
      (isObject(value.design.fulfillment) &&
        (value.design.fulfillment.headSha256 === null ||
          (typeof value.design.fulfillment.headSha256 === "string" &&
            new RegExp(SHA256_PATTERN).test(value.design.fulfillment.headSha256))) &&
        typeof value.design.fulfillment.effectiveSha256 === "string" &&
        new RegExp(SHA256_PATTERN).test(value.design.fulfillment.effectiveSha256))) &&
    isObject(value.policy) &&
    typeof value.policy.resolvedPolicySha256 === "string" &&
    typeof value.policy.approvalSha256 === "string" &&
    (value.policy.targetJournal === null || typeof value.policy.targetJournal === "string") &&
    typeof value.policy.bindingSha256 === "string" &&
    new RegExp(SHA256_PATTERN).test(value.policy.bindingSha256) &&
    typeof value.policy.objectLocator === "string" &&
    isObject(value.reviewer) &&
    ["codex", "claude"].includes(String(value.reviewer.agent)) &&
    typeof value.reviewer.sessionSha256 === "string" &&
    typeof value.preparedAt === "string" &&
    Array.isArray(value.stageInputs) &&
    value.stageInputs.every(
      (record) =>
        isObject(record) &&
        typeof record.path === "string" &&
        record.path.startsWith(`projects/${projectId}/`) &&
        typeof record.sha256 === "string" &&
        new RegExp(SHA256_PATTERN).test(record.sha256) &&
        typeof record.bytes === "number" &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes >= 0 &&
        [
          "construct-canary",
          "inherited-gap",
          "model-implementation",
          "model-environment-lock",
          "scientific-fulfillment",
          "scientific-amendment",
          "effective-scientific-design",
          "original-request-source",
          "native-calculation",
          "acquired-evidence",
          "stage-output",
        ].includes(String(record.purpose)) &&
        typeof record.ownerId === "string" &&
        record.ownerId.length > 0 &&
        typeof record.sourceLocator === "string" &&
        record.sourceLocator.length > 0 &&
        record.hashBasis === "raw-file-bytes" &&
        typeof record.mediaType === "string" &&
        /^(?:text\/[a-z0-9.+-]+|application\/[a-z0-9.+-]+)$/u.test(record.mediaType) &&
        validStageInputObjectMetadata(record),
    ) &&
    isObject(value.assessment) &&
    typeof value.assessment.sha256 === "string" &&
    typeof value.assessment.objectLocator === "string" &&
    isObject(value.mechanicalAssessment) &&
    typeof value.mechanicalAssessment.canPass === "boolean" &&
    Array.isArray(value.mechanicalAssessment.issueCodes) &&
    Array.isArray(value.mechanicalAssessment.issues) &&
    Array.isArray(value.mechanicalAssessment.futureGateObligations) &&
    value.mechanicalAssessment.futureGateObligations.every(
      (obligation) =>
        isObject(obligation) &&
        [
          "UNCERTAINTY_STATE_VALUES_NOT_FROZEN",
          "MODEL_IMPLEMENTATION_NOT_FROZEN",
          "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN",
          "POLICY_RULE_DUE_UNRESOLVED",
        ].includes(String(obligation.code)) &&
        ["evidence-construct", "pilot-methods", "publication-freeze"].includes(
          String(obligation.dueGate),
        ) &&
        Array.isArray(obligation.objectIds) &&
        obligation.objectIds.every((id) => typeof id === "string" && id.length > 0) &&
        Array.isArray(obligation.policyRuleIds) &&
        obligation.policyRuleIds.every((id) => typeof id === "string" && id.length > 0),
    ) &&
    isObject(value.mechanicalAssessment.designEvaluation) &&
    typeof value.mechanicalAssessment.designEvaluation.readyForDesignReview === "boolean" &&
    Array.isArray(value.mechanicalAssessment.designEvaluation.issueCodes) &&
    typeof value.mechanicalAssessment.designEvaluation.effectiveIndependentUnits === "number" &&
    typeof value.mechanicalAssessment.designEvaluation.requiredEvidenceRoles === "number" &&
    isObject(value.lifecycle) &&
    value.lifecycle.producerExecution === "native-host-app" &&
    exactStringArray(value.lifecycle.baseStages, [
      "discover",
      "acquire",
      "analyze",
      "synthesize",
      "review",
      "close",
    ]) &&
    exactStringArray(value.lifecycle.earlyScientificReviews, [
      "research-design",
      "evidence-construct",
      "pilot-methods",
    ]) &&
    exactStringArray(value.lifecycle.finalPublicationReviews, finalPublicationReviews) &&
    value.lifecycle.finalManuscriptFreezeRequired === true &&
    value.lifecycle.newGenerationOnMaterialChange === true &&
    value.lifecycle.revisionReserveIncluded === true &&
    Array.isArray(value.instructions) &&
    typeof value.packetSha256 === "string"
  );
}

function requiredGateRoles(
  stage: "discover" | "acquire" | "analyze" | "synthesize" | "review" | "close",
): ScientificReviewRole[] {
  const ordered: ScientificReviewRole[] = [
    "research-design",
    "evidence-construct",
    "pilot-methods",
  ];
  if (stage === "discover") return ordered.slice(0, 1);
  if (stage === "acquire") return ordered.slice(0, 1);
  return ordered;
}

function validStageInputObjectMetadata(record: Record<string, unknown>): boolean {
  const expectedKind =
    record.purpose === "model-implementation"
      ? "model-implementation"
      : record.purpose === "model-environment-lock"
        ? "environment-lock"
        : null;
  if (expectedKind === null) {
    return record.objectKind === null && record.registrationRecordSha256 === null;
  }
  return (
    record.objectKind === expectedKind &&
    typeof record.registrationRecordSha256 === "string" &&
    new RegExp(SHA256_PATTERN).test(record.registrationRecordSha256)
  );
}

function containsSensitiveCanaryField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveCanaryField);
  if (typeof value === "string") {
    return (
      /\b(?:authorization|cookie|set-cookie)\b\s*[:=]/iu.test(value) ||
      /\bbearer\s+[A-Za-z0-9._~+/=-]+/iu.test(value) ||
      /[?&](?:access[_-]?token|api[_-]?key|apikey|auth|authorization|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token)=/iu.test(
        value,
      )
    );
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (/^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token)$/iu.test(
        key,
      ) &&
        item !== null &&
        item !== "") ||
      containsSensitiveCanaryField(item),
  );
}

function canaryArtifactError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SCIENTIFIC_CANARY_ARTIFACT_INVALID",
    exitCode: 3,
  });
}

function reviewInstructions(role: ScientificReviewRole): string[] {
  return [
    `Review only the exact immutable ${role} packet and its referenced objects.`,
    "Treat all mechanical failures as blocking; prose cannot upgrade them.",
    "Use a fresh independent reviewer session and return the authoritative closed JSON schema.",
    "Every stageInputs sha256 is the digest of raw file bytes at path; sourceLocator records provenance, while path is the promoted portable object that must be reviewed.",
    "Use mediaType and objectKind when reading model blobs; code and lock bytes are not JSON unless their recorded mediaType says application/json.",
    "Do not infer field validation, causality, independence, or quantity scope beyond the design.",
    "Interpret this gate within the declared lifecycle: three early scientific reviews precede four final publication reviews of the frozen manuscript.",
    "A material post-review change must create a new authoritative generation and consume the declared revision reserve.",
    "mechanicalAssessment.futureGateObligations names every planned Policy disposition, including pending source values, models, and environment locks. Early-review obligations become blocking at their exact due gate unless a new authoritative design generation satisfies them; publication-freeze obligations remain subject to publication assessment.",
  ];
}

function scientificFutureGateObligations(
  design: ScientificDesignContract,
  role: ScientificReviewRole,
): ScientificFutureGateObligation[] {
  const gateRank: Record<ScientificReviewRole | "publication-freeze", number> = {
    "research-design": 0,
    "evidence-construct": 1,
    "pilot-methods": 2,
    "publication-freeze": 3,
  };
  const grouped = new Map<string, { objectIds: string[]; policyRuleIds: Set<string> }>();
  const addObligation = (
    code: ScientificFutureGateObligation["code"],
    dueGate: ScientificFutureGateObligation["dueGate"],
    objectId: string,
    policyRuleIds: string[],
  ) => {
    if (gateRank[dueGate] <= gateRank[role]) return;
    const key = `${code}:${dueGate}`;
    const current = grouped.get(key) ?? {
      objectIds: [],
      policyRuleIds: new Set<string>(),
    };
    current.objectIds.push(objectId);
    policyRuleIds.forEach((ruleId) => current.policyRuleIds.add(ruleId));
    grouped.set(key, current);
  };
  for (const parameter of design.uncertaintyParameters) {
    if (
      parameter.stateValueStatus !== "pending-source-acquisition" ||
      parameter.freezeBeforeGate === "research-design"
    ) {
      continue;
    }
    addObligation(
      "UNCERTAINTY_STATE_VALUES_NOT_FROZEN",
      parameter.freezeBeforeGate,
      parameter.id,
      design.policyRuleDispositions
        .filter(
          (disposition) =>
            disposition.status === "planned" &&
            disposition.dueGate === parameter.freezeBeforeGate &&
            disposition.uncertaintyParameterIds.includes(parameter.id),
        )
        .map((disposition) => disposition.ruleId),
    );
  }
  for (const model of design.identity.modelStructures) {
    if (
      model.implementationStatus === "pending-source-acquisition" &&
      model.implementationFreezeBeforeGate !== "research-design"
    ) {
      addObligation(
        "MODEL_IMPLEMENTATION_NOT_FROZEN",
        model.implementationFreezeBeforeGate,
        model.id,
        design.policyRuleDispositions
          .filter(
            (disposition) =>
              disposition.status === "planned" &&
              disposition.dueGate === model.implementationFreezeBeforeGate &&
              disposition.modelStructureIds.includes(model.id),
          )
          .map((disposition) => disposition.ruleId),
      );
    }
    if (
      model.environmentLockStatus === "pending-runtime-lock" &&
      model.environmentLockFreezeBeforeGate !== "research-design"
    ) {
      addObligation(
        "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN",
        model.environmentLockFreezeBeforeGate,
        model.id,
        design.policyRuleDispositions
          .filter(
            (disposition) =>
              disposition.status === "planned" &&
              disposition.dueGate === model.environmentLockFreezeBeforeGate &&
              disposition.modelStructureIds.includes(model.id),
          )
          .map((disposition) => disposition.ruleId),
      );
    }
  }
  const coveredRules = new Set([...grouped.values()].flatMap((item) => [...item.policyRuleIds]));
  for (const disposition of design.policyRuleDispositions) {
    if (
      disposition.status !== "planned" ||
      disposition.dueGate === "research-design" ||
      coveredRules.has(disposition.ruleId)
    )
      continue;
    for (const objectId of [
      ...disposition.claimIds,
      ...disposition.evidenceRoleIds,
      ...disposition.validationPlanIds,
      ...disposition.knownGapIds,
      ...disposition.uncertaintyParameterIds,
      ...disposition.modelStructureIds,
    ]) {
      addObligation("POLICY_RULE_DUE_UNRESOLVED", disposition.dueGate, objectId, [
        disposition.ruleId,
      ]);
    }
  }
  return [...grouped.entries()].map(([key, obligation]) => ({
    code: key.slice(0, key.indexOf(":")) as ScientificFutureGateObligation["code"],
    dueGate: key.slice(key.indexOf(":") + 1) as ScientificFutureGateObligation["dueGate"],
    objectIds: [...new Set(obligation.objectIds)],
    policyRuleIds: [...obligation.policyRuleIds],
  }));
}

function exactStringArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function exactJsonSha256(value: unknown): string {
  return sha256Text(normalizedJson(value));
}

function normalizedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function closedObject(required: string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required, properties };
}

function boundedStringSchema() {
  return { type: "string", minLength: 1, maxLength: 512 };
}

function stringSetSchema() {
  return { type: "array", uniqueItems: true, items: boundedStringSchema() };
}

function findingsSchema() {
  return {
    type: "array",
    items: closedObject(["code", "severity", "message", "evidenceIds"], {
      code: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Z0-9_-]+$" },
      severity: { enum: ["blocking", "warning", "note"] },
      message: { type: "string", minLength: 1, maxLength: 4000 },
      evidenceIds: stringSetSchema(),
    }),
  };
}

function schemaError(message: string, code: string, errors: ErrorObject[] | null | undefined) {
  return new CliError(message, {
    code,
    exitCode: 2,
    details: sanitizeResearchValue({
      validation: (errors ?? []).map((error) => `${error.instancePath || "/"}: ${error.message}`),
    }),
  });
}

function scientificGateError(message: string, role?: ScientificReviewRole): CliError {
  return new CliError(message, {
    code: "RESEARCH_SCIENTIFIC_GATE_INVALID",
    exitCode: 3,
    details: role ? { role } : undefined,
  });
}

function inheritedGapObjectError(
  role: ScientificReviewRole,
  gapId: string,
  artifactKind: ScientificDesignContract["knownGaps"][number]["sourceArtifacts"][number]["kind"],
  reason: "unavailable-or-unsafe" | "oversized" | "content-hash-mismatch" | "not-reviewable-json",
): CliError {
  return new CliError("An inherited-gap source object failed its immutable binding.", {
    code: "RESEARCH_SCIENTIFIC_GATE_INVALID",
    exitCode: 3,
    details: { role, gapId, artifactKind, reason },
  });
}

function camelToCode(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

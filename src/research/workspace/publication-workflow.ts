import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { isConsistentAnalysisRunMetadata } from "./analysis-run.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import { appendJournalEvent, readJournal, verifyJournal } from "./journal.js";
import {
  evaluateTopJournalAssessment,
  type PublicationAssessment,
  type TopJournalAssessmentResult,
} from "./publication.js";
import { loadProject } from "./projects.js";
import { assertResearchPolicyBinding } from "./research-policy.js";
import { assertScientificGateForStage } from "./scientific-review.js";
import { compileTaskAcceptanceContext, type TaskAcceptanceContext } from "./task-acceptance.js";
import {
  analysisGenerationId,
  closedAnalysisLineage,
  RESULT_CORE_FILES,
  verifyMaterialResultLineage,
  lineageError,
  type AnalysisLineage,
} from "./publication-lineage.js";
import { validateTaskObject } from "./task-contract.js";
import {
  canonicalJson,
  ensureDirectory,
  fileRecord,
  isObject,
  pathExists,
  readJsonFile,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { AgentKind, ProjectState, ResearchPolicyBinding } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

export type PublicationReviewRole =
  | "evidence"
  | "methods-reproducibility"
  | "domain-novelty"
  | "journal-editor";

export type PublicationReadinessVerdict =
  | "independent-review-incomplete"
  | "revision-required"
  | "top-journal-candidate"
  | "top-journal-class-ready"
  | "target-journal-submission-ready";

const REQUIRED_REVIEW_ROLES: PublicationReviewRole[] = [
  "evidence",
  "methods-reproducibility",
  "domain-novelty",
  "journal-editor",
];

const SPECIALIST_DECISIONS = new Set(["pass", "revise", "reject"]);
const EDITOR_DECISIONS = new Set([
  "submission-ready",
  "minor-revision",
  "major-revision",
  "reject-and-redesign",
  "desk-reject",
]);

export type PublicationSubmissionRole =
  | "cover-letter"
  | "title-page"
  | "reporting-checklist"
  | "data-availability"
  | "code-availability"
  | "source-data"
  | "figure-table-index"
  | "extended-data"
  | "supplementary-methods";

const REQUIRED_SUBMISSION_ROLES: PublicationSubmissionRole[] = [
  "cover-letter",
  "title-page",
  "reporting-checklist",
  "data-availability",
  "code-availability",
  "source-data",
];

const SUBMISSION_ROLES = new Set<PublicationSubmissionRole>([
  ...REQUIRED_SUBMISSION_ROLES,
  "figure-table-index",
  "extended-data",
  "supplementary-methods",
]);

interface FrozenFile {
  logicalName: string;
  sha256: string;
  bytes: number;
  objectLocator: string;
}

interface FrozenSubmissionFile extends FrozenFile {
  role: PublicationSubmissionRole;
}

interface PublicationSubmissionPackage {
  schemaVersion: 1;
  requiredRoles: PublicationSubmissionRole[];
  files: FrozenSubmissionFile[];
  contentSnapshot: FrozenFile;
  inferenceSnapshot: FrozenFile;
  claimEvidenceGraph: FrozenFile;
  reproducibilityManifest: FrozenFile;
  packageSha256: string;
}

interface PublicationGeneration {
  schemaVersion: 1;
  kind: "tiangong-publication-generation";
  projectId: string;
  generationSha256: string;
  frozenAt: string;
  producer: {
    agent: AgentKind;
    sessionSha256: string;
  };
  policy: {
    projectId: string;
    resolvedPolicySha256: string;
    approvalSha256: string;
    verdictCeiling: ResearchPolicyBinding["verdictCeiling"];
    targetJournal: string | null;
  };
  evidenceSnapshot: {
    id: string;
    sha256: string;
    object: FrozenFile;
  };
  baseResearch: {
    closure: FrozenFile;
    analysis: FrozenFile;
    report: FrozenFile;
  };
  manuscript: FrozenFile;
  assessment: FrozenFile;
  supplements: FrozenFile[];
  submissionPackage: PublicationSubmissionPackage;
  assessmentResult: TopJournalAssessmentResult;
  requiredReviewRoles: PublicationReviewRole[];
  taskAcceptanceSha256?: string | null;
  analysisGenerationId?: string;
  materialResultsManifest?: FrozenFile;
}

interface PublicationCurrentPointer {
  schemaVersion: 1;
  projectId: string;
  generationSha256: string;
  manifestLocator: string;
  updatedAt: string;
}

interface ReviewerSessionRegistry {
  schemaVersion: 1;
  sessions: Array<{
    sessionSha256: string;
    projectId: string;
    generationSha256: string;
    role: PublicationReviewRole;
    agent: AgentKind;
    registeredAt: string;
  }>;
}

export interface PublicationReviewPacket {
  schemaVersion: 1;
  kind: "tiangong-publication-review-packet";
  projectId: string;
  generationSha256: string;
  role: PublicationReviewRole;
  reviewer: {
    agent: AgentKind;
    sessionSha256: string;
  };
  preparedAt: string;
  policy: PublicationGeneration["policy"] & {
    documents: ResearchPolicyBinding["documents"];
    resolvedRules: string[];
    resolvedConstraints: ResearchPolicyBinding["resolvedConstraints"];
  };
  evidenceSnapshot: {
    id: string;
    sha256: string;
    objectLocator: string;
  };
  baseResearch: PublicationGeneration["baseResearch"];
  manuscript: FrozenFile;
  assessment: FrozenFile;
  supplements: FrozenFile[];
  submissionPackage: PublicationSubmissionPackage;
  mechanicalAssessment: TopJournalAssessmentResult;
  taskAcceptance: TaskAcceptanceContext | null;
  instructions: string[];
  packetSha256: string;
  analysisGenerationId: string;
  materialResultsManifest: FrozenFile;
}

interface PublicationReviewRecord {
  schemaVersion: 1;
  role: PublicationReviewRole;
  packetSha256: string;
  reviewerSessionSha256: string;
  decision: string;
  findings: Array<{
    code: string;
    severity: "blocking" | "major" | "minor";
    message: string;
    evidenceIds: string[];
  }>;
  boundedRecommendation: string;
}

export interface PublicationStatus {
  schemaVersion: 1;
  projectId: string;
  generationSha256: string | null;
  manuscriptSha256: string | null;
  submissionPackageSha256: string | null;
  submissionRoles: PublicationSubmissionRole[];
  contentSnapshotSha256: string | null;
  inferenceSnapshotSha256: string | null;
  claimEvidenceGraphSha256: string | null;
  generationStatus: "waiting-for-base-research" | "not-started" | "manuscript-frozen" | "invalid";
  reviewState: "not-started" | "partial" | "complete";
  requiredReviewRoles: PublicationReviewRole[];
  completedReviewRoles: PublicationReviewRole[];
  missingReviewRoles: PublicationReviewRole[];
  mechanicalIssues: string[];
  pivotOptions: string[];
  readinessVerdict: PublicationReadinessVerdict;
  boundedStatement: string;
  closureSha256: string | null;
  analysisGenerationId?: string;
  materialResultsManifestSha256?: string;
}

export interface PublicationClosure {
  schemaVersion: 1;
  kind: "tiangong-publication-closure";
  projectId: string;
  generationSha256: string;
  closedAt: string;
  policy: PublicationGeneration["policy"];
  evidenceSnapshot: PublicationGeneration["evidenceSnapshot"];
  baseResearch: PublicationGeneration["baseResearch"];
  manuscript: FrozenFile;
  assessment: FrozenFile;
  supplements: FrozenFile[];
  submissionPackage: PublicationSubmissionPackage;
  reviews: Array<{
    role: PublicationReviewRole;
    packetSha256: string;
    reviewSha256: string;
    reviewerSessionSha256: string;
    decision: string;
  }>;
  mechanicalIssues: string[];
  pivotOptions: string[];
  readinessVerdict: PublicationReadinessVerdict;
  boundedStatement: string;
  closureSha256: string;
  analysisGenerationId: string;
  materialResultsManifest: FrozenFile;
}

export function publicationAssessmentSchema(): Record<string, unknown> {
  const stringArraySchema = { type: "array", items: { type: "string", minLength: 1 } };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Tiangong top-journal publication assessment",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "title",
      "claims",
      "outcomes",
      "titleOutcomeIds",
      "results",
      "sourceClassifications",
      "recallAudit",
    ],
    properties: {
      schemaVersion: { const: 1 },
      title: { type: "string", minLength: 8 },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "statement", "evidenceSourceIds", "dimensionIds", "resultIds"],
          properties: {
            id: { type: "string", minLength: 1 },
            role: { enum: ["central", "supporting", "contextual", "future-research"] },
            statement: { type: "string", minLength: 1 },
            evidenceSourceIds: stringArraySchema,
            dimensionIds: stringArraySchema,
            resultIds: stringArraySchema,
          },
        },
      },
      outcomes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "label", "supportStatus", "claimIds", "resultIds"],
          properties: {
            id: { type: "string", minLength: 1 },
            role: { enum: ["central", "supporting", "contextual"] },
            label: { type: "string", minLength: 1 },
            supportStatus: {
              enum: [
                "unobserved",
                "future-work",
                "conceptual-proposition",
                "calibrated-model",
                "causal-estimate",
                "field-observation",
                "validated-forecast",
                "systematic-synthesis",
              ],
            },
            claimIds: stringArraySchema,
            resultIds: stringArraySchema,
          },
        },
      },
      titleOutcomeIds: stringArraySchema,
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "role",
            "resultClass",
            "statement",
            "evidenceSourceIds",
            "independentlyReproduced",
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            role: { enum: ["central", "supporting", "contextual"] },
            resultClass: {
              enum: [
                "definition",
                "accounting-identity",
                "illustrative-sensitivity",
                "calibrated-model",
                "causal-estimate",
                "field-observation",
                "validated-forecast",
                "systematic-synthesis",
                "conceptual-proposition",
              ],
            },
            statement: { type: "string", minLength: 1 },
            evidenceSourceIds: stringArraySchema,
            independentlyReproduced: { type: "boolean" },
          },
        },
      },
      sourceClassifications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceId", "relationship", "evidenceKind"],
          properties: {
            sourceId: { type: "string", minLength: 1 },
            relationship: { enum: ["direct", "adjacent", "contextual"] },
            evidenceKind: {
              enum: [
                "peer-reviewed-empirical",
                "peer-reviewed-model",
                "peer-reviewed-review",
                "official-data",
                "administrative-record",
                "patent",
                "news",
                "owner-provided-input",
                "internal-model",
                "other",
              ],
            },
          },
        },
      },
      recallAudit: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "candidateDispositionComplete",
          "databaseCoverageComplete",
          "backwardCitationChasing",
          "forwardCitationChasing",
          "adversarialSearch",
          "closestPriorWorkCompared",
          "missingCoreWorkIds",
        ],
        properties: {
          status: { enum: ["pass", "fail", "incomplete"] },
          candidateDispositionComplete: { type: "boolean" },
          databaseCoverageComplete: { type: "boolean" },
          backwardCitationChasing: { type: "boolean" },
          forwardCitationChasing: { type: "boolean" },
          adversarialSearch: { type: "boolean" },
          closestPriorWorkCompared: { type: "boolean" },
          missingCoreWorkIds: stringArraySchema,
        },
      },
    },
  };
}

export function publicationReviewSchema(role: PublicationReviewRole): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Tiangong ${role} publication review`,
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
      packetSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      reviewerSessionSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      decision: {
        enum: role === "journal-editor" ? [...EDITOR_DECISIONS] : [...SPECIALIST_DECISIONS],
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "severity", "message", "evidenceIds"],
          properties: {
            code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
            severity: { enum: ["blocking", "major", "minor"] },
            message: { type: "string", minLength: 1 },
            evidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
          },
        },
      },
      boundedRecommendation: { type: "string", minLength: 8, maxLength: 4_000 },
    },
  };
}

export async function freezePublicationManuscript(input: {
  root: string;
  projectId: string;
  manuscriptPath: string;
  assessmentPath: string;
  supplementPaths: string[];
  submissionFiles?: Array<{ role: PublicationSubmissionRole; path: string }>;
  resultLineage?: unknown;
  producerAgent: AgentKind;
  producerSessionId: string;
}): Promise<PublicationGeneration & { status: "manuscript-frozen" }> {
  return withWorkspaceLock(input.root, "research.publication.freeze", async () => {
    const project = await requireClosedTopJournalProject(input.root, input.projectId);
    const config = await loadWorkspaceConfig(input.root);
    if (config.producer.agent !== input.producerAgent) {
      throw publicationError(
        "RESEARCH_PUBLICATION_PRODUCER_MISMATCH",
        "Publication generation must be frozen by the configured native producer agent family.",
        3,
        {
          configuredProducer: config.producer.agent,
          requestedProducer: input.producerAgent,
        },
      );
    }
    await assertScientificGateForStage(input.root, project, "close");
    const producerSessionId = requireSessionId(input.producerSessionId, "producer");
    const producerSessionSha256 = sha256Text(producerSessionId);
    if ((await usedReviewerSessionHashes(input.root, project.id)).has(producerSessionSha256)) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
        "A native producer session must not reuse any prior independent reviewer session.",
      );
    }
    const projectRoot = projectDirectory(input.root, project.id);
    const outputRoot = join(projectRoot, "outputs");

    const manuscript = await storePublicationObject(
      input.root,
      project.id,
      input.manuscriptPath,
      "manuscript",
    );
    const assessment = await storePublicationObject(
      input.root,
      project.id,
      input.assessmentPath,
      "publication-assessment",
    );
    const assessmentValue = parsePublicationAssessment(
      JSON.parse(
        await readRegularTextFile(
          join(projectRoot, assessment.objectLocator),
          "publication assessment",
        ),
      ),
    );
    await validateSubmissionManuscript(join(projectRoot, manuscript.objectLocator));
    const supplements: FrozenFile[] = [];
    for (const [index, path] of [...new Set(input.supplementPaths)].entries()) {
      supplements.push(
        await storePublicationObject(input.root, project.id, path, `supplement-${index + 1}`),
      );
    }
    const declaredSubmissionFiles = input.submissionFiles ?? [];
    const declaredRoles = declaredSubmissionFiles.map((file) => file.role);
    const missingSubmissionRoles = REQUIRED_SUBMISSION_ROLES.filter(
      (role) => !declaredRoles.includes(role),
    );
    if (
      missingSubmissionRoles.length ||
      new Set(declaredRoles).size !== declaredRoles.length ||
      new Set(declaredSubmissionFiles.map((file) => resolve(file.path))).size !==
        declaredSubmissionFiles.length ||
      declaredSubmissionFiles.some((file) => !SUBMISSION_ROLES.has(file.role))
    ) {
      throw publicationError(
        "RESEARCH_PUBLICATION_SUBMISSION_PACKAGE_INVALID",
        "Submission package roles must be explicit, unique, complete, and bound to distinct files.",
        3,
        { missingSubmissionRoles },
      );
    }
    const submissionFiles: FrozenSubmissionFile[] = [];
    for (const file of declaredSubmissionFiles.sort((left, right) =>
      left.role.localeCompare(right.role),
    )) {
      submissionFiles.push({
        role: file.role,
        ...(await storePublicationObject(
          input.root,
          project.id,
          file.path,
          `submission-${file.role}`,
        )),
      });
    }
    const evidenceSnapshot = await storePublicationObject(
      input.root,
      project.id,
      join(outputRoot, "evidence-snapshot.json"),
      "evidence-snapshot",
      true,
    );
    const baseResearch = {
      closure: await storePublicationObject(
        input.root,
        project.id,
        join(outputRoot, "closure.json"),
        "base-closure",
        true,
      ),
      analysis: await storePublicationObject(
        input.root,
        project.id,
        join(outputRoot, "analysis.json"),
        "analysis",
        true,
      ),
      report: await storePublicationObject(
        input.root,
        project.id,
        join(outputRoot, "report.md"),
        "research-report",
        true,
      ),
    };
    const contentSnapshot = await storePublicationObject(
      input.root,
      project.id,
      join(outputRoot, "content-snapshot.json"),
      "content-snapshot",
      true,
    );
    const inferenceSnapshot = await storePublicationObject(
      input.root,
      project.id,
      join(outputRoot, "inference-snapshot.json"),
      "inference-snapshot",
      true,
    );
    const claimEvidenceGraph = await storePublicationObject(
      input.root,
      project.id,
      join(outputRoot, "claim-evidence-graph.json"),
      "claim-evidence-graph",
      true,
    );
    const coreObjects = {
      "analysis.json": baseResearch.analysis,
      "report.md": baseResearch.report,
      "claim-evidence-graph.json": claimEvidenceGraph,
      "content-snapshot.json": contentSnapshot,
      "inference-snapshot.json": inferenceSnapshot,
      "evidence-snapshot.json": evidenceSnapshot,
    };
    const frozenPaths = Object.fromEntries(
      Object.entries(coreObjects).map(([name, file]) => [
        name,
        join(projectRoot, file.objectLocator),
      ]),
    );
    const snapshotValue = await readJsonFile<Record<string, unknown>>(
      frozenPaths["evidence-snapshot.json"]!,
      "Frozen evidence snapshot",
    );
    const snapshotSha256 = verifiedSnapshotSha256(project, snapshotValue);
    const closureValue = await readJsonFile<Record<string, unknown>>(
      join(projectRoot, baseResearch.closure.objectLocator),
      "Base research closure",
    );
    assertBaseClosure(project, closureValue, snapshotSha256);
    const submissionBindings = await validateSubmissionBindings(
      outputRoot,
      project.id,
      String(snapshotValue.snapshotId),
      snapshotSha256,
      project.publicationPolicy!.resolvedPolicySha256,
      frozenPaths,
    );
    const baseLineage = await closedAnalysisLineage({
      root: input.root,
      projectId: project.id,
      closure: closureValue,
      analysis: submissionBindings.analysis,
      records: Object.fromEntries(
        Object.entries(coreObjects).map(([name, file]) => [
          name,
          { path: `outputs/${name}`, sha256: file.sha256, bytes: file.bytes },
        ]),
      ),
    });
    const materialLineage = verifyMaterialResultLineage(
      input.resultLineage,
      baseLineage,
      materialFiles(manuscript, assessment, supplements, submissionFiles),
    );
    const materialResultsPath = join(outputRoot, "material-results-manifest.json");
    await writeJsonAtomic(materialResultsPath, materialLineage);
    const materialResultsManifest = await storePublicationObject(
      input.root,
      project.id,
      materialResultsPath,
      "material-results-manifest",
      true,
    );
    const resultGenerationId = analysisGenerationId(baseLineage);
    const analysisValue = submissionBindings.analysis;
    const reproducibilityPath = join(outputRoot, "submission-reproducibility.json");
    await writeJsonAtomic(reproducibilityPath, {
      schemaVersion: 1,
      kind: "tiangong-submission-reproducibility",
      projectId: project.id,
      analysisRun: isObject(analysisValue.analysisRun) ? analysisValue.analysisRun : null,
      bindings: {
        analysisGenerationId: resultGenerationId,
        materialResultsManifestSha256: materialResultsManifest.sha256,
        evidenceSnapshotSha256: evidenceSnapshot.sha256,
        contentSnapshotSha256: contentSnapshot.sha256,
        inferenceSnapshotSha256: inferenceSnapshot.sha256,
        claimEvidenceGraphSha256: claimEvidenceGraph.sha256,
        analysisSha256: baseResearch.analysis.sha256,
      },
    });
    const reproducibilityManifest = await storePublicationObject(
      input.root,
      project.id,
      reproducibilityPath,
      "reproducibility-manifest",
      true,
    );
    const submissionPackageCore = {
      schemaVersion: 1 as const,
      requiredRoles: REQUIRED_SUBMISSION_ROLES,
      files: submissionFiles,
      contentSnapshot,
      inferenceSnapshot,
      claimEvidenceGraph,
      reproducibilityManifest,
    };
    const submissionPackage: PublicationSubmissionPackage = {
      ...submissionPackageCore,
      packageSha256: sha256Text(canonicalJson(submissionPackageCore)),
    };
    const assessmentResult = evaluateTopJournalAssessment({
      policy: project.publicationPolicy!,
      evidenceSnapshot: snapshotValue as never,
      inputs: project.inputs,
      assessment: assessmentValue,
    });
    const frozenAt = new Date().toISOString();
    const generationCore = {
      schemaVersion: 1 as const,
      kind: "tiangong-publication-generation" as const,
      projectId: project.id,
      frozenAt,
      producer: { agent: input.producerAgent, sessionSha256: producerSessionSha256 },
      policy: policySummary(project.publicationPolicy!),
      evidenceSnapshot: {
        id: String(snapshotValue.snapshotId),
        sha256: snapshotSha256,
        object: evidenceSnapshot,
      },
      baseResearch,
      manuscript,
      assessment,
      supplements,
      submissionPackage,
      analysisGenerationId: resultGenerationId,
      materialResultsManifest,
      assessmentResult,
      requiredReviewRoles: requiredReviewRoles(project.publicationPolicy!),
      taskAcceptanceSha256:
        (await compileTaskAcceptanceContext(input.root, project))?.contextSha256 ?? null,
    };
    const generationSha256 = sha256Text(canonicalJson(generationCore));
    const generation: PublicationGeneration = { ...generationCore, generationSha256 };
    const manifestLocator = generationManifestLocator(generationSha256);
    await writeImmutableJson(
      join(projectRoot, manifestLocator),
      generation,
      generationSha256,
      "publication generation",
    );
    const pointer: PublicationCurrentPointer = {
      schemaVersion: 1,
      projectId: project.id,
      generationSha256,
      manifestLocator,
      updatedAt: frozenAt,
    };
    await writeJsonAtomic(publicationCurrentPath(input.root, project.id), pointer);
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "publication.manuscript.frozen",
      project.id,
      {
        projectId: project.id,
        generationSha256,
        manuscriptSha256: manuscript.sha256,
        assessmentSha256: assessment.sha256,
        evidenceSnapshotSha256: snapshotSha256,
        submissionPackageSha256: submissionPackage.packageSha256,
        policySha256: project.publicationPolicy!.resolvedPolicySha256,
        producerAgent: input.producerAgent,
        mechanicalIssueCodes: assessmentResult.issueCodes,
      },
    );
    return { ...generation, status: "manuscript-frozen" };
  });
}

export async function preparePublicationReview(input: {
  root: string;
  projectId: string;
  role: PublicationReviewRole;
  reviewerAgent: AgentKind;
  reviewerSessionId: string;
}): Promise<PublicationReviewPacket> {
  return withWorkspaceLock(input.root, "research.publication.review.prepare", async () => {
    const project = await requireClosedTopJournalProject(input.root, input.projectId);
    const generation = await loadCurrentGeneration(input.root, project.id);
    const config = await loadWorkspaceConfig(input.root);
    if (input.reviewerAgent === generation.producer.agent) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
        "Publication review must use a different agent family from the native producer.",
      );
    }
    if (config.reviewer.agent !== input.reviewerAgent) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEWER_MISMATCH",
        "Publication review must use the configured independent reviewer route.",
        3,
        {
          configuredReviewer: config.reviewer.agent,
          requestedReviewer: input.reviewerAgent,
        },
      );
    }
    const sessionId = requireSessionId(input.reviewerSessionId, "reviewer");
    if (!generation.requiredReviewRoles.includes(input.role)) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_ROLE_INVALID",
        `The ${input.role} review is not declared by the approved policy.`,
        2,
      );
    }
    const sessionSha256 = sha256Text(sessionId);
    if (sessionSha256 === generation.producer.sessionSha256) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
        "A reviewer session must differ from the native producer session.",
      );
    }
    const registry = await loadReviewerRegistry(input.root, project.id);
    const usedSessions = await usedReviewerSessionHashes(input.root, project.id);
    if (
      usedSessions.has(sessionSha256) ||
      registry.sessions.some((entry) => entry.sessionSha256 === sessionSha256)
    ) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
        "Each required review must use a fresh independent reviewer session.",
      );
    }
    const packetPath = reviewPacketPath(
      input.root,
      project.id,
      generation.generationSha256,
      input.role,
    );
    if (await pathExists(packetPath)) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_ALREADY_PREPARED",
        `The ${input.role} review packet is already prepared for this frozen generation.`,
      );
    }
    const preparedAt = new Date().toISOString();
    const packetCore = {
      schemaVersion: 1 as const,
      kind: "tiangong-publication-review-packet" as const,
      projectId: project.id,
      generationSha256: generation.generationSha256,
      role: input.role,
      reviewer: { agent: input.reviewerAgent, sessionSha256 },
      preparedAt,
      policy: {
        ...generation.policy,
        documents: project.publicationPolicy!.documents,
        resolvedRules: project.publicationPolicy!.resolvedRules,
        resolvedConstraints: project.publicationPolicy!.resolvedConstraints,
      },
      evidenceSnapshot: {
        id: generation.evidenceSnapshot.id,
        sha256: generation.evidenceSnapshot.sha256,
        objectLocator: generation.evidenceSnapshot.object.objectLocator,
      },
      baseResearch: generation.baseResearch,
      manuscript: generation.manuscript,
      assessment: generation.assessment,
      supplements: generation.supplements,
      submissionPackage: generation.submissionPackage,
      analysisGenerationId: generation.analysisGenerationId!,
      materialResultsManifest: generation.materialResultsManifest!,
      mechanicalAssessment: generation.assessmentResult,
      taskAcceptance: await compileTaskAcceptanceContext(input.root, project),
      instructions: reviewInstructions(input.role),
    };
    const packet: PublicationReviewPacket = {
      ...packetCore,
      packetSha256: sha256Text(canonicalJson(packetCore)),
    };
    await writeImmutableJson(packetPath, packet, packet.packetSha256, "publication review packet");
    registry.sessions.push({
      sessionSha256,
      projectId: project.id,
      generationSha256: generation.generationSha256,
      role: input.role,
      agent: input.reviewerAgent,
      registeredAt: preparedAt,
    });
    registry.sessions.sort((left, right) => left.sessionSha256.localeCompare(right.sessionSha256));
    await writeJsonAtomic(reviewerRegistryPath(input.root, project.id), registry);
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "publication.review.prepared",
      project.id,
      {
        projectId: project.id,
        generationSha256: generation.generationSha256,
        role: input.role,
        reviewerAgent: input.reviewerAgent,
        reviewerSessionSha256: sessionSha256,
        packetSha256: packet.packetSha256,
      },
    );
    return packet;
  });
}

export async function submitPublicationReview(input: {
  root: string;
  projectId: string;
  role: PublicationReviewRole;
  reviewPath: string;
}): Promise<{ role: PublicationReviewRole; reviewSha256: string; decision: string }> {
  return withWorkspaceLock(input.root, "research.publication.review.submit", async () => {
    await requireClosedTopJournalProject(input.root, input.projectId);
    const generation = await loadCurrentGeneration(input.root, input.projectId);
    const packet = await loadReviewPacket(input.root, input.projectId, generation, input.role);
    const review = parsePublicationReview(
      JSON.parse(await readRegularTextFile(input.reviewPath, "publication review")),
      input.role,
    );
    if (
      review.packetSha256 !== packet.packetSha256 ||
      review.reviewerSessionSha256 !== packet.reviewer.sessionSha256
    ) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_BINDING_INVALID",
        "The submitted review does not bind the prepared packet and reviewer session.",
      );
    }
    const path = submittedReviewPath(
      input.root,
      input.projectId,
      generation.generationSha256,
      input.role,
    );
    if (await pathExists(path)) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_ALREADY_SUBMITTED",
        `The ${input.role} review is already submitted for this frozen generation.`,
      );
    }
    const reviewSha256 = sha256Text(canonicalJson(review));
    await writeImmutableJson(path, review, reviewSha256, "publication review");
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "publication.review.submitted",
      input.projectId,
      {
        projectId: input.projectId,
        generationSha256: generation.generationSha256,
        role: input.role,
        packetSha256: packet.packetSha256,
        reviewSha256,
        decision: review.decision,
      },
    );
    return { role: input.role, reviewSha256, decision: review.decision };
  });
}

export async function inspectPublicationStatus(
  root: string,
  projectId: string,
): Promise<PublicationStatus> {
  const project = await requireTopJournalProject(root, projectId);
  if (
    project.status !== "complete" ||
    project.packages.some((item) => item.status !== "complete")
  ) {
    return {
      schemaVersion: 1,
      projectId,
      generationSha256: null,
      manuscriptSha256: null,
      submissionPackageSha256: null,
      submissionRoles: [],
      contentSnapshotSha256: null,
      inferenceSnapshotSha256: null,
      claimEvidenceGraphSha256: null,
      generationStatus: "waiting-for-base-research",
      reviewState: "not-started",
      requiredReviewRoles: requiredReviewRoles(project.publicationPolicy!),
      completedReviewRoles: [],
      missingReviewRoles: requiredReviewRoles(project.publicationPolicy!),
      mechanicalIssues: [],
      pivotOptions: [],
      readinessVerdict: "independent-review-incomplete",
      boundedStatement:
        "The final manuscript cannot be frozen until base research closes mechanically.",
      closureSha256: null,
    };
  }
  if (!(await pathExists(publicationCurrentPath(root, projectId)))) {
    return {
      schemaVersion: 1,
      projectId,
      generationSha256: null,
      manuscriptSha256: null,
      submissionPackageSha256: null,
      submissionRoles: [],
      contentSnapshotSha256: null,
      inferenceSnapshotSha256: null,
      claimEvidenceGraphSha256: null,
      generationStatus: "not-started",
      reviewState: "not-started",
      requiredReviewRoles: REQUIRED_REVIEW_ROLES,
      completedReviewRoles: [],
      missingReviewRoles: REQUIRED_REVIEW_ROLES,
      mechanicalIssues: [],
      pivotOptions: [],
      readinessVerdict: "independent-review-incomplete",
      boundedStatement: "No final manuscript has been frozen for independent review.",
      closureSha256: null,
    };
  }
  const generation = await loadCurrentGeneration(root, projectId);
  const reviews = await loadSubmittedReviews(root, projectId, generation);
  const completedReviewRoles = reviews.map((entry) => entry.role);
  const missingReviewRoles = generation.requiredReviewRoles.filter(
    (role) => !completedReviewRoles.includes(role),
  );
  const reviewState = !completedReviewRoles.length
    ? "not-started"
    : missingReviewRoles.length
      ? "partial"
      : "complete";
  const readinessVerdict = computeReadinessVerdict(generation, reviews, missingReviewRoles);
  const closurePath = publicationClosurePath(root, projectId, generation.generationSha256);
  const closureSha256 = (await pathExists(closurePath))
    ? (await loadPublicationClosure(closurePath, generation.generationSha256)).closureSha256
    : null;
  return {
    schemaVersion: 1,
    projectId,
    generationSha256: generation.generationSha256,
    manuscriptSha256: generation.manuscript.sha256,
    submissionPackageSha256: generation.submissionPackage.packageSha256,
    submissionRoles: generation.submissionPackage.files.map((file) => file.role),
    contentSnapshotSha256: generation.submissionPackage.contentSnapshot.sha256,
    inferenceSnapshotSha256: generation.submissionPackage.inferenceSnapshot.sha256,
    claimEvidenceGraphSha256: generation.submissionPackage.claimEvidenceGraph.sha256,
    generationStatus: "manuscript-frozen",
    reviewState,
    requiredReviewRoles: generation.requiredReviewRoles,
    completedReviewRoles,
    missingReviewRoles,
    mechanicalIssues: generation.assessmentResult.issueCodes,
    pivotOptions: generation.assessmentResult.pivotOptions,
    readinessVerdict,
    boundedStatement: boundedStatement(readinessVerdict),
    closureSha256,
    analysisGenerationId: generation.analysisGenerationId!,
    materialResultsManifestSha256: generation.materialResultsManifest!.sha256,
  };
}

export async function closePublication(
  root: string,
  projectId: string,
): Promise<PublicationClosure> {
  return withWorkspaceLock(root, "research.publication.close", async () => {
    await requireClosedTopJournalProject(root, projectId);
    const generation = await loadCurrentGeneration(root, projectId);
    const reviews = await loadSubmittedReviews(root, projectId, generation);
    const missing = generation.requiredReviewRoles.filter(
      (role) => !reviews.some((entry) => entry.role === role),
    );
    if (missing.length) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_INCOMPLETE",
        "Publication closure requires every policy-mandated independent review.",
        3,
        { missingReviewRoles: missing },
      );
    }
    const existingPath = publicationClosurePath(root, projectId, generation.generationSha256);
    if (await pathExists(existingPath)) {
      return loadPublicationClosure(existingPath, generation.generationSha256);
    }
    const readinessVerdict = computeReadinessVerdict(generation, reviews, []);
    const closedAt = new Date().toISOString();
    const closureCore = {
      schemaVersion: 1 as const,
      kind: "tiangong-publication-closure" as const,
      projectId,
      generationSha256: generation.generationSha256,
      closedAt,
      policy: generation.policy,
      evidenceSnapshot: generation.evidenceSnapshot,
      baseResearch: generation.baseResearch,
      manuscript: generation.manuscript,
      assessment: generation.assessment,
      supplements: generation.supplements,
      submissionPackage: generation.submissionPackage,
      analysisGenerationId: generation.analysisGenerationId!,
      materialResultsManifest: generation.materialResultsManifest!,
      reviews: reviews.map((entry) => ({
        role: entry.role,
        packetSha256: entry.packet.packetSha256,
        reviewSha256: entry.reviewSha256,
        reviewerSessionSha256: entry.review.reviewerSessionSha256,
        decision: entry.review.decision,
      })),
      mechanicalIssues: generation.assessmentResult.issueCodes,
      pivotOptions: generation.assessmentResult.pivotOptions,
      readinessVerdict,
      boundedStatement: boundedStatement(readinessVerdict),
    };
    const closure: PublicationClosure = {
      ...closureCore,
      closureSha256: sha256Text(canonicalJson(closureCore)),
    };
    await writeImmutableJson(existingPath, closure, closure.closureSha256, "publication closure");
    await appendJournalEvent(workspacePaths(root).journal, "publication.closed", projectId, {
      projectId,
      generationSha256: generation.generationSha256,
      closureSha256: closure.closureSha256,
      readinessVerdict,
      policySha256: generation.policy.resolvedPolicySha256,
      evidenceSnapshotSha256: generation.evidenceSnapshot.sha256,
      manuscriptSha256: generation.manuscript.sha256,
    });
    return closure;
  });
}

async function requireClosedTopJournalProject(
  root: string,
  projectId: string,
): Promise<ProjectState> {
  const project = await requireTopJournalProject(root, projectId);
  if (
    project.status !== "complete" ||
    project.packages.some((item) => item.status !== "complete")
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_BASE_RESEARCH_INCOMPLETE",
      "Freeze the final manuscript only after the evidence-report research project is mechanically closed.",
      3,
    );
  }
  return project;
}

async function requireTopJournalProject(root: string, projectId: string): Promise<ProjectState> {
  const project = await loadProject(root, projectId);
  if (!project.publicationPolicy) {
    throw publicationError(
      "RESEARCH_PUBLICATION_POLICY_REQUIRED",
      "The publication workflow requires an approved top-journal policy binding.",
      3,
    );
  }
  await assertResearchPolicyBinding(root, project.publicationPolicy);
  return project;
}

function verifiedSnapshotSha256(project: ProjectState, snapshot: Record<string, unknown>): string {
  const recorded = snapshot.snapshotSha256;
  if (typeof recorded !== "string" || !/^[a-f0-9]{64}$/.test(recorded)) {
    throw publicationError(
      "RESEARCH_PUBLICATION_BINDING_INVALID",
      "The evidence snapshot hash is invalid.",
    );
  }
  const { snapshotSha256: _ignored, ...withoutHash } = snapshot;
  if (
    sha256Text(canonicalJson(withoutHash)) !== recorded ||
    snapshot.snapshotId !== project.evidenceState.currentSnapshotId ||
    recorded !== project.evidenceState.currentSnapshotSha256 ||
    snapshot.snapshotId !== project.evidenceState.closureSnapshotId
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_BINDING_INVALID",
      "The final manuscript must bind the current mechanically closed evidence snapshot.",
    );
  }
  return recorded;
}

function assertBaseClosure(
  project: ProjectState,
  closure: Record<string, unknown>,
  snapshotSha256: string,
): void {
  const evidenceSnapshot = isObject(closure.evidenceSnapshot) ? closure.evidenceSnapshot : {};
  const policy = isObject(closure.publicationPolicy) ? closure.publicationPolicy : {};
  if (
    closure.projectId !== project.id ||
    closure.status !== "complete" ||
    evidenceSnapshot.snapshotSha256 !== snapshotSha256 ||
    evidenceSnapshot.snapshotId !== project.evidenceState.closureSnapshotId ||
    policy.resolvedPolicySha256 !== project.publicationPolicy!.resolvedPolicySha256 ||
    policy.approvalSha256 !== project.publicationPolicy!.approvalSha256
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_BINDING_INVALID",
      "The base research closure does not bind the current evidence snapshot and approved policy.",
    );
  }
}

async function validateSubmissionManuscript(path: string): Promise<void> {
  const canonical = requireAbsolutePath(path, "manuscript");
  if (![".md", ".txt"].includes(extname(canonical).toLowerCase())) {
    throw publicationError(
      "RESEARCH_PUBLICATION_MANUSCRIPT_INCOMPLETE",
      "The submission manuscript source must be Markdown or plain text for deterministic section validation.",
      3,
    );
  }
  const content = await readRegularTextFile(canonical, "submission manuscript");
  const headings = [...content.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)].map((match) =>
    (match[1] ?? "")
      // Strip only a conservative section number ("1", "3.1") optionally closed
      // by "." or ")" and followed by required whitespace; "1Introduction" stays.
      .replace(/^\d+(?:\.\d+)*[.)]?[ \t]+/u, "")
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, " ")
      .trim(),
  );
  const required = [
    { id: "abstract", aliases: ["abstract"] },
    { id: "introduction", aliases: ["introduction"] },
    { id: "methods", aliases: ["methods", "materials and methods"] },
    { id: "results", aliases: ["results"] },
    { id: "discussion", aliases: ["discussion"] },
    { id: "data-availability", aliases: ["data availability", "data availability statement"] },
    { id: "code-availability", aliases: ["code availability", "code availability statement"] },
    { id: "references", aliases: ["references", "bibliography"] },
  ];
  const missingSections = required
    .filter((section) => !section.aliases.some((alias) => headings.includes(alias)))
    .map((section) => section.id);
  if (missingSections.length) {
    throw publicationError(
      "RESEARCH_PUBLICATION_MANUSCRIPT_INCOMPLETE",
      "The manuscript is missing required submission sections.",
      3,
      { missingSections },
    );
  }
}

async function validateSubmissionBindings(
  outputRoot: string,
  projectId: string,
  evidenceSnapshotId: string,
  evidenceSnapshotSha256: string,
  policySha256: string,
  frozenPaths?: Record<string, string>,
): Promise<{
  analysis: Record<string, unknown>;
}> {
  const inputPath = (name: string) => frozenPaths?.[name] ?? join(outputRoot, name);
  const [content, inference, analysis, graph] = await Promise.all([
    readJsonFile<Record<string, unknown>>(
      inputPath("content-snapshot.json"),
      "Frozen content snapshot",
    ),
    readJsonFile<Record<string, unknown>>(
      inputPath("inference-snapshot.json"),
      "Frozen inference snapshot",
    ),
    readJsonFile<Record<string, unknown>>(inputPath("analysis.json"), "Frozen analysis"),
    readJsonFile<Record<string, unknown>>(
      inputPath("claim-evidence-graph.json"),
      "Frozen Claim-Evidence Graph",
    ),
  ]);
  const contentGate = isObject(content.gate) ? content.gate : {};
  const inferenceGate = isObject(inference.gate) ? inference.gate : {};
  const acquisition = isObject(inference.acquisitionSnapshot) ? inference.acquisitionSnapshot : {};
  const contentBinding = isObject(inference.contentSnapshot) ? inference.contentSnapshot : {};
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isObject) : [];
  const graphEdges = Array.isArray(graph.edges) ? graph.edges.filter(isObject) : [];
  const contentAtoms = Array.isArray(content.atoms) ? content.atoms.filter(isObject) : [];
  const inferenceAtoms = Array.isArray(inference.atoms) ? inference.atoms.filter(isObject) : [];
  const inferenceSources = Array.isArray(inference.sources)
    ? inference.sources.filter(isObject)
    : [];
  const inferenceClaims = Array.isArray(inference.claims) ? inference.claims.filter(isObject) : [];
  const findings = Array.isArray(analysis.findings) ? analysis.findings.filter(isObject) : [];
  const analysisRun = isObject(analysis.analysisRun) ? analysis.analysisRun : {};
  const nodeById = new Map(
    graphNodes.flatMap((node) =>
      typeof node.id === "string"
        ? ([[node.id, node]] as Array<[string, Record<string, unknown>]>)
        : [],
    ),
  );
  const edgeBindings = new Set(
    graphEdges.flatMap((edge) =>
      typeof edge.type === "string" && typeof edge.from === "string" && typeof edge.to === "string"
        ? [`${edge.type}:${edge.from}:${edge.to}`]
        : [],
    ),
  );
  if (
    !hashBoundSnapshot(content, "snapshotSha256") ||
    !hashBoundSnapshot(inference, "snapshotSha256") ||
    !hashBoundSnapshot(graph, "graphSha256") ||
    content.kind !== "tiangong-evidence-content-snapshot" ||
    content.projectId !== projectId ||
    content.acquisitionSnapshotId !== evidenceSnapshotId ||
    content.acquisitionSnapshotSha256 !== evidenceSnapshotSha256 ||
    contentGate.decision !== "pass" ||
    inference.kind !== "tiangong-inference-snapshot" ||
    inference.projectId !== projectId ||
    inferenceGate.decision !== "pass" ||
    acquisition.snapshotId !== evidenceSnapshotId ||
    acquisition.snapshotSha256 !== evidenceSnapshotSha256 ||
    contentBinding.snapshotId !== content.snapshotId ||
    contentBinding.snapshotSha256 !== content.snapshotSha256 ||
    canonicalJson(inferenceAtoms) !== canonicalJson(contentAtoms) ||
    inference.policySha256 !== policySha256 ||
    analysis.schemaVersion !== 2 ||
    analysis.inferenceSnapshotSha256 !== inference.snapshotSha256 ||
    !isConsistentAnalysisRunMetadata(analysisRun) ||
    typeof analysisRun.id !== "string" ||
    findings.length === 0 ||
    graph.kind !== "tiangong-claim-evidence-graph" ||
    graph.projectId !== projectId ||
    graph.inferenceSnapshotSha256 !== inference.snapshotSha256 ||
    graph.analysisSha256 !== (await sha256File(inputPath("analysis.json"))) ||
    graph.analysisRunId !== analysisRun.id ||
    nodeById.size !== graphNodes.length ||
    new Set(graphEdges.flatMap((edge) => (typeof edge.id === "string" ? [edge.id] : []))).size !==
      graphEdges.length ||
    graphEdges.some(
      (edge) =>
        typeof edge.from !== "string" ||
        typeof edge.to !== "string" ||
        !nodeById.has(edge.from) ||
        !nodeById.has(edge.to),
    ) ||
    !validClaimEvidenceTopology({
      findings,
      analysisRunId: analysisRun.id,
      atoms: inferenceAtoms,
      sources: inferenceSources,
      claims: inferenceClaims,
      nodeById,
      edgeBindings,
    })
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_SUBMISSION_BINDING_INVALID",
      "The submission package does not bind passing content/inference gates, mode-consistent analysis metadata, and a complete Claim–Evidence Graph.",
      3,
    );
  }
  return { analysis };
}

function hashBoundSnapshot(value: Record<string, unknown>, hashKey: string): boolean {
  const recorded = value[hashKey];
  if (typeof recorded !== "string" || !/^[a-f0-9]{64}$/u.test(recorded)) return false;
  const core = { ...value };
  delete core[hashKey];
  return sha256Text(canonicalJson(core)) === recorded;
}

function validClaimEvidenceTopology(input: {
  findings: Array<Record<string, unknown>>;
  analysisRunId: string;
  atoms: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  nodeById: Map<string, Record<string, unknown>>;
  edgeBindings: Set<string>;
}): boolean {
  const atomById = objectMap(input.atoms, "atomId");
  const sourceById = objectMap(input.sources, "id");
  const claimById = objectMap(input.claims, "id");
  const runNodeId = `analysis-run:${input.analysisRunId}`;
  const runNode = input.nodeById.get(runNodeId);
  if (!runNode || runNode.type !== "analysis-run" || runNode.label !== input.analysisRunId) {
    return false;
  }
  for (const finding of input.findings) {
    if (
      typeof finding.id !== "string" ||
      typeof finding.statement !== "string" ||
      !nonEmptyStringArray(finding.evidence) ||
      !nonEmptyStringArray(finding.evidenceAtomIds) ||
      !nonEmptyStringArray(finding.claimIds)
    ) {
      return false;
    }
    const findingNodeId = `finding:${finding.id}`;
    const findingNode = input.nodeById.get(findingNodeId);
    if (
      !findingNode ||
      findingNode.type !== "finding" ||
      findingNode.label !== finding.statement ||
      findingNode.sha256 !== sha256Text(canonicalJson(finding)) ||
      !input.edgeBindings.has(`finding-produced-by-analysis-run:${findingNodeId}:${runNodeId}`)
    ) {
      return false;
    }
    const atomSourceIds = new Set<string>();
    for (const atomId of finding.evidenceAtomIds) {
      const atom = atomById.get(atomId);
      if (
        !atom ||
        typeof atom.sourceId !== "string" ||
        typeof atom.statement !== "string" ||
        typeof atom.atomSha256 !== "string"
      ) {
        return false;
      }
      const source = sourceById.get(atom.sourceId);
      const atomNodeId = `atom:${atomId}`;
      const sourceNodeId = `source:${atom.sourceId}`;
      const atomNode = input.nodeById.get(atomNodeId);
      const sourceNode = input.nodeById.get(sourceNodeId);
      if (
        !source ||
        !atomNode ||
        atomNode.type !== "atom" ||
        atomNode.label !== atom.statement ||
        atomNode.sha256 !== atom.atomSha256 ||
        !sourceNode ||
        sourceNode.type !== "source" ||
        sourceNode.label !== atom.sourceId ||
        sourceNode.sha256 !== sha256Text(canonicalJson(source)) ||
        !input.edgeBindings.has(`finding-supported-by-atom:${findingNodeId}:${atomNodeId}`) ||
        !input.edgeBindings.has(`atom-derived-from-source:${atomNodeId}:${sourceNodeId}`)
      ) {
        return false;
      }
      atomSourceIds.add(atom.sourceId);
    }
    if (finding.evidence.some((sourceId) => !atomSourceIds.has(sourceId))) return false;
    for (const claimId of finding.claimIds) {
      const claim = claimById.get(claimId);
      const claimNodeId = `design-claim:${claimId}`;
      const claimNode = input.nodeById.get(claimNodeId);
      if (
        !claim ||
        !claimNode ||
        claimNode.type !== "design-claim" ||
        claimNode.label !== (typeof claim.statement === "string" ? claim.statement : claimId) ||
        claimNode.sha256 !== sha256Text(canonicalJson(claim)) ||
        !input.edgeBindings.has(`finding-addresses-design-claim:${findingNodeId}:${claimNodeId}`)
      ) {
        return false;
      }
    }
  }
  return true;
}

function objectMap(
  values: Array<Record<string, unknown>>,
  idKey: string,
): Map<string, Record<string, unknown>> {
  return new Map(
    values.flatMap((value) =>
      typeof value[idKey] === "string"
        ? ([[value[idKey], value]] as Array<[string, Record<string, unknown>]>)
        : [],
    ),
  );
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

function policySummary(policy: ResearchPolicyBinding): PublicationGeneration["policy"] {
  return {
    projectId: policy.projectId,
    resolvedPolicySha256: policy.resolvedPolicySha256,
    approvalSha256: policy.approvalSha256,
    verdictCeiling: policy.verdictCeiling,
    targetJournal: policy.targetJournal,
  };
}

function requiredReviewRoles(policy: ResearchPolicyBinding): PublicationReviewRole[] {
  const declared = policy.requiredReviewers.filter(isPublicationReviewRole);
  return [...new Set([...REQUIRED_REVIEW_ROLES, ...declared])].sort() as PublicationReviewRole[];
}

function isPublicationReviewRole(value: string): value is PublicationReviewRole {
  return REQUIRED_REVIEW_ROLES.includes(value as PublicationReviewRole);
}

async function storePublicationObject(
  root: string,
  projectId: string,
  sourcePath: string,
  logicalName: string,
  allowControlPath = false,
): Promise<FrozenFile> {
  const canonical = requireAbsolutePath(sourcePath, logicalName);
  if (!allowControlPath && canonical.split(sep).includes(RESEARCH_CONTROL_DIRECTORY)) {
    throw publicationError(
      "RESEARCH_PUBLICATION_FILE_INVALID",
      "Publication source files cannot be read from a research control directory.",
      2,
    );
  }
  const info = await lstat(canonical).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw publicationError(
      "RESEARCH_PUBLICATION_FILE_INVALID",
      `The ${logicalName} must be a regular non-symlink file.`,
      2,
    );
  }
  const sha256 = await sha256File(canonical);
  const extension = safeExtension(extname(basename(canonical)));
  const objectLocator = `publication/objects/${sha256}/content${extension}`;
  const destination = join(projectDirectory(root, projectId), objectLocator);
  if (await pathExists(destination)) {
    if ((await sha256File(destination)) !== sha256) {
      throw publicationError(
        "RESEARCH_PUBLICATION_OBJECT_INVALID",
        "A content-addressed publication object failed hash verification.",
      );
    }
  } else {
    await ensureDirectory(dirname(destination));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, await readFile(canonical), { mode: 0o600 });
    if ((await sha256File(temporary)) !== sha256) {
      throw publicationError(
        "RESEARCH_PUBLICATION_OBJECT_INVALID",
        "A publication object changed while it was being frozen.",
      );
    }
    await rename(temporary, destination);
    await chmod(destination, 0o444);
  }
  return { logicalName, sha256, bytes: info.size, objectLocator };
}

async function loadCurrentGeneration(
  root: string,
  projectId: string,
): Promise<PublicationGeneration> {
  const pointer = await readJsonFile<PublicationCurrentPointer>(
    publicationCurrentPath(root, projectId),
    "Current publication generation",
  );
  if (
    pointer.schemaVersion !== 1 ||
    pointer.projectId !== projectId ||
    !/^[a-f0-9]{64}$/.test(pointer.generationSha256) ||
    pointer.manifestLocator !== generationManifestLocator(pointer.generationSha256)
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication pointer is invalid.",
    );
  }
  const manifestPath = join(projectDirectory(root, projectId), pointer.manifestLocator);
  const generation = await readJsonFile<PublicationGeneration>(
    manifestPath,
    "Publication generation",
  );
  const { generationSha256, ...withoutHash } = generation;
  if (
    generation.kind !== "tiangong-publication-generation" ||
    generation.projectId !== projectId ||
    !isObject(generation.producer) ||
    !["codex", "claude", "workbuddy", "codebuddy"].includes(String(generation.producer.agent)) ||
    typeof generation.producer.sessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(generation.producer.sessionSha256) ||
    generationSha256 !== pointer.generationSha256 ||
    sha256Text(canonicalJson(withoutHash)) !== generationSha256
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication generation failed its content hash binding.",
    );
  }
  if (
    !isObject(generation.submissionPackage) ||
    generation.submissionPackage.schemaVersion !== 1 ||
    !Array.isArray(generation.submissionPackage.requiredRoles) ||
    !Array.isArray(generation.submissionPackage.files) ||
    generation.submissionPackage.requiredRoles.some(
      (role) => !REQUIRED_SUBMISSION_ROLES.includes(role as PublicationSubmissionRole),
    ) ||
    REQUIRED_SUBMISSION_ROLES.some(
      (role) => !generation.submissionPackage.requiredRoles.includes(role),
    ) ||
    generation.submissionPackage.files.some(
      (file) => !isObject(file) || !SUBMISSION_ROLES.has(file.role as PublicationSubmissionRole),
    ) ||
    typeof generation.submissionPackage.packageSha256 !== "string"
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication submission package is invalid.",
    );
  }
  const { packageSha256, ...submissionPackageCore } = generation.submissionPackage;
  if (sha256Text(canonicalJson(submissionPackageCore)) !== packageSha256) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication submission package hash binding is invalid.",
    );
  }
  if (!generation.materialResultsManifest || !generation.analysisGenerationId) {
    throw lineageError(
      "RESEARCH_PUBLICATION_RESULT_LINEAGE_REQUIRED",
      "This legacy publication has no material result lineage. Preserve its history and refreeze with a prepared resultLineage before another review or readiness claim.",
    );
  }
  await verifyFrozenFiles(root, projectId, [
    generation.materialResultsManifest,
    generation.manuscript,
    generation.assessment,
    generation.evidenceSnapshot.object,
    generation.baseResearch.closure,
    generation.baseResearch.analysis,
    generation.baseResearch.report,
    ...generation.supplements,
    ...generation.submissionPackage.files,
    generation.submissionPackage.contentSnapshot,
    generation.submissionPackage.inferenceSnapshot,
    generation.submissionPackage.claimEvidenceGraph,
    generation.submissionPackage.reproducibilityManifest,
  ]);
  const base = await currentClosedAnalysisLineage(root, projectId);
  const manifest = await readJsonFile<unknown>(
    join(projectDirectory(root, projectId), generation.materialResultsManifest.objectLocator),
    "Frozen material results manifest",
  );
  verifyMaterialResultLineage(
    manifest,
    base,
    materialFiles(
      generation.manuscript,
      generation.assessment,
      generation.supplements,
      generation.submissionPackage.files,
    ),
  );
  if (
    generation.analysisGenerationId !== analysisGenerationId(base) ||
    generation.baseResearch.analysis.sha256 !== base.analysisSha256 ||
    generation.baseResearch.report.sha256 !== base.reportSha256 ||
    generation.submissionPackage.claimEvidenceGraph.sha256 !== base.claimEvidenceGraphSha256
  ) {
    throw lineageError(
      "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      "The publication no longer binds the current closed result generation.",
      {
        object: "analysisGenerationId",
        expected: analysisGenerationId(base),
        supplied: generation.analysisGenerationId,
      },
    );
  }
  const reproduction = await readJsonFile<Record<string, unknown>>(
    join(
      projectDirectory(root, projectId),
      generation.submissionPackage.reproducibilityManifest.objectLocator,
    ),
    "Frozen reproducibility manifest",
  );
  const expectedReproduction = {
    analysisGenerationId: generation.analysisGenerationId,
    materialResultsManifestSha256: generation.materialResultsManifest.sha256,
    evidenceSnapshotSha256: generation.evidenceSnapshot.object.sha256,
    contentSnapshotSha256: generation.submissionPackage.contentSnapshot.sha256,
    inferenceSnapshotSha256: generation.submissionPackage.inferenceSnapshot.sha256,
    claimEvidenceGraphSha256: generation.submissionPackage.claimEvidenceGraph.sha256,
    analysisSha256: generation.baseResearch.analysis.sha256,
  };
  const frozenAnalysis = await readJsonFile<Record<string, unknown>>(
    join(projectDirectory(root, projectId), generation.baseResearch.analysis.objectLocator),
    "Frozen analysis",
  );
  if (
    reproduction.projectId !== projectId ||
    canonicalJson(reproduction.bindings) !== canonicalJson(expectedReproduction) ||
    canonicalJson(reproduction.analysisRun) !== canonicalJson(frozenAnalysis.analysisRun)
  ) {
    throw lineageError(
      "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      "The reproducibility record does not bind the frozen material results and analysis.",
      { object: "submission-reproducibility" },
    );
  }
  const currentTask = await compileTaskAcceptanceContext(root, await loadProject(root, projectId));
  if ((generation.taskAcceptanceSha256 ?? null) !== (currentTask?.contextSha256 ?? null)) {
    throw publicationError(
      "RESEARCH_PUBLICATION_TASK_BINDING_INVALID",
      "The frozen publication generation no longer binds the current task checks.",
    );
  }
  return generation;
}

function materialFiles(
  manuscript: FrozenFile,
  assessment: FrozenFile,
  supplements: FrozenFile[],
  submission: FrozenSubmissionFile[],
) {
  return [
    { role: "manuscript", sha256: manuscript.sha256 },
    { role: "assessment", sha256: assessment.sha256 },
    ...supplements.map((file) => ({ role: file.logicalName, sha256: file.sha256 })),
    ...submission.map((file) => ({ role: file.role, sha256: file.sha256 })),
  ];
}

async function currentClosedAnalysisLineage(
  root: string,
  projectId: string,
): Promise<AnalysisLineage> {
  const project = await requireClosedTopJournalProject(root, projectId);
  const outputRoot = join(projectDirectory(root, projectId), "outputs");
  const snapshot = await readJsonFile<Record<string, unknown>>(
    join(outputRoot, "evidence-snapshot.json"),
    "Closed evidence snapshot",
  );
  const snapshotSha256 = verifiedSnapshotSha256(project, snapshot);
  const closure = await readJsonFile<Record<string, unknown>>(
    join(outputRoot, "closure.json"),
    "Base closure",
  );
  assertBaseClosure(project, closure, snapshotSha256);
  const { analysis } = await validateSubmissionBindings(
    outputRoot,
    projectId,
    String(snapshot.snapshotId),
    snapshotSha256,
    project.publicationPolicy!.resolvedPolicySha256,
  );
  const records = Object.fromEntries(
    await Promise.all(
      RESULT_CORE_FILES.map(
        async (name) =>
          [name, await fileRecord(join(outputRoot, name), `outputs/${name}`)] as const,
      ),
    ),
  );
  return closedAnalysisLineage({ root, projectId, closure, analysis, records });
}

/** Read the current authority before authoring material; never label existing files automatically. */
export async function inspectPublicationLineage(root: string, projectId: string) {
  const base = await currentClosedAnalysisLineage(root, projectId);
  return {
    analysisGenerationId: analysisGenerationId(base),
    resultLineage: { schemaVersion: 1, ...base, files: [] },
    bindingScope: "producer-declared-derivation-with-verified-bytes-and-closed-analysis",
    nextAction:
      "Record each material file's role, SHA-256 and source analysisSha256 when producing it. Fill every manuscript, assessment, submission and supplement-N entry; do not relabel stale artifacts. Freeze verifies this prepared manifest. Scientific fidelity still requires independent review.",
  };
}

async function verifyFrozenFiles(
  root: string,
  projectId: string,
  files: FrozenFile[],
): Promise<void> {
  for (const file of files) {
    const path = join(projectDirectory(root, projectId), file.objectLocator);
    const info = await lstat(path).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.bytes ||
      (await sha256File(path)) !== file.sha256
    ) {
      throw publicationError(
        "RESEARCH_PUBLICATION_OBJECT_INVALID",
        "A frozen publication object is missing or failed hash verification.",
      );
    }
  }
}

async function loadReviewerRegistry(
  root: string,
  projectId: string,
): Promise<ReviewerSessionRegistry> {
  const path = reviewerRegistryPath(root, projectId);
  if (!(await pathExists(path))) return { schemaVersion: 1, sessions: [] };
  const value = await readJsonFile<ReviewerSessionRegistry>(path, "Publication reviewer registry");
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sessions) ||
    value.sessions.some(
      (entry) =>
        typeof entry.sessionSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sessionSha256) ||
        entry.projectId !== projectId ||
        typeof entry.generationSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.generationSha256) ||
        !isPublicationReviewRole(entry.role) ||
        !["codex", "claude"].includes(entry.agent) ||
        typeof entry.registeredAt !== "string",
    )
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication reviewer registry is invalid.",
    );
  }
  return value;
}

async function usedReviewerSessionHashes(root: string, projectId: string): Promise<Set<string>> {
  const journalPath = workspacePaths(root).journal;
  await verifyJournal(journalPath);
  const hashes = new Set<string>();
  for (const event of await readJournal(journalPath)) {
    if (
      event.type !== "publication.review.prepared" ||
      event.scope !== projectId ||
      event.payload.projectId !== projectId
    ) {
      continue;
    }
    const value = event.payload.reviewerSessionSha256;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw publicationError(
        "RESEARCH_PUBLICATION_STATE_INVALID",
        "A publication review journal event is missing its session hash binding.",
      );
    }
    hashes.add(value);
  }
  return hashes;
}

async function loadReviewPacket(
  root: string,
  projectId: string,
  generation: PublicationGeneration,
  role: PublicationReviewRole,
): Promise<PublicationReviewPacket> {
  const packet = await readJsonFile<PublicationReviewPacket>(
    reviewPacketPath(root, projectId, generation.generationSha256, role),
    `Publication ${role} review packet`,
  );
  const { packetSha256, ...withoutHash } = packet;
  if (
    packet.kind !== "tiangong-publication-review-packet" ||
    packet.projectId !== projectId ||
    packet.generationSha256 !== generation.generationSha256 ||
    packet.role !== role ||
    !isObject(packet.reviewer) ||
    !["codex", "claude"].includes(String(packet.reviewer.agent)) ||
    typeof packet.reviewer.sessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(packet.reviewer.sessionSha256) ||
    sha256Text(canonicalJson(withoutHash)) !== packetSha256 ||
    (packet.taskAcceptance?.contextSha256 ?? null) !== (generation.taskAcceptanceSha256 ?? null)
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_REVIEW_BINDING_INVALID",
      "The publication review packet failed its content hash binding.",
    );
  }
  if (packet.taskAcceptance)
    validateTaskObject(packet.taskAcceptance, generation.taskAcceptanceSha256!, "contextSha256");
  return packet;
}

async function loadSubmittedReviews(
  root: string,
  projectId: string,
  generation: PublicationGeneration,
): Promise<
  Array<{
    role: PublicationReviewRole;
    review: PublicationReviewRecord;
    reviewSha256: string;
    packet: PublicationReviewPacket;
  }>
> {
  const reviews = [];
  for (const role of generation.requiredReviewRoles) {
    const path = submittedReviewPath(root, projectId, generation.generationSha256, role);
    if (!(await pathExists(path))) continue;
    const packet = await loadReviewPacket(root, projectId, generation, role);
    const raw = await readJsonFile<unknown>(path, `Publication ${role} review`);
    const review = parsePublicationReview(raw, role);
    if (
      review.packetSha256 !== packet.packetSha256 ||
      review.reviewerSessionSha256 !== packet.reviewer.sessionSha256
    ) {
      throw publicationError(
        "RESEARCH_PUBLICATION_REVIEW_BINDING_INVALID",
        "A submitted publication review failed its packet binding.",
      );
    }
    reviews.push({ role, review, reviewSha256: sha256Text(canonicalJson(review)), packet });
  }
  return reviews;
}

function parsePublicationReview(
  value: unknown,
  expectedRole: PublicationReviewRole,
): PublicationReviewRecord {
  if (!isObject(value)) throw malformedReview();
  const decisionSet = expectedRole === "journal-editor" ? EDITOR_DECISIONS : SPECIALIST_DECISIONS;
  if (
    value.schemaVersion !== 1 ||
    value.role !== expectedRole ||
    typeof value.packetSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.packetSha256) ||
    typeof value.reviewerSessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.reviewerSessionSha256) ||
    !decisionSet.has(String(value.decision)) ||
    !Array.isArray(value.findings) ||
    value.findings.some((finding) => !isReviewFinding(finding)) ||
    typeof value.boundedRecommendation !== "string" ||
    value.boundedRecommendation.trim().length < 8 ||
    value.boundedRecommendation.length > 4_000
  ) {
    throw malformedReview();
  }
  return value as unknown as PublicationReviewRecord;
}

function isReviewFinding(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,63}$/.test(value.code) &&
    ["blocking", "major", "minor"].includes(String(value.severity)) &&
    typeof value.message === "string" &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every((id) => typeof id === "string")
  );
}

function malformedReview(): CliError {
  return publicationError(
    "RESEARCH_PUBLICATION_REVIEW_INVALID",
    "The publication review does not match the role-specific structured schema.",
    2,
  );
}

function parsePublicationAssessment(value: unknown): PublicationAssessment {
  if (!isObject(value)) throw malformedAssessment();
  if (
    value.schemaVersion !== 1 ||
    typeof value.title !== "string" ||
    value.title.trim().length < 8 ||
    !Array.isArray(value.claims) ||
    value.claims.some((claim) => !isAssessmentClaim(claim)) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.some((outcome) => !isAssessmentOutcome(outcome)) ||
    !Array.isArray(value.titleOutcomeIds) ||
    value.titleOutcomeIds.some((id) => typeof id !== "string") ||
    !Array.isArray(value.results) ||
    value.results.some((result) => !isAssessmentResult(result)) ||
    !Array.isArray(value.sourceClassifications) ||
    value.sourceClassifications.some((item) => !isSourceClassification(item)) ||
    !isRecallAudit(value.recallAudit)
  ) {
    throw malformedAssessment();
  }
  return value as unknown as PublicationAssessment;
}

function isAssessmentClaim(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmptyString(value.id) &&
    ["central", "supporting", "contextual", "future-research"].includes(String(value.role)) &&
    nonEmptyString(value.statement) &&
    stringArray(value.evidenceSourceIds) &&
    stringArray(value.dimensionIds) &&
    stringArray(value.resultIds)
  );
}

function isAssessmentOutcome(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmptyString(value.id) &&
    ["central", "supporting", "contextual"].includes(String(value.role)) &&
    nonEmptyString(value.label) &&
    [
      "unobserved",
      "future-work",
      "conceptual-proposition",
      "calibrated-model",
      "causal-estimate",
      "field-observation",
      "validated-forecast",
      "systematic-synthesis",
    ].includes(String(value.supportStatus)) &&
    stringArray(value.claimIds) &&
    stringArray(value.resultIds)
  );
}

function isAssessmentResult(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmptyString(value.id) &&
    ["central", "supporting", "contextual"].includes(String(value.role)) &&
    [
      "definition",
      "accounting-identity",
      "illustrative-sensitivity",
      "calibrated-model",
      "causal-estimate",
      "field-observation",
      "validated-forecast",
      "systematic-synthesis",
      "conceptual-proposition",
    ].includes(String(value.resultClass)) &&
    nonEmptyString(value.statement) &&
    stringArray(value.evidenceSourceIds) &&
    typeof value.independentlyReproduced === "boolean"
  );
}

function isSourceClassification(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmptyString(value.sourceId) &&
    ["direct", "adjacent", "contextual"].includes(String(value.relationship)) &&
    [
      "peer-reviewed-empirical",
      "peer-reviewed-model",
      "peer-reviewed-review",
      "official-data",
      "administrative-record",
      "patent",
      "news",
      "owner-provided-input",
      "internal-model",
      "other",
    ].includes(String(value.evidenceKind))
  );
}

function isRecallAudit(value: unknown): boolean {
  return (
    isObject(value) &&
    ["pass", "fail", "incomplete"].includes(String(value.status)) &&
    typeof value.candidateDispositionComplete === "boolean" &&
    typeof value.databaseCoverageComplete === "boolean" &&
    typeof value.backwardCitationChasing === "boolean" &&
    typeof value.forwardCitationChasing === "boolean" &&
    typeof value.adversarialSearch === "boolean" &&
    typeof value.closestPriorWorkCompared === "boolean" &&
    stringArray(value.missingCoreWorkIds)
  );
}

function malformedAssessment(): CliError {
  return publicationError(
    "RESEARCH_PUBLICATION_ASSESSMENT_INVALID",
    "The publication assessment does not match the authoritative structured schema.",
    2,
  );
}

function computeReadinessVerdict(
  generation: PublicationGeneration,
  reviews: Awaited<ReturnType<typeof loadSubmittedReviews>>,
  missing: PublicationReviewRole[],
): PublicationReadinessVerdict {
  if (missing.length) return "independent-review-incomplete";
  const specialistPass = reviews
    .filter((entry) => entry.role !== "journal-editor")
    .every((entry) => entry.review.decision === "pass");
  const editorReady = reviews.some(
    (entry) => entry.role === "journal-editor" && entry.review.decision === "submission-ready",
  );
  if (!specialistPass || !editorReady || generation.assessmentResult.issueCodes.length > 0) {
    return "revision-required";
  }
  if (!generation.assessmentResult.canClaimSubmissionReady) {
    return generation.policy.verdictCeiling === "top-journal-class-ready"
      ? "top-journal-class-ready"
      : "top-journal-candidate";
  }
  return "target-journal-submission-ready";
}

function boundedStatement(verdict: PublicationReadinessVerdict): string {
  if (verdict === "target-journal-submission-ready") {
    return "The exact frozen manuscript passed all required independent reviews and is mechanically bounded as target-journal submission-ready; acceptance is not guaranteed.";
  }
  if (verdict === "top-journal-class-ready") {
    return "The exact frozen manuscript is bounded as top-journal-class-ready, not target-journal submission-ready.";
  }
  if (verdict === "top-journal-candidate") {
    return "The exact frozen manuscript remains a top-journal candidate, not submission-ready.";
  }
  if (verdict === "revision-required") {
    return "The exact frozen manuscript is not submission-ready; revision or a policy-declared research pivot is required.";
  }
  return "The exact frozen manuscript is not submission-ready because required independent reviews are incomplete.";
}

function reviewInstructions(role: PublicationReviewRole): string[] {
  return [
    "Review only the exact content-addressed manuscript, role-complete submission package, evidence and inference snapshots, Claim–Evidence Graph, reproducibility manifest, base research outputs, and policy in this packet.",
    "Use a fresh independent reviewer session; do not inherit producer reasoning or an earlier manuscript review.",
    "Do not upgrade the mechanical assessment or policy verdict ceiling.",
    role === "journal-editor"
      ? "Act as a skeptical target-journal editor and return one allowed editorial decision."
      : `Apply the ${role} rubric and return pass, revise, or reject with structured findings.`,
  ];
}

async function writeImmutableJson(
  path: string,
  value: unknown,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (await pathExists(path)) {
    const existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const actual = sha256Text(canonicalJson(withoutBindingHash(existing)));
    if (actual !== expectedSha256) {
      throw publicationError(
        "RESEARCH_PUBLICATION_OBJECT_INVALID",
        `The immutable ${label} already exists with different content.`,
      );
    }
    return;
  }
  await writeJsonAtomic(path, value, 0o444);
}

function withoutBindingHash(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.generationSha256 === "string") {
    const { generationSha256: _ignored, ...rest } = value;
    return rest;
  }
  if (typeof value.packetSha256 === "string") {
    const { packetSha256: _ignored, ...rest } = value;
    return rest;
  }
  if (typeof value.closureSha256 === "string") {
    const { closureSha256: _ignored, ...rest } = value;
    return rest;
  }
  return value;
}

async function loadPublicationClosure(
  path: string,
  generationSha256: string,
): Promise<PublicationClosure> {
  const closure = await readJsonFile<PublicationClosure>(path, "Publication closure");
  const { closureSha256, ...withoutHash } = closure;
  if (
    closure.kind !== "tiangong-publication-closure" ||
    closure.generationSha256 !== generationSha256 ||
    sha256Text(canonicalJson(withoutHash)) !== closureSha256
  ) {
    throw publicationError(
      "RESEARCH_PUBLICATION_STATE_INVALID",
      "The publication closure failed its content hash binding.",
    );
  }
  return closure;
}

async function readRegularTextFile(path: string, label: string): Promise<string> {
  const canonical = requireAbsolutePath(path, label);
  const info = await lstat(canonical).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw publicationError(
      "RESEARCH_PUBLICATION_FILE_INVALID",
      `The ${label} must be a regular non-symlink file.`,
      2,
    );
  }
  if (info.size > 16 * 1024 * 1024) {
    throw publicationError(
      "RESEARCH_PUBLICATION_FILE_INVALID",
      `The ${label} exceeds the 16 MiB structured-input limit.`,
      2,
    );
  }
  return readFile(canonical, "utf8");
}

function requireAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw publicationError(
      "RESEARCH_PUBLICATION_FILE_INVALID",
      `The ${label} path must be absolute and canonical.`,
      2,
    );
  }
  return path;
}

function requireSessionId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw publicationError(
      "RESEARCH_PUBLICATION_SESSION_INVALID",
      `The ${label} session ID must contain 8-128 safe opaque characters.`,
      2,
    );
  }
  return normalized;
}

function safeExtension(value: string): string {
  return /^\.[A-Za-z0-9]{1,10}$/.test(value) ? value.toLowerCase() : ".bin";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

function projectDirectory(root: string, projectId: string): string {
  return join(workspacePaths(root).projects, projectId);
}

function generationManifestLocator(generationSha256: string): string {
  return `publication/generations/${generationSha256}/manifest.json`;
}

function publicationCurrentPath(root: string, projectId: string): string {
  return join(projectDirectory(root, projectId), "publication", "current.json");
}

function reviewerRegistryPath(root: string, projectId: string): string {
  return join(projectDirectory(root, projectId), "publication", "reviewer-sessions.json");
}

function reviewPacketPath(
  root: string,
  projectId: string,
  generationSha256: string,
  role: PublicationReviewRole,
): string {
  return join(
    projectDirectory(root, projectId),
    "publication",
    "generations",
    generationSha256,
    "review-packets",
    `${role}.json`,
  );
}

function submittedReviewPath(
  root: string,
  projectId: string,
  generationSha256: string,
  role: PublicationReviewRole,
): string {
  return join(
    projectDirectory(root, projectId),
    "publication",
    "generations",
    generationSha256,
    "reviews",
    `${role}.json`,
  );
}

function publicationClosurePath(root: string, projectId: string, generationSha256: string): string {
  return join(
    projectDirectory(root, projectId),
    "publication",
    "generations",
    generationSha256,
    "closure.json",
  );
}

function publicationError(
  code: string,
  message: string,
  exitCode = 3,
  details?: Record<string, unknown>,
): CliError {
  return new CliError(message, { code, exitCode, details });
}

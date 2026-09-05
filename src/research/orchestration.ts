import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { CliError } from "../errors.js";
import {
  projectAuthority,
  projectWithEffectiveAuthority,
  readProjectAuthorityIndex,
} from "./workspace/project-authority.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { researchSetupHelp, runResearchSetupCommand } from "./setup-command.js";
import {
  loadCapabilityDeclarations,
  lockCapabilities,
  verifyCapabilities,
} from "./workspace/capabilities.js";
import { inspectResearchContext } from "./workspace/context.js";
import { packageVersion } from "./workspace/constants.js";
import {
  researchDataCredentialIds,
  setCapabilityCredentialValue,
} from "./workspace/credentials.js";
import {
  configureExternalSkillProfile,
  doctorExternalCapabilities,
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
  importExternalCapability,
  inspectExternalSkillCatalog,
} from "./workspace/external-skills.js";
import { appendJournalEvent, readJournal } from "./workspace/journal.js";
import { fetchNativeCandidateSource } from "./workspace/broker.js";
import { preflightEvidenceArtifact, registerEvidenceArtifact } from "./workspace/artifacts.js";
import {
  executeResearchDataCapability,
  projectResearchDataEvidenceViewResult,
  projectResearchDataExecutionResult,
  readResearchDataEvidence,
} from "./workspace/data-evidence-adapter.js";
import { exportProjectAuditBundle, verifyProjectAuditBundle } from "./workspace/audit-bundle.js";
import { loadCurrentEvidenceSnapshot } from "./workspace/acquisition.js";
import { inspectAcquisitionForecast } from "./workspace/acquisition-forecast.js";
import { reviseProjectAcquisition } from "./workspace/acquisition-revision.js";
import {
  approveProjectTaskScope,
  defineProjectTask,
  isTaskSchemaName,
  proposeProjectTaskScope,
  taskInputSchema,
} from "./workspace/task-contract.js";
import {
  inspectProjectTask,
  recordProjectTaskAcceptance,
  taskAcceptanceInputSchema,
} from "./workspace/task-acceptance.js";
import {
  freezeEvidenceContentSnapshot,
  loadCurrentEvidenceContentSnapshot,
  recordArtifactDecomposition,
  registerEvidenceAtom,
  registerEvidenceContentBatch,
} from "./workspace/content-evidence.js";
import { inspectDiscoveryProgress } from "./workspace/discovery-status.js";
import {
  EVIDENCE_CONTENT_LIMITS,
  EVIDENCE_CONTENT_SCHEMA_NAMES,
  evidenceContentInputSchema,
  isEvidenceContentSchemaName,
} from "./workspace/evidence-content-schema.js";
import { inspectEvidenceAccessStatus } from "./workspace/evidence-exhaustion.js";
import { recordDiscoveryAssessmentBatch } from "./workspace/discovery.js";
import { bindEvidenceDownload } from "./workspace/downloads.js";
import { registerNativeDiscoveryCandidate } from "./workspace/evidence-ledger.js";
import { recordNativeResearchActivity } from "./workspace/native-activity.js";
import { inspectReviewerStatus, startReviewerBridgeSidecar } from "./workspace/review-executor.js";
import { readAndVerifyProjectInputPlan } from "./workspace/input-plan.js";
import { executeScientificReview } from "./workspace/scientific-review-execution.js";
import { claudeCodeCompatibleSchema } from "./workspace/schema-compatibility.js";
import {
  loadCurrentClaimEvidenceGraph,
  loadCurrentInferenceSnapshot,
} from "./workspace/inference.js";
import {
  addProjectInput,
  createProjectAddendum,
  initializeProject,
  forkProject,
  listProjects,
  loadProject,
  nextReadyPackage,
  normalizeEvidenceRequirements,
  refreshProject,
  retryProjectPackage,
  setProjectDisposition,
  scientificGateRecommendedAction,
} from "./workspace/projects.js";
import { evaluateProjectPreflight } from "./workspace/preflight.js";
import {
  closePublication,
  freezePublicationManuscript,
  inspectPublicationStatus,
  preparePublicationReview,
  publicationAssessmentSchema,
  publicationReviewSchema,
  submitPublicationReview,
  type PublicationReviewRole,
  type PublicationSubmissionRole,
  type PublicationStatus,
} from "./workspace/publication-workflow.js";
import {
  approveResearchPolicy,
  initializeResearchPolicy,
  inspectResearchPolicyCatalog,
  inspectResearchPolicyStatus,
  loadApprovedResearchPolicy,
} from "./workspace/research-policy.js";
import {
  resolveInstalledResearchPolicySource,
  runInteractiveResearchPolicyWizard,
} from "./workspace/research-policy-wizard.js";
import {
  abortNativeResearchStage,
  inspectNativeResearchStage,
  prepareNativeResearchStage,
  readNativeStageArtifact,
  requestResearchHandoff,
  resolveResearchHandoff,
  runResearchWorkspace,
  submitNativeResearchStage,
} from "./workspace/runtime.js";
import { schemaForStage } from "./workspace/schemas.js";
import {
  readAndVerifyScientificDesign,
  scientificDesignSchema,
} from "./workspace/scientific-design.js";
import {
  inspectScientificObject,
  parseScientificObjectKind,
  registerScientificObject,
} from "./workspace/scientific-objects.js";
import {
  inspectScientificFulfillment,
  recordScientificFulfillment,
  scientificFulfillmentSchema,
} from "./workspace/scientific-fulfillment.js";
import {
  inspectNativeRun,
  nativeRunInputSchema,
  observeNativeRun,
} from "./workspace/native-run.js";
import {
  inspectScientificReviewStatus,
  prepareScientificReview,
  scientificGateAssessmentSchema,
  scientificReviewSchema,
  submitScientificReview,
} from "./workspace/scientific-review.js";
import { isObject, pathExists, sha256Text, workspacePaths } from "./workspace/storage.js";
import type {
  AgentKind,
  ProjectEvidenceRequirements,
  ProjectInput,
  ProjectInputTrustStatus,
  ResearchMode,
  ScientificReviewRole,
} from "./workspace/types.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
  requireResearchWorkspace,
  withWorkspaceLock,
} from "./workspace/workspace.js";

const COMMON_OPTIONS = { help: "boolean", json: "boolean" } as const;
const WORKSPACE_OPTIONS = { ...COMMON_OPTIONS, workspace: "string" } as const;

export async function runResearchOrchestrationCommand(
  subcommand: string,
  argv: string[],
  io: CliIO,
): Promise<number | undefined> {
  if (subcommand === "context") return runContext(argv, io);
  if (subcommand === "setup") return runResearchSetupCommand(argv, io);
  if (subcommand === "workspace") return runWorkspace(argv, io);
  if (subcommand === "reviewer") return runReviewer(argv, io);
  if (subcommand === "capability") return runCapability(argv, io);
  if (subcommand === "policy") return runPolicy(argv, io);
  if (subcommand === "publication") return runPublication(argv, io);
  if (subcommand === "scientific") return runScientific(argv, io);
  if (subcommand === "project") return runProject(argv, io);
  if (subcommand === "schema") return runSchema(argv, io);
  if (subcommand === "status") return runStatus(argv, io);
  if (subcommand === "run") return runWorkspaceExecution(argv, io);
  return undefined;
}

export function researchOrchestrationHelp(): string {
  return `Research workspace commands:
  tiangong-ai research setup
  tiangong-ai research setup --help
  tiangong-ai research context inspect [--path <absolute-path>] [--json]
  tiangong-ai research workspace init <absolute-path> [--name <name>] [--mode smoke-test|production-research] [--json]
  tiangong-ai research workspace doctor [--workspace <absolute-path>] [--agent-smoke] [--capability-smoke] [--json]
  tiangong-ai research reviewer serve --state-dir <absolute-private-directory> [--workspace <absolute-path>] [--json]
  tiangong-ai research reviewer status [--workspace <absolute-path>] [--json]
  tiangong-ai research reviewer doctor --confirm-agent-smoke-cost [--workspace <absolute-path>] [--json]
  tiangong-ai research capability catalog [--path <absolute-path>] [--workspace <absolute-path>] [--skill-root <absolute-path>] [--json]
  tiangong-ai research capability configure [--profile ${EXTERNAL_SKILL_PROFILE}|${EXTERNAL_SKILL_CONTEXT_PROFILE}|${EXTERNAL_SKILL_MEDIA_PROFILE}] [--skill-root <absolute-path>] [--workspace <absolute-path>] [--json]
  tiangong-ai research capability import --definition <absolute-json> [--workspace <absolute-path>] [--json]
  tiangong-ai research capability doctor [--live] [--workspace <absolute-path>] [--json]
  tiangong-ai research capability credential set --id <logical-id> --from-env <name> [--workspace <absolute-path>] [--json]
  tiangong-ai research capability lock [--workspace <absolute-path>] [--json]
  tiangong-ai research capability verify [--workspace <absolute-path>] [--json]
  tiangong-ai research policy wizard <project-id> [--workspace <path>] [--json]
  tiangong-ai research policy catalog [--source-root <absolute-installed-skill-root>] [--workspace <path>] [--json]
  tiangong-ai research policy init <project-id> [--source-root <absolute-installed-skill-root>] --article-type <id> --field <id> --journal-class <id> [--include-exact-journal-template] [--workspace <path>] [--json]
  tiangong-ai research policy status <project-id> [--workspace <path>] [--json]
  tiangong-ai research policy validate <project-id> [--workspace <path>] [--json]
  tiangong-ai research policy approve <project-id> --confirm [--acknowledge-defaults] [--workspace <path>] [--json]
  tiangong-ai research policy resolve <project-id> [--workspace <path>] [--json]
  tiangong-ai research publication freeze <project-id> --manuscript <absolute-file> --assessment <absolute-json> --submission <absolute-json> --producer-agent codex|claude|workbuddy|codebuddy --producer-session <opaque-id> [--supplements <absolute-json-array>] [--workspace <path>] [--json]
  tiangong-ai research publication review prepare <project-id> --role evidence|methods-reproducibility|domain-novelty|journal-editor --reviewer-agent codex|claude --reviewer-session <opaque-id> [--workspace <path>] [--json]
  tiangong-ai research publication review submit <project-id> --role evidence|methods-reproducibility|domain-novelty|journal-editor --review <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research publication status <project-id> [--workspace <path>] [--json]
  tiangong-ai research publication close <project-id> [--workspace <path>] [--json]
  tiangong-ai research scientific object register --kind model-implementation|environment-lock --path <absolute-file> [--media-type <type>] [--workspace <path>] [--json]
  tiangong-ai research scientific object inspect --kind model-implementation|environment-lock --locator <control-relative-locator> [--workspace <path>] [--json]
  tiangong-ai research scientific fulfillment record <project> --input <json-file> [--workspace <path>] [--json]
  tiangong-ai research scientific fulfillment status <project> [--workspace <path>] [--json]
  tiangong-ai research project task run observe <project> --input <json-file> --confirm-execution [--workspace <path>] [--json]
  tiangong-ai research project task run inspect <project> --run <run-id> [--workspace <path>] [--json]
  tiangong-ai research project init <project-id> --question <question> [--goal evidence-report|top-journal] [--design <absolute-json> --design-producer-agent codex|claude --design-producer-session <opaque-id>] [--requirements <absolute-json>] [--input-plan <absolute-json>] [--confirm-budget] [--workspace <path>] [--json]
  tiangong-ai research project preflight --question <question> [--goal evidence-report|top-journal] [--policy-project <project-id> --design <absolute-json>] [--requirements <absolute-json>] [--input-plan <absolute-json>] [--workspace <path>] [--json]
  tiangong-ai research project input add <project-id> --path <absolute-file> [--role primary|reference|replication] [--trust-status verified-owner-input|unverified-owner-input|reference-only|replication-candidate] [--independently-reproduced] [--workspace <path>] [--json]
  tiangong-ai research project retry <project-id> [--package <package-id>] [--workspace <path>] [--json]
  tiangong-ai research project task define <project-id> --input <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project task status <project-id> [--workspace <path>] [--json]
  tiangong-ai research project task acceptance record <project-id> --input <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project task scope propose <project-id> --input <absolute-json> --expected-contract <sha256> [--workspace <path>] [--json]
  tiangong-ai research project task scope approve <project-id> --proposal <sha256> --confirm-change <sha256> [--workspace <path>] [--json]
  tiangong-ai research project fork <source-project-id> --to <target-project-id> [--resume-through discover|acquire|analyze|synthesize] [--design <absolute-json> --design-producer-agent codex|claude --design-producer-session <opaque-id>] [--workspace <path>] [--json]
  tiangong-ai research project addendum <closed-project-id> --to <target-project-id> [--design <absolute-json> --design-producer-agent codex|claude --design-producer-session <opaque-id>] [--workspace <path>] [--json]
  tiangong-ai research project archive <project-id> --reason <text> [--workspace <path>] [--json]
  tiangong-ai research project abandon <project-id> --reason <text> [--workspace <path>] [--json]
  tiangong-ai research project handoff request <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project handoff resolve <project-id> --note <text> [--workspace <path>] [--json]
  tiangong-ai research project access status <project-id> [--workspace <path>] [--json]
  tiangong-ai research project scientific review prepare <project-id> --role research-design|evidence-construct|pilot-methods --assessment <absolute-json> [--canary-artifacts <absolute-json-array>] --reviewer-agent codex|claude --reviewer-session <opaque-id> [--workspace <path>] [--json]
  tiangong-ai research project scientific review submit <project-id> --role research-design|evidence-construct|pilot-methods --review <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project scientific review execute <project-id> --role research-design|evidence-construct|pilot-methods --confirm-review-cost [--retry] [--workspace <path>] [--json]
  tiangong-ai research project scientific status <project-id> [--workspace <path>] [--json]
  tiangong-ai research project audit export <project-id> --output <absolute-new-directory> [--workspace <path>] [--json]
  tiangong-ai research project audit verify --bundle <absolute-directory> [--json]
  tiangong-ai research project stage prepare <project-id> --stage discover|acquire|analyze|synthesize --host-agent codex|claude|workbuddy|codebuddy [--workspace <path>] [--json]
  tiangong-ai research project stage submit <project-id> --session <id> --output <absolute-json> [--confirm-model <id>] [--workspace <path>] [--json]
  tiangong-ai research project stage abort <project-id> --session <id> [--workspace <path>] [--json]
  tiangong-ai research project stage artifacts <project-id> --session <id> [--offset <n>] [--limit <n>] [--path-prefix <prefix>] [--workspace <path>] [--json]
  tiangong-ai research project stage read <project-id> --session <id> --artifact <object-id> [--offset <bytes>] [--length <bytes|all>] [--encoding utf8|base64] [--workspace <path>] [--json]
  tiangong-ai research project evidence fetch <project-id> --request <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence data run <project-id> --request <absolute-data-run-request.json> [--workspace <path>] [--json]
  tiangong-ai research project evidence data read <project-id> --receipt <attempt-id> --cursor <opaque-cursor> [--workspace <path>] [--json]
  tiangong-ai research project evidence activity record <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence candidate register <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence assessment record <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence download bind <project-id> --candidate <id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence artifact register <project-id> --candidate <id> --path <absolute-file> [--download-binding <id> | --derived-from-artifact <id>] [--media-type <type>] [--source-url <https-url>] [--license <declared-license>] [--license-url <https-url>] [--host-type <type>] [--article-version <version>] [--workspace <path>] [--json]
  tiangong-ai research project evidence decomposition record <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence decomposition batch <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence atom batch <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence artifact preflight (--bytes <known-bytes> | --path <absolute-file>) [--workspace <path>] [--json]
  tiangong-ai research project evidence atom register <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence content freeze <project-id> [--workspace <path>] [--json]
  tiangong-ai research project evidence content forecast <project-id> --input <absolute-acquisition-audit.json> [--workspace <path>] [--json]
  tiangong-ai research project evidence acquisition revise <project-id> --expected-snapshot <sha256> --reason <text> [--include-discovery] [--workspace <path>] [--json]
  tiangong-ai research project evidence content status <project-id> [--workspace <path>] [--json]
  tiangong-ai research schema show <discover|acquire|analyze|synthesize|review|doctor|task-contract|task-scope-change|task-acceptance|scientific-design|scientific-assessment-research-design|scientific-assessment-evidence-construct|scientific-assessment-pilot-methods|scientific-review-research-design|scientific-review-evidence-construct|scientific-review-pilot-methods|publication-assessment|publication-review-evidence|publication-review-methods-reproducibility|publication-review-domain-novelty|publication-review-journal-editor> [--compatibility claude-code] [--json]
  tiangong-ai research status [--project <project-id>] [--all] [--workspace <absolute-path>] [--json]
  tiangong-ai research run [--project <project-id>] [--max-parallel <1-8>] [--max-cycles <1-100>] [--dry-run] [--progress-jsonl] [--workspace <absolute-path>] [--json]

Evidence input schemas: ${EVIDENCE_CONTENT_SCHEMA_NAMES.join(", ")}.
Evidence batches: at most ${EVIDENCE_CONTENT_LIMITS.maxBatchRecords} records and ${EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes} bytes (${EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes / (1024 * 1024)} MiB) of UTF-8 input.
Use research schema show <name> --json; schemas validate shape only, not exact artifact/lineage/locator semantics.

${researchSetupHelp()}
`;
}

async function runScientific(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "fulfillment") {
    const [operation, ...arguments_] = rest;
    if (operation !== "record" && operation !== "status")
      throw unknownAction("research scientific fulfillment", operation ?? "");
    const args = parseStrictArgs(
      arguments_,
      { ...WORKSPACE_OPTIONS, ...(operation === "record" ? { input: "string" as const } : {}) },
      `research scientific fulfillment ${operation}`,
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(
      args.positionals,
      `research scientific fulfillment ${operation}`,
    );
    const root = await workspaceFromArgs(args);
    if (operation === "status")
      writeJson(io, await inspectScientificFulfillment(root, projectId), args);
    else {
      const path = strictString(args, "input");
      if (!path)
        throw new CliError("Fulfillment record requires --input.", {
          code: "RESEARCH_SCIENTIFIC_FULFILLMENT_INVALID",
          exitCode: 2,
        });
      writeJson(
        io,
        await recordScientificFulfillment(
          root,
          projectId,
          await readBoundedJsonRecord(path, "--input", "RESEARCH_SCIENTIFIC_FULFILLMENT_INVALID"),
        ),
        args,
      );
    }
    return 0;
  }
  if (action !== "object") throw unknownAction("research scientific", action);
  const [objectAction, ...objectRest] = rest;
  if (objectAction === "register") {
    const args = parseStrictArgs(
      objectRest,
      { ...WORKSPACE_OPTIONS, kind: "string", path: "string", "media-type": "string" },
      "research scientific object register",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research scientific object register");
    const sourcePath = strictString(args, "path");
    if (!sourcePath) {
      throw new CliError("Scientific object register requires --kind and --path.", {
        code: "RESEARCH_SCIENTIFIC_OBJECT_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const objectKind = parseScientificObjectKind(strictString(args, "kind"));
    const record = await withWorkspaceLock(
      root,
      "research.scientific-object.register",
      async () => {
        const value = await registerScientificObject({
          root,
          objectKind,
          path: sourcePath,
          ...(strictString(args, "media-type")
            ? { mediaType: strictString(args, "media-type")! }
            : {}),
        });
        await appendJournalEvent(
          workspacePaths(root).journal,
          "scientific-object.registered",
          "workspace",
          {
            objectKind: value.objectKind,
            sha256: value.sha256,
            bytes: value.bytes,
            mediaType: value.mediaType,
            objectLocator: value.objectLocator,
            recordLocator: value.recordLocator,
            recordSha256: value.recordSha256,
          },
        );
        return value;
      },
    );
    writeJson(io, record, args);
    return 0;
  }
  if (objectAction === "inspect") {
    const args = parseStrictArgs(
      objectRest,
      { ...WORKSPACE_OPTIONS, kind: "string", locator: "string" },
      "research scientific object inspect",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research scientific object inspect");
    const objectLocator = strictString(args, "locator");
    if (!objectLocator) {
      throw new CliError("Scientific object inspect requires --kind and --locator.", {
        code: "RESEARCH_SCIENTIFIC_OBJECT_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    writeJson(
      io,
      await inspectScientificObject({
        root,
        objectKind: parseScientificObjectKind(strictString(args, "kind")),
        objectLocator,
      }),
      args,
    );
    return 0;
  }
  throw unknownAction("research scientific object", objectAction ?? "");
}

async function runReviewer(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "status") {
    const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, "research reviewer status");
    if (strictBoolean(args, "help")) return writeHelp(io);
    if (args.positionals.length)
      throw unknownAction("research reviewer status", args.positionals[0]!);
    const root = await workspaceFromArgs(args);
    const result = await inspectReviewerStatus(root, io.env);
    writeJson(io, result, args);
    return isObject(result) && result.status === "ready" ? 0 : 3;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, "confirm-agent-smoke-cost": "boolean" },
      "research reviewer doctor",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    if (args.positionals.length)
      throw unknownAction("research reviewer doctor", args.positionals[0]!);
    if (!strictBoolean(args, "confirm-agent-smoke-cost")) {
      throw new CliError("Reviewer doctor requires explicit model-cost confirmation.", {
        code: "RESEARCH_REVIEW_BRIDGE_CONFIRMATION_REQUIRED",
        exitCode: 3,
        details: {
          minimumAction:
            "Rerun with --confirm-agent-smoke-cost after reviewing reviewer provider quota and cost.",
        },
      });
    }
    const root = await workspaceFromArgs(args);
    const result = await doctorResearchWorkspace(root, {
      agentSmoke: true,
      environment: io.env,
    });
    writeJson(io, result, args);
    return result.status === "ready" ? 0 : 3;
  }
  if (action === "serve") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, "state-dir": "string" },
      "research reviewer serve",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    if (args.positionals.length)
      throw unknownAction("research reviewer serve", args.positionals[0]!);
    const stateDirectory = strictString(args, "state-dir");
    if (
      !stateDirectory ||
      !isAbsolute(stateDirectory) ||
      resolve(stateDirectory) !== stateDirectory
    ) {
      throw new CliError("Reviewer sidecar --state-dir must be an explicit absolute directory.", {
        code: "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const sidecar = await startReviewerBridgeSidecar({
      root,
      stateDirectory,
      environment: io.env,
    });
    writeJson(
      io,
      {
        status: "ready",
        workspaceId: sidecar.workspaceId,
        packageVersion: packageVersion(),
        keyFingerprint: sidecar.keyFingerprint,
        supportedActions: ["execute", "fingerprint", "status"],
      },
      args,
    );
    try {
      await waitForReviewerSidecarTermination();
    } finally {
      await sidecar.close();
    }
    return 0;
  }
  throw unknownAction("research reviewer", action);
}

async function waitForReviewerSidecarTermination(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runPublication(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "freeze") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        manuscript: "string",
        assessment: "string",
        supplements: "string",
        submission: "string",
        "producer-agent": "string",
        "producer-session": "string",
      },
      "research publication freeze",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research publication freeze");
    const manuscriptPath = strictString(args, "manuscript");
    const assessmentPath = strictString(args, "assessment");
    const producerSessionId = strictString(args, "producer-session");
    const submissionPath = strictString(args, "submission");
    if (!manuscriptPath || !assessmentPath || !submissionPath || !producerSessionId) {
      throw new CliError(
        "research publication freeze requires --manuscript, --assessment, --submission, --producer-agent, and --producer-session.",
        { code: "RESEARCH_PUBLICATION_ARGUMENT_REQUIRED", exitCode: 2 },
      );
    }
    const root = await workspaceFromArgs(args);
    const supplementsPath = strictString(args, "supplements");
    writeJson(
      io,
      await freezePublicationManuscript({
        root,
        projectId,
        manuscriptPath,
        assessmentPath,
        supplementPaths: supplementsPath ? await readAbsolutePathArray(supplementsPath) : [],
        submissionFiles: await readSubmissionFiles(submissionPath),
        producerAgent: publicationAgent(strictString(args, "producer-agent"), "producer"),
        producerSessionId,
      }),
      args,
    );
    return 0;
  }
  if (action === "review") {
    const [reviewAction, ...reviewRest] = rest;
    if (reviewAction === "--help" || reviewAction === "-h") return writeHelp(io);
    if (reviewAction === "prepare") {
      const args = parseStrictArgs(
        reviewRest,
        {
          ...WORKSPACE_OPTIONS,
          role: "string",
          "reviewer-agent": "string",
          "reviewer-session": "string",
        },
        "research publication review prepare",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research publication review prepare");
      const reviewerSessionId = strictString(args, "reviewer-session");
      if (!reviewerSessionId) {
        throw new CliError("publication review prepare requires --reviewer-session.", {
          code: "RESEARCH_PUBLICATION_ARGUMENT_REQUIRED",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      writeJson(
        io,
        await preparePublicationReview({
          root,
          projectId,
          role: publicationReviewRole(strictString(args, "role")),
          reviewerAgent: publicationAgent(strictString(args, "reviewer-agent"), "reviewer"),
          reviewerSessionId,
        }),
        args,
      );
      return 0;
    }
    if (reviewAction === "submit") {
      const args = parseStrictArgs(
        reviewRest,
        { ...WORKSPACE_OPTIONS, role: "string", review: "string" },
        "research publication review submit",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research publication review submit");
      const reviewPath = strictString(args, "review");
      if (!reviewPath) {
        throw new CliError("publication review submit requires --review.", {
          code: "RESEARCH_PUBLICATION_ARGUMENT_REQUIRED",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      writeJson(
        io,
        await submitPublicationReview({
          root,
          projectId,
          role: publicationReviewRole(strictString(args, "role")),
          reviewPath,
        }),
        args,
      );
      return 0;
    }
    throw unknownAction("research publication review", reviewAction ?? "missing");
  }
  if (action === "status" || action === "close") {
    const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, `research publication ${action}`);
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, `research publication ${action}`);
    const root = await workspaceFromArgs(args);
    writeJson(
      io,
      action === "status"
        ? await inspectPublicationStatus(root, projectId)
        : await closePublication(root, projectId),
      args,
    );
    return 0;
  }
  throw unknownAction("research publication", action);
}

async function runPolicy(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "wizard") {
    const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, "research policy wizard");
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research policy wizard");
    const root = await workspaceFromArgs(args);
    return runInteractiveResearchPolicyWizard({
      root,
      projectId,
      io,
      json: strictBoolean(args, "json"),
    });
  }
  if (action === "catalog") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, "source-root": "string" },
      "research policy catalog",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research policy catalog");
    const explicitSourceRoot = strictString(args, "source-root");
    const sourceRoot =
      explicitSourceRoot ??
      (await resolveInstalledResearchPolicySource(await workspaceFromArgs(args), io.env));
    writeJson(io, await inspectResearchPolicyCatalog(sourceRoot), args);
    return 0;
  }
  if (action === "init") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        "source-root": "string",
        "article-type": "string",
        field: "string",
        "journal-class": "string",
        "include-exact-journal-template": "boolean",
      },
      "research policy init",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research policy init");
    const articleType = strictString(args, "article-type");
    const field = strictString(args, "field");
    const journalClass = strictString(args, "journal-class");
    if (!articleType || !field || !journalClass) {
      throw new CliError(
        "research policy init requires --article-type, --field, and --journal-class.",
        { code: "RESEARCH_POLICY_INVALID", exitCode: 2 },
      );
    }
    const root = await workspaceFromArgs(args);
    const sourceRoot =
      strictString(args, "source-root") ??
      (await resolveInstalledResearchPolicySource(root, io.env));
    writeJson(
      io,
      await initializeResearchPolicy({
        root,
        projectId,
        sourceRoot,
        articleType,
        field,
        journalClass,
        includeExactJournalTemplate: strictBoolean(args, "include-exact-journal-template"),
      }),
      args,
    );
    return 0;
  }
  if (["status", "validate", "approve", "resolve"].includes(action)) {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        confirm: "boolean",
        "acknowledge-defaults": "boolean",
      },
      `research policy ${action}`,
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, `research policy ${action}`);
    const root = await workspaceFromArgs(args);
    if (action === "approve") {
      const result = await approveResearchPolicy(root, projectId, {
        confirm: strictBoolean(args, "confirm"),
        acknowledgeDefaults: strictBoolean(args, "acknowledge-defaults"),
      });
      writeJson(io, result, args);
      return 0;
    }
    if (action === "resolve") {
      writeJson(io, await loadApprovedResearchPolicy(root, projectId), args);
      return 0;
    }
    const result = await inspectResearchPolicyStatus(root, projectId);
    writeJson(io, result, args);
    return action === "validate" &&
      ["missing", "invalid", "changed", "stale"].includes(result.status)
      ? 3
      : 0;
  }
  throw unknownAction("research policy", action);
}

async function runSchema(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action !== "show") throw unknownAction("research schema", action);
  const args = parseStrictArgs(
    rest,
    { ...COMMON_OPTIONS, compatibility: "string" },
    "research schema show",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  const stage = onePositional(args.positionals, "research schema show");
  let schema: Record<string, unknown>;
  if (stage === "task-acceptance") {
    schema = taskAcceptanceInputSchema();
  } else if (stage === "task-native-run") {
    schema = nativeRunInputSchema();
  } else if (isTaskSchemaName(stage)) {
    schema = taskInputSchema(stage);
  } else if (isEvidenceContentSchemaName(stage)) {
    schema = evidenceContentInputSchema(stage);
  } else if (stage === "scientific-design") {
    schema = scientificDesignSchema();
  } else if (stage === "scientific-fulfillment") {
    schema = scientificFulfillmentSchema();
  } else if (stage.startsWith("scientific-assessment-")) {
    const role = scientificReviewRole(stage.slice("scientific-assessment-".length));
    schema = scientificGateAssessmentSchema(role);
  } else if (stage.startsWith("scientific-review-")) {
    const role = scientificReviewRole(stage.slice("scientific-review-".length));
    schema = scientificReviewSchema(role);
  } else if (stage === "publication-assessment") {
    schema = publicationAssessmentSchema();
  } else if (stage.startsWith("publication-review-")) {
    const role = publicationReviewRole(stage.slice("publication-review-".length));
    schema = publicationReviewSchema(role);
  } else if (
    stage === "discover" ||
    stage === "acquire" ||
    stage === "analyze" ||
    stage === "synthesize" ||
    stage === "review" ||
    stage === "doctor"
  ) {
    schema = schemaForStage(stage);
  } else {
    throw new CliError(`Unsupported research schema stage: ${stage}`, {
      code: "RESEARCH_SCHEMA_INVALID",
      exitCode: 2,
    });
  }
  writeJson(io, compatibleSchema(schema, strictString(args, "compatibility")), args);
  return 0;
}

function compatibleSchema(
  schema: Record<string, unknown>,
  compatibility: string | undefined,
): Record<string, unknown> {
  if (!compatibility) return schema;
  if (compatibility !== "claude-code") {
    throw new CliError(`Unsupported schema compatibility target: ${compatibility}`, {
      code: "RESEARCH_SCHEMA_COMPATIBILITY_INVALID",
      exitCode: 2,
      details: { supported: ["claude-code"] },
    });
  }
  return claudeCodeCompatibleSchema(schema);
}

async function runContext(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action !== "inspect") throw unknownAction("research context", action);
  const args = parseStrictArgs(
    rest,
    { ...COMMON_OPTIONS, path: "string" },
    "research context inspect",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research context inspect");
  const result = await inspectResearchContext(strictString(args, "path") ?? process.cwd());
  writeJson(io, result, args);
  return 0;
}

async function runWorkspace(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "init") {
    const args = parseStrictArgs(
      rest,
      { ...COMMON_OPTIONS, name: "string", mode: "string" },
      "research workspace init",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const target = onePositional(args.positionals, "research workspace init");
    const result = await initializeResearchWorkspace(
      target,
      strictString(args, "name"),
      researchMode(strictString(args, "mode")),
    );
    writeJson(io, result, args);
    return 0;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        "agent-smoke": "boolean",
        "capability-smoke": "boolean",
      },
      "research workspace doctor",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research workspace doctor");
    const result = await doctorResearchWorkspace(strictString(args, "workspace") ?? process.cwd(), {
      agentSmoke: strictBoolean(args, "agent-smoke"),
      capabilitySmoke: strictBoolean(args, "capability-smoke"),
      environment: io.env,
    });
    writeJson(io, result, args);
    return result.status === "ready" ? 0 : 3;
  }
  throw unknownAction("research workspace", action);
}

async function runCapability(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "credential") {
    const [credentialAction, ...credentialRest] = rest;
    if (credentialAction === "--help" || credentialAction === "-h") return writeHelp(io);
    if (credentialAction !== "set") {
      throw unknownAction("research capability credential", credentialAction ?? "missing");
    }
    const args = parseStrictArgs(
      credentialRest,
      { ...WORKSPACE_OPTIONS, id: "string", "from-env": "string" },
      "research capability credential set",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability credential set");
    const credentialId = strictString(args, "id");
    const environmentName = strictString(args, "from-env");
    if (!credentialId || !environmentName) {
      throw new CliError("research capability credential set requires --id and --from-env.", {
        code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.credential.set", async () => {
      const declarations = await loadCapabilityDeclarations(root);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName)) {
        throw new CliError("credential source environment name is invalid", {
          code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID",
          exitCode: 3,
        });
      }
      const credentialValue = io.env[environmentName];
      if (typeof credentialValue !== "string" || Buffer.byteLength(credentialValue, "utf8") < 8) {
        throw new CliError(
          `credential source environment variable is missing or too short: ${environmentName}`,
          { code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID", exitCode: 3 },
        );
      }
      const value = await setCapabilityCredentialValue({
        root,
        declaredCredentialIds: [
          ...new Set([
            ...declarations.capabilities.flatMap((capability) =>
              capability.credentials.map((credential) => credential.id),
            ),
            ...researchDataCredentialIds(),
          ]),
        ],
        credentialId,
        value: credentialValue,
        minimumUtf8Bytes: 8,
      });
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.credential.configured",
        "workspace",
        {
          credentialId: value.credentialId,
          sourceEnvironmentNameSha256: sha256Text(environmentName),
          configuredCredentialIds: value.configuredCredentialIds,
        },
      );
      return { ...value, sourceEnvironmentName: environmentName };
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "catalog") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, path: "string", "skill-root": "string" },
      "research capability catalog",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability catalog");
    const workspaceArgument = strictString(args, "workspace");
    const workspace = workspaceArgument ? await requireResearchWorkspace(workspaceArgument) : null;
    const selectedPath = strictString(args, "path") ?? workspace ?? process.cwd();
    const result = await inspectExternalSkillCatalog({
      selectedPath,
      workspace,
      skillRoot: strictString(args, "skill-root") ?? null,
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "configure") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, profile: "string", "skill-root": "string" },
      "research capability configure",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability configure");
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.configure", async () => {
      const value = await configureExternalSkillProfile({
        workspace: root,
        profile: strictString(args, "profile") ?? EXTERNAL_SKILL_PROFILE,
        skillRoot: strictString(args, "skill-root") ?? null,
      });
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.profile.configured",
        "workspace",
        {
          profile: value.profile,
          capabilities: value.configured.map((capability) => ({
            id: capability.id,
            treeSha256: capability.treeSha256,
            requiredForDiscovery: capability.requiredForDiscovery,
          })),
        },
      );
      return value;
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "import") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, definition: "string" },
      "research capability import",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability import");
    const definitionPath = strictString(args, "definition");
    if (!definitionPath) {
      throw new CliError("research capability import requires --definition.", {
        code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.import", async () => {
      const value = await importExternalCapability({ workspace: root, definitionPath });
      await appendJournalEvent(workspacePaths(root).journal, "capability.imported", "workspace", {
        ...value.imported,
      });
      return value;
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, live: "boolean" },
      "research capability doctor",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability doctor");
    const root = await workspaceFromArgs(args);
    const result = await doctorExternalCapabilities(root, { live: strictBoolean(args, "live") });
    writeJson(io, result, args);
    return result.status === "ready" ? 0 : 3;
  }
  if (action !== "lock" && action !== "verify") throw unknownAction("research capability", action);
  const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, `research capability ${action}`);
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, `research capability ${action}`);
  const root = await workspaceFromArgs(args);
  if (action === "lock") {
    const lock = await withWorkspaceLock(root, "capability.lock", async () => {
      const value = await lockCapabilities(root);
      await appendJournalEvent(workspacePaths(root).journal, "capability.locked", "workspace", {
        count: value.capabilities.length,
        treeHashes: value.capabilities.map((item) => ({ id: item.id, sha256: item.treeSha256 })),
      });
      return value;
    });
    writeJson(io, lock, args);
    return 0;
  }
  const verification = await verifyCapabilities(root);
  writeJson(io, verification, args);
  return verification.status === "verified" ? 0 : 3;
}

async function runProject(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "audit") {
    const [auditAction, ...auditRest] = rest;
    if (auditAction === "export") {
      const args = parseStrictArgs(
        auditRest,
        { ...WORKSPACE_OPTIONS, output: "string" },
        "research project audit export",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project audit export");
      const destination = strictString(args, "output");
      if (!destination) {
        throw new CliError("Audit export requires --output.", {
          code: "RESEARCH_AUDIT_BUNDLE_PATH_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      writeJson(io, await exportProjectAuditBundle({ root, projectId, destination }), args);
      return 0;
    }
    if (auditAction === "verify") {
      const args = parseStrictArgs(
        auditRest,
        { ...COMMON_OPTIONS, bundle: "string" },
        "research project audit verify",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      rejectPositionals(args.positionals, "research project audit verify");
      const bundlePath = strictString(args, "bundle");
      if (!bundlePath) {
        throw new CliError("Audit verification requires --bundle.", {
          code: "RESEARCH_AUDIT_BUNDLE_PATH_INVALID",
          exitCode: 2,
        });
      }
      writeJson(io, await verifyProjectAuditBundle(bundlePath), args);
      return 0;
    }
    throw unknownAction("research project audit", auditAction ?? "");
  }
  if (action === "access") {
    const [accessAction, ...accessRest] = rest;
    if (accessAction !== "status") {
      throw unknownAction("research project access", accessAction ?? "");
    }
    const args = parseStrictArgs(accessRest, WORKSPACE_OPTIONS, "research project access status");
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project access status");
    const root = await workspaceFromArgs(args);
    writeJson(io, await inspectEvidenceAccessStatus(root, projectId), args);
    return 0;
  }
  if (action === "handoff") {
    const [handoffAction, ...handoffRest] = rest;
    if (handoffAction === "request") {
      const args = parseStrictArgs(
        handoffRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project handoff request",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project handoff request");
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("handoff request requires --record.", {
          code: "RESEARCH_PROJECT_HANDOFF_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_PROJECT_HANDOFF_INVALID",
      );
      const result = await requestResearchHandoff({ root, projectId, value: record });
      writeJson(io, result, args);
      return 0;
    }
    if (handoffAction === "resolve") {
      const args = parseStrictArgs(
        handoffRest,
        { ...WORKSPACE_OPTIONS, note: "string" },
        "research project handoff resolve",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project handoff resolve");
      const note = strictString(args, "note");
      if (!note) {
        throw new CliError("handoff resolve requires --note.", {
          code: "RESEARCH_PROJECT_HANDOFF_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await resolveResearchHandoff({ root, projectId, note });
      writeJson(io, result, args);
      return 0;
    }
    throw unknownAction("research project handoff", handoffAction ?? "");
  }
  if (action === "scientific") {
    const [scientificAction, ...scientificRest] = rest;
    if (scientificAction === "status") {
      const args = parseStrictArgs(
        scientificRest,
        WORKSPACE_OPTIONS,
        "research project scientific status",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project scientific status");
      const root = await workspaceFromArgs(args);
      writeJson(io, await inspectScientificReviewStatus(root, projectId), args);
      return 0;
    }
    if (scientificAction !== "review") {
      throw unknownAction("research project scientific", scientificAction ?? "");
    }
    const [reviewAction, ...reviewRest] = scientificRest;
    if (reviewAction === "execute") {
      const args = parseStrictArgs(
        reviewRest,
        {
          ...WORKSPACE_OPTIONS,
          role: "string",
          "confirm-review-cost": "boolean",
          retry: "boolean",
        },
        "research project scientific review execute",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project scientific review execute",
      );
      const root = await workspaceFromArgs(args);
      const result = await executeScientificReview({
        root,
        projectId,
        role: scientificReviewRole(strictString(args, "role")),
        confirmCost: strictBoolean(args, "confirm-review-cost"),
        retry: strictBoolean(args, "retry"),
        environment: io.env,
      });
      writeJson(io, result, args);
      return result.status === "passed" ? 0 : 3;
    }
    if (reviewAction === "prepare") {
      const args = parseStrictArgs(
        reviewRest,
        {
          ...WORKSPACE_OPTIONS,
          role: "string",
          assessment: "string",
          "canary-artifacts": "string",
          "reviewer-agent": "string",
          "reviewer-session": "string",
        },
        "research project scientific review prepare",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project scientific review prepare",
      );
      const assessmentPath = strictString(args, "assessment");
      const reviewerSessionId = strictString(args, "reviewer-session");
      if (!assessmentPath || !reviewerSessionId) {
        throw new CliError(
          "Scientific review prepare requires --assessment, --reviewer-agent, and --reviewer-session.",
          { code: "RESEARCH_SCIENTIFIC_REVIEW_ARGUMENT_REQUIRED", exitCode: 2 },
        );
      }
      const root = await workspaceFromArgs(args);
      const role = scientificReviewRole(strictString(args, "role"));
      const canaryArtifactsFile = strictString(args, "canary-artifacts");
      if (canaryArtifactsFile && role !== "evidence-construct") {
        throw new CliError("--canary-artifacts is valid only for evidence-construct.", {
          code: "RESEARCH_SCIENTIFIC_REVIEW_ARGUMENT_INVALID",
          exitCode: 2,
        });
      }
      writeJson(
        io,
        await prepareScientificReview({
          root,
          projectId,
          role,
          assessmentPath,
          reviewerAgent: publicationAgent(strictString(args, "reviewer-agent"), "reviewer"),
          reviewerSessionId,
          canaryArtifactPaths: canaryArtifactsFile
            ? await readAbsolutePathArray(canaryArtifactsFile, "canary-artifacts")
            : [],
        }),
        args,
      );
      return 0;
    }
    if (reviewAction === "submit") {
      const args = parseStrictArgs(
        reviewRest,
        { ...WORKSPACE_OPTIONS, role: "string", review: "string" },
        "research project scientific review submit",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project scientific review submit",
      );
      const reviewPath = strictString(args, "review");
      if (!reviewPath) {
        throw new CliError("Scientific review submit requires --review.", {
          code: "RESEARCH_SCIENTIFIC_REVIEW_ARGUMENT_REQUIRED",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      writeJson(
        io,
        await submitScientificReview({
          root,
          projectId,
          role: scientificReviewRole(strictString(args, "role")),
          reviewPath,
        }),
        args,
      );
      return 0;
    }
    throw unknownAction("research project scientific review", reviewAction ?? "");
  }
  if (action === "stage") {
    const [stageAction, ...stageRest] = rest;
    if (stageAction === "artifacts" || stageAction === "read") {
      const args = parseStrictArgs(
        stageRest,
        {
          ...WORKSPACE_OPTIONS,
          session: "string",
          artifact: "string",
          offset: "string",
          limit: "string",
          length: "string",
          encoding: "string",
          "path-prefix": "string",
        },
        `research project stage ${stageAction}`,
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const sessionId = strictString(args, "session");
      const objectId = strictString(args, "artifact");
      if (!sessionId || (stageAction === "read" && !objectId))
        throw new CliError(
          "Stage artifact reads require --session and an exact --artifact for read.",
          { code: "RESEARCH_NATIVE_STAGE_SESSION_REQUIRED", exitCode: 3 },
        );
      const offset = strictString(args, "offset");
      const limit = strictString(args, "limit");
      const length = strictString(args, "length");
      const encoding = strictString(args, "encoding");
      if (encoding && encoding !== "utf8" && encoding !== "base64")
        throw new CliError("Artifact encoding must be utf8 or base64.", {
          code: "RESEARCH_ARTIFACT_VIEW_INVALID",
          exitCode: 3,
        });
      const projectId = onePositional(args.positionals, `research project stage ${stageAction}`);
      writeJson(
        io,
        await readNativeStageArtifact({
          root: await workspaceFromArgs(args),
          projectId,
          sessionId,
          ...(stageAction === "read"
            ? {
                selection: {
                  objectId: objectId!,
                  ...(offset === undefined ? {} : { offset: Number(offset) }),
                  ...(length === undefined
                    ? {}
                    : { length: length === "all" ? null : Number(length) }),
                  ...(encoding ? { encoding: encoding as "utf8" | "base64" } : {}),
                },
              }
            : {
                listing: {
                  ...(offset === undefined ? {} : { offset: Number(offset) }),
                  ...(limit === undefined ? {} : { limit: Number(limit) }),
                  ...(strictString(args, "path-prefix")
                    ? { pathPrefix: strictString(args, "path-prefix")! }
                    : {}),
                },
              }),
        }),
        args,
      );
      return 0;
    }
    if (stageAction === "prepare") {
      const args = parseStrictArgs(
        stageRest,
        { ...WORKSPACE_OPTIONS, stage: "string", "host-agent": "string" },
        "research project stage prepare",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage prepare");
      const stage = nativeProducerStage(strictString(args, "stage"));
      const hostAgent = nativeHostAgent(strictString(args, "host-agent"));
      const root = await workspaceFromArgs(args);
      const result = await prepareNativeResearchStage({ root, projectId, stage, hostAgent });
      writeJson(io, result, args);
      return 0;
    }
    if (stageAction === "submit") {
      const args = parseStrictArgs(
        stageRest,
        {
          ...WORKSPACE_OPTIONS,
          session: "string",
          output: "string",
          "confirm-model": "string",
        },
        "research project stage submit",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage submit");
      const sessionId = strictString(args, "session");
      const outputPath = strictString(args, "output");
      if (!sessionId || !outputPath) {
        throw new CliError("stage submit requires --session and --output.", {
          code: "RESEARCH_NATIVE_STAGE_OUTPUT_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await submitNativeResearchStage({
        root,
        projectId,
        sessionId,
        outputPath,
        confirmedModel: strictString(args, "confirm-model") ?? null,
      });
      writeJson(io, result, args);
      return 0;
    }
    if (stageAction === "abort") {
      const args = parseStrictArgs(
        stageRest,
        { ...WORKSPACE_OPTIONS, session: "string" },
        "research project stage abort",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage abort");
      const sessionId = strictString(args, "session");
      if (!sessionId) {
        throw new CliError("stage abort requires --session.", {
          code: "RESEARCH_NATIVE_STAGE_SESSION_REQUIRED",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await abortNativeResearchStage({ root, projectId, sessionId });
      writeJson(io, result, args);
      return 0;
    }
    throw unknownAction("research project stage", stageAction ?? "");
  }
  if (action === "task") {
    const [taskAction, ...taskRest] = rest;
    if (taskAction === "run") {
      const [runAction, ...runRest] = taskRest;
      if (runAction !== "observe" && runAction !== "inspect")
        throw unknownAction("research project task run", runAction ?? "");
      const args = parseStrictArgs(
        runRest,
        { ...WORKSPACE_OPTIONS, input: "string", run: "string", "confirm-execution": "boolean" },
        `research project task run ${runAction}`,
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, `research project task run ${runAction}`);
      const root = await workspaceFromArgs(args);
      const result =
        runAction === "inspect"
          ? await inspectNativeRun(root, projectId, strictString(args, "run") ?? "")
          : await observeNativeRun(
              root,
              projectId,
              await readBoundedJsonRecord(
                strictString(args, "input") ?? "",
                "--input",
                "RESEARCH_NATIVE_RUN_INVALID",
              ),
              strictBoolean(args, "confirm-execution"),
            );
      writeJson(io, result, args);
      return "record" in result && result.record && result.record.status !== "succeeded" ? 3 : 0;
    }
    if (taskAction === "acceptance") {
      const [acceptanceAction, ...acceptanceRest] = taskRest;
      if (acceptanceAction !== "record")
        throw unknownAction("research project task acceptance", acceptanceAction ?? "");
      const args = parseStrictArgs(
        acceptanceRest,
        { ...WORKSPACE_OPTIONS, input: "string" },
        "research project task acceptance record",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project task acceptance record");
      const result = await recordProjectTaskAcceptance(
        await workspaceFromArgs(args),
        projectId,
        await readBoundedJsonRecord(
          strictString(args, "input") ?? "",
          "--input",
          "RESEARCH_TASK_ACCEPTANCE_INVALID",
        ),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (taskAction === "scope") {
      const [scopeAction, ...scopeRest] = taskRest;
      if (!["propose", "approve"].includes(scopeAction ?? ""))
        throw unknownAction("research project task scope", scopeAction ?? "");
      const args = parseStrictArgs(
        scopeRest,
        {
          ...WORKSPACE_OPTIONS,
          input: "string",
          "expected-contract": "string",
          proposal: "string",
          "confirm-change": "string",
        },
        `research project task scope ${scopeAction}`,
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        `research project task scope ${scopeAction}`,
      );
      const root = await workspaceFromArgs(args);
      const result =
        scopeAction === "approve"
          ? await approveProjectTaskScope(
              root,
              projectId,
              strictString(args, "proposal") ?? "",
              strictString(args, "confirm-change"),
            )
          : await proposeProjectTaskScope(
              root,
              projectId,
              strictString(args, "expected-contract") ?? "",
              await readBoundedJsonRecord(
                strictString(args, "input") ?? "",
                "--input",
                "RESEARCH_TASK_INVALID",
              ),
            );
      writeJson(io, result, args);
      return 0;
    }
    if (taskAction !== "define" && taskAction !== "status")
      throw unknownAction("research project task", taskAction ?? "");
    const args = parseStrictArgs(
      taskRest,
      { ...WORKSPACE_OPTIONS, input: "string" },
      `research project task ${taskAction}`,
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, `research project task ${taskAction}`);
    const root = await workspaceFromArgs(args);
    const result =
      taskAction === "status"
        ? await inspectProjectTask(root, projectId)
        : await defineProjectTask(
            root,
            projectId,
            await readBoundedJsonRecord(
              strictString(args, "input") ?? "",
              "--input",
              "RESEARCH_TASK_INVALID",
            ),
          );
    writeJson(io, result, args);
    return 0;
  }
  if (action === "evidence") {
    const [evidenceAction, ...evidenceRest] = rest;
    if (evidenceAction === "acquisition") {
      const [revisionAction, ...revisionRest] = evidenceRest;
      if (revisionAction !== "revise")
        throw unknownAction("research project evidence acquisition", revisionAction ?? "");
      const args = parseStrictArgs(
        revisionRest,
        {
          ...WORKSPACE_OPTIONS,
          "expected-snapshot": "string",
          reason: "string",
          "include-discovery": "boolean",
        },
        "research project evidence acquisition revise",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence acquisition revise",
      );
      const result = await reviseProjectAcquisition({
        root: await workspaceFromArgs(args),
        projectId,
        expectedSnapshotSha256: strictString(args, "expected-snapshot") ?? "",
        reason: strictString(args, "reason") ?? "",
        includeDiscovery: strictBoolean(args, "include-discovery"),
      });
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "data") {
      const [dataAction, ...dataRest] = evidenceRest;
      if (dataAction !== "run" && dataAction !== "read") {
        throw unknownAction("research project evidence data", dataAction ?? "");
      }
      if (dataAction === "read") {
        const args = parseStrictArgs(
          dataRest,
          { ...WORKSPACE_OPTIONS, receipt: "string", cursor: "string" },
          "research project evidence data read",
        );
        if (strictBoolean(args, "help")) return writeHelp(io);
        const projectId = onePositional(args.positionals, "research project evidence data read");
        const receiptId = strictString(args, "receipt");
        const cursor = strictString(args, "cursor");
        if (!receiptId || !cursor) {
          throw new CliError("evidence data read requires --receipt and --cursor.", {
            code: "RESEARCH_DATA_EVIDENCE_CURSOR_INVALID",
            exitCode: 2,
          });
        }
        const root = await workspaceFromArgs(args);
        const result = await withWorkspaceLock(root, "research.data-evidence.read", () =>
          readResearchDataEvidence({ root, projectId, receiptId, cursor }),
        );
        writeJson(io, projectResearchDataEvidenceViewResult(result), args);
        return 0;
      }
      const args = parseStrictArgs(
        dataRest,
        { ...WORKSPACE_OPTIONS, request: "string" },
        "research project evidence data run",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project evidence data run");
      const requestPath = strictString(args, "request");
      if (!requestPath) {
        throw new CliError("evidence data run requires --request.", {
          code: "RESEARCH_DATA_REQUEST_INVALID",
          exitCode: 2,
        });
      }
      const request = await readBoundedJsonRecord(
        requestPath,
        "--request",
        "RESEARCH_DATA_REQUEST_INVALID",
      );
      const root = await workspaceFromArgs(args);
      const result = await withWorkspaceLock(root, "research.data-evidence.run", () =>
        executeResearchDataCapability({
          root,
          projectId,
          request,
        }),
      );
      writeJson(io, projectResearchDataExecutionResult(result), args);
      return result.coreResult.status === "success"
        ? 0
        : result.coreResult.status === "partial"
          ? 4
          : 3;
    }
    if (evidenceAction === "activity") {
      const [activityAction, ...activityRest] = evidenceRest;
      if (activityAction !== "record") {
        throw unknownAction("research project evidence activity", activityAction ?? "");
      }
      const args = parseStrictArgs(
        activityRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence activity record",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence activity record",
      );
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("activity record requires --record.", {
          code: "RESEARCH_NATIVE_ACTIVITY_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_NATIVE_ACTIVITY_INVALID",
      );
      const result = await withWorkspaceLock(root, "research.native-activity.record", () =>
        recordNativeResearchActivity({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "candidate") {
      const [candidateAction, ...candidateRest] = evidenceRest;
      if (candidateAction !== "register") {
        throw unknownAction("research project evidence candidate", candidateAction ?? "");
      }
      const args = parseStrictArgs(
        candidateRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence candidate register",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence candidate register",
      );
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("candidate register requires --record.", {
          code: "RESEARCH_NATIVE_CANDIDATE_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_NATIVE_CANDIDATE_INVALID",
      );
      const result = await withWorkspaceLock(root, "research.native-candidate.register", () =>
        registerNativeDiscoveryCandidate({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "assessment") {
      const [assessmentAction, ...assessmentRest] = evidenceRest;
      if (assessmentAction !== "record") {
        throw unknownAction("research project evidence assessment", assessmentAction ?? "");
      }
      const args = parseStrictArgs(
        assessmentRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence assessment record",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence assessment record",
      );
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("assessment record requires --record.", {
          code: "RESEARCH_DISCOVERY_ASSESSMENT_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_DISCOVERY_ASSESSMENT_INVALID",
      );
      const result = await withWorkspaceLock(root, "research.discovery-assessment.record", () =>
        recordDiscoveryAssessmentBatch({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "download") {
      const [downloadAction, ...downloadRest] = evidenceRest;
      if (downloadAction !== "bind") {
        throw unknownAction("research project evidence download", downloadAction ?? "");
      }
      const args = parseStrictArgs(
        downloadRest,
        { ...WORKSPACE_OPTIONS, candidate: "string", record: "string" },
        "research project evidence download bind",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project evidence download bind");
      const candidateId = strictString(args, "candidate");
      const recordPath = strictString(args, "record");
      if (!candidateId || !recordPath) {
        throw new CliError("download bind requires --candidate and --record.", {
          code: "RESEARCH_DOWNLOAD_BINDING_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_DOWNLOAD_BINDING_INVALID",
      );
      const result = await withWorkspaceLock(root, "research.download.bind", () =>
        bindEvidenceDownload({ root, projectId, candidateId, value: record }),
      );
      writeJson(io, result, args);
      return result.status === "completed" ? 0 : 3;
    }
    if (evidenceAction === "artifact") {
      const [artifactAction, ...artifactRest] = evidenceRest;
      if (artifactAction === "preflight") {
        const args = parseStrictArgs(
          artifactRest,
          { ...WORKSPACE_OPTIONS, bytes: "string", path: "string" },
          "research project evidence artifact preflight",
        );
        if (strictBoolean(args, "help")) return writeHelp(io);
        if (args.positionals.length)
          throw unknownAction("research project evidence artifact preflight", args.positionals[0]!);
        const bytes = strictString(args, "bytes");
        const path = strictString(args, "path");
        const result = await preflightEvidenceArtifact({
          root: await workspaceFromArgs(args),
          ...(bytes === undefined
            ? {}
            : { bytes: /^\d+$/u.test(bytes) ? Number(bytes) : Number.NaN }),
          ...(path === undefined ? {} : { path }),
        });
        writeJson(io, result, args);
        return result.decision === "pass" ? 0 : 3;
      }
      if (artifactAction !== "register") {
        throw unknownAction("research project evidence artifact", artifactAction ?? "");
      }
      const args = parseStrictArgs(
        artifactRest,
        {
          ...WORKSPACE_OPTIONS,
          candidate: "string",
          path: "string",
          "media-type": "string",
          "source-url": "string",
          license: "string",
          "license-url": "string",
          "host-type": "string",
          "article-version": "string",
          "download-binding": "string",
          "derived-from-artifact": "string",
        },
        "research project evidence artifact register",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence artifact register",
      );
      const candidateId = strictString(args, "candidate");
      const path = strictString(args, "path");
      if (!candidateId || !path) {
        throw new CliError("artifact register requires --candidate and --path.", {
          code: "RESEARCH_ARTIFACT_PATH_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await withWorkspaceLock(root, "research.artifact.register", () =>
        registerEvidenceArtifact({
          root,
          projectId,
          candidateId,
          path,
          ...(strictString(args, "media-type")
            ? { mediaType: strictString(args, "media-type")! }
            : {}),
          ...(strictString(args, "source-url")
            ? { sourceUrl: strictString(args, "source-url")! }
            : {}),
          ...(strictString(args, "license") ? { license: strictString(args, "license")! } : {}),
          ...(strictString(args, "license-url")
            ? { licenseUrl: strictString(args, "license-url")! }
            : {}),
          ...(strictString(args, "host-type")
            ? { hostType: strictString(args, "host-type")! }
            : {}),
          ...(strictString(args, "article-version")
            ? { articleVersion: strictString(args, "article-version")! }
            : {}),
          ...(strictString(args, "download-binding")
            ? { downloadBindingId: strictString(args, "download-binding")! }
            : {}),
          ...(strictString(args, "derived-from-artifact")
            ? { derivedFromArtifactId: strictString(args, "derived-from-artifact")! }
            : {}),
        }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "decomposition") {
      const [decompositionAction, ...decompositionRest] = evidenceRest;
      if (decompositionAction !== "record" && decompositionAction !== "batch") {
        throw unknownAction("research project evidence decomposition", decompositionAction ?? "");
      }
      const args = parseStrictArgs(
        decompositionRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence decomposition record",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence decomposition record",
      );
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("decomposition record requires --record.", {
          code: "RESEARCH_DECOMPOSITION_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_DECOMPOSITION_INVALID",
        decompositionAction === "batch" ? EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes : undefined,
      );
      const result = await withWorkspaceLock(root, "research.decomposition.record", async () =>
        decompositionAction === "batch"
          ? registerEvidenceContentBatch({ root, projectId, kind: "decomposition", value: record })
          : recordArtifactDecomposition({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "atom") {
      const [atomAction, ...atomRest] = evidenceRest;
      if (atomAction !== "register" && atomAction !== "batch") {
        throw unknownAction("research project evidence atom", atomAction ?? "");
      }
      const args = parseStrictArgs(
        atomRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence atom register",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project evidence atom register");
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("atom register requires --record.", {
          code: "RESEARCH_EVIDENCE_ATOM_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_EVIDENCE_ATOM_INVALID",
        atomAction === "batch" ? EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes : undefined,
      );
      const result = await withWorkspaceLock(root, "research.evidence-atom.register", async () =>
        atomAction === "batch"
          ? registerEvidenceContentBatch({ root, projectId, kind: "atom", value: record })
          : registerEvidenceAtom({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "content") {
      const [contentAction, ...contentRest] = evidenceRest;
      if (contentAction === "forecast") {
        const args = parseStrictArgs(
          contentRest,
          { ...WORKSPACE_OPTIONS, input: "string" },
          "research project evidence content forecast",
        );
        if (strictBoolean(args, "help")) return writeHelp(io);
        const projectId = onePositional(
          args.positionals,
          "research project evidence content forecast",
        );
        const inputPath = strictString(args, "input");
        if (!inputPath)
          throw new CliError(
            "content forecast requires --input with a proposed acquisition audit.",
            { code: "RESEARCH_ACQUISITION_FORECAST_INVALID", exitCode: 2 },
          );
        const root = await workspaceFromArgs(args);
        const value = await readBoundedJsonRecord(
          inputPath,
          "--input",
          "RESEARCH_ACQUISITION_FORECAST_INVALID",
        );
        const result = await inspectAcquisitionForecast(root, projectId, value);
        writeJson(io, result, args);
        return result.submissionGate.decision !== "stop" &&
          result.acquisitionGate.decision === "pass" &&
          !result.knownRoleDeficits.length
          ? 0
          : 3;
      }
      if (contentAction !== "freeze" && contentAction !== "status") {
        throw unknownAction("research project evidence content", contentAction ?? "");
      }
      const args = parseStrictArgs(
        contentRest,
        WORKSPACE_OPTIONS,
        `research project evidence content ${contentAction}`,
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        `research project evidence content ${contentAction}`,
      );
      const root = await workspaceFromArgs(args);
      const result =
        contentAction === "freeze"
          ? await withWorkspaceLock(root, "research.evidence-content.freeze", () =>
              freezeEvidenceContentSnapshot(root, projectId),
            )
          : await loadCurrentEvidenceContentSnapshot(root, projectId);
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction !== "fetch") {
      throw unknownAction("research project evidence", evidenceAction ?? "");
    }
    const args = parseStrictArgs(
      evidenceRest,
      { ...WORKSPACE_OPTIONS, request: "string" },
      "research project evidence fetch",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project evidence fetch");
    const requestPath = strictString(args, "request");
    if (!requestPath) {
      throw new CliError("evidence fetch requires --request.", {
        code: "RESEARCH_BROKER_REQUEST_INVALID",
        exitCode: 2,
      });
    }
    const request = await readNativeEvidenceRequest(requestPath);
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "research.native-evidence.fetch", () =>
      fetchNativeCandidateSource({ root, projectId, request }),
    );
    writeJson(io, result, args);
    return 0;
  }
  if (action === "init") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        question: "string",
        goal: "string",
        requirements: "string",
        "input-plan": "string",
        design: "string",
        "design-producer-agent": "string",
        "design-producer-session": "string",
        "confirm-budget": "boolean",
      },
      "research project init",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project init");
    const question = strictString(args, "question");
    if (!question) {
      throw new CliError("research project init requires --question.", {
        code: "RESEARCH_QUESTION_REQUIRED",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const goal = researchGoal(strictString(args, "goal"));
    const requirementsPath = strictString(args, "requirements");
    const inputPlanPath = strictString(args, "input-plan");
    const publicationPolicy =
      goal === "top-journal" ? await loadApprovedResearchPolicy(root, projectId) : undefined;
    const designPath = strictString(args, "design");
    const designProducerAgent = strictString(args, "design-producer-agent");
    const designProducerSession = strictString(args, "design-producer-session");
    if (goal === "top-journal" && (!designPath || !designProducerAgent || !designProducerSession)) {
      throw new CliError(
        "Top-journal init requires --design, --design-producer-agent, and --design-producer-session.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REQUIRED", exitCode: 2 },
      );
    }
    if (goal !== "top-journal" && (designPath || designProducerAgent || designProducerSession)) {
      throw new CliError("Scientific design options are only valid with --goal top-journal.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_REQUIRED",
        exitCode: 2,
      });
    }
    const project = await initializeProject(
      root,
      projectId,
      question,
      requirementsPath ? await readEvidenceRequirements(requirementsPath) : undefined,
      strictBoolean(args, "confirm-budget"),
      inputPlanPath ? await readAndVerifyProjectInputPlan(inputPlanPath) : undefined,
      publicationPolicy,
      designPath && designProducerAgent && designProducerSession
        ? {
            design: await readAndVerifyScientificDesign(designPath, projectId),
            producerAgent: publicationAgent(designProducerAgent, "design producer"),
            producerSessionId: designProducerSession,
          }
        : undefined,
    );
    writeJson(io, project, args);
    return 0;
  }
  if (action === "preflight") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        question: "string",
        goal: "string",
        "policy-project": "string",
        requirements: "string",
        "input-plan": "string",
        design: "string",
      },
      "research project preflight",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research project preflight");
    const question = strictString(args, "question")?.trim();
    if (!question) {
      throw new CliError("research project preflight requires --question.", {
        code: "RESEARCH_QUESTION_REQUIRED",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const goal = researchGoal(strictString(args, "goal"));
    const policyProject = strictString(args, "policy-project");
    let publicationPolicy = null;
    if (goal === "top-journal") {
      if (!policyProject) {
        throw new CliError("Top-journal preflight requires --policy-project.", {
          code: "RESEARCH_POLICY_REQUIRED",
          exitCode: 2,
        });
      }
      publicationPolicy = await loadApprovedResearchPolicy(root, policyProject);
    } else if (policyProject) {
      throw new CliError("--policy-project is only valid with --goal top-journal.", {
        code: "RESEARCH_POLICY_INVALID",
        exitCode: 2,
      });
    }
    const requirementsPath = strictString(args, "requirements");
    const requirements = requirementsPath ? await readEvidenceRequirements(requirementsPath) : null;
    const inputPlanPath = strictString(args, "input-plan");
    const inputPlan = inputPlanPath ? await readAndVerifyProjectInputPlan(inputPlanPath) : null;
    const designPath = strictString(args, "design");
    if (goal === "top-journal" && !designPath) {
      throw new CliError("Top-journal preflight requires --design.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REQUIRED",
        exitCode: 2,
      });
    }
    if (goal !== "top-journal" && designPath) {
      throw new CliError("--design is only valid with --goal top-journal.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_REQUIRED",
        exitCode: 2,
      });
    }
    const scientificDesign = designPath
      ? await readAndVerifyScientificDesign(designPath, policyProject)
      : null;
    const result = await evaluateProjectPreflight(root, question, requirements, inputPlan, {
      publicationPolicy,
      scientificDesign,
    });
    writeJson(io, result, args);
    return result.readyToInitialize ? 0 : 3;
  }
  if (action === "input") {
    const [inputAction, ...inputRest] = rest;
    if (inputAction === "--help" || inputAction === "-h") return writeHelp(io);
    if (inputAction !== "add") throw unknownAction("research project input", inputAction ?? "");
    const args = parseStrictArgs(
      inputRest,
      {
        ...WORKSPACE_OPTIONS,
        path: "string",
        role: "string",
        "trust-status": "string",
        "independently-reproduced": "boolean",
      },
      "research project input add",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project input add");
    const inputPath = strictString(args, "path");
    if (!inputPath) {
      throw new CliError("research project input add requires --path.", {
        code: "RESEARCH_INPUT_REQUIRED",
        exitCode: 2,
      });
    }
    const role = inputRole(strictString(args, "role"));
    const root = await workspaceFromArgs(args);
    const trustStatus = projectInputTrustStatus(strictString(args, "trust-status"), role);
    const input = await addProjectInput(root, projectId, inputPath, role, {
      ...(trustStatus ? { trustStatus } : {}),
      independentlyReproduced: strictBoolean(args, "independently-reproduced"),
    });
    writeJson(io, input, args);
    return 0;
  }
  if (action === "retry") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, package: "string" },
      "research project retry",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project retry");
    const root = await workspaceFromArgs(args);
    const project = await retryProjectPackage(root, projectId, strictString(args, "package"));
    writeJson(io, project, args);
    return 0;
  }
  if (action === "fork") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        to: "string",
        "resume-through": "string",
        design: "string",
        "design-producer-agent": "string",
        "design-producer-session": "string",
      },
      "research project fork",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const sourceProjectId = onePositional(args.positionals, "research project fork");
    const targetProjectId = strictString(args, "to");
    if (!targetProjectId) {
      throw new CliError("research project fork requires --to.", {
        code: "RESEARCH_PROJECT_FORK_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const source = await loadProject(root, sourceProjectId);
    const designPath = strictString(args, "design");
    const designProducerAgent = strictString(args, "design-producer-agent");
    const designProducerSession = strictString(args, "design-producer-session");
    if (
      source.publicationPolicy &&
      (!designPath || !designProducerAgent || !designProducerSession)
    ) {
      throw new CliError(
        "A top-journal fork requires a target-specific approved policy plus --design, --design-producer-agent, and --design-producer-session.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!source.publicationPolicy && (designPath || designProducerAgent || designProducerSession)) {
      throw new CliError("Scientific reapproval options require a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const project = await forkProject(
      root,
      sourceProjectId,
      targetProjectId,
      resumeStage(strictString(args, "resume-through")),
      designPath && designProducerAgent && designProducerSession
        ? {
            publicationPolicy: await loadApprovedResearchPolicy(root, targetProjectId),
            scientificDesign: {
              design: await readAndVerifyScientificDesign(designPath, targetProjectId),
              producerAgent: publicationAgent(designProducerAgent, "design producer"),
              producerSessionId: designProducerSession,
            },
          }
        : undefined,
    );
    writeJson(io, project, args);
    return 0;
  }
  if (action === "addendum") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        to: "string",
        design: "string",
        "design-producer-agent": "string",
        "design-producer-session": "string",
      },
      "research project addendum",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const sourceProjectId = onePositional(args.positionals, "research project addendum");
    const targetProjectId = strictString(args, "to");
    if (!targetProjectId) {
      throw new CliError("research project addendum requires --to.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const source = await loadProject(root, sourceProjectId);
    const designPath = strictString(args, "design");
    const designProducerAgent = strictString(args, "design-producer-agent");
    const designProducerSession = strictString(args, "design-producer-session");
    if (
      source.publicationPolicy &&
      (!designPath || !designProducerAgent || !designProducerSession)
    ) {
      throw new CliError(
        "A top-journal addendum requires a target-specific approved policy plus --design, --design-producer-agent, and --design-producer-session.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!source.publicationPolicy && (designPath || designProducerAgent || designProducerSession)) {
      throw new CliError("Scientific reapproval options require a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const project = await createProjectAddendum(
      root,
      sourceProjectId,
      targetProjectId,
      designPath && designProducerAgent && designProducerSession
        ? {
            publicationPolicy: await loadApprovedResearchPolicy(root, targetProjectId),
            scientificDesign: {
              design: await readAndVerifyScientificDesign(designPath, targetProjectId),
              producerAgent: publicationAgent(designProducerAgent, "design producer"),
              producerSessionId: designProducerSession,
            },
          }
        : undefined,
    );
    writeJson(io, project, args);
    return 0;
  }
  if (action === "archive" || action === "abandon") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, reason: "string" },
      `research project ${action}`,
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, `research project ${action}`);
    const reason = strictString(args, "reason");
    if (!reason) {
      throw new CliError(`research project ${action} requires --reason.`, {
        code: "RESEARCH_PROJECT_DISPOSITION_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const project = await setProjectDisposition(
      root,
      projectId,
      action === "archive" ? "archived" : "abandoned",
      reason,
    );
    writeJson(io, project, args);
    return 0;
  }
  throw unknownAction("research project", action);
}

async function runStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, project: "string", all: "boolean" },
    "research status",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research status");
  const root = await workspaceFromArgs(args);
  const config = await loadWorkspaceConfig(root);
  const selectedProject = strictString(args, "project");
  const authorityIndex = await readProjectAuthorityIndex(root);
  const workspaceProjects = await listProjects(root, authorityIndex);
  const allProjects = selectedProject
    ? [
        workspaceProjects.find((project) => project.id === selectedProject) ??
          (await loadProject(root, selectedProject)),
      ]
    : workspaceProjects;
  const projects =
    selectedProject || strictBoolean(args, "all")
      ? allProjects
      : allProjects.filter((project) =>
          ["authoritative", "invalid"].includes(projectAuthority(project, authorityIndex).state),
        );
  const result = {
    workspace: root,
    execution: {
      producer: {
        host: config.producer.agent,
        model: config.producer.model,
        mode: config.producer.executionMode,
      },
      reviewer: {
        agent: config.reviewer.agent,
        model: config.reviewer.model,
        mode: config.reviewer.executionMode,
        transport: config.reviewerExecution.transport,
        isolationProvider: config.reviewerExecution.isolationProvider,
      },
    },
    hiddenSupersededProjects:
      selectedProject || strictBoolean(args, "all")
        ? 0
        : workspaceProjects.filter((project) => authorityIndex.successors.has(project.id)).length,
    hiddenArchivedProjects:
      selectedProject || strictBoolean(args, "all")
        ? 0
        : workspaceProjects.filter((project) => project.status === "archived").length,
    hiddenAbandonedProjects:
      selectedProject || strictBoolean(args, "all")
        ? 0
        : workspaceProjects.filter((project) => project.status === "abandoned").length,
    projects: await Promise.all(
      projects.map(async (project) => {
        const current = refreshProject(projectWithEffectiveAuthority(project, authorityIndex));
        const authority = projectAuthority(current, authorityIndex);
        const nativeStage = await inspectNativeResearchStage(root, current);
        const evidencePipeline = await inspectEvidencePipelineForStatus(root, current);
        const snapshot = evidencePipeline.acquisition;
        const readyPackage = nextReadyPackage(current)?.id ?? null;
        const scientificReview = await inspectScientificReviewStatus(root, current.id, current);
        const evidenceAccess = current.scientificDesign
          ? await inspectEvidenceAccessForStatus(root, current.id)
          : null;
        const publication = current.publicationPolicy
          ? await inspectPublicationForStatus(root, current.id)
          : null;
        return {
          id: current.id,
          question: current.question,
          status: current.status,
          authority,
          lineage: current.lineage,
          handoff: current.handoff,
          evidenceState: current.evidenceState,
          snapshot,
          evidencePipeline,
          nativeStage,
          scientificReview,
          task: await inspectProjectTask(
            root,
            current.id,
            authorityIndex.taskEvents.get(current.id) ?? [],
          ),
          evidenceAccess,
          publication,
          readyPackage,
          recommendedAction:
            authority.state === "invalid"
              ? "This recovery target has no project.forked commit marker. Do not execute it; inspect and remove or repair the incomplete fork while retaining source authority."
              : projectRecommendedAction(
                  root,
                  current,
                  readyPackage,
                  nativeStage,
                  evidencePipeline,
                  publication,
                ),
          usage: current.usage,
          inputs: current.inputs,
          packages: current.packages,
          discovery: await inspectDiscoveryProgress(root, current),
        };
      }),
    ),
  };
  writeJson(io, result, args);
  return 0;
}

interface EvidencePipelineStageStatus {
  status: "absent" | "verified" | "blocked" | "invalid";
  code?: string;
  gate?: { decision: "pass" | "stop"; reasons: string[] };
  [key: string]: unknown;
}

interface EvidencePipelineStatus {
  acquisition: EvidencePipelineStageStatus;
  content: EvidencePipelineStageStatus;
  inference: EvidencePipelineStageStatus;
  claimGraph: EvidencePipelineStageStatus;
}

async function inspectEvidencePipelineForStatus(
  root: string,
  project: Awaited<ReturnType<typeof loadProject>>,
): Promise<EvidencePipelineStatus> {
  const projectRoot = join(workspacePaths(root).projects, project.id);
  const acquisition = await inspectSnapshotForStatus(root, project.id);
  const contentPath = join(projectRoot, "outputs", "content-snapshot.json");
  let content: EvidencePipelineStageStatus = { status: "absent" };
  if (await pathExists(contentPath)) {
    try {
      const snapshot = await loadCurrentEvidenceContentSnapshot(root, project.id);
      content = {
        status: "verified",
        snapshotId: snapshot.snapshotId,
        snapshotSha256: snapshot.snapshotSha256,
        decompositionCount: snapshot.decompositions.length,
        atomCount: snapshot.atoms.length,
        sourceCount: snapshot.sourceCoverage.length,
        roleCount: snapshot.roleCoverage.length,
        insufficientRoleIds: snapshot.roleCoverage
          .filter((role) => role.decision === "insufficient")
          .map((role) => role.roleId),
        gate: snapshot.gate,
      };
    } catch (error) {
      content = {
        status: "invalid",
        code: error instanceof CliError ? error.code : "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_INVALID",
      };
    }
  }
  const inferencePath = join(projectRoot, "outputs", "inference-snapshot.json");
  let inference: EvidencePipelineStageStatus = { status: "absent" };
  if (await pathExists(inferencePath)) {
    try {
      const snapshot = await loadCurrentInferenceSnapshot(root, project.id);
      inference = {
        status: "verified",
        snapshotId: snapshot.snapshotId,
        snapshotSha256: snapshot.snapshotSha256,
        sourceCount: snapshot.sources.length,
        atomCount: snapshot.atoms.length,
        claimCount: snapshot.claims.length,
        artifactCount: snapshot.artifactSha256s.length,
        gate: snapshot.gate,
      };
    } catch (error) {
      inference = {
        status: "invalid",
        code: error instanceof CliError ? error.code : "RESEARCH_INFERENCE_SNAPSHOT_INVALID",
      };
    }
  } else if (acquisition.gate?.decision === "stop") {
    inference = { status: "blocked", gate: acquisition.gate };
  } else if (content.gate?.decision === "stop") {
    inference = { status: "blocked", gate: content.gate };
  } else if (project.scientificDesign && content.status !== "verified") {
    inference = {
      status: "blocked",
      code: "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_REQUIRED",
    };
  }
  const graphPath = join(projectRoot, "outputs", "claim-evidence-graph.json");
  let claimGraph: EvidencePipelineStageStatus = { status: "absent" };
  if (await pathExists(graphPath)) {
    try {
      const graph = await loadCurrentClaimEvidenceGraph(root, project.id);
      claimGraph = {
        status: "verified",
        graphId: graph.graphId,
        graphSha256: graph.graphSha256,
        analysisSha256: graph.analysisSha256,
        analysisRunId: graph.analysisRunId,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      };
    } catch (error) {
      claimGraph = {
        status: "invalid",
        code: error instanceof CliError ? error.code : "RESEARCH_CLAIM_EVIDENCE_GRAPH_INVALID",
      };
    }
  }
  return { acquisition, content, inference, claimGraph };
}

async function inspectEvidenceAccessForStatus(
  root: string,
  projectId: string,
): Promise<
  Awaited<ReturnType<typeof inspectEvidenceAccessStatus>> | { status: "invalid"; code: string }
> {
  try {
    return await inspectEvidenceAccessStatus(root, projectId);
  } catch (error) {
    return {
      status: "invalid",
      code: error instanceof CliError ? error.code : "RESEARCH_EVIDENCE_ACCESS_PLAN_INVALID",
    };
  }
}

async function inspectSnapshotForStatus(
  root: string,
  projectId: string,
): Promise<EvidencePipelineStageStatus> {
  const currentPath = join(
    workspacePaths(root).projects,
    projectId,
    "outputs",
    "evidence-snapshot.json",
  );
  if (!(await pathExists(currentPath))) return { status: "absent" };
  try {
    const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
    return {
      status: "verified",
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
      parentSnapshotId: snapshot.parentSnapshotId,
      sourceCount: snapshot.sources.length,
      artifactCount: snapshot.artifacts.length,
      gapCount: snapshot.gaps.length,
      gate: snapshot.inferenceGate,
      delta: snapshot.delta,
    };
  } catch (error) {
    const code = error instanceof CliError ? error.code : "RESEARCH_EVIDENCE_SNAPSHOT_INVALID";
    return {
      status: "invalid",
      code,
    };
  }
}

async function inspectPublicationForStatus(
  root: string,
  projectId: string,
): Promise<PublicationStatus | { generationStatus: "invalid"; code: string }> {
  try {
    return await inspectPublicationStatus(root, projectId);
  } catch (error) {
    return {
      generationStatus: "invalid",
      code: error instanceof CliError ? error.code : "RESEARCH_PUBLICATION_STATE_INVALID",
    };
  }
}

function projectRecommendedAction(
  root: string,
  project: Awaited<ReturnType<typeof loadProject>>,
  readyPackage: string | null,
  nativeStage: Awaited<ReturnType<typeof inspectNativeResearchStage>>,
  evidencePipeline: EvidencePipelineStatus,
  publication: PublicationStatus | { generationStatus: "invalid"; code: string } | null,
): string {
  if (project.lineage.supersededBy) {
    return `Continue with superseding project ${project.lineage.supersededBy}.`;
  }
  if (project.status === "archived" || project.status === "abandoned") {
    return `Project is ${project.status}; inspect with research status --all and continue only from an authoritative project.`;
  }
  if (project.handoff.state === "user-action-required") {
    const resources = project.handoff.accessRequests.map((request) => request.resourceName);
    const detail = resources.length ? ` Required resources: ${resources.join(", ")}.` : "";
    const stop =
      project.handoff.kind === "evidence-exhausted"
        ? " Do not continue substitute searching; the plan-bound agent routes are frozen in the handoff."
        : "";
    return `User action required: ${project.handoff.summary ?? "review the requested action"}${detail}${stop} Resolve only after completion: tiangong-ai research project handoff resolve ${project.id} --note <resolution-note> --workspace ${root}`;
  }
  if (project.handoff.state === "external-response-required") {
    return `Waiting for an external response: ${project.handoff.summary ?? "external evidence is pending"} Do not continue substitute searching; resolve after the response is registered.`;
  }
  if (nativeStage.status === "stale" || nativeStage.status === "invalid") {
    return nativeStage.recommendedAction ?? "Recover the stale native session explicitly.";
  }
  if (nativeStage.status === "active") {
    return nativeStage.recommendedAction ?? "Resume the active native stage.";
  }
  if (readyPackage === "analyze") {
    if (evidencePipeline.content.status === "absent") {
      return `Decompose every acquired full-text/data artifact, register exact evidence atoms, then freeze typed content: tiangong-ai research project evidence content freeze ${project.id} --workspace ${root}`;
    }
    if (evidencePipeline.content.status === "invalid") {
      return `Typed evidence content is invalid (${evidencePipeline.content.code ?? "unknown"}); repair exact decomposition/atom bindings before analysis.`;
    }
    if (evidencePipeline.content.gate?.decision === "stop") {
      return "Typed evidence coverage is insufficient; complete lawful gap filling or request a scope/access handoff instead of starting inference.";
    }
    if (evidencePipeline.acquisition.gate?.decision === "stop") {
      return "Frozen acquisition gaps block inference; request a scope/access handoff after all acquired content is decomposed instead of continuing substitute search.";
    }
    if (evidencePipeline.inference.status === "invalid") {
      return `Inference snapshot is invalid (${evidencePipeline.inference.code ?? "unknown"}); repair its frozen upstream bindings before analysis.`;
    }
  }
  const scientificAction = scientificGateRecommendedAction(root, project);
  if (scientificAction) return scientificAction;
  if (project.status === "complete") {
    if (project.publicationPolicy) {
      if (publication && "code" in publication) {
        return `Publication state is invalid (${publication.code}); inspect Research Policy and frozen object bindings before continuing.`;
      }
      if (!publication || publication.generationStatus === "not-started") {
        return `Freeze the final manuscript and publication assessment, then inspect publication status: tiangong-ai research publication freeze ${project.id} --help`;
      }
      if (publication.closureSha256) {
        return `Publication closure is complete at ${publication.readinessVerdict}; inspect the immutable closure before post-closure authoring.`;
      }
      if (publication.reviewState !== "complete") {
        return `Complete fresh independent publication reviews for ${publication.missingReviewRoles.join(", ")}; inspect: tiangong-ai research publication status ${project.id} --workspace ${root}`;
      }
      return `Mechanically close the reviewed frozen manuscript: tiangong-ai research publication close ${project.id} --workspace ${root}`;
    }
    return `Create an immutable evidence addendum only when new evidence exists: tiangong-ai research project addendum ${project.id} --to <new-project-id> --workspace ${root}`;
  }
  if (project.status === "blocked") {
    const failed = project.packages.find((workPackage) => workPackage.status === "failed");
    return failed
      ? `Review ${failed.lastFailureKind ?? "deterministic"} failure for ${failed.id}, then run the explicit project retry command if corrected.`
      : "Inspect the blocking package and use explicit retry or fork recovery.";
  }
  if (readyPackage && ["discover", "acquire", "analyze", "synthesize"].includes(readyPackage)) {
    return `Prepare native ${readyPackage}: tiangong-ai research project stage prepare ${project.id} --stage ${readyPackage} --host-agent <codex|claude|workbuddy|codebuddy> --workspace ${root}`;
  }
  return readyPackage === "review"
    ? `Run the independent reviewer package: tiangong-ai research run --project ${project.id} --workspace ${root}`
    : "Continue the next ready package.";
}

async function runWorkspaceExecution(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      "max-parallel": "string",
      "max-cycles": "string",
      project: "string",
      "dry-run": "boolean",
      "progress-jsonl": "boolean",
    },
    "research run",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research run");
  const root = await workspaceFromArgs(args);
  const progressJsonl = strictBoolean(args, "progress-jsonl");
  const projectId = strictString(args, "project");
  const result = await runResearchWorkspace(root, {
    maxParallel: integerOption(strictString(args, "max-parallel"), 1, "--max-parallel"),
    maxCycles: integerOption(strictString(args, "max-cycles"), 20, "--max-cycles"),
    dryRun: strictBoolean(args, "dry-run"),
    environment: io.env,
    ...(projectId ? { projectId } : {}),
    ...(progressJsonl
      ? { onProgress: (event: unknown) => write(io.stderr, `${JSON.stringify(event)}\n`) }
      : {}),
  });
  writeJson(io, result, args);
  return result.status === "blocked" ? 3 : 0;
}

async function readEvidenceRequirements(path: string): Promise<ProjectEvidenceRequirements> {
  if (!isAbsolute(path)) {
    throw new CliError("--requirements must be an absolute JSON file path.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new CliError("Evidence requirements file is missing or invalid JSON.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
      details: { error: String(error) },
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as ProjectEvidenceRequirements).dimensions) ||
    !Array.isArray((value as ProjectEvidenceRequirements).sourceTypes) ||
    ((value as ProjectEvidenceRequirements).requiredCapabilityIds !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredCapabilityIds)) ||
    ((value as ProjectEvidenceRequirements).requiredCompanionIds !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredCompanionIds)) ||
    ((value as ProjectEvidenceRequirements).requiredDiscoveryScopes !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredDiscoveryScopes)) ||
    typeof (value as ProjectEvidenceRequirements).minSources !== "number" ||
    typeof (value as ProjectEvidenceRequirements).minFullTextSources !== "number" ||
    typeof (value as ProjectEvidenceRequirements).minDatedSources !== "number" ||
    !(
      (value as ProjectEvidenceRequirements).publicationDateFrom === null ||
      typeof (value as ProjectEvidenceRequirements).publicationDateFrom === "string"
    ) ||
    !(
      (value as ProjectEvidenceRequirements).publicationDateTo === null ||
      typeof (value as ProjectEvidenceRequirements).publicationDateTo === "string"
    )
  ) {
    throw new CliError("Evidence requirements file has an unsupported shape.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  return normalizeEvidenceRequirements({
    ...(value as ProjectEvidenceRequirements),
    requiredCapabilityIds: (value as ProjectEvidenceRequirements).requiredCapabilityIds ?? [],
    requiredCompanionIds: (value as ProjectEvidenceRequirements).requiredCompanionIds ?? [],
    requiredDiscoveryScopes: (value as ProjectEvidenceRequirements).requiredDiscoveryScopes ?? [],
  });
}

function researchMode(value: string | undefined): ResearchMode {
  if (!value || value === "smoke-test") return "smoke-test";
  if (value === "production-research") return value;
  throw new CliError(`Unsupported research mode: ${value}`, {
    code: "RESEARCH_MODE_INVALID",
    exitCode: 2,
  });
}

function researchGoal(value: string | undefined): "evidence-report" | "top-journal" {
  if (!value || value === "evidence-report") return "evidence-report";
  if (value === "top-journal") return value;
  throw new CliError(`Unsupported research goal: ${value}`, {
    code: "RESEARCH_GOAL_INVALID",
    exitCode: 2,
  });
}

function resumeStage(
  value: string | undefined,
): "discover" | "acquire" | "analyze" | "synthesize" | undefined {
  if (!value) return undefined;
  if (value === "discover" || value === "acquire" || value === "analyze" || value === "synthesize")
    return value;
  throw new CliError(`Unsupported --resume-through stage: ${value}`, {
    code: "RESEARCH_PROJECT_FORK_INVALID",
    exitCode: 2,
  });
}

function nativeProducerStage(
  value: string | undefined,
): "discover" | "acquire" | "analyze" | "synthesize" {
  if (value === "discover" || value === "acquire" || value === "analyze" || value === "synthesize")
    return value;
  throw new CliError("--stage must be discover, acquire, analyze, or synthesize.", {
    code: "RESEARCH_NATIVE_STAGE_INVALID",
    exitCode: 2,
  });
}

function nativeHostAgent(value: string | undefined): AgentKind {
  if (value === "codex" || value === "claude" || value === "workbuddy" || value === "codebuddy") {
    return value;
  }
  throw new CliError("--host-agent must be codex, claude, workbuddy, or codebuddy.", {
    code: "RESEARCH_NATIVE_HOST_INVALID",
    exitCode: 2,
  });
}

async function readNativeEvidenceRequest(path: string): Promise<Record<string, unknown>> {
  return readBoundedJsonRecord(path, "--request", "RESEARCH_BROKER_REQUEST_INVALID");
}

async function readBoundedJsonRecord(
  path: string,
  label: string,
  code: string,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!isAbsolute(path)) {
    throw new CliError(`${label} must be an absolute JSON file path.`, {
      code,
      exitCode: 2,
    });
  }
  const selected = resolve(path);
  const info = await lstat(selected).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new CliError(`${label} must be a bounded regular non-symlink JSON file.`, {
      code,
      exitCode: 2,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selected, "utf8")) as unknown;
  } catch {
    throw new CliError(`${label} contains invalid JSON.`, {
      code,
      exitCode: 2,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`${label} must contain one JSON object.`, {
      code,
      exitCode: 2,
    });
  }
  return value as Record<string, unknown>;
}

async function workspaceFromArgs(args: ReturnType<typeof parseStrictArgs>): Promise<string> {
  return requireResearchWorkspace(strictString(args, "workspace") ?? process.cwd());
}

function writeJson(io: CliIO, value: unknown, args: ReturnType<typeof parseStrictArgs>): void {
  write(io.stdout, stringifyJson(value, strictBoolean(args, "json")));
}

function writeHelp(io: CliIO): number {
  write(io.stdout, researchOrchestrationHelp());
  return 0;
}

function onePositional(positionals: string[], command: string): string {
  if (positionals.length !== 1) {
    throw new CliError(`${command} requires exactly one positional argument.`, {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals },
    });
  }
  return positionals[0]!;
}

function rejectPositionals(positionals: string[], command: string): void {
  if (positionals.length) {
    throw new CliError(`${command} does not accept positional arguments.`, {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals },
    });
  }
}

function inputRole(value: string | undefined): ProjectInput["role"] {
  if (!value || value === "primary") return "primary";
  if (value === "reference" || value === "replication") return value;
  throw new CliError(`Unsupported research input role: ${value}`, {
    code: "RESEARCH_INPUT_ROLE_INVALID",
    exitCode: 2,
  });
}

function projectInputTrustStatus(
  value: string | undefined,
  role: ProjectInput["role"],
): ProjectInputTrustStatus | undefined {
  if (!value) return undefined;
  if (
    value === "verified-owner-input" ||
    value === "unverified-owner-input" ||
    value === "reference-only" ||
    value === "replication-candidate"
  ) {
    return value;
  }
  throw new CliError(`Unsupported trust status for ${role} input: ${value}`, {
    code: "RESEARCH_INPUT_TRUST_INVALID",
    exitCode: 2,
  });
}

function publicationReviewRole(value: string | undefined): PublicationReviewRole {
  if (
    value === "evidence" ||
    value === "methods-reproducibility" ||
    value === "domain-novelty" ||
    value === "journal-editor"
  ) {
    return value;
  }
  throw new CliError(
    "--role must be evidence, methods-reproducibility, domain-novelty, or journal-editor.",
    { code: "RESEARCH_PUBLICATION_REVIEW_ROLE_INVALID", exitCode: 2 },
  );
}

function scientificReviewRole(value: string | undefined): ScientificReviewRole {
  if (value === "research-design" || value === "evidence-construct" || value === "pilot-methods") {
    return value;
  }
  throw new CliError("--role must be research-design, evidence-construct, or pilot-methods.", {
    code: "RESEARCH_SCIENTIFIC_REVIEW_ROLE_INVALID",
    exitCode: 2,
  });
}

function publicationAgent(value: string | undefined, label: string): AgentKind {
  const producer = label.includes("producer");
  if (
    value === "codex" ||
    value === "claude" ||
    (producer && (value === "workbuddy" || value === "codebuddy"))
  ) {
    return value;
  }
  throw new CliError(
    `--${label}-agent must be ${producer ? "codex, claude, workbuddy, or codebuddy" : "codex or claude"}.`,
    {
      code: "RESEARCH_PUBLICATION_AGENT_INVALID",
      exitCode: 2,
    },
  );
}

async function readAbsolutePathArray(path: string, option = "supplements"): Promise<string[]> {
  const code =
    option === "supplements"
      ? "RESEARCH_PUBLICATION_FILE_INVALID"
      : "RESEARCH_SCIENTIFIC_CANARY_ARTIFACT_INVALID";
  if (!isAbsolute(path)) {
    throw new CliError(`--${option} must be an absolute JSON file path.`, {
      code,
      exitCode: 2,
    });
  }
  const selected = resolve(path);
  const info = await lstat(selected).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new CliError(`--${option} must be a bounded regular non-symlink JSON file.`, {
      code,
      exitCode: 2,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selected, "utf8")) as unknown;
  } catch {
    throw new CliError(`--${option} contains invalid JSON.`, {
      code,
      exitCode: 2,
    });
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !isAbsolute(item) || resolve(item) !== item)
  ) {
    throw new CliError(`--${option} must contain an array of absolute canonical paths.`, {
      code,
      exitCode: 2,
    });
  }
  return value;
}

async function readSubmissionFiles(
  path: string,
): Promise<Array<{ role: PublicationSubmissionRole; path: string }>> {
  const value = await readBoundedJsonRecord(
    path,
    "--submission",
    "RESEARCH_PUBLICATION_SUBMISSION_PACKAGE_INVALID",
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    value.files.some(
      (file) =>
        !isObject(file) ||
        typeof file.role !== "string" ||
        typeof file.path !== "string" ||
        !isAbsolute(file.path) ||
        resolve(file.path) !== file.path,
    )
  ) {
    throw new CliError(
      "--submission must declare schemaVersion 1 and role/path entries with absolute canonical paths.",
      { code: "RESEARCH_PUBLICATION_SUBMISSION_PACKAGE_INVALID", exitCode: 2 },
    );
  }
  return value.files as Array<{ role: PublicationSubmissionRole; path: string }>;
}

function integerOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError(`${label} must be an integer.`, {
      code: "RESEARCH_RUN_OPTION_INVALID",
      exitCode: 2,
    });
  }
  return parsed;
}

function unknownAction(command: string, action: string): CliError {
  return new CliError(`Unknown ${command} action: ${action}`, {
    code: "INVALID_ARGS",
    exitCode: 2,
  });
}

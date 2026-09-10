import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { cp, chmod, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import {
  isIsolatedReviewToolPolicy,
  openArtifactViews,
  reviewNetworkPolicy,
  type ArtifactViewBinding,
} from "./artifact-views.js";
import { packageVersion, RESEARCH_PACKAGE_NAME } from "./constants.js";
import {
  researchPlatformCapabilities,
  type NativeIsolationProvider,
} from "./platform-capabilities.js";
import {
  executeAgent,
  fingerprintAgentRoute,
  inspectAgentProviderRouting,
  isAgentProviderRouting,
  sameRuntimeFingerprint,
  probeNativeCapsuleIsolation,
  type AgentExecutionRequest,
} from "./executor.js";
import {
  configuredResearchSecrets,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  hashRegularTree,
  isObject,
  sha256Bytes,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type {
  AgentRoute,
  AgentProviderRouting,
  AgentRuntimeFingerprint,
  ExecutionResult,
  ReviewExecutionAttestation,
  ReviewExecutionConfig,
  WorkspaceConfig,
} from "./types.js";
import {
  loadWorkspaceConfig,
  loadWorkspaceMarker,
  requireCurrentRuntimeLock,
  verifyDoctorAttestation,
} from "./workspace.js";

const REVIEW_BRIDGE_PROTOCOL_VERSION = 1 as const;
const REVIEW_BRIDGE_MAX_BODY_BYTES = 8 * 1024 * 1024;
const REVIEW_BRIDGE_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type NativeExecutor = (request: AgentExecutionRequest) => Promise<ExecutionResult>;
type RouteFingerprinter = (
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
) => Promise<AgentRuntimeFingerprint>;

export interface ReviewExecutor {
  readonly transport: ReviewExecutionConfig["transport"];
  execute(request: AgentExecutionRequest): Promise<ExecutionResult>;
  fingerprint(route: AgentRoute, environment: NodeJS.ProcessEnv): Promise<AgentRuntimeFingerprint>;
}

export interface ReviewerBridgePaths {
  socket: string;
  connection: string;
}

export interface ReviewerBridgeSidecar {
  readonly workspaceId: string;
  readonly keyFingerprint: string;
  close(): Promise<void>;
}

interface ReviewerBridgeConnection {
  schemaVersion: 1;
  protocolVersion: 1;
  workspaceId: string;
  packageName: typeof RESEARCH_PACKAGE_NAME;
  packageVersion: string;
  socketPath: string;
  publicKey: string;
  keyFingerprint: string;
  clientToken: string;
  createdAt: string;
}

interface ReviewBridgeRequestCore {
  schemaVersion: 1;
  protocolVersion: 1;
  action: "execute" | "fingerprint" | "status";
  requestId: string;
  nonce: string;
  issuedAt: string;
  workspaceId: string;
  packageName: typeof RESEARCH_PACKAGE_NAME;
  packageVersion: string;
  runtimeLockSha256: string;
  configSha256: string;
}

interface ReviewBridgeExecutePayload {
  reviewer: {
    agent: AgentRoute["agent"];
    model: string | null;
    effort: AgentRoute["effort"] | null;
    verbosity: AgentRoute["verbosity"] | null;
  };
  prompt: string;
  outputSchema: AgentExecutionRequest["outputSchema"];
  purpose: AgentExecutionRequest["purpose"];
  capsuleRoot: string;
  projectRoot: string;
  capsuleSha256: string;
  timeoutSeconds: number;
  maxTurns: number;
  maxOutputTokens: number;
  maxToolContextTokens: number;
  maxCostUsd: number;
  expectedRuntime: AgentRuntimeFingerprint | null;
  toolPolicy: "none" | "packet-read";
  artifactViews?: ArtifactViewBinding;
  brokerUrl: null;
}

interface ReviewBridgeExecuteRequest extends ReviewBridgeRequestCore {
  action: "execute";
  payload: ReviewBridgeExecutePayload;
  requestSha256: string;
}

interface ReviewBridgeSimpleRequest extends ReviewBridgeRequestCore {
  action: "fingerprint" | "status";
  requestSha256: string;
}

type ReviewBridgeRequest = ReviewBridgeExecuteRequest | ReviewBridgeSimpleRequest;

interface BridgeSuccessResponse {
  schemaVersion: 1;
  protocolVersion: 1;
  ok: true;
  requestId: string;
  nonce: string;
  requestSha256: string;
  result: ExecutionResult | AgentRuntimeFingerprint | ReviewerBridgeStatus;
  attestation: ReviewExecutionAttestation;
}

interface BridgeFailureResponse {
  schemaVersion: 1;
  protocolVersion: 1;
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export interface ReviewerBridgeStatus {
  status: "ready";
  workspaceId: string;
  packageVersion: string;
  keyFingerprint: string;
  supportedActions: ["execute", "fingerprint", "status"];
  negativeProbes: ReviewerBridgeNegativeProbes;
  configuredReviewer?: {
    cliFamily: AgentRoute["agent"];
    configuredModelAlias: string | null;
    providerRouting: AgentProviderRouting;
  };
}

export interface ReviewerBridgeNegativeProbes {
  outsideReadBlocked: true;
  outsideWriteBlocked: true;
  workspaceCredentialReadBlocked: true;
  arbitraryCommandSurfaceAbsent: true;
  reviewerToolsDisabled: true;
}

export function reviewerBridgePaths(root: string): ReviewerBridgePaths {
  const runtime = workspacePaths(root).runtime;
  return {
    // Darwin limits Unix-domain socket paths to roughly one hundred bytes.
    // Workspaces are user-selected and may be arbitrarily deep, so bind the
    // owner-only socket to a stable short path while keeping the secret client
    // connection record inside the selected workspace runtime.
    socket: join("/tmp", `tiangong-review-${sha256Text(resolve(root)).slice(0, 32)}.sock`),
    connection: join(runtime, "reviewer-bridge.connection.json"),
  };
}

export function createReviewExecutor(input: {
  root: string;
  execution: ReviewExecutionConfig;
  executeNative?: NativeExecutor;
  fingerprintNative?: RouteFingerprinter;
  nonceFactory?: () => string;
}): ReviewExecutor {
  const executeNative = input.executeNative ?? executeAgent;
  const fingerprintNative = input.fingerprintNative ?? fingerprintAgentRoute;
  if (input.execution.transport === "native-direct") {
    return {
      transport: "native-direct",
      execute: executeNative,
      fingerprint: fingerprintNative,
    };
  }
  return {
    transport: "sandbox-bridge",
    execute: (request) =>
      executeThroughBridge(input.root, request, input.nonceFactory ?? secureNonce),
    fingerprint: (route) =>
      fingerprintThroughBridge(input.root, route, input.nonceFactory ?? secureNonce),
  };
}

export async function inspectReviewerBridgeStatus(root: string): Promise<ReviewerBridgeStatus> {
  const binding = await bridgeBinding(root, "status", "reviewer-bridge-status", secureNonce);
  const core = { ...binding.core, action: "status" as const };
  const bridgeRequest: ReviewBridgeSimpleRequest = {
    ...core,
    requestSha256: sha256Text(canonicalJson(core)),
  };
  const response = await sendBridgeRequest(binding.connection, bridgeRequest);
  const result = verifyBridgeResponse(binding.connection, bridgeRequest, response);
  if (
    !isObject(result) ||
    result.status !== "ready" ||
    result.workspaceId !== binding.connection.workspaceId ||
    result.packageVersion !== packageVersion() ||
    result.keyFingerprint !== binding.connection.keyFingerprint ||
    !isReviewerBridgeNegativeProbes(result.negativeProbes)
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge status response does not match its workspace and version binding.",
    );
  }
  return result as unknown as ReviewerBridgeStatus;
}

/** Read-only operator status: never starts a paid smoke or copies authentication. */
export async function inspectReviewerStatus(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = await loadWorkspaceConfig(root);
  if (config.reviewerExecution.transport === "sandbox-bridge") {
    const status = await inspectReviewerBridgeStatus(root);
    return {
      ...status,
      transport: "sandbox-bridge" as const,
      readinessScope: "bridge-transport",
      providerIdentity: "unverified",
      minimumAction:
        "Bridge readiness proves the local transport only. Review the configured routing before sending material; runtime fingerprints do not attest upstream provider identity.",
    };
  }
  const marker = await loadWorkspaceMarker(root);
  await requireCurrentRuntimeLock(root, marker);
  const platform = researchPlatformCapabilities();
  const production = config.mode === "production-research";
  const doctor = production
    ? await verifyDoctorAttestation(root)
    : {
        status: "not-required" as const,
        attestation: null,
        errors: [] as string[],
      };
  const errors: Array<{ code: string; message: string }> = [];
  let runtime: AgentRuntimeFingerprint | null = null;
  try {
    runtime = await fingerprintAgentRoute(config.reviewer, environment);
  } catch (error) {
    errors.push({
      code: error instanceof CliError ? error.code : "RESEARCH_EXECUTOR_UNAVAILABLE",
      message:
        "The configured native reviewer executable could not be fingerprinted; install or configure that exact reviewer route and rerun workspace doctor.",
    });
  }
  if (!platform.nativeIsolationProvider) {
    errors.push({
      code: "RESEARCH_SANDBOX_UNAVAILABLE",
      message: "This platform has no supported native reviewer capsule provider.",
    });
  }
  const expected = doctor.attestation?.runtimes[0];
  const runtimeMatches = Boolean(runtime && expected && sameRuntimeFingerprint(runtime, expected));
  if (doctor.status === "verified" && !runtimeMatches) {
    errors.push({
      code: "RESEARCH_EXECUTOR_DRIFT",
      message:
        "The reviewer runtime differs from its doctor attestation; rerun the explicit reviewer smoke.",
    });
  }
  return sanitizeResearchValue(
    {
      status: errors.length
        ? "blocked"
        : !production || doctor.status === "verified"
          ? "ready"
          : "incomplete",
      readinessScope: production ? "production-attestation" : "smoke-configuration",
      productionReady: production && errors.length === 0 && doctor.status === "verified",
      transport: "native-direct" as const,
      workspaceId: marker.workspaceId,
      packageVersion: packageVersion(),
      platformCapsule: { provider: platform.nativeIsolationProvider },
      runtime,
      providerIdentity: "unverified",
      doctorAttestation: {
        status: doctor.status,
        expiresAt: doctor.attestation?.expiresAt ?? null,
        errors: doctor.errors,
      },
      errors,
      minimumAction: errors.length
        ? "Check the configured native reviewer executable and supported platform capsule. Status does not run a paid smoke."
        : production && doctor.status !== "verified"
          ? "Explicitly run research workspace doctor --agent-smoke --capability-smoke to refresh the production attestation. Status does not run paid checks."
          : null,
    },
    configuredResearchSecrets(environment),
  );
}

export async function startReviewerBridgeSidecar(input: {
  root: string;
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  executeNative?: NativeExecutor;
  fingerprintNative?: RouteFingerprinter;
}): Promise<ReviewerBridgeSidecar> {
  const capabilities = researchPlatformCapabilities();
  if (!capabilities.reviewerSidecarExecution) {
    throw new CliError(
      `Reviewer sidecar execution is unsupported on ${capabilities.platform}; this platform is configuration/smoke-only.`,
      {
        code: "RESEARCH_SANDBOX_UNAVAILABLE",
        exitCode: 3,
        details: {
          platform: capabilities.platform,
          setupMode: capabilities.setupMode,
          productionResearch: capabilities.productionResearch,
        },
      },
    );
  }
  const root = resolve(input.root);
  const stateDirectory = await requireExternalStateDirectory(root, input.stateDirectory);
  const marker = await loadWorkspaceMarker(root);
  const runtimeLock = await requireCurrentRuntimeLock(root, marker);
  const config = await loadWorkspaceConfig(root);
  requireBridgeSelection(config);
  const paths = reviewerBridgePaths(root);
  await ensureDirectory(workspacePaths(root).runtime);
  const key = await loadOrCreateSigningKey(stateDirectory);
  const filesystemProbe = await probeNativeCapsuleIsolation({
    workspaceRoot: root,
    stateDirectory,
  });
  const negativeProbes: ReviewerBridgeNegativeProbes = {
    ...filesystemProbe,
    arbitraryCommandSurfaceAbsent: true,
    reviewerToolsDisabled: true,
  };
  const clientToken = randomBytes(32).toString("hex");
  const connection: ReviewerBridgeConnection = {
    schemaVersion: 1,
    protocolVersion: REVIEW_BRIDGE_PROTOCOL_VERSION,
    workspaceId: marker.workspaceId,
    packageName: RESEARCH_PACKAGE_NAME,
    packageVersion: packageVersion(),
    socketPath: paths.socket,
    publicKey: key.publicKeyPem,
    keyFingerprint: key.fingerprint,
    clientToken,
    createdAt: new Date().toISOString(),
  };
  await removeStaleSocket(paths.socket);
  await writeJsonAtomic(paths.connection, connection, 0o600);
  const nonceDirectory = join(stateDirectory, "nonces");
  await ensureDirectory(nonceDirectory);
  const executeNative = input.executeNative ?? executeAgent;
  const fingerprintNative = input.fingerprintNative ?? fingerprintAgentRoute;
  const server = createServer((request, response) => {
    void handleSidecarRequest({
      request,
      response,
      root,
      stateDirectory,
      expectedClientToken: clientToken,
      connection,
      privateKeyPem: key.privateKeyPem,
      nonceDirectory,
      environment: input.environment,
      executeNative,
      fingerprintNative,
      negativeProbes,
    });
  });
  await listenOnSocket(server, paths.socket);
  await chmod(paths.socket, 0o600);
  let closed = false;
  return {
    workspaceId: marker.workspaceId,
    keyFingerprint: key.fingerprint,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await Promise.all([
        rm(paths.socket, { force: true }).catch(() => undefined),
        rm(paths.connection, { force: true }).catch(() => undefined),
      ]);
    },
  };
}

async function executeThroughBridge(
  root: string,
  request: AgentExecutionRequest,
  nonceFactory: () => string,
): Promise<ExecutionResult> {
  if (!isIsolatedReviewToolPolicy(request)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID",
      "sandbox-bridge accepts only tool-free or exact packet-read review, without a broker or external MCP route.",
    );
  }
  const binding = await bridgeBinding(root, "execute", request.requestId, nonceFactory);
  const capsuleSha256 = await hashRegularTree(request.projectRoot);
  const payload: ReviewBridgeExecutePayload = {
    reviewer: {
      agent: request.route.agent,
      model: request.route.model,
      effort: request.route.effort ?? null,
      verbosity: request.route.verbosity ?? null,
    },
    prompt: request.prompt,
    outputSchema: request.outputSchema,
    purpose: request.purpose,
    capsuleRoot: request.capsuleRoot,
    projectRoot: request.projectRoot,
    capsuleSha256,
    timeoutSeconds: request.timeoutSeconds,
    maxTurns: request.maxTurns,
    maxOutputTokens: request.maxOutputTokens,
    maxToolContextTokens: request.maxToolContextTokens ?? 0,
    maxCostUsd: request.maxCostUsd,
    expectedRuntime: request.expectedRuntime ?? null,
    toolPolicy: request.toolPolicy as "none" | "packet-read",
    ...(request.artifactViews ? { artifactViews: request.artifactViews } : {}),
    brokerUrl: null,
  };
  const core = { ...binding.core, action: "execute" as const, payload };
  const bridgeRequest: ReviewBridgeExecuteRequest = {
    ...core,
    requestSha256: sha256Text(canonicalJson(core)),
  };
  const response = await sendBridgeRequest(binding.connection, bridgeRequest);
  const result = verifyBridgeResponse(binding.connection, bridgeRequest, response);
  if (!isExecutionResult(result)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer sidecar returned an invalid execution result.",
    );
  }
  return { ...result, reviewAttestation: response.attestation };
}

async function fingerprintThroughBridge(
  root: string,
  route: AgentRoute,
  nonceFactory: () => string,
): Promise<AgentRuntimeFingerprint> {
  const binding = await bridgeBinding(
    root,
    "fingerprint",
    `fingerprint-${route.agent}`,
    nonceFactory,
  );
  const core = { ...binding.core, action: "fingerprint" as const };
  const bridgeRequest: ReviewBridgeSimpleRequest = {
    ...core,
    requestSha256: sha256Text(canonicalJson(core)),
  };
  const response = await sendBridgeRequest(binding.connection, bridgeRequest);
  const result = verifyBridgeResponse(binding.connection, bridgeRequest, response);
  if (
    !isAgentRuntimeFingerprint(result) ||
    result.agent !== route.agent ||
    result.model !== route.model
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_MODEL_MISMATCH",
      "The reviewer sidecar runtime does not match the configured reviewer model.",
    );
  }
  return result;
}

async function bridgeBinding(
  root: string,
  action: ReviewBridgeRequestCore["action"],
  requestId: string,
  nonceFactory: () => string,
): Promise<{ connection: ReviewerBridgeConnection; core: ReviewBridgeRequestCore }> {
  const connection = await loadBridgeConnection(root);
  const marker = await loadWorkspaceMarker(root);
  const runtimeLock = await requireCurrentRuntimeLock(root, marker);
  const config = await loadWorkspaceConfig(root);
  requireBridgeSelection(config);
  if (
    connection.protocolVersion !== REVIEW_BRIDGE_PROTOCOL_VERSION ||
    connection.packageVersion !== packageVersion() ||
    connection.packageName !== RESEARCH_PACKAGE_NAME ||
    runtimeLock.packageVersion !== connection.packageVersion
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_VERSION_MISMATCH",
      "The reviewer bridge, workspace runtime lock, and active CLI must use the same exact version.",
    );
  }
  if (connection.workspaceId !== marker.workspaceId) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge is bound to a different workspace.",
    );
  }
  const nonce = nonceFactory();
  if (!HASH_PATTERN.test(nonce)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge nonce source returned an invalid value.",
    );
  }
  return {
    connection,
    core: {
      schemaVersion: 1,
      protocolVersion: REVIEW_BRIDGE_PROTOCOL_VERSION,
      action,
      requestId,
      nonce,
      issuedAt: new Date().toISOString(),
      workspaceId: marker.workspaceId,
      packageName: RESEARCH_PACKAGE_NAME,
      packageVersion: packageVersion(),
      runtimeLockSha256: await sha256File(workspacePaths(root).runtimeLock),
      configSha256: await sha256File(workspacePaths(root).config),
    },
  };
}

async function handleSidecarRequest(input: {
  request: import("node:http").IncomingMessage;
  response: import("node:http").ServerResponse;
  root: string;
  stateDirectory: string;
  expectedClientToken: string;
  connection: ReviewerBridgeConnection;
  privateKeyPem: string;
  nonceDirectory: string;
  environment: NodeJS.ProcessEnv;
  executeNative: NativeExecutor;
  fingerprintNative: RouteFingerprinter;
  negativeProbes: ReviewerBridgeNegativeProbes;
}): Promise<void> {
  try {
    if (input.request.method !== "POST" || input.request.url !== "/v1/review") {
      writeBridgeFailure(
        input.response,
        404,
        bridgeError(
          "RESEARCH_REVIEW_BRIDGE_ACTION_INVALID",
          "The reviewer sidecar exposes only the fixed review protocol.",
        ),
      );
      return;
    }
    if (!authorized(input.request.headers.authorization, input.expectedClientToken)) {
      writeBridgeFailure(
        input.response,
        401,
        bridgeError(
          "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE",
          "The reviewer bridge client binding is unavailable or invalid.",
        ),
      );
      return;
    }
    const value = JSON.parse(await readBoundedBody(input.request));
    const request = parseBridgeRequest(value);
    await validateServerBinding(input.root, input.connection, request);
    await consumeNonce(input.nonceDirectory, request.nonce, request.issuedAt);
    const config = await loadWorkspaceConfig(input.root);
    let result: ExecutionResult | AgentRuntimeFingerprint | ReviewerBridgeStatus;
    let capsuleSha256 = sha256Text("not-applicable");
    let isolationProvider: ReviewExecutionAttestation["isolationProvider"];
    let policySha256: string;
    if (request.action === "execute") {
      const executed = await executeSidecarReview({
        root: input.root,
        stateDirectory: input.stateDirectory,
        request,
        config,
        environment: input.environment,
        executeNative: input.executeNative,
      });
      result = executed.result;
      capsuleSha256 = request.payload.capsuleSha256;
      isolationProvider = executed.result.isolation!.provider;
      policySha256 = executed.result.isolation!.policySha256;
    } else if (request.action === "fingerprint") {
      result = await input.fingerprintNative(config.reviewer, input.environment);
      isolationProvider = requiredNativeIsolationProvider();
      policySha256 = sha256Text("fingerprint-only");
    } else {
      result = {
        status: "ready",
        workspaceId: input.connection.workspaceId,
        packageVersion: input.connection.packageVersion,
        keyFingerprint: input.connection.keyFingerprint,
        supportedActions: ["execute", "fingerprint", "status"],
        negativeProbes: input.negativeProbes,
        configuredReviewer: {
          cliFamily: config.reviewer.agent,
          configuredModelAlias: config.reviewer.model,
          providerRouting: await inspectAgentProviderRouting(config.reviewer, input.environment),
        },
      };
      isolationProvider = requiredNativeIsolationProvider();
      policySha256 = sha256Text("status-only");
    }
    const safeResult = sanitizeBridgeResult(result, input.environment);
    const attestation = signBridgeAttestation({
      request,
      result: safeResult,
      capsuleSha256,
      isolationProvider,
      policySha256,
      keyFingerprint: input.connection.keyFingerprint,
      privateKeyPem: input.privateKeyPem,
    });
    const response: BridgeSuccessResponse = {
      schemaVersion: 1,
      protocolVersion: REVIEW_BRIDGE_PROTOCOL_VERSION,
      ok: true,
      requestId: request.requestId,
      nonce: request.nonce,
      requestSha256: request.requestSha256,
      result: safeResult,
      attestation,
    };
    input.response.writeHead(200, { "content-type": "application/json" });
    input.response.end(`${JSON.stringify(response)}\n`);
  } catch (error) {
    writeBridgeFailure(
      input.response,
      400,
      normalizeBridgeError(error, configuredResearchSecrets(input.environment)),
    );
  }
}

function requiredNativeIsolationProvider(): NativeIsolationProvider {
  const capabilities = researchPlatformCapabilities();
  if (capabilities.nativeIsolationProvider) return capabilities.nativeIsolationProvider;
  throw new CliError(
    `Native reviewer execution is unsupported on ${capabilities.platform}; this platform is configuration/smoke-only.`,
    {
      code: "RESEARCH_SANDBOX_UNAVAILABLE",
      exitCode: 3,
      details: {
        platform: capabilities.platform,
        setupMode: capabilities.setupMode,
        productionResearch: capabilities.productionResearch,
      },
    },
  );
}

async function executeSidecarReview(input: {
  root: string;
  stateDirectory: string;
  request: ReviewBridgeExecuteRequest;
  config: WorkspaceConfig;
  environment: NodeJS.ProcessEnv;
  executeNative: NativeExecutor;
}): Promise<{ result: ExecutionResult }> {
  const payload = input.request.payload;
  if (!isIsolatedReviewToolPolicy(payload)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID",
      "The reviewer sidecar accepts no unrestricted tools, browser, broker, or external MCP route.",
    );
  }
  if (
    payload.reviewer.agent !== input.config.reviewer.agent ||
    payload.reviewer.model !== input.config.reviewer.model
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_MODEL_MISMATCH",
      "The requested reviewer family or model does not match the sidecar workspace binding.",
    );
  }
  const sourceCapsule = await requireWorkspaceCapsule(
    input.root,
    payload.capsuleRoot,
    payload.projectRoot,
  );
  if ((await hashRegularTree(sourceCapsule.projectRoot)) !== payload.capsuleSha256) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer capsule changed after the bridge request was prepared.",
    );
  }
  const privateCapsule = join(
    input.stateDirectory,
    "runs",
    `${safeIdentifier(input.request.requestId)}-${input.request.nonce.slice(0, 16)}`,
  );
  const privateProject = join(privateCapsule, "project");
  await ensureDirectory(join(input.stateDirectory, "runs"));
  await mkdir(privateCapsule, { recursive: false, mode: 0o700 });
  try {
    await cp(sourceCapsule.projectRoot, privateProject, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: false,
    });
    if ((await hashRegularTree(privateProject)) !== payload.capsuleSha256) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
        "The private reviewer capsule does not match the signed source capsule.",
      );
    }
    if (payload.artifactViews)
      await openArtifactViews(
        privateProject,
        payload.artifactViews.index,
        payload.artifactViews.packetSha256,
      );
    const result = await input.executeNative({
      route: input.config.reviewer,
      prompt: payload.prompt,
      outputSchema: payload.outputSchema,
      requestId: input.request.requestId,
      purpose: payload.purpose,
      capsuleRoot: privateCapsule,
      projectRoot: privateProject,
      workspaceRoot: input.root,
      timeoutSeconds: payload.timeoutSeconds,
      maxTurns: payload.maxTurns,
      maxOutputTokens: payload.maxOutputTokens,
      maxToolContextTokens: payload.maxToolContextTokens,
      maxCostUsd: payload.maxCostUsd,
      expectedRuntime: payload.expectedRuntime ?? undefined,
      toolPolicy: payload.toolPolicy,
      ...(payload.artifactViews ? { artifactViews: payload.artifactViews } : {}),
      environment: input.environment,
      brokerUrl: null,
    });
    if (
      !result.isolation ||
      result.isolation.toolPolicy !== payload.toolPolicy ||
      result.isolation.networkPolicy !== reviewNetworkPolicy(payload.toolPolicy) ||
      !HASH_PATTERN.test(result.isolation.policySha256)
    ) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID",
        "The native reviewer did not return the required platform-capsule policy binding.",
      );
    }
    if (
      !result.runtime ||
      result.runtime.agent !== input.config.reviewer.agent ||
      result.runtime.model !== input.config.reviewer.model
    ) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_MODEL_MISMATCH",
        "The executed reviewer runtime does not match the configured reviewer model.",
      );
    }
    if (payload.toolPolicy === "none" && (result.telemetry?.toolCalls ?? 0) !== 0) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID",
        "The reviewer attempted a tool call despite the tool-free bridge policy.",
      );
    }
    return { result };
  } finally {
    await rm(privateCapsule, { recursive: true, force: true });
  }
}

function signBridgeAttestation(input: {
  request: ReviewBridgeRequest;
  result: ExecutionResult | AgentRuntimeFingerprint | ReviewerBridgeStatus;
  capsuleSha256: string;
  isolationProvider: ReviewExecutionAttestation["isolationProvider"];
  policySha256: string;
  keyFingerprint: string;
  privateKeyPem: string;
}): ReviewExecutionAttestation {
  const core = {
    schemaVersion: 1 as const,
    protocolVersion: REVIEW_BRIDGE_PROTOCOL_VERSION,
    transport: "sandbox-bridge" as const,
    isolationProvider: input.isolationProvider,
    toolPolicy:
      input.request.action === "execute" ? input.request.payload.toolPolicy : ("none" as const),
    workspaceId: input.request.workspaceId,
    requestId: input.request.requestId,
    requestSha256: input.request.requestSha256,
    resultSha256: sha256Text(canonicalJson(input.result)),
    capsuleSha256: input.capsuleSha256,
    runtimeLockSha256: input.request.runtimeLockSha256,
    configSha256: input.request.configSha256,
    policySha256: input.policySha256,
    signerKeyFingerprint: input.keyFingerprint,
  };
  const attestationSha256 = sha256Text(canonicalJson(core));
  const signed = { ...core, attestationSha256 };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(signed), "utf8"),
    createPrivateKey(input.privateKeyPem),
  ).toString("base64");
  return { ...signed, signature };
}

function verifyBridgeResponse(
  connection: ReviewerBridgeConnection,
  request: ReviewBridgeRequest,
  response: BridgeSuccessResponse,
): BridgeSuccessResponse["result"] {
  if (
    response.schemaVersion !== 1 ||
    response.protocolVersion !== REVIEW_BRIDGE_PROTOCOL_VERSION ||
    response.requestId !== request.requestId ||
    response.nonce !== request.nonce ||
    response.requestSha256 !== request.requestSha256
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge response does not match its request binding.",
    );
  }
  const attestation = response.attestation;
  const { signature, attestationSha256, ...core } = attestation;
  if (
    attestation.workspaceId !== request.workspaceId ||
    attestation.toolPolicy !==
      (request.action === "execute" ? request.payload.toolPolicy : "none") ||
    attestation.requestId !== request.requestId ||
    attestation.requestSha256 !== request.requestSha256 ||
    attestation.runtimeLockSha256 !== request.runtimeLockSha256 ||
    attestation.configSha256 !== request.configSha256 ||
    attestation.signerKeyFingerprint !== connection.keyFingerprint ||
    attestation.resultSha256 !== sha256Text(canonicalJson(response.result)) ||
    sha256Text(canonicalJson(core)) !== attestationSha256 ||
    publicKeyFingerprint(connection.publicKey) !== connection.keyFingerprint
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge attestation is invalid or does not match the exact result.",
    );
  }
  const signed = { ...core, attestationSha256 };
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(signed), "utf8"),
      createPublicKey(connection.publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge signature is invalid.",
    );
  }
  return response.result;
}

async function sendBridgeRequest(
  connection: ReviewerBridgeConnection,
  value: ReviewBridgeRequest,
): Promise<BridgeSuccessResponse> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > REVIEW_BRIDGE_MAX_BODY_BYTES) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge request exceeds the bounded protocol size.",
    );
  }
  let raw: string;
  try {
    raw = await new Promise<string>((resolvePromise, reject) => {
      const request = httpRequest(
        {
          socketPath: connection.socketPath,
          path: "/v1/review",
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.clientToken}`,
            "content-type": "application/json",
            "content-length": body.byteLength,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes <= REVIEW_BRIDGE_MAX_BODY_BYTES) chunks.push(chunk);
          });
          response.on("end", () => {
            if (bytes > REVIEW_BRIDGE_MAX_BODY_BYTES) {
              reject(new Error("response too large"));
              return;
            }
            resolvePromise(Buffer.concat(chunks).toString("utf8"));
          });
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  } catch {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE",
      "The sandbox-bridge reviewer is unavailable. Start the exact-version reviewer sidecar outside the IDE sandbox, then rerun doctor.",
      {
        retryable: false,
        minimumAction:
          "Start tiangong-ai research reviewer serve for this workspace from an owner-controlled native terminal.",
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge returned malformed protocol bytes.",
    );
  }
  if (isBridgeFailureResponse(parsed)) {
    throw new CliError(parsed.error.message, {
      code: parsed.error.code,
      exitCode: 3,
      details: sanitizeResearchValue(parsed.error.details),
    });
  }
  if (!isBridgeSuccessResponse(parsed)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge returned an unsupported protocol response.",
    );
  }
  return parsed;
}

async function loadBridgeConnection(root: string): Promise<ReviewerBridgeConnection> {
  const path = reviewerBridgePaths(root).connection;
  const info = await lstat(path).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE",
      "The sandbox-bridge reviewer is unavailable. Start the owner-controlled reviewer sidecar outside the IDE sandbox.",
      {
        retryable: false,
        minimumAction:
          "Start tiangong-ai research reviewer serve for this workspace from an owner-controlled native terminal.",
      },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE",
      "The sandbox-bridge client binding is missing or invalid.",
    );
  }
  if (!isReviewerBridgeConnection(value)) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_VERSION_MISMATCH",
      "The sandbox-bridge client binding uses an unsupported protocol or version.",
    );
  }
  return value;
}

async function validateServerBinding(
  root: string,
  connection: ReviewerBridgeConnection,
  request: ReviewBridgeRequest,
): Promise<void> {
  const marker = await loadWorkspaceMarker(root);
  const runtimeLock = await requireCurrentRuntimeLock(root, marker);
  const config = await loadWorkspaceConfig(root);
  requireBridgeSelection(config);
  const age = Math.abs(Date.now() - Date.parse(request.issuedAt));
  if (
    !Number.isFinite(age) ||
    age > REVIEW_BRIDGE_REQUEST_MAX_AGE_MS ||
    request.protocolVersion !== REVIEW_BRIDGE_PROTOCOL_VERSION ||
    request.packageName !== RESEARCH_PACKAGE_NAME ||
    request.packageVersion !== packageVersion() ||
    request.packageVersion !== connection.packageVersion ||
    runtimeLock.packageVersion !== request.packageVersion
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_VERSION_MISMATCH",
      "The reviewer bridge request version or validity window does not match the sidecar.",
    );
  }
  if (
    request.workspaceId !== marker.workspaceId ||
    request.workspaceId !== connection.workspaceId ||
    request.runtimeLockSha256 !== (await sha256File(workspacePaths(root).runtimeLock)) ||
    request.configSha256 !== (await sha256File(workspacePaths(root).config))
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge request does not match the workspace runtime and configuration binding.",
    );
  }
  const { requestSha256, ...core } = request;
  if (sha256Text(canonicalJson(core)) !== requestSha256) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge request hash is invalid.",
    );
  }
}

async function consumeNonce(directory: string, nonce: string, seenAt: string): Promise<void> {
  await ensureDirectory(directory);
  const claimPath = join(directory, nonce);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(claimPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_NONCE_REPLAY",
        "The reviewer bridge rejected a replayed request nonce.",
      );
    }
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "The reviewer bridge could not persist its replay-protection claim.",
    );
  }
  try {
    await handle.writeFile(`${seenAt}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireWorkspaceCapsule(
  root: string,
  capsuleRoot: string,
  projectRoot: string,
): Promise<{ capsuleRoot: string; projectRoot: string }> {
  const runtimeRoot = await realpath(workspacePaths(root).runtime);
  const capsule = await realpath(capsuleRoot).catch(() => "");
  const project = await realpath(projectRoot).catch(() => "");
  const capsuleInfo = capsule ? await lstat(capsule).catch(() => undefined) : undefined;
  const projectInfo = project ? await lstat(project).catch(() => undefined) : undefined;
  if (
    !capsuleInfo?.isDirectory() ||
    capsuleInfo.isSymbolicLink() ||
    !projectInfo?.isDirectory() ||
    projectInfo.isSymbolicLink() ||
    relative(runtimeRoot, capsule).startsWith("..") ||
    project !== join(capsule, "project")
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
      "The reviewer bridge capsule is outside the current workspace runtime or has an invalid shape.",
    );
  }
  return { capsuleRoot: capsule, projectRoot: project };
}

async function requireExternalStateDirectory(root: string, value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "Reviewer sidecar state must use an explicit absolute directory.",
    );
  }
  const selectedInfo = await lstat(value).catch(() => undefined);
  if (selectedInfo?.isSymbolicLink() || (selectedInfo && !selectedInfo.isDirectory())) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "Reviewer sidecar private state must be a regular non-symlink directory.",
    );
  }
  await ensureDirectory(value);
  const canonical = await realpath(value);
  const info = await lstat(canonical);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonical === root ||
    canonical.startsWith(`${root}${sep}`)
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "Reviewer sidecar private state must be a regular directory outside the research workspace.",
    );
  }
  return canonical;
}

async function loadOrCreateSigningKey(stateDirectory: string): Promise<{
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
}> {
  const privateKeyPath = join(stateDirectory, "reviewer-bridge-private-key.pem");
  let privateKeyPem: string;
  const info = await lstat(privateKeyPath).catch(() => undefined);
  if (info) {
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
        "Reviewer sidecar signing material must be an owner-only regular file.",
      );
    }
    privateKeyPem = await readFile(privateKeyPath, "utf8");
  } else {
    const generated = generateKeyPairSync("ed25519");
    privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeTextAtomic(privateKeyPath, privateKeyPem, 0o600);
  }
  let publicKeyPem: string;
  try {
    publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "Reviewer sidecar signing material is invalid.",
    );
  }
  return {
    privateKeyPem,
    publicKeyPem,
    fingerprint: publicKeyFingerprint(publicKeyPem),
  };
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return sha256Bytes(der);
}

function sanitizeBridgeResult<
  T extends ExecutionResult | AgentRuntimeFingerprint | ReviewerBridgeStatus,
>(value: T, environment: NodeJS.ProcessEnv): T {
  const secrets = configuredResearchSecrets(environment);
  if (isExecutionResult(value)) {
    return {
      ...value,
      stdout: sanitizeResearchText(value.stdout, secrets),
      stderr: sanitizeResearchText(value.stderr, secrets),
      telemetry: value.telemetry
        ? (sanitizeResearchValue(value.telemetry, secrets) as ExecutionResult["telemetry"])
        : undefined,
      reviewAttestation: undefined,
    } as T;
  }
  return sanitizeResearchValue(value, secrets) as T;
}

function requireBridgeSelection(config: WorkspaceConfig): void {
  if (
    config.reviewerExecution.transport !== "sandbox-bridge" ||
    config.reviewerExecution.isolationProvider !== "platform-capsule"
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_NOT_SELECTED",
      "This workspace did not explicitly select sandbox-bridge reviewer execution.",
    );
  }
}

function secureNonce(): string {
  return randomBytes(32).toString("hex");
}

function safeIdentifier(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return normalized || "review";
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const actual = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

async function readBoundedBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > REVIEW_BRIDGE_MAX_BODY_BYTES) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
        "The reviewer bridge request exceeds the bounded protocol size.",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBridgeRequest(value: unknown): ReviewBridgeRequest {
  if (
    !isObject(value) ||
    !isBridgeRequestCore(value) ||
    !HASH_PATTERN.test(String(value.requestSha256))
  ) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
      "The reviewer bridge request is malformed.",
    );
  }
  if (value.action === "execute") {
    if (!isExecutePayload(value.payload)) {
      throw bridgeError(
        "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID",
        "The reviewer bridge execution payload is malformed.",
      );
    }
    return value as unknown as ReviewBridgeExecuteRequest;
  }
  if (value.action === "fingerprint" || value.action === "status") {
    return value as unknown as ReviewBridgeSimpleRequest;
  }
  throw bridgeError(
    "RESEARCH_REVIEW_BRIDGE_ACTION_INVALID",
    "The reviewer sidecar exposes only execute, fingerprint, and status actions.",
  );
}

function isBridgeRequestCore(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 1 &&
    value.protocolVersion === 1 &&
    ["execute", "fingerprint", "status"].includes(String(value.action)) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.nonce === "string" &&
    HASH_PATTERN.test(value.nonce) &&
    typeof value.issuedAt === "string" &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    typeof value.workspaceId === "string" &&
    value.packageName === RESEARCH_PACKAGE_NAME &&
    typeof value.packageVersion === "string" &&
    typeof value.runtimeLockSha256 === "string" &&
    HASH_PATTERN.test(value.runtimeLockSha256) &&
    typeof value.configSha256 === "string" &&
    HASH_PATTERN.test(value.configSha256)
  );
}

function isExecutePayload(value: unknown): value is ReviewBridgeExecutePayload {
  return (
    isObject(value) &&
    isObject(value.reviewer) &&
    (value.reviewer.agent === "codex" || value.reviewer.agent === "claude") &&
    (value.reviewer.model === null || typeof value.reviewer.model === "string") &&
    typeof value.prompt === "string" &&
    isObject(value.outputSchema) &&
    ["primary", "repair", "doctor"].includes(String(value.purpose)) &&
    typeof value.capsuleRoot === "string" &&
    typeof value.projectRoot === "string" &&
    typeof value.capsuleSha256 === "string" &&
    HASH_PATTERN.test(value.capsuleSha256) &&
    positiveInteger(value.timeoutSeconds) &&
    positiveInteger(value.maxTurns) &&
    positiveInteger(value.maxOutputTokens) &&
    Number.isInteger(value.maxToolContextTokens) &&
    Number(value.maxToolContextTokens) >= 0 &&
    typeof value.maxCostUsd === "number" &&
    value.maxCostUsd >= 0 &&
    isIsolatedReviewToolPolicy({
      toolPolicy: value.toolPolicy,
      artifactViews: value.artifactViews,
      brokerUrl: value.brokerUrl,
    }) &&
    value.brokerUrl === null
  );
}

function isReviewerBridgeConnection(value: unknown): value is ReviewerBridgeConnection {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.protocolVersion === 1 &&
    typeof value.workspaceId === "string" &&
    value.packageName === RESEARCH_PACKAGE_NAME &&
    typeof value.packageVersion === "string" &&
    typeof value.socketPath === "string" &&
    isAbsolute(value.socketPath) &&
    typeof value.publicKey === "string" &&
    typeof value.keyFingerprint === "string" &&
    HASH_PATTERN.test(value.keyFingerprint) &&
    typeof value.clientToken === "string" &&
    /^[a-f0-9]{64}$/.test(value.clientToken) &&
    typeof value.createdAt === "string"
  );
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  return (
    isObject(value) &&
    typeof value.exitCode === "number" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.tokens === "number" &&
    typeof value.inputTokens === "number" &&
    typeof value.cachedInputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.costUsd === "number" &&
    typeof value.wallSeconds === "number" &&
    (value.model === null || typeof value.model === "string") &&
    (value.runtime === null || isAgentRuntimeFingerprint(value.runtime)) &&
    isObject(value.isolation)
  );
}

function isAgentRuntimeFingerprint(value: unknown): value is AgentRuntimeFingerprint {
  return (
    isObject(value) &&
    (value.providerRouting === undefined || isAgentProviderRouting(value.providerRouting)) &&
    (value.agent === "codex" || value.agent === "claude") &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.binarySha256 === "string" &&
    HASH_PATTERN.test(value.binarySha256) &&
    typeof value.wrapperSha256 === "string" &&
    HASH_PATTERN.test(value.wrapperSha256) &&
    typeof value.adapterSha256 === "string" &&
    HASH_PATTERN.test(value.adapterSha256) &&
    typeof value.binaryVersion === "string" &&
    typeof value.platform === "string" &&
    typeof value.architecture === "string"
  );
}

function isReviewerBridgeNegativeProbes(value: unknown): value is ReviewerBridgeNegativeProbes {
  return (
    isObject(value) &&
    value.outsideReadBlocked === true &&
    value.outsideWriteBlocked === true &&
    value.workspaceCredentialReadBlocked === true &&
    value.arbitraryCommandSurfaceAbsent === true &&
    value.reviewerToolsDisabled === true
  );
}

function isBridgeFailureResponse(value: unknown): value is BridgeFailureResponse {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.protocolVersion === 1 &&
    value.ok === false &&
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function isBridgeSuccessResponse(value: unknown): value is BridgeSuccessResponse {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.protocolVersion === 1 &&
    value.ok === true &&
    typeof value.requestId === "string" &&
    typeof value.nonce === "string" &&
    typeof value.requestSha256 === "string" &&
    isObject(value.attestation) &&
    "result" in value
  );
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function bridgeError(code: string, message: string, details?: unknown): CliError {
  return new CliError(message, { code, exitCode: 3, details: sanitizeResearchValue(details) });
}

function normalizeBridgeError(error: unknown, secrets: readonly string[]): CliError {
  if (error instanceof CliError) {
    return bridgeError(error.code, sanitizeResearchText(error.message, secrets), error.details);
  }
  return bridgeError(
    "RESEARCH_REVIEW_BRIDGE_RESULT_BINDING_INVALID",
    `The reviewer sidecar rejected an invalid request: ${sanitizeResearchText(
      error instanceof Error ? error.message : String(error),
      secrets,
    ).slice(0, 500)}`,
  );
}

function writeBridgeFailure(
  response: import("node:http").ServerResponse,
  status: number,
  error: CliError,
): void {
  const value: BridgeFailureResponse = {
    schemaVersion: 1,
    protocolVersion: REVIEW_BRIDGE_PROTOCOL_VERSION,
    ok: false,
    error: {
      code: error.code,
      message: sanitizeResearchText(error.message),
      ...(error.details === undefined ? {} : { details: sanitizeResearchValue(error.details) }),
    },
  };
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function removeStaleSocket(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return;
  if (!info.isSocket() || info.isSymbolicLink()) {
    throw bridgeError(
      "RESEARCH_REVIEW_BRIDGE_STATE_INVALID",
      "The reviewer bridge socket path is occupied by a non-socket entry.",
    );
  }
  await rm(path, { force: true });
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

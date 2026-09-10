import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "../../errors.js";
import {
  isArtifactViewBinding,
  openArtifactViews,
  reviewNetworkPolicy,
  type ArtifactViewBinding,
} from "./artifact-views.js";
import { ARTIFACT_VIEW_TOOL_NAMES, startArtifactViewServer } from "./artifact-view-mcp.js";
import { codexArtifactTrace, isPacketArtifactTool } from "./artifact-trace.js";
import { researchPlatformCapabilities } from "./platform-capabilities.js";
import {
  configuredResearchSecrets,
  isSensitiveEnvironmentName,
  sanitizeResearchText,
} from "./sanitization.js";
import type { JsonSchema } from "./schemas.js";
import { claudeCodeCompatibleSchema } from "./schema-compatibility.js";
import { isObject, sha256File, sha256Text } from "./storage.js";
import type {
  AgentReasoningEffort,
  AgentExecutionTelemetry,
  AgentRoute,
  AgentProviderRouting,
  AgentRuntimeFingerprint,
  AgentVerbosity,
  ExecutionResult,
  ReviewIsolationFingerprint,
} from "./types.js";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const MIN_CAPTURE_BYTES = 64 * 1024;
const BYTES_PER_OUTPUT_TOKEN = 16;
const BYTES_PER_TOOL_CONTEXT_TOKEN = 3;
const EXECUTOR_WRAPPER_PATH = fileURLToPath(import.meta.url);
const WRAPPER_TARGET_ENV = "TIANGONG_RESEARCH_AGENT_BINARY";
const CODEX_CAPSULE_ROOT_MARKER = ".tiangong-research-capsule-root";
const CODEX_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "computer_use",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "mentions_v2",
  "multi_agent",
  "personality",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "workspace_dependencies",
  "view_image",
] as const;

const ROUTE_AUTH_ENVIRONMENT: Record<AgentRoute["agent"], readonly string[]> = {
  codex: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  workbuddy: [],
  codebuddy: [],
};
const CLAUDE_SETTINGS_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

const DEFAULT_AGENT_EFFORT: AgentReasoningEffort = "low";
const DEFAULT_CODEX_VERBOSITY: AgentVerbosity = "low";

export interface AgentExecutionRequest {
  route: AgentRoute;
  prompt: string;
  outputSchema: JsonSchema;
  requestId: string;
  purpose: "primary" | "repair" | "doctor";
  capsuleRoot: string;
  projectRoot: string;
  workspaceRoot: string;
  timeoutSeconds: number;
  maxTurns: number;
  /** Approximate planning turns; provider turn guards apply only where supported. */
  reservationTurns?: number;
  maxOutputTokens: number;
  maxToolContextTokens?: number;
  maxCostUsd: number;
  expectedRuntime?: AgentRuntimeFingerprint | undefined;
  toolPolicy?: "none" | "workspace-read" | "packet-read";
  artifactViews?: ArtifactViewBinding;
  environment: NodeJS.ProcessEnv;
  brokerUrl: string | null;
}

interface CapsuleAuthenticationBinding {
  agent: AgentRoute["agent"];
  source: string;
  sourceRealPath: string;
  destination: string;
  sourceSha256: string;
}

interface PreparedCapsuleAuthentication {
  secrets: string[];
  environment: NodeJS.ProcessEnv;
  bindings: CapsuleAuthenticationBinding[];
}

export async function executeAgent(request: AgentExecutionRequest): Promise<ExecutionResult> {
  // Use the same configuration snapshot for admission and child execution.
  request = { ...request, environment: { ...request.environment } };
  requireHeadlessAgentRoute(request.route);
  if (
    (request.toolPolicy === "packet-read" &&
      (!isArtifactViewBinding(request.artifactViews) || request.brokerUrl !== null)) ||
    (request.artifactViews && request.toolPolicy !== "packet-read")
  ) {
    throw new CliError(
      "Packet-only review requires its exact artifact index and no broker route.",
      { code: "RESEARCH_ARTIFACT_VIEW_INVALID", exitCode: 3 },
    );
  }
  const artifactSecrets = [
    ...configuredResearchSecrets(process.env),
    ...configuredResearchSecrets(request.environment),
  ];
  const artifactViews = request.artifactViews
    ? await openArtifactViews(
        request.projectRoot,
        request.artifactViews.index,
        request.artifactViews.packetSha256,
        artifactSecrets,
      )
    : null;
  validateAgentBinary(request.route);
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw new CliError("Agent max output tokens must be a positive integer.", {
      code: "RESEARCH_EXECUTOR_INVALID",
      exitCode: 2,
    });
  }
  if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1) {
    throw new CliError("Agent max turns must be a positive integer.", {
      code: "RESEARCH_EXECUTOR_INVALID",
      exitCode: 2,
    });
  }
  const temporaryDirectory = join(request.capsuleRoot, "tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const executables = await resolveAgentExecutables(request.route, request.environment.PATH);
  const settingsEnvironment = await routeSettingsEnvironment(request.route, request.environment);
  const providerRouting = configuredProviderRouting(
    request.route,
    request.environment,
    settingsEnvironment,
  );
  const runtime = await fingerprintResolvedBinary(
    request.route,
    executables.launcher,
    executables.target,
    request.environment.PATH,
    providerRouting,
  );
  if (request.expectedRuntime && !sameRuntimeFingerprint(runtime, request.expectedRuntime)) {
    throw new CliError(
      `Configured ${request.route.agent} runtime drifted after the successful doctor smoke.`,
      {
        code: "RESEARCH_EXECUTOR_DRIFT",
        exitCode: 3,
        details: {
          agent: request.route.agent,
          expectedBinarySha256: request.expectedRuntime.binarySha256,
          actualBinarySha256: runtime.binarySha256,
          expectedWrapperSha256: request.expectedRuntime.wrapperSha256,
          actualWrapperSha256: runtime.wrapperSha256,
          expectedAdapterSha256: request.expectedRuntime.adapterSha256,
          actualAdapterSha256: runtime.adapterSha256,
          expectedProviderRouting: request.expectedRuntime.providerRouting ?? null,
          actualProviderRouting: runtime.providerRouting,
        },
      },
    );
  }
  const capsuleHome = join(request.capsuleRoot, "home");
  const capsuleAuth = await prepareCapsuleHome(
    request.route,
    capsuleHome,
    request.environment,
    settingsEnvironment,
  );
  const secrets = [...configuredResearchSecrets(request.environment), ...capsuleAuth.secrets];
  artifactSecrets.push(...capsuleAuth.secrets);
  if (request.route.agent === "codex") {
    // Codex discovers project configuration by walking parent directories. Bound that
    // discovery to the isolated capsule project so a host workspace .codex/config.toml
    // is neither required nor made readable by the platform sandbox.
    await writeFile(join(request.projectRoot, CODEX_CAPSULE_ROOT_MARKER), "", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const started = process.hrtime.bigint();
  let completed: Awaited<ReturnType<typeof spawnCaptured>>;
  let sandboxed: Awaited<ReturnType<typeof sandboxInvocation>>;
  let artifactServer: Awaited<ReturnType<typeof startArtifactViewServer>> | null = null;
  try {
    artifactServer = artifactViews ? await startArtifactViewServer(artifactViews) : null;
    const invocation = await buildInvocation(
      request,
      executables.launcher,
      join(request.capsuleRoot, `${request.purpose}-output-schema.json`),
      artifactServer?.url,
    );
    sandboxed = await sandboxInvocation(
      invocation.binary,
      invocation.args,
      request.capsuleRoot,
      request.projectRoot,
      request.workspaceRoot,
      executables.target,
    );
    completed = await spawnCaptured({
      binary: sandboxed.binary,
      args: sandboxed.args,
      stdin: invocation.stdin,
      cwd: request.projectRoot,
      env: sanitizedEnvironment(
        request.environment,
        temporaryDirectory,
        capsuleHome,
        request.route,
        executables.target,
        capsuleAuth.environment,
      ),
      timeoutMs: request.timeoutSeconds * 1000,
      compactArtifactTrace: request.route.agent === "codex" && request.toolPolicy === "packet-read",
      maxCaptureBytes: Math.min(
        MAX_CAPTURE_BYTES,
        Math.max(
          MIN_CAPTURE_BYTES,
          request.maxOutputTokens * BYTES_PER_OUTPUT_TOKEN +
            (request.maxToolContextTokens ?? 0) * BYTES_PER_TOOL_CONTEXT_TOKEN,
        ),
      ),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`Configured ${request.route.agent} executable is unavailable.`, {
        code: "RESEARCH_EXECUTOR_UNAVAILABLE",
        exitCode: 3,
      });
    }
    throw error;
  } finally {
    if (artifactServer) await artifactServer.stop();
    secrets.push(...(await reconcileCapsuleAuthentication(capsuleAuth)));
  }
  const wallSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  if (isNestedSandboxDenial(completed.exitCode, completed.stderr)) {
    throw new CliError(
      "The native-direct reviewer cannot create its platform capsule inside this sandboxed IDE. Explicitly configure sandbox-bridge and start its owner-controlled reviewer sidecar, or run the review from a native host.",
      {
        code: "RESEARCH_NESTED_SANDBOX_UNSUPPORTED",
        exitCode: 3,
        details: {
          transport: "native-direct",
          platform: platform(),
          retryable: false,
          minimumAction:
            "Choose sandbox-bridge explicitly and start the exact-version reviewer sidecar outside the IDE sandbox; do not enable Full Access or disable either sandbox.",
        },
      },
    );
  }
  const parsed = parseAgentResult(request.route, completed.stdout, completed.stderr);
  const redacted = redactResult(parsed.stdout, parsed.stderr, secrets);
  const toolPolicyViolated =
    request.toolPolicy === "packet-read"
      ? (parsed.telemetry.packetReadViolations ?? 0) > 0
      : request.toolPolicy === "none" &&
        (parsed.telemetry.toolCalls > 0 || (parsed.telemetry.packetReadViolations ?? 0) > 0);
  const exitCode = redacted.exposed
    ? 86
    : completed.captureExceeded
      ? 75
      : completed.exitCode !== 0
        ? completed.exitCode
        : toolPolicyViolated
          ? 78
          : parsed.parseFailed
            ? 3
            : 0;
  const inputTokens = redacted.exposed ? 0 : parsed.inputTokens;
  const cachedInputTokens = redacted.exposed ? 0 : parsed.cachedInputTokens;
  const outputTokens = redacted.exposed ? 0 : parsed.outputTokens;
  const tokens = inputTokens + cachedInputTokens + outputTokens;
  const providerCost = redacted.exposed ? 0 : parsed.costUsd;
  const costUsd = providerCost > 0 ? providerCost : estimateCost(request.route, parsed);
  return {
    exitCode,
    stdout: redacted.stdout,
    stderr: completed.captureExceeded
      ? `${redacted.stderr}\nagent output exceeded the configured capture limit`.trim()
      : toolPolicyViolated
        ? `${redacted.stderr}\nreviewer tool policy violation: an unapproved I/O tool was reported`.trim()
        : redacted.stderr,
    tokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
    wallSeconds,
    model: parsed.model ?? request.route.model,
    runtime: { ...runtime, model: parsed.model ?? request.route.model },
    ...((request.toolPolicy === "none" || request.toolPolicy === "packet-read") &&
    request.brokerUrl === null
      ? {
          isolation: {
            ...sandboxed.isolation,
            readScopes: [
              "platform-runtime",
              "agent-runtime",
              "private-capsule",
            ] as ReviewIsolationFingerprint["readScopes"],
            writeScopes: ["private-capsule"] as ["private-capsule"],
            networkPolicy: reviewNetworkPolicy(request.toolPolicy),
            toolPolicy: request.toolPolicy,
          },
        }
      : {}),
    telemetry: sanitizeExecutionTelemetry(parsed.telemetry, secrets),
    ...(artifactViews ? { artifactReads: artifactViews.receipts() } : {}),
  };
}

function isNestedSandboxDenial(exitCode: number, stderr: string): boolean {
  if (exitCode === 0) return false;
  return (
    /sandbox-exec:\s*sandbox_apply:\s*Operation not permitted/i.test(stderr) ||
    /bwrap:.*(?:namespace|userns).*Operation not permitted/i.test(stderr) ||
    /bubblewrap:.*(?:namespace|userns).*Operation not permitted/i.test(stderr)
  );
}

export async function fingerprintAgentRoute(
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
): Promise<AgentRuntimeFingerprint> {
  requireHeadlessAgentRoute(route);
  environment = { ...environment };
  validateAgentBinary(route);
  const executables = await resolveAgentExecutables(route, environment.PATH);
  const settingsEnvironment = await routeSettingsEnvironment(route, environment);
  return fingerprintResolvedBinary(
    route,
    executables.launcher,
    executables.target,
    environment.PATH,
    configuredProviderRouting(route, environment, settingsEnvironment),
  );
}

export interface NativeCapsuleIsolationProbe {
  outsideReadBlocked: true;
  outsideWriteBlocked: true;
  workspaceCredentialReadBlocked: true;
}

export async function probeNativeCapsuleIsolation(input: {
  workspaceRoot: string;
  stateDirectory: string;
}): Promise<NativeCapsuleIsolationProbe> {
  const probeId = randomUUID();
  const capsuleRoot = join(input.stateDirectory, `isolation-probe-${probeId}`);
  const projectRoot = join(capsuleRoot, "project");
  const outsideReadPath = join(input.stateDirectory, `outside-read-${probeId}`);
  const outsideWritePath = join(input.stateDirectory, `outside-write-${probeId}`);
  const credentialPath = join(input.workspaceRoot, ".tiangong-research", ".env");
  let createdCredential = false;
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(join(capsuleRoot, "home"), { mode: 0o700 }),
    mkdir(join(capsuleRoot, "tmp"), { mode: 0o700 }),
  ]);
  await writeFile(outsideReadPath, "reviewer-isolation-probe\n", { mode: 0o600 });
  if (!(await lstat(credentialPath).catch(() => undefined))) {
    const handle = await open(credentialPath, "wx", 0o600).catch(() => null);
    if (handle) {
      await handle.writeFile("TIANGONG_REVIEWER_ISOLATION_PROBE=unreadable\n", "utf8");
      await handle.close();
      createdCredential = true;
    }
  }
  try {
    const probeScript = join(projectRoot, "isolation-probe.mjs");
    await writeFile(
      probeScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const [, , outsideReadPath, outsideWritePath, credentialPath] = process.argv;",
        "const cannotRead = (path) => { try { readFileSync(path); return false; } catch { return true; } };",
        "let outsideWriteBlocked = false;",
        'try { writeFileSync(outsideWritePath, "forbidden\\n"); } catch { outsideWriteBlocked = true; }',
        "process.stdout.write(JSON.stringify({",
        "  outsideReadBlocked: cannotRead(outsideReadPath),",
        "  outsideWriteBlocked,",
        "  workspaceCredentialReadBlocked: cannotRead(credentialPath),",
        '}) + "\\n");',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const sandboxed = await sandboxInvocation(
      process.execPath,
      [probeScript, outsideReadPath, outsideWritePath, credentialPath],
      capsuleRoot,
      projectRoot,
      input.workspaceRoot,
      process.execPath,
    );
    const completed = await spawnCaptured({
      binary: sandboxed.binary,
      args: sandboxed.args,
      cwd: projectRoot,
      env: {
        HOME: join(capsuleRoot, "home"),
        PATH: "/usr/bin:/bin",
        TMPDIR: join(capsuleRoot, "tmp"),
      },
      timeoutMs: 15_000,
      maxCaptureBytes: MIN_CAPTURE_BYTES,
    });
    let result: unknown;
    try {
      result = JSON.parse(completed.stdout.trim());
    } catch {
      result = null;
    }
    const outsideWriteReachedHost =
      (await lstat(outsideWritePath).catch(() => undefined)) !== undefined;
    if (
      completed.exitCode !== 0 ||
      !isObject(result) ||
      result.outsideReadBlocked !== true ||
      result.workspaceCredentialReadBlocked !== true ||
      outsideWriteReachedHost
    ) {
      throw new CliError("The reviewer platform capsule failed its filesystem negative probes.", {
        code: "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID",
        exitCode: 3,
        details: {
          provider: sandboxed.isolation.provider,
          policySha256: sandboxed.isolation.policySha256,
          exitCode: completed.exitCode,
          probe: isObject(result)
            ? {
                outsideReadBlocked: result.outsideReadBlocked === true,
                outsideWriteSyscallBlocked: result.outsideWriteBlocked === true,
                outsideWriteReachedHost,
                workspaceCredentialReadBlocked: result.workspaceCredentialReadBlocked === true,
              }
            : null,
        },
      });
    }
    return {
      outsideReadBlocked: true,
      outsideWriteBlocked: true,
      workspaceCredentialReadBlocked: true,
    };
  } finally {
    await Promise.all([
      rm(capsuleRoot, { recursive: true, force: true }),
      rm(outsideReadPath, { force: true }),
      rm(outsideWritePath, { force: true }),
      ...(createdCredential ? [rm(credentialPath, { force: true })] : []),
    ]);
  }
}

async function buildInvocation(
  request: AgentExecutionRequest,
  resolvedBinary: string,
  outputSchemaPath: string,
  artifactServerUrl?: string,
): Promise<{ binary: string; args: string[]; stdin: string }> {
  const outputSchema =
    request.route.agent === "claude"
      ? claudeCodeCompatibleSchema(request.outputSchema)
      : request.outputSchema;
  await writeFile(outputSchemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (request.route.agent === "codex") {
    const toolPolicy = request.toolPolicy ?? "workspace-read";
    const args = [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      // The process is already confined by sandbox-exec/Bubblewrap below. A nested Codex
      // sandbox fails on macOS and can cancel MCP calls; this flag is intended for an
      // externally sandboxed automation boundary.
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'web_search="disabled"',
      "--output-schema",
      outputSchemaPath,
      "--json",
    ];
    for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
    if (toolPolicy !== "workspace-read")
      args.push("--disable", "shell_tool", "--disable", "unified_exec");
    args.push(
      "-c",
      "include_apps_instructions=false",
      "-c",
      "include_collaboration_mode_instructions=false",
      "-c",
      "include_environment_context=false",
      "-c",
      "include_permissions_instructions=false",
      "-c",
      `project_root_markers=[${JSON.stringify(CODEX_CAPSULE_ROOT_MARKER)}]`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(request.route.effort ?? DEFAULT_AGENT_EFFORT)}`,
      "-c",
      `model_verbosity=${JSON.stringify(request.route.verbosity ?? DEFAULT_CODEX_VERBOSITY)}`,
    );
    if (request.brokerUrl) {
      args.push(
        "-c",
        `mcp_servers.research_broker.url=${JSON.stringify(request.brokerUrl)}`,
        "-c",
        "mcp_servers.research_broker.required=true",
        "-c",
        'mcp_servers.research_broker.enabled_tools=["fetch_candidate_source"]',
      );
    }
    if (request.route.model) args.push("--model", request.route.model);
    if (artifactServerUrl)
      args.push(
        "-c",
        `mcp_servers.research_artifacts.url=${JSON.stringify(artifactServerUrl)}`,
        "-c",
        "mcp_servers.research_artifacts.required=true",
        "-c",
        `mcp_servers.research_artifacts.enabled_tools=${JSON.stringify(ARTIFACT_VIEW_TOOL_NAMES)}`,
      );
    return { binary: resolvedBinary, args, stdin: request.prompt };
  }
  if (request.route.agent !== "claude") {
    throw new CliError("Native WorkBuddy/CodeBuddy producers cannot be launched as child CLIs.", {
      code: "RESEARCH_EXECUTOR_INVALID",
      exitCode: 2,
    });
  }
  const toolPolicy = request.toolPolicy ?? "workspace-read";
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "default",
    "--no-session-persistence",
    "--max-turns",
    String(request.maxTurns),
    "--setting-sources",
    "",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools",
    toolPolicy === "workspace-read" ? "Read,Glob,Grep" : "",
    "--effort",
    request.route.effort ?? DEFAULT_AGENT_EFFORT,
  ];
  if (request.purpose !== "repair") {
    args.splice(1, 0, "--json-schema", JSON.stringify(outputSchema));
  }
  const allowedTools = toolPolicy === "workspace-read" ? ["Read", "Glob", "Grep"] : [];
  if (request.brokerUrl) {
    const mcpConfigPath = join(request.capsuleRoot, "research-mcp.json");
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify({
        mcpServers: {
          research_broker: { type: "http", url: request.brokerUrl },
        },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    allowedTools.push("mcp__research_broker__fetch_candidate_source");
    args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  }
  if (artifactServerUrl) {
    const mcpConfigPath = join(request.capsuleRoot, "artifact-mcp.json");
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          research_artifacts: { type: "http", url: artifactServerUrl },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    allowedTools.push(
      ...ARTIFACT_VIEW_TOOL_NAMES.map((name) => `mcp__research_artifacts__${name}`),
    );
    args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  }
  args.push("--allowedTools", allowedTools.join(","));
  if (request.maxCostUsd > 0) args.push("--max-budget-usd", String(request.maxCostUsd));
  if (request.route.model) args.push("--model", request.route.model);
  return { binary: resolvedBinary, args, stdin: request.prompt };
}

function requireHeadlessAgentRoute(route: AgentRoute): void {
  if (route.agent === "codex" || route.agent === "claude") return;
  throw new CliError(
    `The ${route.agent} producer is native-host only and cannot be launched by the control plane.`,
    { code: "RESEARCH_EXECUTOR_INVALID", exitCode: 2 },
  );
}

async function sandboxInvocation(
  binary: string,
  args: string[],
  capsuleRoot: string,
  projectRoot: string,
  workspaceRoot: string,
  targetBinary: string,
): Promise<{
  binary: string;
  args: string[];
  isolation: Pick<ReviewIsolationFingerprint, "provider" | "policySha256">;
}> {
  const configuredCredentialPath = join(workspaceRoot, ".tiangong-research", ".env");
  const workspaceCredentialPath = await realpath(configuredCredentialPath).catch(
    () => configuredCredentialPath,
  );
  const capabilities = researchPlatformCapabilities(platform());
  if (capabilities.nativeIsolationProvider === "sandbox-exec") {
    const sandbox = "/usr/bin/sandbox-exec";
    await requireExecutable(sandbox, "macOS sandbox-exec");
    const profile = join(capsuleRoot, "execution.sb");
    const canonicalCapsuleRoot = await realpath(capsuleRoot);
    const readRoots = await existingReadRoots(binary, targetBinary, canonicalCapsuleRoot);
    const readClauses = readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ");
    const policy = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow network*)",
      "(allow file-read-metadata)",
      `(allow file-read* ${readClauses} (literal "/") (literal "/var") (literal "/dev/dtracehelper") (literal "/dev/null") (literal "/dev/urandom"))`,
      `(deny file-read* (literal ${sandboxString(workspaceCredentialPath)}))`,
      '(allow file-ioctl (literal "/dev/dtracehelper"))',
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix*)",
      `(allow file-write* (literal "/dev/dtracehelper") (literal "/dev/null") (subpath ${sandboxString(canonicalCapsuleRoot)}))`,
      "",
    ].join("\n");
    await writeFile(profile, policy, { encoding: "utf8", mode: 0o600 });
    return {
      binary: sandbox,
      args: ["-f", profile, binary, ...args],
      isolation: { provider: "sandbox-exec", policySha256: sha256Text(policy) },
    };
  }
  if (capabilities.nativeIsolationProvider === "bubblewrap") {
    const bubblewrap = await firstExecutable([
      "/usr/bin/bwrap",
      "/usr/local/bin/bwrap",
      "/bin/bwrap",
    ]);
    if (!bubblewrap) {
      throw new CliError("Linux research execution requires Bubblewrap.", {
        code: "RESEARCH_SANDBOX_UNAVAILABLE",
        exitCode: 3,
      });
    }
    const sandboxArgs = ["--die-with-parent", "--new-session"];
    const systemRoots = await existingLinuxSystemRoots();
    for (const path of systemRoots) {
      sandboxArgs.push("--ro-bind", path, path);
    }
    const createdDirectories = new Set(systemRoots);
    const runtimeRoots = [
      executableReadRoot(binary),
      executableReadRoot(targetBinary),
      executableReadRoot(process.execPath),
    ];
    for (const runtimeRoot of [...new Set(runtimeRoots)]) {
      if (
        runtimeRoot.startsWith(`${capsuleRoot}/`) ||
        systemRoots.some((root) => runtimeRoot === root || runtimeRoot.startsWith(`${root}/`))
      ) {
        continue;
      }
      await appendBubblewrapParentDirectories(sandboxArgs, runtimeRoot, createdDirectories);
      sandboxArgs.push("--ro-bind", runtimeRoot, runtimeRoot);
      createdDirectories.add(runtimeRoot);
    }
    await appendBubblewrapParentDirectories(sandboxArgs, capsuleRoot, createdDirectories);
    sandboxArgs.push(
      "--bind",
      capsuleRoot,
      capsuleRoot,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      projectRoot,
    );
    if (
      workspaceCredentialPath.startsWith(`${capsuleRoot}/`) &&
      (await pathIsReadable(workspaceCredentialPath))
    ) {
      sandboxArgs.push("--ro-bind", "/dev/null", workspaceCredentialPath);
    }
    sandboxArgs.push(binary, ...args);
    return {
      binary: bubblewrap,
      args: sandboxArgs,
      isolation: {
        provider: "bubblewrap",
        policySha256: sha256Text(JSON.stringify(sandboxArgs)),
      },
    };
  }
  throw new CliError(`Unsupported research execution platform: ${capabilities.platform}`, {
    code: "RESEARCH_SANDBOX_UNAVAILABLE",
    exitCode: 3,
    details: {
      platform: capabilities.platform,
      setupMode: capabilities.setupMode,
      productionResearch: capabilities.productionResearch,
    },
  });
}

async function prepareCapsuleHome(
  route: AgentRoute,
  capsuleHome: string,
  environment: NodeJS.ProcessEnv,
  settingsEnvironment: NodeJS.ProcessEnv,
): Promise<PreparedCapsuleAuthentication> {
  await mkdir(capsuleHome, { recursive: true, mode: 0o700 });
  const sourceHome =
    environment.HOME && isAbsolute(environment.HOME) ? environment.HOME : homedir();
  const claudeConfigRoot =
    environment.CLAUDE_CONFIG_DIR && isAbsolute(environment.CLAUDE_CONFIG_DIR)
      ? environment.CLAUDE_CONFIG_DIR
      : join(sourceHome, ".claude");
  const candidates =
    route.agent === "codex"
      ? [
          {
            source: join(
              environment.CODEX_HOME && isAbsolute(environment.CODEX_HOME)
                ? environment.CODEX_HOME
                : join(sourceHome, ".codex"),
              "auth.json",
            ),
            destination: join(capsuleHome, ".codex", "auth.json"),
          },
        ]
      : [
          {
            source: join(claudeConfigRoot, ".credentials.json"),
            destination: join(capsuleHome, ".claude", ".credentials.json"),
          },
        ];
  const secrets: string[] = [];
  const bindings: CapsuleAuthenticationBinding[] = [];
  for (const candidate of candidates) {
    const info = await lstat(candidate.source).catch(() => undefined);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CliError(
        `Configured ${route.agent} authentication material is not a regular file.`,
        {
          code: "RESEARCH_EXECUTOR_AUTH_INVALID",
          exitCode: 3,
        },
      );
    }
    assertOwnerOnlyAuthenticationFile(info.mode, route.agent);
    const sourceRealPath = await realpath(candidate.source);
    await mkdir(dirname(candidate.destination), { recursive: true, mode: 0o700 });
    const sourceSha256 = await ensureCapsuleAuthenticationFile(
      sourceRealPath,
      candidate.destination,
      route.agent,
    );
    bindings.push({
      agent: route.agent,
      source: candidate.source,
      sourceRealPath,
      destination: candidate.destination,
      sourceSha256,
    });
    secrets.push(...authSecretValues(await readFile(candidate.destination, "utf8")));
  }
  for (const name of ROUTE_AUTH_ENVIRONMENT[route.agent]) {
    const value = settingsEnvironment[name];
    if (value && value.length >= 8) secrets.push(value);
  }
  return {
    secrets: [...new Set(secrets)].sort((left, right) => right.length - left.length),
    environment: settingsEnvironment,
    bindings,
  };
}

async function ensureCapsuleAuthenticationFile(
  source: string,
  destination: string,
  agent: AgentRoute["agent"],
): Promise<string> {
  let destinationInfo = await lstat(destination).catch(() => undefined);
  if (!destinationInfo) {
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    destinationInfo = await lstat(destination).catch(() => undefined);
  }
  if (!destinationInfo?.isFile() || destinationInfo.isSymbolicLink()) {
    throw new CliError(`Capsule ${agent} authentication material is not a regular file.`, {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
  assertOwnerOnlyAuthenticationFile(destinationInfo.mode, agent);
  const [sourceSha256, destinationSha256] = await Promise.all([
    sha256File(source),
    sha256File(destination),
  ]);
  if (sourceSha256 !== destinationSha256) {
    throw new CliError(
      `Configured ${agent} authentication material changed while the capsule was active.`,
      {
        code: "RESEARCH_EXECUTOR_AUTH_DRIFT",
        exitCode: 3,
      },
    );
  }
  return sourceSha256;
}

async function reconcileCapsuleAuthentication(
  authentication: PreparedCapsuleAuthentication,
): Promise<string[]> {
  const refreshedSecrets: string[] = [];
  for (const binding of authentication.bindings) {
    if (binding.agent !== "claude") continue;
    const destinationInfo = await lstat(binding.destination).catch(() => undefined);
    if (!destinationInfo?.isFile() || destinationInfo.isSymbolicLink()) {
      throw authenticationReconciliationError("the capsule credential is no longer a regular file");
    }
    assertReconciliationFileMode(destinationInfo.mode, "the capsule credential");
    const destinationSha256 = await sha256File(binding.destination);
    if (destinationSha256 === binding.sourceSha256) continue;

    const refreshedContent = await readFile(binding.destination, "utf8");
    try {
      if (!isObject(JSON.parse(refreshedContent) as unknown)) {
        throw new Error("credential root must be an object");
      }
    } catch {
      throw authenticationReconciliationError("the refreshed capsule credential is not valid JSON");
    }
    await assertAuthenticationSourceUnchanged(binding);

    const temporaryPath = join(
      dirname(binding.sourceRealPath),
      `.tiangong-claude-credentials-${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(refreshedContent, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await assertAuthenticationSourceUnchanged(binding);
      await rename(temporaryPath, binding.sourceRealPath);
      const persistedInfo = await lstat(binding.sourceRealPath);
      if (!persistedInfo.isFile() || persistedInfo.isSymbolicLink()) {
        throw new Error("persisted credential is not a regular file");
      }
      assertOwnerOnlyAuthenticationFile(persistedInfo.mode, binding.agent);
      if ((await sha256File(binding.sourceRealPath)) !== destinationSha256) {
        throw new Error("persisted credential hash does not match the capsule credential");
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (
        error instanceof CliError &&
        error.code === "RESEARCH_EXECUTOR_AUTH_RECONCILIATION_FAILED"
      ) {
        throw error;
      }
      throw authenticationReconciliationError("atomic owner credential replacement failed");
    }
    refreshedSecrets.push(...authSecretValues(refreshedContent));
  }
  return refreshedSecrets;
}

async function assertAuthenticationSourceUnchanged(
  binding: CapsuleAuthenticationBinding,
): Promise<void> {
  const configuredSourceInfo = await lstat(binding.source).catch(() => undefined);
  if (!configuredSourceInfo?.isFile() || configuredSourceInfo.isSymbolicLink()) {
    throw authenticationReconciliationError(
      "the configured owner credential is no longer a regular file",
    );
  }
  const currentRealPath = await realpath(binding.source).catch(() => undefined);
  if (currentRealPath !== binding.sourceRealPath) {
    throw authenticationReconciliationError("the owner credential path changed concurrently");
  }
  const sourceInfo = await lstat(binding.sourceRealPath).catch(() => undefined);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw authenticationReconciliationError("the owner credential is no longer a regular file");
  }
  assertReconciliationFileMode(sourceInfo.mode, "the owner credential");
  if ((await sha256File(binding.sourceRealPath)) !== binding.sourceSha256) {
    throw authenticationReconciliationError("the owner credential changed concurrently");
  }
}

function assertReconciliationFileMode(mode: number, description: string): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) {
    throw authenticationReconciliationError(`${description} is not owner-only`);
  }
}

function authenticationReconciliationError(reason: string): CliError {
  return new CliError(
    `Refreshed Claude authentication could not be persisted because ${reason}. The capsule was retained for owner recovery.`,
    {
      code: "RESEARCH_EXECUTOR_AUTH_RECONCILIATION_FAILED",
      exitCode: 3,
      details: {
        agent: "claude",
        retainCapsule: true,
        minimumAction:
          "Reconcile the retained capsule credential with the owner Claude credential before deleting the capsule.",
      },
    },
  );
}

async function routeSettingsEnvironment(
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  if (route.agent !== "claude") return {};
  const sourceHome =
    environment.HOME && isAbsolute(environment.HOME) ? environment.HOME : homedir();
  const configRoot =
    environment.CLAUDE_CONFIG_DIR && isAbsolute(environment.CLAUDE_CONFIG_DIR)
      ? environment.CLAUDE_CONFIG_DIR
      : join(sourceHome, ".claude");
  return readClaudeSettingsEnvironment(join(configRoot, "settings.json"));
}

function configuredProviderRouting(
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
  settings: NodeJS.ProcessEnv,
): AgentProviderRouting {
  // This is a binding of admitted configuration, never a wire-level identity claim.
  // Keep URL paths/queries, proxy credentials and mapped provider IDs out of receipts.
  const selected = new Map<string, string>();
  const modelMappingSources: AgentProviderRouting["modelMappingSources"] = {};
  const names = new Set([...Object.keys(environment), ...Object.keys(settings)]);
  for (const name of [...names].sort()) {
    if (isSensitiveEnvironmentName(name)) continue;
    const isModel =
      route.agent === "claude" &&
      (/^ANTHROPIC_(?:DEFAULT_[A-Z_]+_MODEL|MODEL|SMALL_FAST_MODEL)$/.test(name) ||
        name === "CLAUDE_CODE_SUBAGENT_MODEL");
    const isRouting =
      /^(?:https?_proxy|all_proxy|no_proxy)$/i.test(name) ||
      (route.agent === "claude" &&
        (/^ANTHROPIC_[A-Z_]*BASE_URL$/.test(name) || /^CLAUDE_CODE_USE_[A-Z_]+$/.test(name))) ||
      (route.agent === "codex" && name === "OPENAI_BASE_URL");
    if (!isModel && !isRouting) continue;
    const value = environment[name] || settings[name];
    if (!value) continue;
    selected.set(name, value);
    if (isModel)
      modelMappingSources[name] = environment[name] ? "process-environment" : "claude-settings-env";
  }
  const endpoint = route.agent === "claude" ? selected.get("ANTHROPIC_BASE_URL") : undefined;
  if (endpoint) assertSafeClaudeBaseUrl(endpoint);
  return {
    schemaVersion: 1,
    configurationSha256: sha256Text(JSON.stringify([...selected])),
    endpointOrigin: endpoint ? new URL(endpoint).origin : null,
    endpointSource: endpoint
      ? environment.ANTHROPIC_BASE_URL
        ? "process-environment"
        : "claude-settings-env"
      : "runtime-default",
    modelMappingSources,
    identityVerification: "unverified",
    scope: "configured-routing-only",
  };
}

/** Offline configuration inspection; never invokes an agent or sends material. */
export async function inspectAgentProviderRouting(
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
) {
  environment = { ...environment };
  return configuredProviderRouting(
    route,
    environment,
    await routeSettingsEnvironment(route, environment),
  );
}

export function isAgentProviderRouting(value: unknown): value is AgentProviderRouting {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.configurationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.configurationSha256) ||
    typeof value.endpointSource !== "string" ||
    !["process-environment", "claude-settings-env", "runtime-default"].includes(
      value.endpointSource,
    ) ||
    value.identityVerification !== "unverified" ||
    value.scope !== "configured-routing-only" ||
    !isObject(value.modelMappingSources)
  )
    return false;
  if (value.endpointOrigin !== null) {
    if (typeof value.endpointOrigin !== "string") return false;
    try {
      const url = new URL(value.endpointOrigin);
      if (url.protocol !== "https:" || url.origin !== value.endpointOrigin) return false;
    } catch {
      return false;
    }
  }
  return Object.entries(value.modelMappingSources).every(
    ([name, source]) =>
      /^(?:ANTHROPIC_(?:DEFAULT_[A-Z_]+_MODEL|MODEL|SMALL_FAST_MODEL)|CLAUDE_CODE_SUBAGENT_MODEL)$/.test(
        name,
      ) &&
      (source === "process-environment" || source === "claude-settings-env"),
  );
}

async function readClaudeSettingsEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return {};
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CliError("Claude settings authentication source is not a regular file.", {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new CliError("Claude settings authentication source is not valid JSON.", {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
  if (!isObject(value) || !isObject(value.env)) return {};
  const selected: NodeJS.ProcessEnv = {};
  for (const name of CLAUDE_SETTINGS_ENVIRONMENT) {
    const candidate = value.env[name];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new CliError(`Claude settings ${name} must be a non-empty string.`, {
        code: "RESEARCH_EXECUTOR_AUTH_INVALID",
        exitCode: 3,
      });
    }
    if (ROUTE_AUTH_ENVIRONMENT.claude.includes(name) && candidate.length < 8) {
      throw new CliError(`Claude settings ${name} is too short to be valid.`, {
        code: "RESEARCH_EXECUTOR_AUTH_INVALID",
        exitCode: 3,
      });
    }
    if (name === "ANTHROPIC_BASE_URL") assertSafeClaudeBaseUrl(candidate);
    selected[name] = candidate;
  }
  if (Object.keys(selected).some((name) => ROUTE_AUTH_ENVIRONMENT.claude.includes(name))) {
    assertOwnerOnlyAuthenticationFile(info.mode, "claude");
  }
  return selected;
}

function assertSafeClaudeBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("Claude ANTHROPIC_BASE_URL must be a valid HTTPS URL.", {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CliError("Claude ANTHROPIC_BASE_URL must use HTTPS without embedded credentials.", {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
}

function assertOwnerOnlyAuthenticationFile(mode: number, agent: AgentRoute["agent"]): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) {
    throw new CliError(`Configured ${agent} authentication material must be owner-only (0600).`, {
      code: "RESEARCH_EXECUTOR_AUTH_INVALID",
      exitCode: 3,
    });
  }
}

async function fingerprintResolvedBinary(
  route: AgentRoute,
  launcher: string,
  target: string,
  pathValue: string | undefined,
  providerRouting: AgentProviderRouting,
): Promise<AgentRuntimeFingerprint> {
  const versionEnvironment: NodeJS.ProcessEnv = {
    PATH: pathValue ?? process.env.PATH,
    NO_COLOR: "1",
  };
  if (route.wrapperTargetBinary) versionEnvironment[WRAPPER_TARGET_ENV] = target;
  const version = await spawnCaptured({
    binary: launcher,
    args: ["--version"],
    cwd: dirname(launcher),
    env: versionEnvironment,
    timeoutMs: 10_000,
    maxCaptureBytes: 64 * 1024,
  }).catch((error) => {
    throw new CliError(`Could not inspect the configured ${route.agent} executable.`, {
      code: "RESEARCH_EXECUTOR_UNAVAILABLE",
      exitCode: 3,
      details: {
        error: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
      },
    });
  });
  const binaryVersion = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/, 1)[0] ?? "";
  if (version.exitCode !== 0 || !binaryVersion) {
    throw new CliError(`Configured ${route.agent} executable did not report a version.`, {
      code: "RESEARCH_EXECUTOR_UNAVAILABLE",
      exitCode: 3,
    });
  }
  return {
    agent: route.agent,
    model: route.model,
    effort: route.effort ?? DEFAULT_AGENT_EFFORT,
    verbosity: route.agent === "codex" ? (route.verbosity ?? DEFAULT_CODEX_VERBOSITY) : null,
    binarySha256: await sha256File(target),
    wrapperSha256: await sha256File(launcher),
    adapterSha256: await sha256File(EXECUTOR_WRAPPER_PATH),
    binaryVersion: sanitizeResearchText(binaryVersion).slice(0, 300),
    platform: platform(),
    architecture: arch(),
    providerRouting,
  };
}

async function resolveAgentExecutables(
  route: AgentRoute,
  pathValue: string | undefined,
): Promise<{ launcher: string; target: string }> {
  const launcher = await resolveExecutable(route.binary, pathValue);
  const target = route.wrapperTargetBinary
    ? await resolveExecutable(route.wrapperTargetBinary, pathValue)
    : launcher;
  if (launcher === target && route.wrapperTargetBinary) {
    throw new CliError("Agent wrapper and wrapper target resolve to the same executable.", {
      code: "RESEARCH_EXECUTOR_INVALID",
      exitCode: 2,
    });
  }
  return { launcher, target };
}

async function resolveExecutable(binary: string, pathValue: string | undefined): Promise<string> {
  const candidates = isAbsolute(binary)
    ? [binary]
    : (pathValue ?? process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const info = await lstat(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  throw new CliError(`Configured executable is unavailable: ${binary}`, {
    code: "RESEARCH_EXECUTOR_UNAVAILABLE",
    exitCode: 3,
  });
}

async function spawnCaptured(input: {
  binary: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxCaptureBytes: number;
  compactArtifactTrace?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string; captureExceeded: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: platform() !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let captureExceeded = false;
    let settled = false;

    const terminate = (): void => {
      if (!child.pid) return;
      try {
        if (platform() === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => terminate(), input.timeoutMs);
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EPIPE" || settled) return;
      settled = true;
      clearTimeout(timer);
      terminate();
      reject(error);
    });
    child.stdin.end(input.stdin ?? "", "utf8");
    const capture = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > input.maxCaptureBytes) {
        captureExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    const artifactTrace = input.compactArtifactTrace
      ? codexArtifactTrace({
          maxControlBytes: input.maxCaptureBytes,
          line: (chunk) => capture(stdout, chunk),
          oversized: () => {
            captureExceeded = true;
            terminate();
          },
        })
      : null;
    child.stdout.on("data", (chunk: Buffer) =>
      artifactTrace ? artifactTrace.write(chunk) : capture(stdout, chunk),
    );
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      artifactTrace?.end();
      settled = true;
      clearTimeout(timer);
      const detail = signal ? `\nprocess terminated by ${signal}` : "";
      resolvePromise({
        exitCode: typeof code === "number" ? code : 70,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${detail}`,
        captureExceeded,
      });
    });
  });
}

function parseAgentResult(
  route: AgentRoute,
  stdout: string,
  stderr: string,
): {
  stdout: string;
  stderr: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string | null;
  parseFailed: boolean;
  telemetry: AgentExecutionTelemetry;
} {
  if (route.agent === "codex") {
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let model: string | null = route.model;
    const messages: string[] = [];
    let parsedEvents = 0;
    const eventCounts: Record<string, number> = {};
    const itemCounts: Record<string, number> = {};
    let toolCalls = 0;
    let packetReadViolations = 0;
    let reasoningOutputTokens = 0;
    const providerErrors: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        parsedEvents += 1;
        if (typeof event.type === "string") incrementCount(eventCounts, event.type);
        if (event.type === "error") appendProviderError(providerErrors, event);
        if (event.type === "turn.completed" && isObject(event.usage)) {
          cachedInputTokens = numeric(event.usage.cached_input_tokens);
          inputTokens = Math.max(0, numeric(event.usage.input_tokens) - cachedInputTokens);
          outputTokens = numeric(event.usage.output_tokens);
          reasoningOutputTokens = numeric(event.usage.reasoning_output_tokens);
        }
        if (typeof event.model === "string") model = event.model;
        if (event.type === "item.completed" && isObject(event.item)) {
          if (typeof event.item.type === "string") {
            incrementCount(itemCounts, event.item.type);
            if (isToolItemType(event.item.type)) toolCalls += 1;
            if (
              event.item.type === "file_change" ||
              (isToolItemType(event.item.type) && !isPacketArtifactTool(event.item))
            )
              packetReadViolations += 1;
            if (event.item.type === "error") appendProviderError(providerErrors, event.item);
          }
          if (event.item.type === "agent_message" && typeof event.item.text === "string") {
            messages.push(event.item.text);
          }
        }
      } catch {
        continue;
      }
    }
    return {
      stdout: messages.at(-1) ?? stdout,
      stderr,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd: 0,
      model,
      parseFailed: parsedEvents === 0 || messages.length === 0,
      telemetry: {
        eventCounts,
        itemCounts,
        toolCalls,
        ...(packetReadViolations ? { packetReadViolations } : {}),
        providerTurns: eventCounts["turn.completed"] ?? eventCounts["turn.started"] ?? null,
        reasoningOutputTokens,
        providerErrors,
      },
    };
  }
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const usage = isObject(value.usage) ? value.usage : {};
    const providerFailed =
      value.is_error === true ||
      (typeof value.subtype === "string" && value.subtype.startsWith("error_"));
    const providerErrors: string[] = [];
    if (providerFailed) {
      if (typeof value.subtype === "string")
        appendProviderError(providerErrors, { message: value.subtype });
      if (Array.isArray(value.errors)) {
        for (const error of value.errors)
          if (typeof error === "string") appendProviderError(providerErrors, { message: error });
      }
    }
    const structured = value.structured_output !== undefined && value.structured_output !== null;
    const answer = structured
      ? JSON.stringify(value.structured_output)
      : typeof value.result === "string"
        ? value.result
        : stdout;
    return {
      stdout: providerFailed ? "" : answer,
      stderr,
      inputTokens: numeric(usage.input_tokens),
      cachedInputTokens:
        numeric(usage.cache_creation_input_tokens) + numeric(usage.cache_read_input_tokens),
      outputTokens: numeric(usage.output_tokens),
      costUsd: numeric(value.total_cost_usd),
      model: typeof value.model === "string" ? value.model : route.model,
      parseFailed: providerFailed || (!structured && typeof value.result !== "string"),
      telemetry: {
        eventCounts: { result: 1 },
        itemCounts: {},
        toolCalls: 0,
        providerTurns: numeric(value.num_turns) || null,
        reasoningOutputTokens: numeric(usage.reasoning_output_tokens),
        providerErrors,
      },
    };
  } catch {
    return {
      stdout,
      stderr,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: route.model,
      parseFailed: true,
      telemetry: {
        eventCounts: {},
        itemCounts: {},
        toolCalls: 0,
        providerTurns: null,
        reasoningOutputTokens: 0,
        providerErrors: [],
      },
    };
  }
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  temporaryDirectory: string,
  capsuleHome: string,
  route: AgentRoute,
  targetBinary: string,
  capsuleAuthEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!value || isSensitiveEnvironmentName(name)) continue;
    if (
      name === "HOME" ||
      name === "CODEX_HOME" ||
      name === "CLAUDE_CONFIG_DIR" ||
      name === WRAPPER_TARGET_ENV
    ) {
      continue;
    }
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(capsuleAuthEnvironment)) {
    if (value) environment[name] = value;
  }
  const explicitRouteEnvironment =
    route.agent === "claude" ? CLAUDE_SETTINGS_ENVIRONMENT : ROUTE_AUTH_ENVIRONMENT[route.agent];
  for (const name of explicitRouteEnvironment) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  environment.HOME = capsuleHome;
  if (route.agent === "codex") {
    environment.CODEX_HOME = join(capsuleHome, ".codex");
  } else {
    environment.CLAUDE_CONFIG_DIR = join(capsuleHome, ".claude");
    environment.CLAUDE_TMPDIR = temporaryDirectory;
    environment.CLAUDE_CODE_TMPDIR = temporaryDirectory;
    environment.BUN_TMPDIR = temporaryDirectory;
  }
  environment.NO_COLOR = "1";
  if (route.wrapperTargetBinary) environment[WRAPPER_TARGET_ENV] = targetBinary;
  environment.TMPDIR = temporaryDirectory;
  environment.TMP = temporaryDirectory;
  environment.TEMP = temporaryDirectory;
  return environment;
}

function redactResult(
  stdout: string,
  stderr: string,
  secrets: string[],
): { stdout: string; stderr: string; exposed: boolean } {
  let exposed = false;
  for (const secret of secrets) {
    if (stdout.includes(secret) || stderr.includes(secret)) exposed = true;
  }
  return {
    stdout: sanitizeResearchText(stdout, secrets),
    stderr: sanitizeResearchText(stderr, secrets),
    exposed,
  };
}

function estimateCost(
  route: AgentRoute,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number {
  if (!route.pricing) return 0;
  return roundMoney(
    (usage.inputTokens * route.pricing.inputUsdPerMillionTokens +
      usage.cachedInputTokens * route.pricing.cachedInputUsdPerMillionTokens +
      usage.outputTokens * route.pricing.outputUsdPerMillionTokens) /
      1_000_000,
  );
}

function authSecretValues(content: string): string[] {
  try {
    const value = JSON.parse(content) as unknown;
    const secrets = new Set<string>();
    collectSensitiveJsonValues(value, "", secrets);
    return [...secrets].sort((left, right) => right.length - left.length);
  } catch {
    return [];
  }
}

function collectSensitiveJsonValues(value: unknown, key: string, target: Set<string>): void {
  if (typeof value === "string") {
    if (isSensitiveEnvironmentName(key) && value.length >= 8) target.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveJsonValues(item, key, target);
    return;
  }
  if (!isObject(value)) return;
  for (const [childKey, item] of Object.entries(value)) {
    collectSensitiveJsonValues(item, childKey, target);
  }
}

async function existingReadRoots(
  launcher: string,
  target: string,
  capsuleRoot: string,
): Promise<string[]> {
  const candidates = [
    capsuleRoot,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/private/etc/ssl",
    "/private/var/db/timezone",
    "/private/var/run",
    "/private/var/select",
    executableReadRoot(launcher),
    executableReadRoot(target),
    executableReadRoot(process.execPath),
  ];
  const result: string[] = [];
  for (const candidate of candidates) {
    if (result.some((root) => candidate === root || candidate.startsWith(`${root}/`))) continue;
    if (await lstat(candidate).catch(() => undefined)) result.push(candidate);
  }
  return result;
}

function executableReadRoot(binary: string): string {
  const parent = dirname(binary);
  return dirname(parent);
}

async function existingLinuxSystemRoots(): Promise<string[]> {
  const candidates = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (await lstat(candidate).catch(() => undefined)) roots.push(candidate);
  }
  return roots;
}

async function appendBubblewrapParentDirectories(
  args: string[],
  target: string,
  created: Set<string>,
): Promise<void> {
  const parts = resolve(target).split("/").filter(Boolean);
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current += `/${part}`;
    if (!(await lstat(current).catch(() => undefined))) continue;
    if (
      [...created].some((directory) => current === directory || current.startsWith(`${directory}/`))
    ) {
      continue;
    }
    args.push("--dir", current);
    created.add(current);
  }
}

async function pathIsReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function validateAgentBinary(route: AgentRoute): void {
  if (!isAbsolute(route.binary) && route.binary !== route.agent) {
    throw new CliError(
      `Configured ${route.agent} binary must be absolute or exactly '${route.agent}'.`,
      {
        code: "RESEARCH_EXECUTOR_INVALID",
        exitCode: 2,
      },
    );
  }
  if (
    route.wrapperTargetBinary &&
    (!isAbsolute(route.binary) || !isAbsolute(route.wrapperTargetBinary))
  ) {
    throw new CliError(
      "An agent wrapper and its wrapperTargetBinary must both use explicit absolute paths.",
      {
        code: "RESEARCH_EXECUTOR_INVALID",
        exitCode: 2,
      },
    );
  }
  if (route.wrapperTargetBinary === route.binary) {
    throw new CliError("Agent wrapperTargetBinary must differ from the wrapper path.", {
      code: "RESEARCH_EXECUTOR_INVALID",
      exitCode: 2,
    });
  }
}

async function requireExecutable(path: string, label: string): Promise<void> {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new CliError(`${label} is unavailable: ${path}`, {
      code: "RESEARCH_SANDBOX_UNAVAILABLE",
      exitCode: 3,
    });
  }
}

async function firstExecutable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function sandboxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function appendProviderError(target: string[], value: Record<string, unknown>): void {
  if (target.length >= 10) return;
  const candidate = [value.message, value.error, value.detail]
    .map((item) => {
      if (typeof item === "string") return item;
      if (isObject(item)) return JSON.stringify(item);
      return "";
    })
    .find(Boolean);
  if (!candidate) return;
  // Truncate only after sanitization; otherwise a boundary can leave part of a
  // configured secret unmatched by the later exact-value redactor.
  if (!target.includes(candidate)) target.push(candidate);
}

function sanitizeExecutionTelemetry(
  telemetry: AgentExecutionTelemetry,
  secrets: readonly string[],
): AgentExecutionTelemetry {
  return {
    ...telemetry,
    providerErrors: telemetry.providerErrors.map((error) =>
      sanitizeResearchText(error, secrets).slice(0, 1_000),
    ),
  };
}

function isToolItemType(value: string): boolean {
  return (
    value === "command_execution" ||
    value === "mcp_tool_call" ||
    value === "web_search" ||
    value === "dynamic_tool_call" ||
    value === "tool_call" ||
    value.endsWith("_tool_call")
  );
}

export function sameRuntimeFingerprint(
  actual: AgentRuntimeFingerprint,
  expected: AgentRuntimeFingerprint,
): boolean {
  return (
    actual.agent === expected.agent &&
    actual.model === expected.model &&
    actual.effort === expected.effort &&
    actual.verbosity === expected.verbosity &&
    actual.binarySha256 === expected.binarySha256 &&
    actual.wrapperSha256 === expected.wrapperSha256 &&
    actual.adapterSha256 === expected.adapterSha256 &&
    actual.binaryVersion === expected.binaryVersion &&
    actual.platform === expected.platform &&
    actual.architecture === expected.architecture &&
    actual.providerRouting?.configurationSha256 === expected.providerRouting?.configurationSha256
  );
}

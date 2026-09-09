import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import {
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
} from "./workspace/external-skills.js";
import { exportSetupAuditBundle, verifySetupAuditBundle } from "./workspace/setup-audit-bundle.js";
import { inspectResearchSetupCatalog } from "./workspace/setup-catalog.js";
import {
  discoverResearchSetupDeclaration,
  executeResearchSetupDeclaration,
  initializeResearchSetupDeclaration,
} from "./workspace/setup-declarative.js";
import {
  applyResearchSetupPlan,
  checkResearchSetupUpdates,
  createResearchSetupPlan,
  createResearchSetupUpgradePlan,
  researchSetupUpgradeCandidatePath,
  doctorResearchSetup,
  inspectResearchSetupStatus,
  retryResearchSetup,
  runResearchSetupCompanion,
  setResearchSetupCredentialFromEnvironment,
  setResearchSetupCredentialValue,
  type ResearchSetupAgentRoutePlan,
  type ResearchSetupEvidenceProfile,
} from "./workspace/setup.js";
import {
  exactResearchCliCommand,
  researchSetupApplyCommand,
} from "./workspace/setup-invocation.js";
import { isObject, workspacePaths } from "./workspace/storage.js";
import type { ResearchMode } from "./workspace/types.js";
import {
  promptResearchSetupCredentialValue,
  readResearchSetupCredentialStdin,
  runResearchSetupWizard,
} from "./workspace/setup-wizard.js";

const COMMON_OPTIONS = { help: "boolean", json: "boolean" } as const;
const WORKSPACE_OPTIONS = { ...COMMON_OPTIONS, workspace: "string" } as const;

export async function runResearchSetupCommand(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action.startsWith("-")) {
    return runSetupEntry(argv, io);
  }
  if (action === "wizard") {
    return runResearchSetupWizard(rest, io);
  }
  if (action === "--help" || action === "-h" || action === "help") {
    write(io.stdout, researchSetupHelp());
    return 0;
  }
  if (action === "catalog") return runCatalog(rest, io);
  if (action === "init") return runDeclarationInit(rest, io);
  if (action === "plan") return runPlan(rest, io);
  if (action === "apply") return runApply(rest, io);
  if (action === "status") return runStatus(rest, io);
  if (action === "doctor") return runDoctor(rest, io);
  if (action === "audit") return runAudit(rest, io);
  if (action === "credential") return runCredential(rest, io);
  if (action === "companion") return runCompanion(rest, io);
  if (action === "retry") return runRetry(rest, io);
  if (action === "update") return runUpdate(rest, io);
  if (action === "upgrade") return runUpgrade(rest, io);
  throw new CliError(`Unknown research setup action: ${action}`, {
    code: "INVALID_ARGS",
    exitCode: 2,
  });
}

export function researchSetupHelp(): string {
  return `Research setup commands:
  tiangong-ai research setup [--workspace <absolute-path>] [--config <absolute-yaml>] [--env-file <absolute-owner-only-env>] [--json]
      Auto-runs a discovered .tiangong-research/setup.yaml declaration; otherwise starts the interactive Wizard.
  tiangong-ai research setup wizard [--workspace <absolute-path>] [--credential-stdin <logical-id[,logical-id...]>] [--json]
      Explicitly start the interactive, user-initiated setup Wizard (TTY required).
  tiangong-ai research setup init [--workspace <absolute-path>] [--json]
      Create no-overwrite setup.yaml and setup.env.example templates.
  tiangong-ai research setup catalog [--workspace <absolute-path>] [--scope project|global] [--agents codex,claude-code] [--json]
  tiangong-ai research setup plan --workspace <absolute-path> --mode smoke-test|production-research --evidence-profile none|brave-baseline|brave-context|brave-media [--reviewer-transport native-direct|sandbox-bridge] [--skills <csv>] [--scope project|global] [--agents <csv>] [--accept-license <csv>] [--settings <absolute-json>] [--credential-env <absolute-json>] [--agent-routes <absolute-json>] [--confirm-network-downloads] [--confirm-global] [--live] [--allow-synthetic-unstructure-upload] [--agent-smoke --confirm-agent-smoke-cost] [--replace-plan] [--json]
  tiangong-ai research setup apply [--plan <absolute-json>] [--workspace <absolute-path>] [--skip-doctor] [--json]
  tiangong-ai research setup status [--workspace <absolute-path>] [--json]
  tiangong-ai research setup doctor [--workspace <absolute-path>] [--live] [--allow-synthetic-unstructure-upload] [--agent-smoke --confirm-agent-smoke-cost] [--json]
  tiangong-ai research setup audit export --output <absolute-new-directory> [--workspace <absolute-path>] [--json]
  tiangong-ai research setup audit verify --bundle <absolute-directory> --expected-manifest-sha256 <sha256> [--json]
  tiangong-ai research setup credential set --id <logical-id> (--prompt | --from-stdin | --from-env <name>) [--workspace <absolute-path>] [--json]
  tiangong-ai research setup companion run --id tiangong.document-granular-decompose --input <absolute-file> --output <absolute-new-file> [--timeout <seconds>] [--workspace <absolute-path>] [--json]
  tiangong-ai research setup companion run --id tiangong.academic-paper-download (--doi <doi> | --title <exact-title> [--author <name>] [--year <yyyy>]) --out <absolute-existing-directory> [--timeout <seconds>] [--workspace <absolute-path>] [--json]
  tiangong-ai research setup retry --step <recorded-step> [--clear-stale-lock --confirm-clear-stale-lock] [--workspace <absolute-path>] [--json]
  tiangong-ai research setup update --check [--candidate-version <exact-stable-version>] [--workspace <absolute-path>] [--json]
  tiangong-ai research setup upgrade --rollback --candidate <absolute-plan-path> --workspace <absolute-path> [--json]
  tiangong-ai research setup upgrade --plan --confirm-upgrade [--accept-license <csv>] [--workspace <absolute-path>] [--json]

Safety defaults:
  Skills are never bundled or installed implicitly. Plans pin the installer,
  source commits, tree hashes, destinations, licenses, and declared mutations.
  Project-local copy mode is the default. Credentials use hidden TTY input,
  bounded stdin, or named owner environment variables; values are never printed.
  Every selected Skill requires its displayed license id and an explicit
  network-download confirmation; an empty smoke-test plan requires neither.
  Declarative setup never scans parent directories. Its YAML explicitly lists
  every catalog Skill, credential, and setting; omission is invalid. setup.env
  is optional, owner-only (0600), literal, and exposes every credential name.
  Disabled credentials must remain empty and are never selected by presence.
  Declarative apply always runs live provider checks and independent reviewer
  smoke; setup succeeds only when overallReadiness is READY.
  Setup audit verification requires the manifest digest retained outside the
  bundle from the trusted export result.
`;
}

async function runAudit(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") {
    write(io.stdout, researchSetupHelp());
    return 0;
  }
  if (action === "export") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, output: "string" },
      "research setup audit export",
    );
    if (strictBoolean(args, "help")) return writeSetupHelp(io);
    rejectPositionals(args.positionals, "research setup audit export");
    const output = strictString(args, "output");
    if (!output || !isAbsolute(output) || resolve(output) !== output) {
      throw invalidSetupArgument(
        "research setup audit export requires normalized absolute --output.",
      );
    }
    const result = await exportSetupAuditBundle({
      root: workspaceArgument(args),
      destination: output,
      environment: io.env,
    });
    writeSetupJson(io, result, args);
    return 0;
  }
  if (action === "verify") {
    const args = parseStrictArgs(
      rest,
      { ...COMMON_OPTIONS, bundle: "string", "expected-manifest-sha256": "string" },
      "research setup audit verify",
    );
    if (strictBoolean(args, "help")) return writeSetupHelp(io);
    rejectPositionals(args.positionals, "research setup audit verify");
    const bundle = strictString(args, "bundle");
    if (!bundle || !isAbsolute(bundle) || resolve(bundle) !== bundle) {
      throw invalidSetupArgument(
        "research setup audit verify requires normalized absolute --bundle.",
      );
    }
    const expectedManifestSha256 = strictString(args, "expected-manifest-sha256");
    if (!expectedManifestSha256 || !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)) {
      throw invalidSetupArgument(
        "research setup audit verify requires --expected-manifest-sha256 from a trusted external record.",
      );
    }
    const result = await verifySetupAuditBundle(bundle, { expectedManifestSha256 });
    writeSetupJson(io, result, args);
    return 0;
  }
  throw new CliError(`Unknown research setup audit action: ${action ?? "missing"}`, {
    code: "INVALID_ARGS",
    exitCode: 2,
  });
}

async function runSetupEntry(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      config: "string",
      "env-file": "string",
      "credential-stdin": "string",
    },
    "research setup",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup");
  const workspace = workspaceArgument(args);
  const configurationPath = strictString(args, "config");
  const environmentPath = strictString(args, "env-file");
  const credentialStdin = strictString(args, "credential-stdin");
  const discovered = await discoverResearchSetupDeclaration(workspace, {
    ...(configurationPath === undefined ? {} : { configurationPath }),
    ...(environmentPath === undefined ? {} : { environmentPath }),
  });
  if (discovered) {
    if (credentialStdin) {
      throw invalidSetupArgument(
        "--credential-stdin belongs to the Wizard and cannot be combined with declarative setup.",
      );
    }
    const result = await executeResearchSetupDeclaration({
      workspace,
      configurationPath: discovered.configurationPath,
      ...(discovered.environmentPath === null
        ? {}
        : { environmentPath: discovered.environmentPath }),
      environment: io.env,
    });
    writeSetupJson(io, result, args);
    return result.exitCode;
  }
  if (configurationPath || environmentPath) {
    throw new CliError("Declarative setup was requested but setup.yaml was not found.", {
      code: "RESEARCH_SETUP_DECLARATION_NOT_FOUND",
      exitCode: 2,
      details: {
        step: "declarative-discovery",
        minimumAction: "Run research setup init or remove --config/--env-file to use the Wizard.",
      },
    });
  }
  return runResearchSetupWizard(argv, io);
}

async function runDeclarationInit(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(argv, WORKSPACE_OPTIONS, "research setup init");
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup init");
  const result = await initializeResearchSetupDeclaration(workspaceArgument(args));
  writeSetupJson(io, result, args);
  return 0;
}

async function runCatalog(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, scope: "string", agents: "string" },
    "research setup catalog",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup catalog");
  const result = await inspectResearchSetupCatalog({
    selectedPath: workspaceArgument(args),
    scope: setupScope(strictString(args, "scope")),
    agents: setupAgents(strictString(args, "agents")),
    environment: io.env,
  });
  writeSetupJson(io, result, args);
  return 0;
}

async function runPlan(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      name: "string",
      mode: "string",
      "evidence-profile": "string",
      skills: "string",
      scope: "string",
      agents: "string",
      "accept-license": "string",
      settings: "string",
      "credential-env": "string",
      "agent-routes": "string",
      "reviewer-transport": "string",
      live: "boolean",
      "allow-synthetic-unstructure-upload": "boolean",
      "agent-smoke": "boolean",
      "confirm-network-downloads": "boolean",
      "confirm-global": "boolean",
      "confirm-agent-smoke-cost": "boolean",
      "replace-plan": "boolean",
    },
    "research setup plan",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup plan");
  const workspace = requiredAbsoluteWorkspace(args);
  const mode = setupMode(strictString(args, "mode"), true);
  const evidenceProfile = setupEvidenceProfile(strictString(args, "evidence-profile"), true);
  const settings = await optionalStringRecord(strictString(args, "settings"), "--settings");
  const credentialEnvironment = await optionalStringRecord(
    strictString(args, "credential-env"),
    "--credential-env",
  );
  const agentRoutes = await optionalAgentRoutes(strictString(args, "agent-routes"));
  const name = strictString(args, "name");
  const plan = await createResearchSetupPlan({
    workspace,
    ...(name === undefined ? {} : { name }),
    mode,
    evidenceProfile,
    skillIds: csv(strictString(args, "skills")),
    scope: setupScope(strictString(args, "scope")),
    agents: setupAgents(strictString(args, "agents")),
    acceptedLicenseIds: csv(strictString(args, "accept-license")),
    credentialEnvironment,
    settings,
    agentRoutes,
    reviewerExecution: {
      transport: setupReviewerTransport(strictString(args, "reviewer-transport")),
      isolationProvider: "platform-capsule",
    },
    liveChecks: strictBoolean(args, "live"),
    allowSyntheticUnstructureUpload: strictBoolean(args, "allow-synthetic-unstructure-upload"),
    agentSmoke: strictBoolean(args, "agent-smoke"),
    confirmNetworkDownloads: strictBoolean(args, "confirm-network-downloads"),
    confirmGlobalMutation: strictBoolean(args, "confirm-global"),
    confirmAgentSmokeCost: strictBoolean(args, "confirm-agent-smoke-cost"),
    replacePlan: strictBoolean(args, "replace-plan"),
    environment: io.env,
  });
  writeSetupJson(io, plan, args);
  return 0;
}

async function runApply(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, plan: "string", "skip-doctor": "boolean" },
    "research setup apply",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup apply");
  const planPath = strictString(args, "plan");
  if (planPath && !isAbsolute(planPath)) {
    throw invalidSetupArgument("--plan must be an absolute file path.");
  }
  const root = workspaceArgument(args);
  const result = await applyResearchSetupPlan(
    planPath ? resolve(planPath) : workspacePaths(root).setupPlan,
    { environment: io.env, skipDoctor: strictBoolean(args, "skip-doctor") },
  );
  writeSetupJson(io, result, args);
  return result.state.status === "ready" ? 0 : 3;
}

async function runStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(argv, WORKSPACE_OPTIONS, "research setup status");
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup status");
  const result = await inspectResearchSetupStatus(workspaceArgument(args), io.env);
  writeSetupJson(io, result, args);
  return result.state.status === "ready" ? 0 : 3;
}

async function runDoctor(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      live: "boolean",
      "allow-synthetic-unstructure-upload": "boolean",
      "agent-smoke": "boolean",
      "confirm-agent-smoke-cost": "boolean",
    },
    "research setup doctor",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup doctor");
  if (strictBoolean(args, "allow-synthetic-unstructure-upload") && !strictBoolean(args, "live")) {
    throw invalidSetupArgument("Synthetic upload confirmation is valid only together with --live.");
  }
  if (strictBoolean(args, "agent-smoke") && !strictBoolean(args, "confirm-agent-smoke-cost")) {
    throw new CliError(
      "Agent smoke may consume provider quota and requires explicit confirmation.",
      {
        code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
        exitCode: 2,
        details: {
          step: "doctor",
          minimumAction: "Pass --confirm-agent-smoke-cost or omit --agent-smoke.",
        },
      },
    );
  }
  const result = await doctorResearchSetup(workspaceArgument(args), {
    live: strictBoolean(args, "live"),
    allowSyntheticUnstructureUpload: strictBoolean(args, "allow-synthetic-unstructure-upload"),
    agentSmoke: strictBoolean(args, "agent-smoke"),
    environment: io.env,
  });
  writeSetupJson(io, result, args);
  return result.overallReadiness === "READY" ? 0 : 3;
}

async function runCredential(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return writeSetupHelp(io);
  if (action !== "set") {
    throw new CliError(`Unknown research setup credential action: ${action ?? "missing"}`, {
      code: "INVALID_ARGS",
      exitCode: 2,
    });
  }
  const args = parseStrictArgs(
    rest,
    {
      ...WORKSPACE_OPTIONS,
      id: "string",
      prompt: "boolean",
      "from-stdin": "boolean",
      "from-env": "string",
    },
    "research setup credential set",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup credential set");
  const credentialId = strictString(args, "id");
  const environmentName = strictString(args, "from-env");
  const prompt = strictBoolean(args, "prompt");
  const fromStdin = strictBoolean(args, "from-stdin");
  const sourceCount = Number(Boolean(environmentName)) + Number(prompt) + Number(fromStdin);
  if (!credentialId || sourceCount !== 1) {
    throw invalidSetupArgument(
      "research setup credential set requires --id and exactly one of --prompt, --from-stdin, or --from-env.",
    );
  }
  if (environmentName) {
    const result = await setResearchSetupCredentialFromEnvironment({
      workspace: workspaceArgument(args),
      credentialId,
      environmentName,
      environment: io.env,
    });
    writeSetupJson(io, result, args);
    return 0;
  }
  let value = "";
  try {
    value = prompt
      ? await promptResearchSetupCredentialValue(io, credentialId, strictBoolean(args, "json"))
      : (await readResearchSetupCredentialStdin(io.stdin, [credentialId]))[credentialId]!;
    const result = await setResearchSetupCredentialValue({
      workspace: workspaceArgument(args),
      credentialId,
      value,
      inputMethod: prompt ? "secure-input" : "stdin",
    });
    writeSetupJson(io, result, args);
    return 0;
  } finally {
    value = "";
  }
}

async function runCompanion(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return writeSetupHelp(io);
  if (action !== "run") {
    throw new CliError(`Unknown research setup companion action: ${action ?? "missing"}`, {
      code: "INVALID_ARGS",
      exitCode: 2,
    });
  }
  const args = parseStrictArgs(
    rest,
    {
      ...WORKSPACE_OPTIONS,
      id: "string",
      input: "string",
      output: "string",
      out: "string",
      doi: "string",
      title: "string",
      author: "string",
      year: "string",
      timeout: "string",
    },
    "research setup companion run",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup companion run");
  const id = strictString(args, "id");
  const timeoutSeconds = optionalPositiveInteger(strictString(args, "timeout"), "--timeout");
  let result;
  if (id === "tiangong.document-granular-decompose") {
    const inputPath = strictString(args, "input");
    const outputPath = strictString(args, "output");
    if (!inputPath || !outputPath) {
      throw invalidSetupArgument("The document companion requires --input and --output.");
    }
    rejectPresentOptions(args, ["out", "doi", "title", "author", "year"], id);
    result = await runResearchSetupCompanion(
      {
        workspace: workspaceArgument(args),
        skillId: id,
        inputPath,
        outputPath,
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
      { environment: io.env },
    );
  } else if (id === "tiangong.academic-paper-download") {
    const outputDirectory = strictString(args, "out");
    if (!outputDirectory) {
      throw invalidSetupArgument("The academic-paper companion requires --out.");
    }
    rejectPresentOptions(args, ["input", "output"], id);
    const year = optionalPositiveInteger(strictString(args, "year"), "--year");
    const doi = strictString(args, "doi");
    const title = strictString(args, "title");
    const author = strictString(args, "author");
    result = await runResearchSetupCompanion(
      {
        workspace: workspaceArgument(args),
        skillId: id,
        outputDirectory,
        ...(doi === undefined ? {} : { doi }),
        ...(title === undefined ? {} : { title }),
        ...(author === undefined ? {} : { author }),
        ...(year === undefined ? {} : { year }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
      { environment: io.env },
    );
  } else {
    throw invalidSetupArgument(
      "--id must be tiangong.document-granular-decompose or tiangong.academic-paper-download.",
    );
  }
  writeSetupJson(io, result, args);
  return result.status === "browser-handoff-required" ? 4 : 0;
}

async function runRetry(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      step: "string",
      "clear-stale-lock": "boolean",
      "confirm-clear-stale-lock": "boolean",
    },
    "research setup retry",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup retry");
  const step = strictString(args, "step");
  if (!step) throw invalidSetupArgument("research setup retry requires --step.");
  const clear = strictBoolean(args, "clear-stale-lock");
  if (clear && !strictBoolean(args, "confirm-clear-stale-lock")) {
    throw new CliError("Clearing a stale setup lock requires a second explicit confirmation.", {
      code: "RESEARCH_SETUP_CONFIRMATION_REQUIRED",
      exitCode: 2,
    });
  }
  const result = await retryResearchSetup({
    workspace: workspaceArgument(args),
    step,
    clearStaleLock: clear,
    options: { environment: io.env },
  });
  writeSetupJson(io, result, args);
  return result.state.status === "blocked" ? 3 : 0;
}

async function runUpdate(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, check: "boolean", "candidate-version": "string" },
    "research setup update",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup update");
  if (!strictBoolean(args, "check")) {
    throw invalidSetupArgument("research setup update is read-only and requires --check.");
  }
  const result = await checkResearchSetupUpdates(
    workspaceArgument(args),
    io.env,
    strictString(args, "candidate-version"),
  );
  writeSetupJson(io, result, args);
  return 0;
}

async function runUpgrade(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      plan: "boolean",
      "confirm-upgrade": "boolean",
      "accept-license": "string",
      rollback: "boolean",
      candidate: "string",
    },
    "research setup upgrade",
  );
  if (strictBoolean(args, "help")) return writeSetupHelp(io);
  rejectPositionals(args.positionals, "research setup upgrade");
  if (strictBoolean(args, "rollback")) {
    const candidate = strictString(args, "candidate");
    if (!candidate || !isAbsolute(candidate) || strictBoolean(args, "plan"))
      throw invalidSetupArgument(
        "Rollback requires one absolute --candidate path and cannot generate a plan.",
      );
    const { rollbackResearchSetupUpgrade } = await import("./workspace/setup-upgrade.js");
    writeSetupJson(
      io,
      await rollbackResearchSetupUpgrade(candidate, workspaceArgument(args)),
      args,
    );
    return 0;
  }
  if (strictString(args, "candidate"))
    throw invalidSetupArgument("--candidate is used only with --rollback.");
  if (!strictBoolean(args, "plan")) {
    throw invalidSetupArgument(
      "Upgrade is plan-only; pass --plan and review the result before apply.",
    );
  }
  const result = await createResearchSetupUpgradePlan({
    workspace: workspaceArgument(args),
    acceptedLicenseIds: csv(strictString(args, "accept-license")),
    confirmUpgrade: strictBoolean(args, "confirm-upgrade"),
    environment: io.env,
  });
  const planPath = researchSetupUpgradeCandidatePath(result);
  writeSetupJson(
    io,
    {
      ...result,
      planPath,
      applyCommand: researchSetupApplyCommand({ version: result.cli.version, planPath }),
      rollbackCommand: exactResearchCliCommand(
        [
          "research",
          "setup",
          "upgrade",
          "--rollback",
          "--candidate",
          planPath,
          "--workspace",
          result.workspace.path,
          "--json",
        ],
        result.cli.version,
      ),
      activePlanUnchanged: true,
    },
    args,
  );
  return 0;
}

function workspaceArgument(args: ReturnType<typeof parseStrictArgs>): string {
  return resolve(strictString(args, "workspace") ?? process.cwd());
}

function requiredAbsoluteWorkspace(args: ReturnType<typeof parseStrictArgs>): string {
  const workspace = strictString(args, "workspace");
  if (!workspace || !isAbsolute(workspace)) {
    throw invalidSetupArgument("research setup plan requires an absolute --workspace path.");
  }
  return resolve(workspace);
}

function setupScope(value: string | undefined): "project" | "global" {
  if (!value || value === "project") return "project";
  if (value === "global") return value;
  throw invalidSetupArgument(`Unsupported setup scope: ${value}.`);
}

function setupAgents(value: string | undefined): Array<"codex" | "claude-code"> {
  const values = value ? csv(value) : ["codex"];
  if (values.length === 0 || values.some((agent) => agent !== "codex" && agent !== "claude-code")) {
    throw invalidSetupArgument("--agents must be codex, claude-code, or both as CSV.");
  }
  return [...new Set(values)] as Array<"codex" | "claude-code">;
}

function setupMode(value: string | undefined, required: boolean): ResearchMode {
  if (value === "smoke-test" || value === "production-research") return value;
  if (!value && !required) return "production-research";
  throw invalidSetupArgument("--mode must be smoke-test or production-research.");
}

function setupReviewerTransport(value: string | undefined): "native-direct" | "sandbox-bridge" {
  if (value === undefined || value === "native-direct") return "native-direct";
  if (value === "sandbox-bridge") return value;
  throw invalidSetupArgument("--reviewer-transport must be native-direct or sandbox-bridge.");
}

function setupEvidenceProfile(
  value: string | undefined,
  required: boolean,
): ResearchSetupEvidenceProfile {
  if (
    value === "none" ||
    value === EXTERNAL_SKILL_PROFILE ||
    value === EXTERNAL_SKILL_CONTEXT_PROFILE ||
    value === EXTERNAL_SKILL_MEDIA_PROFILE
  ) {
    return value;
  }
  if (value === "brave-baseline") return EXTERNAL_SKILL_PROFILE;
  if (value === "brave-context") return EXTERNAL_SKILL_CONTEXT_PROFILE;
  if (value === "brave-media") return EXTERNAL_SKILL_MEDIA_PROFILE;
  if (!value && !required) return EXTERNAL_SKILL_PROFILE;
  throw invalidSetupArgument(
    "--evidence-profile must be none, brave-baseline, brave-context, or brave-media.",
  );
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (new Set(values).size !== values.length) {
    throw invalidSetupArgument("CSV option values must not contain duplicates.");
  }
  return values;
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw invalidSetupArgument(`${label} must be a positive base-10 integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidSetupArgument(`${label} is outside the supported integer range.`);
  }
  return parsed;
}

function rejectPresentOptions(
  args: ReturnType<typeof parseStrictArgs>,
  names: string[],
  skillId: string,
): void {
  const present = names.filter((name) => args.flags.has(name));
  if (present.length) {
    throw invalidSetupArgument(
      `${present.map((name) => `--${name}`).join(", ")} do not apply to ${skillId}.`,
    );
  }
}

async function optionalStringRecord(
  path: string | undefined,
  label: string,
): Promise<Record<string, string>> {
  if (!path) return {};
  const value = await readAbsoluteJson(path, label);
  if (!isObject(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw invalidSetupArgument(`${label} must contain one JSON object of string values.`);
  }
  return value as Record<string, string>;
}

async function optionalAgentRoutes(
  path: string | undefined,
): Promise<Partial<ResearchSetupAgentRoutePlan>> {
  if (!path) return {};
  const value = await readAbsoluteJson(path, "--agent-routes");
  if (!isObject(value)) {
    throw invalidSetupArgument("--agent-routes must contain one JSON object.");
  }
  return value as Partial<ResearchSetupAgentRoutePlan>;
}

async function readAbsoluteJson(path: string, label: string): Promise<unknown> {
  if (!isAbsolute(path)) throw invalidSetupArgument(`${label} must be an absolute JSON path.`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new CliError(`${label} is missing or invalid JSON.`, {
      code: "RESEARCH_SETUP_INPUT_INVALID",
      exitCode: 2,
      details: { label, error: String(error) },
    });
  }
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

function invalidSetupArgument(message: string): CliError {
  return new CliError(message, { code: "RESEARCH_SETUP_ARGUMENT_INVALID", exitCode: 2 });
}

function writeSetupJson(io: CliIO, value: unknown, args: ReturnType<typeof parseStrictArgs>): void {
  write(io.stdout, stringifyJson(value, strictBoolean(args, "json")));
}

function writeSetupHelp(io: CliIO): number {
  write(io.stdout, researchSetupHelp());
  return 0;
}

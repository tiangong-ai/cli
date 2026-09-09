import { constants } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CliError } from "../../errors.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { exactResearchCliCommand, researchSetupApplyCommand } from "./setup-invocation.js";
import { SETUP_UPGRADING_MARKER } from "./constants.js";
import { assertResearchSetupRuntimeIntegrity } from "./setup-runtime-integrity.js";
import {
  applyResearchSetupPlan,
  assertUpgradeParent,
  createResearchSetupPlan,
  doctorResearchSetup,
  loadAndVerifyResearchSetupPlan,
  loadHashVerifiedResearchSetupPlan,
  researchSetupUpgradeCandidatePath,
  type ApplyResearchSetupOptions,
  type ApplyResearchSetupResult,
  type ResearchSetupPlan,
  type ResearchSetupState,
} from "./setup.js";
import {
  acquireFileLock,
  canonicalJson,
  hashRegularTree,
  isObject,
  pathExists,
  sha256Bytes,
  sha256File,
  workspacePaths,
  writeBytesAtomic,
  writeJsonAtomic,
} from "./storage.js";

const MAX_CONTROL_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const DIAGNOSTICS = new Set(["state", "report", "attestation"]);
type FileImage = { sha256: string; mode: number } | null;
type FileChange = { key: string; before: FileImage; after: FileImage };
type TreeChange = {
  agent: "codex" | "claude-code";
  skillId: string;
  before: string | null;
  after: string;
};
type UpgradeState = {
  schemaVersion: 1;
  planSha256: string;
  phase:
    | "preparing"
    | "prepared"
    | "committing"
    | "activating"
    | "committed"
    | "rolling-back"
    | "rolled-back";
  initialized: boolean;
  stagePlanSha256: string | null;
  before: Record<string, FileImage>;
  files: FileChange[];
  trees: TreeChange[];
  doctorAttempted: boolean;
  journalBoundary: number;
  stateSha256: string;
};

function fail(message: string, code = "RESEARCH_SETUP_UPGRADE_CONFLICT"): CliError {
  return new CliError(message, { code, exitCode: 3 });
}
function directory(root: string, hash: string) {
  if (!HASH.test(hash)) throw fail("Invalid upgrade identity.");
  return join(workspacePaths(root).control, "setup-upgrades", hash);
}
function files(root: string): Record<string, string> {
  const p = workspacePaths(root);
  return {
    marker: p.marker,
    runtime: p.runtimeLock,
    config: p.config,
    plan: p.setupPlan,
    state: p.setupState,
    capabilities: p.capabilityDeclarations,
    capabilityLock: p.capabilityLock,
    setupConfig: p.setupConfig,
    env: p.env,
    adapter: p.setupAdapterEnv,
    declaration: p.setupDeclarationBinding,
    routing: join(p.control, "setup-instruction-routing.json"),
    agents: join(root, "AGENTS.md"),
    claudeRules: join(root, ".claude/rules/tiangong-auto-research.md"),
    report: p.setupReport,
    attestation: p.doctorAttestation,
  };
}
async function regularParents(path: string) {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw fail("Upgrade paths must use regular directories.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function bytes(path: string): Promise<{ bytes: Buffer; mode: number } | null> {
  await regularParents(dirname(path));
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONTROL_BYTES)
    throw fail("Upgrade control data is not a bounded regular file.");
  const value = await readFile(path);
  if (value.length !== info.size) throw fail("Upgrade control data changed while reading.");
  return { bytes: value, mode: info.mode & 0o777 };
}
async function image(dir: string, path: string): Promise<FileImage> {
  const value = await bytes(path);
  return value ? store(dir, value.bytes, value.mode) : null;
}
async function store(
  dir: string,
  value: Uint8Array,
  mode = 0o600,
): Promise<NonNullable<FileImage>> {
  if (value.byteLength > MAX_CONTROL_BYTES)
    throw fail("Upgrade control object exceeds its size bound.");
  const hash = sha256Bytes(value);
  const path = join(dir, "objects", hash);
  await regularParents(dirname(path));
  if (await pathExists(path)) {
    const existing = await bytes(path);
    if (!existing || sha256Bytes(existing.bytes) !== hash)
      throw fail("Upgrade object hash mismatch.");
  } else await writeBytesAtomic(path, value, 0o600);
  return { sha256: hash, mode };
}
async function objectBytes(dir: string, value: NonNullable<FileImage>) {
  if (!HASH.test(value.sha256)) throw fail("Invalid upgrade object identity.");
  const object = await bytes(join(dir, "objects", value.sha256));
  if (!object || sha256Bytes(object.bytes) !== value.sha256)
    throw fail("Upgrade object is missing or changed.");
  return object.bytes;
}
async function currentHash(path: string) {
  const value = await bytes(path);
  return value ? sha256Bytes(value.bytes) : null;
}
async function installFile(dir: string, path: string, value: FileImage) {
  await regularParents(dirname(path));
  if (value) await writeBytesAtomic(path, await objectBytes(dir, value), value.mode);
  else await rm(path, { force: true });
}
async function save(dir: string, state: UpgradeState) {
  const { stateSha256: _ignored, ...core } = state;
  state.stateSha256 = sha256Bytes(Buffer.from(canonicalJson(core)));
  await regularParents(dir);
  await writeJsonAtomic(join(dir, "state.json"), state);
}
async function load(dir: string, plan: ResearchSetupPlan): Promise<UpgradeState | null> {
  const raw = await bytes(join(dir, "state.json"));
  if (!raw) return null;
  const value: unknown = JSON.parse(raw.bytes.toString("utf8"));
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.planSha256 !== plan.planSha256 ||
    !isObject(value.before) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.trees) ||
    typeof value.initialized !== "boolean" ||
    typeof value.doctorAttempted !== "boolean" ||
    !Number.isSafeInteger(value.journalBoundary) ||
    ![
      "preparing",
      "prepared",
      "committing",
      "activating",
      "committed",
      "rolling-back",
      "rolled-back",
    ].includes(String(value.phase))
  )
    throw fail("Upgrade state is invalid.");
  const { stateSha256, ...core } = value;
  if (stateSha256 !== sha256Bytes(Buffer.from(canonicalJson(core))))
    throw fail("Upgrade state hash mismatch.");
  const validImage = (v: unknown): boolean =>
    v === null ||
    (isObject(v) &&
      typeof v.sha256 === "string" &&
      HASH.test(v.sha256) &&
      Number.isInteger(v.mode) &&
      Number(v.mode) >= 0 &&
      Number(v.mode) <= 0o777);
  const known = files(plan.workspace.path);
  if (
    Object.entries(value.before).some(([k, v]) => !Object.hasOwn(known, k) || !validImage(v)) ||
    Object.keys(value.before).length !== Object.keys(known).length ||
    value.files.some(
      (f) =>
        !isObject(f) ||
        typeof f.key !== "string" ||
        !Object.hasOwn(known, f.key) ||
        !validImage(f.before) ||
        !validImage(f.after),
    ) ||
    value.trees.some(
      (t) =>
        !isObject(t) ||
        !["codex", "claude-code"].includes(String(t.agent)) ||
        typeof t.skillId !== "string" ||
        !plan.skills.some((s) => s.id === t.skillId) ||
        (t.before !== null && (typeof t.before !== "string" || !HASH.test(t.before))) ||
        typeof t.after !== "string" ||
        !HASH.test(t.after),
    )
  )
    throw fail("Upgrade state contains an unknown target.");
  return value as unknown as UpgradeState;
}
async function treeHash(path: string): Promise<string | null> {
  await regularParents(dirname(path));
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw fail("Install destination is unsafe.", "RESEARCH_SETUP_INSTALL_DESTINATION_UNSAFE");
  return hashRegularTree(path);
}
function treePaths(plan: ResearchSetupPlan, tree: TreeChange) {
  const target = plan.install.targets.find((t) => t.agent === tree.agent)!;
  const skill = plan.skills.find((s) => s.id === tree.skillId)!;
  const scratch = join(
    dirname(target.root),
    ".tiangong-setup-upgrades",
    plan.planSha256,
    tree.agent,
  );
  return {
    active: join(target.root, skill.skillName),
    old: join(scratch, "old", skill.skillName),
    next: join(scratch, "new", skill.skillName),
  };
}
async function copyTree(source: string, target: string, expected: string) {
  const existing = await treeHash(target);
  if (existing === expected) return;
  if (existing !== null) throw fail("Prepared Skill tree changed; it will not be overwritten.");
  await regularParents(dirname(target));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
  });
  if ((await treeHash(target)) !== expected)
    throw fail("Prepared Skill tree failed its content binding.");
}
async function assertIdle(root: string) {
  const p = workspacePaths(root);
  for (const entry of await readdir(p.projects, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw fail("Project metadata is unsafe.");
    if (
      entry.isDirectory() &&
      (await pathExists(join(p.projects, entry.name, "native/active.json")))
    )
      throw fail("Complete or abort active native stages before upgrading.");
  }
}
function projectPlanInput(plan: ResearchSetupPlan, stage: string, environment: NodeJS.ProcessEnv) {
  return {
    workspace: stage,
    name: plan.workspace.name,
    mode: plan.workspace.mode,
    evidenceProfile: plan.selection.evidenceProfile,
    skillIds: plan.selection.skillIds,
    scope: "project" as const,
    agents: plan.install.agents,
    acceptedLicenseIds: plan.acceptedLicenses.map((x) => x.licenseId),
    settings: plan.settings,
    credentialEnvironment: Object.fromEntries(
      plan.credentialSources.map((x) => [x.id, x.fromEnvironment]),
    ),
    agentRoutes: plan.agentRoutes,
    reviewerExecution: plan.reviewerExecution,
    confirmNetworkDownloads: true,
    environment,
    liveChecks: false,
    agentSmoke: false,
  };
}
async function prepare(
  plan: ResearchSetupPlan,
  state: UpgradeState,
  dir: string,
  options: ApplyResearchSetupOptions,
) {
  const root = plan.workspace.path,
    active = files(root),
    stage = join(dir, "stage"),
    target = files(stage);
  await assertUpgradeParent(plan);
  const prior = JSON.parse(
    (await objectBytes(dir, state.before.plan!)).toString("utf8"),
  ) as ResearchSetupPlan;
  const sourceEnvironment = options.environment ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    ...sourceEnvironment,
    HOME: join(stage, "installer-home"),
  };
  delete environment.CODEX_HOME;
  delete environment.CLAUDE_CONFIG_DIR;
  if (!state.initialized) {
    const { initializeResearchWorkspace } = await import("./workspace.js");
    if (!(await pathExists(target.marker!)))
      await initializeResearchWorkspace(stage, plan.workspace.name, plan.workspace.mode);
    for (const key of [
      "config",
      "capabilities",
      "capabilityLock",
      "env",
      "adapter",
      "agents",
      "claudeRules",
    ]) {
      if (state.before[key]) await installFile(dir, target[key]!, state.before[key]!);
    }
    if (state.before.routing) {
      const old = JSON.parse((await objectBytes(dir, state.before.routing)).toString("utf8"));
      for (const item of old.targets) item.path = join(stage, relative(root, item.path));
      await writeJsonAtomic(target.routing!, old);
    }
    for (const actual of plan.install.targets)
      for (const skill of plan.skills) {
        const before = prior.skills.find((x) => x.id === skill.id);
        const source = join(actual.root, skill.skillName);
        if (
          before?.expectedTreeSha256 === skill.expectedTreeSha256 &&
          (await treeHash(source)) === skill.expectedTreeSha256
        )
          await copyTree(
            source,
            join(
              stage,
              actual.agent === "codex" ? ".agents" : ".claude",
              "skills",
              skill.skillName,
            ),
            skill.expectedTreeSha256,
          );
      }
    state.initialized = true;
    await save(dir, state);
  }
  let stagePlan: ResearchSetupPlan;
  if (await pathExists(target.plan!))
    stagePlan = await loadAndVerifyResearchSetupPlan(target.plan!);
  else stagePlan = await createResearchSetupPlan(projectPlanInput(plan, stage, environment));
  if (
    stagePlan.workspace.path !== stage ||
    canonicalJson(stagePlan.selection) !== canonicalJson(plan.selection) ||
    canonicalJson(stagePlan.agentRoutes) !== canonicalJson(plan.agentRoutes) ||
    canonicalJson(stagePlan.reviewerExecution) !== canonicalJson(plan.reviewerExecution)
  )
    throw fail("Prepared plan does not match its candidate.");
  state.stagePlanSha256 = stagePlan.planSha256;
  await save(dir, state);
  const applied = await applyResearchSetupPlan(target.plan!, {
    ...options,
    environment,
    skipDoctor: true,
    sourceCacheWorkspace: root,
    installerCacheDirectory: join(dir, "npm-cache"),
  });
  const replacements = [
    ...stagePlan.install.targets.map(
      (t) => [t.root, plan.install.targets.find((x) => x.agent === t.agent)!.root] as const,
    ),
    [stage, root] as const,
  ].sort((a, b) => b[0].length - a[0].length);
  const remap = (path: string) => {
    for (const [from, to] of replacements)
      if (path === from || path.startsWith(from + sep)) return to + path.slice(from.length);
    return path;
  };
  const desired: Record<string, FileImage> = { ...state.before };
  for (const key of ["config", "env", "adapter"]) desired[key] = await image(dir, target[key]!);
  for (const key of ["capabilities", "capabilityLock", "setupConfig", "routing"]) {
    const contents = await bytes(target[key]!);
    if (!contents) {
      desired[key] = null;
      continue;
    }
    const value = JSON.parse(contents.bytes.toString("utf8"));
    if (key === "capabilities" || key === "capabilityLock")
      for (const capability of value.capabilities)
        capability.skillPath = remap(capability.skillPath);
    if (key === "setupConfig" || key === "routing") value.planSha256 = plan.planSha256;
    if (key === "routing") for (const item of value.targets) item.path = remap(item.path);
    desired[key] = await store(
      dir,
      Buffer.from(JSON.stringify(value, null, 2) + "\n"),
      contents.mode,
    );
  }
  if (plan.instructionRouting.targets.length) {
    for (const key of ["agents", "claudeRules"]) {
      if (plan.instructionRouting.targets.some((t) => t.path === active[key]))
        desired[key] = await image(dir, target[key]!);
    }
  } else desired.routing = state.before.routing ?? null;
  if (state.before.declaration) {
    const binding = JSON.parse((await objectBytes(dir, state.before.declaration)).toString("utf8"));
    if (binding.planSha256 !== prior.planSha256) throw fail("Declarative setup binding is stale.");
    desired.declaration = await store(
      dir,
      Buffer.from(JSON.stringify({ ...binding, planSha256: plan.planSha256 }, null, 2) + "\n"),
      state.before.declaration.mode,
    );
  }
  desired.plan = await store(dir, Buffer.from(JSON.stringify(plan, null, 2) + "\n"), 0o444);
  const lock = JSON.parse((await objectBytes(dir, state.before.runtime!)).toString("utf8"));
  desired.runtime = await store(
    dir,
    Buffer.from(JSON.stringify({ ...lock, packageVersion: plan.cli.version }, null, 2) + "\n"),
    state.before.runtime!.mode,
  );
  desired.state = await store(
    dir,
    Buffer.from(
      JSON.stringify(
        { ...applied.state, planSha256: plan.planSha256, status: "partially-ready" },
        null,
        2,
      ) + "\n",
    ),
  );
  desired.report = null;
  desired.attestation = null;
  state.files = Object.keys(active)
    .filter((key) => key !== "marker")
    .map((key) => ({ key, before: state.before[key] ?? null, after: desired[key] ?? null }));
  // A verified staged tree is copied to its destination filesystem before any
  // active directory is moved; the final rename is always same-filesystem.
  for (const tree of state.trees) {
    const skill = plan.skills.find((s) => s.id === tree.skillId)!;
    await copyTree(
      join(stage, tree.agent === "codex" ? ".agents" : ".claude", "skills", skill.skillName),
      treePaths(plan, tree).next,
      tree.after,
    );
  }
  state.phase = "prepared";
  await save(dir, state);
  await appendJournalEvent(
    workspacePaths(root).journal,
    "research.setup.upgrade.prepared",
    "workspace",
    { planSha256: plan.planSha256, definitionSha256: definitionHash(state) },
  );
  await options.upgradeCheckpoint?.("prepared");
}
async function assertInputs(plan: ResearchSetupPlan, state: UpgradeState) {
  await assertUpgradeParent(plan);
  const active = files(plan.workspace.path);
  for (const [key, before] of Object.entries(state.before))
    if ((await currentHash(active[key]!)) !== (before?.sha256 ?? null))
      throw fail("Active setup input changed during preparation.");
  for (const tree of state.trees)
    if ((await treeHash(treePaths(plan, tree).active)) !== tree.before)
      throw fail(
        "Active Skill changed during preparation.",
        "RESEARCH_SETUP_INSTALL_DESTINATION_UNSAFE",
      );
}
async function activate(
  plan: ResearchSetupPlan,
  state: UpgradeState,
  dir: string,
  options: ApplyResearchSetupOptions,
) {
  const root = plan.workspace.path,
    active = files(root),
    p = workspacePaths(root);
  await assertIdle(root);
  if (state.phase === "prepared") {
    await assertInputs(plan, state);
    state.phase = "committing";
    state.journalBoundary = (await readVerifiedJournal(p.journal)).length;
    await save(dir, state);
  }
  const markerBytes = await objectBytes(dir, state.before.marker!);
  const marker = JSON.parse(markerBytes.toString("utf8"));
  const blocked = Buffer.from(
    JSON.stringify(
      { ...marker, kind: SETUP_UPGRADING_MARKER, setupUpgradePlanSha256: plan.planSha256 },
      null,
      2,
    ) + "\n",
  );
  const markerHash = await currentHash(active.marker!);
  if (markerHash !== state.before.marker!.sha256 && markerHash !== sha256Bytes(blocked))
    throw fail("Workspace marker changed during upgrade.");
  if (state.phase !== "activating")
    await writeBytesAtomic(active.marker!, blocked, state.before.marker!.mode);
  for (const tree of state.trees) {
    const locations = treePaths(plan, tree),
      current = await treeHash(locations.active),
      backup = await treeHash(locations.old);
    if (current === tree.after) continue;
    if (current !== tree.before && !(current === null && backup === tree.before))
      throw fail("Skill transition conflicts with owner changes.");
    if (current !== null) {
      if (backup !== null) throw fail("Upgrade backup destination is occupied.");
      await regularParents(dirname(locations.old));
      await mkdir(dirname(locations.old), { recursive: true, mode: 0o700 });
      await rename(locations.active, locations.old);
    }
    if ((await treeHash(locations.next)) !== tree.after)
      throw fail("Prepared replacement tree is missing or changed.");
    await mkdir(dirname(locations.active), { recursive: true, mode: 0o700 });
    await rename(locations.next, locations.active);
    await options.upgradeCheckpoint?.(`after-tree:${tree.agent}`);
  }
  for (const change of [...state.files].sort(
    (a, b) => Number(a.key === "runtime") - Number(b.key === "runtime"),
  )) {
    const current = await currentHash(active[change.key]!);
    if (current === (change.after?.sha256 ?? null)) continue;
    if (current !== (change.before?.sha256 ?? null))
      throw fail("A setup control file changed during upgrade.");
    await installFile(dir, active[change.key]!, change.after);
  }
  await options.upgradeCheckpoint?.("after-files");
  state.phase = "activating";
  await save(dir, state);
  await options.upgradeCheckpoint?.("before-activation");
  await writeBytesAtomic(active.marker!, markerBytes, state.before.marker!.mode);
  state.phase = "committed";
  await save(dir, state);
  await appendJournalEvent(p.journal, "research.setup.upgrade.committed", "workspace", {
    planSha256: plan.planSha256,
    parentPlanSha256: plan.upgrade!.parentPlanSha256,
  });
}

export async function applyManagedSetupUpgrade(
  plan: ResearchSetupPlan,
  options: ApplyResearchSetupOptions,
): Promise<ApplyResearchSetupResult> {
  const root = plan.workspace.path,
    p = workspacePaths(root),
    dir = directory(root, plan.planSha256);
  const release = await acquireFileLock(p.setupLock, {
    pid: process.pid,
    operation: "research.setup.upgrade",
    acquiredAt: new Date().toISOString(),
    planSha256: plan.planSha256,
  });
  let releaseWorkspace: (() => Promise<void>) | null = null;
  let state: UpgradeState | null = null;
  try {
    releaseWorkspace = await acquireFileLock(join(p.locks, "workspace.lock"), {
      pid: process.pid,
      operation: "research.setup.upgrade",
      acquiredAt: new Date().toISOString(),
    });
    await assertIdle(root);
    state = await load(dir, plan);
    if (!state) {
      const prior = await assertUpgradeParent(plan);
      if (new Set(plan.install.targets.map((t) => t.root)).size !== plan.install.targets.length)
        throw fail("Upgrade targets must be distinct.");
      const before: Record<string, FileImage> = {};
      for (const [key, path] of Object.entries(files(root))) before[key] = await image(dir, path);
      const lock = JSON.parse((await objectBytes(dir, before.runtime!)).toString("utf8"));
      const marker = JSON.parse((await objectBytes(dir, before.marker!)).toString("utf8"));
      if (
        lock.packageName !== "@tiangong-ai/cli" ||
        lock.protocolVersion !== 1 ||
        lock.workspaceId !== marker.workspaceId ||
        lock.packageVersion !== prior.cli.version
      )
        throw fail(
          "The active plan and runtime lock need verified legacy recovery before this upgrade.",
          "RESEARCH_SETUP_LEGACY_UPGRADE_RECOVERY_REQUIRED",
        );
      const trees: TreeChange[] = [];
      for (const target of plan.install.targets)
        for (const skill of plan.skills) {
          const old = prior.skills.find((s) => s.id === skill.id);
          const observed = await treeHash(join(target.root, skill.skillName));
          if (observed !== null && observed !== old?.expectedTreeSha256)
            throw fail(
              "Existing install destination differs from its verified parent.",
              "RESEARCH_SETUP_INSTALL_DESTINATION_UNSAFE",
            );
          if (observed !== skill.expectedTreeSha256)
            trees.push({
              agent: target.agent,
              skillId: skill.id,
              before: observed,
              after: skill.expectedTreeSha256,
            });
        }
      state = {
        schemaVersion: 1,
        planSha256: plan.planSha256,
        phase: "preparing",
        initialized: false,
        stagePlanSha256: null,
        before,
        files: [],
        trees,
        doctorAttempted: false,
        journalBoundary: 0,
        stateSha256: "",
      };
      await save(dir, state);
    }
    await verifyAnchors(plan, state, dir);
    if (state.phase === "rolling-back")
      throw fail(
        "Resume the recorded rollback before applying another upgrade.",
        "RESEARCH_SETUP_UPGRADE_PENDING",
      );
    if (state.phase === "rolled-back")
      throw fail(
        "This candidate was rolled back; create a fresh candidate from the restored generation.",
      );
    if (state.phase === "preparing") await prepare(plan, state, dir, options);
    if (state.phase !== "committed") await activate(plan, state, dir, options);
    if ((await loadAndVerifyResearchSetupPlan(p.setupPlan)).planSha256 !== plan.planSha256)
      throw fail("A later generation superseded this upgrade.");
    for (const target of plan.install.targets)
      for (const skill of plan.skills)
        if ((await treeHash(join(target.root, skill.skillName))) !== skill.expectedTreeSha256)
          throw fail("Committed installation drifted.");
    const setupState = JSON.parse(
      (await bytes(p.setupState))!.bytes.toString("utf8"),
    ) as ResearchSetupState;
    if (!options.skipDoctor && !state.doctorAttempted) {
      await appendJournalEvent(p.journal, "research.setup.upgrade.doctor-started", "workspace", {
        planSha256: plan.planSha256,
      });
      state.doctorAttempted = true;
      await save(dir, state);
      await releaseWorkspace();
      releaseWorkspace = null;
      const report = await doctorResearchSetup(root, {
        live: plan.checks.live,
        allowSyntheticUnstructureUpload: plan.checks.allowSyntheticUnstructureUpload,
        agentSmoke: plan.checks.agentSmoke,
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.sleeper ? { sleeper: options.sleeper } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
      });
      setupState.status =
        report.researchReadiness === "BLOCKED"
          ? "blocked"
          : report.overallReadiness === "PARTIALLY_READY"
            ? "partially-ready"
            : "ready";
      setupState.completedSteps = [...new Set([...setupState.completedSteps, "doctor"])];
      setupState.updatedAt = new Date().toISOString();
      await writeJsonAtomic(p.setupState, setupState);
      return { schemaVersion: 1 as const, plan, state: setupState, report };
    }
    return { schemaVersion: 1 as const, plan, state: setupState, report: null };
  } catch (error) {
    throw upgradeFailure(error, plan, state?.phase ?? "preflight");
  } finally {
    try {
      await releaseWorkspace?.();
    } finally {
      await release();
    }
  }
}

export async function rollbackResearchSetupUpgrade(
  candidatePath: string,
  workspace: string,
  options: { checkpoint?: (point: string) => Promise<void> } = {},
) {
  const plan = await loadAndVerifyResearchSetupPlan(resolve(candidatePath));
  if (!plan.upgrade || plan.workspace.path !== resolve(workspace))
    throw fail("Rollback must select the exact candidate and workspace.");
  await assertResearchSetupRuntimeIntegrity(plan.upgrade.cliRuntimeSha256);
  const root = plan.workspace.path,
    p = workspacePaths(root),
    dir = directory(root, plan.planSha256);
  const releaseSetup = await acquireFileLock(p.setupLock, {
    pid: process.pid,
    operation: "research.setup.upgrade.rollback",
    acquiredAt: new Date().toISOString(),
  });
  let state: UpgradeState | null = null;
  try {
    const release = await acquireFileLock(join(p.locks, "workspace.lock"), {
      pid: process.pid,
      operation: "research.setup.upgrade.rollback",
      acquiredAt: new Date().toISOString(),
    });
    try {
      state = await load(dir, plan);
      if (!state) throw fail("No upgrade transition exists for this candidate.");
      await verifyAnchors(plan, state, dir);
      await assertIdle(root);
      const active = files(root),
        markerBytes = await objectBytes(dir, state.before.marker!);
      const marker = JSON.parse(markerBytes.toString("utf8"));
      const events = await readVerifiedJournal(p.journal);
      if (
        ["committed", "rolling-back"].includes(state.phase) &&
        events
          .slice(state.journalBoundary)
          .some((e) => e.scope !== "workspace" && e.scope !== marker.workspaceId)
      )
        throw fail(
          "New research activity prevents rollback; preserve it and use a reviewed forward upgrade.",
        );
      const blocked = Buffer.from(
        JSON.stringify(
          { ...marker, kind: SETUP_UPGRADING_MARKER, setupUpgradePlanSha256: plan.planSha256 },
          null,
          2,
        ) + "\n",
      );
      const actualMarker = await currentHash(active.marker!);
      if (actualMarker !== state.before.marker!.sha256 && actualMarker !== sha256Bytes(blocked))
        throw fail("Workspace marker changed after this upgrade.");
      // Check every target before reversing even one file. Unknown owner bytes
      // are never overwritten to make another part of the transaction succeed.
      for (const change of state.files) {
        const current = await currentHash(active[change.key]!);
        if (
          !DIAGNOSTICS.has(change.key) &&
          current !== (change.before?.sha256 ?? null) &&
          current !== (change.after?.sha256 ?? null)
        )
          throw fail("Owner changes conflict with rollback.");
        if (change.before) await objectBytes(dir, change.before);
      }
      for (const tree of state.trees) {
        const loc = treePaths(plan, tree),
          current = await treeHash(loc.active),
          backup = await treeHash(loc.old),
          prepared = await treeHash(loc.next);
        if (current !== tree.before && current !== tree.after && current !== null)
          throw fail("Owner Skill changes conflict with rollback.");
        if (current !== tree.before && tree.before !== null && backup !== tree.before)
          throw fail("The prior Skill backup is missing or changed.");
        if (current === tree.after && prepared !== null)
          throw fail("Rollback staging path is occupied.");
      }
      if (state.phase === "rolled-back")
        return {
          schemaVersion: 1,
          status: "rolled-back",
          replayed: true,
          planSha256: plan.planSha256,
          parentPlanSha256: plan.upgrade.parentPlanSha256,
        };
      if (state.phase !== "rolling-back") {
        const diagnostics: Record<string, FileImage> = {};
        for (const key of DIAGNOSTICS) diagnostics[key] = await image(dir, active[key]!);
        await writeJsonAtomic(join(dir, "rollback-diagnostics.json"), {
          planSha256: plan.planSha256,
          files: diagnostics,
        });
        state.phase = "rolling-back";
        await save(dir, state);
        await appendJournalEvent(
          p.journal,
          "research.setup.upgrade.rollback-started",
          "workspace",
          { planSha256: plan.planSha256 },
        );
      }
      await writeBytesAtomic(active.marker!, blocked, state.before.marker!.mode);
      for (const change of [...state.files].reverse()) {
        if ((await currentHash(active[change.key]!)) === (change.before?.sha256 ?? null)) continue;
        await installFile(dir, active[change.key]!, change.before);
        await options.checkpoint?.(`after-rollback-file:${change.key}`);
      }
      for (const tree of [...state.trees].reverse()) {
        const loc = treePaths(plan, tree),
          current = await treeHash(loc.active);
        if (current === tree.before) continue;
        if (current === tree.after) {
          await mkdir(dirname(loc.next), { recursive: true, mode: 0o700 });
          await rename(loc.active, loc.next);
        }
        if (tree.before !== null) await rename(loc.old, loc.active);
      }
      await installFile(dir, active.marker!, state.before.marker!);
      state.phase = "rolled-back";
      await save(dir, state);
      await appendJournalEvent(p.journal, "research.setup.upgrade.rolled-back", "workspace", {
        planSha256: plan.planSha256,
        parentPlanSha256: plan.upgrade.parentPlanSha256,
      });
      return {
        schemaVersion: 1,
        status: "rolled-back",
        planSha256: plan.planSha256,
        parentPlanSha256: plan.upgrade.parentPlanSha256,
      };
    } finally {
      await release();
    }
  } catch (error) {
    throw upgradeFailure(error, plan, state?.phase ?? "rollback");
  } finally {
    await releaseSetup();
  }
}

function definitionHash(state: UpgradeState) {
  return sha256Bytes(
    Buffer.from(
      canonicalJson({
        before: state.before,
        files: state.files,
        trees: state.trees,
        stagePlanSha256: state.stagePlanSha256,
      }),
    ),
  );
}
async function verifyAnchors(plan: ResearchSetupPlan, state: UpgradeState, dir: string) {
  const binding = plan.upgrade!;
  if (
    state.before.runtime?.sha256 !== binding.parentRuntimeLockSha256 ||
    state.before.config?.sha256 !== binding.parentConfigSha256 ||
    state.before.marker?.sha256 !== binding.parentMarkerSha256 ||
    !state.before.plan
  )
    throw fail("Upgrade preimages do not bind their approved parent.");
  const parent = await loadHashVerifiedResearchSetupPlan(
    join(dir, "objects", state.before.plan.sha256),
  );
  if (
    parent.planSha256 !== binding.parentPlanSha256 ||
    parent.workspace.path !== plan.workspace.path
  )
    throw fail("Upgrade parent identity changed.");
  const treeKeys = new Set<string>();
  for (const tree of state.trees) {
    const key = tree.agent + ":" + tree.skillId;
    if (
      treeKeys.has(key) ||
      !plan.install.targets.some((t) => t.agent === tree.agent) ||
      tree.after !== plan.skills.find((s) => s.id === tree.skillId)?.expectedTreeSha256 ||
      (tree.before !== null &&
        tree.before !== parent.skills.find((s) => s.id === tree.skillId)?.expectedTreeSha256)
    )
      throw fail("Upgrade tree intents differ from the reviewed generations.");
    treeKeys.add(key);
  }
  const path = workspacePaths(plan.workspace.path).journal;
  let events = await readVerifiedJournal(path);
  const matching = (type: string) =>
    events.filter(
      (e) => e.scope === "workspace" && e.type === type && e.payload.planSha256 === plan.planSha256,
    );
  const beforeHash = sha256Bytes(
    Buffer.from(canonicalJson({ before: state.before, trees: state.trees })),
  );
  let starts = matching("research.setup.upgrade.started");
  if (!starts.length) {
    if (state.phase !== "preparing" || state.initialized || state.files.length)
      throw fail("Upgrade has no authoritative start record.");
    await assertInputs(plan, state);
    await appendJournalEvent(path, "research.setup.upgrade.started", "workspace", {
      planSha256: plan.planSha256,
      beforeSha256: beforeHash,
    });
    events = await readVerifiedJournal(path);
    starts = matching("research.setup.upgrade.started");
  }
  if (starts.length !== 1 || starts[0]!.payload.beforeSha256 !== beforeHash)
    throw fail("Upgrade state differs from its journal-bound preimages.");
  state.journalBoundary = events.indexOf(starts[0]!) + 1;
  const prepared = matching("research.setup.upgrade.prepared");
  if (prepared.length) {
    const keys = Object.keys(files(plan.workspace.path)).filter((k) => k !== "marker");
    if (
      prepared.length !== 1 ||
      prepared[0]!.payload.definitionSha256 !== definitionHash(state) ||
      state.files.length !== keys.length ||
      new Set(state.files.map((f) => f.key)).size !== keys.length ||
      state.files.some((f) => canonicalJson(f.before) !== canonicalJson(state.before[f.key]))
    )
      throw fail("Upgrade definitions differ from their journal-bound preparation.");
    if (state.phase === "preparing") {
      state.phase = "prepared";
      await save(dir, state);
    }
  } else if (state.phase === "prepared") {
    // A kill between private state and journal append preceded all active writes.
    state.phase = "preparing";
    await save(dir, state);
  } else if (state.phase !== "preparing")
    throw fail("Upgrade has no authoritative preparation record.");
  state.doctorAttempted = matching("research.setup.upgrade.doctor-started").length > 0;
}
function upgradeFailure(error: unknown, plan: ResearchSetupPlan, phase: string): CliError {
  const code =
    error instanceof CliError && /^[A-Z0-9_]{1,128}$/.test(error.code)
      ? error.code
      : "RESEARCH_SETUP_UPGRADE_INTERRUPTED";
  const planPath = researchSetupUpgradeCandidatePath(plan);
  const legacyMismatch = code === "RESEARCH_SETUP_LEGACY_UPGRADE_RECOVERY_REQUIRED";
  return new CliError(
    "Managed setup upgrade did not complete. Preserve its candidate and use the recorded recovery action.",
    {
      code,
      exitCode: error instanceof CliError ? error.exitCode : 3,
      details: {
        step: "upgrade-" + phase,
        planSha256: plan.planSha256,
        planPath,
        retryCommand: legacyMismatch
          ? null
          : researchSetupApplyCommand({ version: plan.cli.version, planPath }),
        rollbackCommand: legacyMismatch
          ? null
          : exactResearchCliCommand(
              [
                "research",
                "setup",
                "upgrade",
                "--rollback",
                "--candidate",
                planPath,
                "--workspace",
                plan.workspace.path,
                "--json",
              ],
              plan.cli.version,
            ),
        minimumAction: legacyMismatch
          ? "The candidate's hash-bound active plan and runtime lock describe different generations. No active controls were changed. Preserve these exact files and the journal-linked predecessor for verified legacy recovery; repeating apply or rolling back an unstarted transition cannot repair this mismatch. Do not rewrite locks or delete installed trees."
          : phase === "rolling-back"
            ? "Repeat the exact rollback command; do not apply a partly reversed candidate."
            : "Inspect the candidate's staged setup diagnostics, then retry its apply or explicitly roll it back. Do not edit control files.",
      },
    },
  );
}

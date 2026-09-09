import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import { rollbackResearchSetupUpgrade } from "../src/research/workspace/setup-upgrade.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import { packageRoot, packageVersion } from "../src/research/workspace/constants.js";
import {
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SKILLS,
  RESEARCH_SETUP_SOURCES,
} from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  createResearchSetupUpgradePlan,
  inspectResearchSetupStatus,
  loadAndVerifyResearchSetupPlan,
  type ApplyResearchSetupOptions,
  type SetupCommandRunner,
} from "../src/research/workspace/setup.js";
import {
  canonicalJson,
  sha256Text,
  hashRegularTree,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import {
  loadWorkspaceConfig,
  loadWorkspaceMarker,
  requireCurrentRuntimeLock,
} from "../src/research/workspace/workspace.js";

// Two synthetic catalog generations, each installed through the real plan/apply
// factory. Their hashes are computed from actual regular trees, not forged plans.
describe("managed setup upgrade generations", () => {
  it("rejects a same-version CLI whose runtime bytes differ from the reviewed upgrade candidate", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "upgrade-code-binding-")));
    const shadow = await realpath(await mkdtemp(join(tmpdir(), "upgrade-code-shadow-")));
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const candidate = await createResearchSetupUpgradePlan({
        workspace: root,
        acceptedLicenseIds: [],
        confirmUpgrade: true,
      });
      const before = await controlBytes(root);
      for (const name of ["bin", "dist", "package.json"])
        await cp(join(packageRoot(), name), join(shadow, name), { recursive: true });
      await symlink(
        join(packageRoot(), "node_modules"),
        join(shadow, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const changedModule = join(shadow, "dist/research/workspace/constants.js");
      await writeFile(
        changedModule,
        (await readFile(changedModule, "utf8")) +
          "\n// Same version, different reviewed runtime bytes.\n",
      );
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              join(shadow, "bin/tiangong-ai.js"),
              "research",
              "setup",
              "apply",
              "--plan",
              candidatePath(root, candidate.planSha256),
              "--skip-doctor",
              "--json",
            ],
            { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (x) => {
            stdout += x;
          });
          child.stderr.on("data", (x) => {
            stderr += x;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      assert.equal(
        JSON.parse(result.stdout || result.stderr).error?.code,
        "RESEARCH_SETUP_CLI_INTEGRITY_MISMATCH",
        result.stderr || result.stdout,
      );
      assert.deepEqual(await controlBytes(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(shadow, { recursive: true, force: true });
    }
  });

  it(
    "checks an exact candidate through the public CLI without changing the active generation",
    { skip: process.platform === "win32" },
    async () => {
      const f = await fixture("0.0.60");
      const bin = await mkdtemp(join(tmpdir(), "upgrade-registry-bin-"));
      try {
        const candidateVersion = packageVersion();
        const payload = {
          name: "@tiangong-ai/cli",
          version: candidateVersion,
          "dist.integrity": "sha512-" + Buffer.alloc(64, 7).toString("base64"),
          "dist.tarball": `https://registry.npmjs.org/@tiangong-ai/cli/-/cli-${candidateVersion}.tgz`,
          gitHead: "a".repeat(40),
        };
        const invoked = join(bin, "invoked");
        const executable = join(bin, "npm");
        await writeFile(
          executable,
          `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(invoked)},'called\\n');process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`,
        );
        await chmod(executable, 0o700);
        const before = await controlBytes(f.root);
        let stdout = "",
          stderr = "";
        const exitCode = await runCli(
          [
            "research",
            "setup",
            "update",
            "--check",
            "--candidate-version",
            candidateVersion,
            "--workspace",
            f.root,
            "--json",
          ],
          {
            env: { PATH: bin, HOME: bin },
            stdout: {
              write: (text: string) => {
                stdout += text;
              },
            },
            stderr: {
              write: (text: string) => {
                stderr += text;
              },
            },
          },
        );
        assert.equal(exitCode, 0, stderr);
        const result = JSON.parse(stdout);
        assert.equal(result.releaseCandidate.status, "newer");
        assert.equal(result.releaseCandidate.installedVersion, "0.0.60");
        assert.equal(result.releaseCandidate.metadata.gitHead, payload.gitHead);
        assert.match(
          result.candidateUpgradeCommand,
          new RegExp(`@tiangong-ai/cli@${candidateVersion.replaceAll(".", "\\.")}`),
        );
        assert.match(result.candidateUpgradeCommand, /research setup upgrade --plan/u);
        assert.equal(await readFile(invoked, "utf8"), "called\n");
        assert.deepEqual(await controlBytes(f.root), before);
      } finally {
        await f.cleanup();
        await rm(bin, { recursive: true, force: true });
      }
    },
  );

  it("writes an immutable candidate without replacing any active control bytes", async () => {
    const f = await fixture();
    try {
      const before = await controlBytes(f.root);
      const candidate = await f.candidate();
      assert.deepEqual(await controlBytes(f.root), before);
      assert.notEqual(candidate.planSha256, f.prior.planSha256);
      assert.deepEqual(
        JSON.parse(await readFile(candidatePath(f.root, candidate.planSha256), "utf8")),
        candidate,
      );
      const binding = (candidate as unknown as { upgrade: Record<string, unknown> }).upgrade;
      assert.equal(binding.parentPlanSha256, f.prior.planSha256);
      assert.equal(
        binding.parentRuntimeLockSha256,
        await sha256File(workspacePaths(f.root).runtimeLock),
      );
      assert.equal(
        (await loadAndVerifyResearchSetupPlan(candidatePath(f.root, candidate.planSha256)))
          .planSha256,
        candidate.planSha256,
      );
      assert.equal(f.installs.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("migrates a factory-created older runtime lock and retains its version guard", async () => {
    const f = await fixture("0.0.60");
    try {
      const marker = await loadWorkspaceMarker(f.root);
      await assert.rejects(requireCurrentRuntimeLock(f.root), {
        code: "RESEARCH_RUNTIME_VERSION_MISMATCH",
      });
      const candidate = await f.candidate();
      await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
        runner: f.runner,
        skipDoctor: true,
      });
      assert.equal((await requireCurrentRuntimeLock(f.root)).packageVersion, packageVersion());
      assert.equal((await loadWorkspaceMarker(f.root)).workspaceId, marker.workspaceId);
      await withFactoryVersion("0.0.60", () =>
        assert.rejects(requireCurrentRuntimeLock(f.root), {
          code: "RESEARCH_RUNTIME_VERSION_MISMATCH",
        }),
      );
      await rollbackResearchSetupUpgrade(candidatePath(f.root, candidate.planSha256), f.root);
      await withFactoryVersion("0.0.60", async () =>
        assert.equal((await requireCurrentRuntimeLock(f.root)).workspaceId, marker.workspaceId),
      );
    } finally {
      await f.cleanup();
    }
  });

  it("captures the current configured models and pricing instead of stale original plan values", async () => {
    const f = await fixture();
    try {
      const config = await loadWorkspaceConfig(f.root);
      config.reviewer.model = "owner-current-reviewer";
      config.reviewer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(f.root).config, config);
      const candidate = await f.candidate();
      assert.equal(candidate.agentRoutes.reviewerModel, config.reviewer.model);
      assert.deepEqual(candidate.agentRoutes.reviewerPricing, config.reviewer.pricing);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves same-family private launchers and wrapper targets", async () => {
    const f = await fixture();
    try {
      const config = await loadWorkspaceConfig(f.root);
      config.reviewer.binary = join(f.root, "owner-private-reviewer");
      config.reviewer.wrapperTargetBinary = join(f.root, "owner-native-claude");
      config.reviewer.effort = "high";
      await writeJsonAtomic(workspacePaths(f.root).config, config);
      const candidate = await f.candidate();
      await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
        runner: f.runner,
        skipDoctor: true,
      });
      assert.deepEqual((await loadWorkspaceConfig(f.root)).reviewer, config.reviewer);
    } finally {
      await f.cleanup();
    }
  });

  it("reports the exact candidate recovery action while ordinary status is blocked", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate(),
        path = candidatePath(f.root, candidate.planSha256);
      await assert.rejects(
        applyResearchSetupPlan(path, {
          runner: f.runner,
          skipDoctor: true,
          upgradeCheckpoint: async (point) => {
            if (point === `after-tree:${candidate.install.targets[0]!.agent}`)
              throw new Error("interrupt");
          },
        }),
      );
      await assert.rejects(inspectResearchSetupStatus(f.root), (error: unknown) => {
        const e = error as {
          code?: string;
          details?: { planPath?: string; retryCommand?: string };
        };
        assert.equal(e.code, "RESEARCH_SETUP_UPGRADE_PENDING");
        assert.equal(e.details?.planPath, path);
        assert.match(e.details?.retryCommand ?? "", /research setup apply/u);
        assert.doesNotMatch(e.details?.retryCommand ?? "", /setup-upgrades/u);
        return true;
      });
    } finally {
      await f.cleanup();
    }
  });

  it("recovers a genuinely killed commit process using the same prepared bytes", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate(),
        path = candidatePath(f.root, candidate.planSha256);
      await assert.rejects(
        applyResearchSetupPlan(path, {
          runner: f.runner,
          skipDoctor: true,
          upgradeCheckpoint: async (point) => {
            if (point === "prepared") throw new Error("prepared");
          },
        }),
      );
      const checkpoint = `after-tree:${candidate.install.targets[0]!.agent}`;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "test/helpers/setup-upgrade-crash-worker.ts",
          f.root,
          path,
          f.newHash,
          checkpoint,
        ],
        { cwd: packageRoot(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      assert.notEqual(ended.code, 0, stderr);
      assert.equal(await readFile(join(f.root, "crash-checkpoint.txt"), "utf8"), checkpoint);
      await assert.rejects(requireCurrentRuntimeLock(f.root), {
        code: "RESEARCH_SETUP_UPGRADE_PENDING",
      });
      await applyResearchSetupPlan(path, { runner: f.runner, skipDoctor: true });
      assert.equal(f.installs.length, 2);
      for (const target of candidate.install.targets)
        assert.equal(await hashRegularTree(join(target.root, f.skill.skillName)), f.newHash);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves the reviewed transport and reuses unchanged accepted licenses", async () => {
    const f = await fixture();
    try {
      const candidate = await createResearchSetupUpgradePlan({
        workspace: f.root,
        acceptedLicenseIds: [],
        confirmUpgrade: true,
      });
      assert.deepEqual(candidate.reviewerExecution, f.prior.reviewerExecution);
      assert.deepEqual(candidate.acceptedLicenses, f.prior.acceptedLicenses);
      assert.deepEqual(candidate.agentRoutes, f.prior.agentRoutes);
    } finally {
      await f.cleanup();
    }
  });

  it("upgrades both verified prior-owned roots while preserving identity, budget and research files", async () => {
    const f = await fixture();
    try {
      const marker = await readFile(workspacePaths(f.root).marker, "utf8");
      const config = await loadWorkspaceConfig(f.root);
      const candidate = await f.candidate();
      const applied = await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
        runner: f.runner,
        skipDoctor: true,
      });
      assert.equal(applied.plan.planSha256, candidate.planSha256);
      assert.equal(
        applied.state.status,
        "partially-ready",
        "skip-doctor must not certify readiness",
      );
      assert.equal(await readFile(workspacePaths(f.root).marker, "utf8"), marker);
      assert.deepEqual((await loadWorkspaceConfig(f.root)).budget, config.budget);
      assert.deepEqual(
        (await loadWorkspaceConfig(f.root)).reviewerExecution,
        f.prior.reviewerExecution,
      );
      assert.equal((await requireCurrentRuntimeLock(f.root)).packageVersion, packageVersion());
      assert.equal(
        await readFile(join(f.root, "research-notes.txt"), "utf8"),
        "Owner evidence remains unchanged.\n",
      );
      for (const target of candidate.install.targets)
        assert.equal(await hashRegularTree(join(target.root, f.skill.skillName)), f.newHash);
      assert.equal(f.installs.length, 2);
      const repeated = await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
        runner: f.runner,
        skipDoctor: true,
      });
      assert.equal(repeated.state.status, "partially-ready");
      assert.equal(f.installs.length, 2, "committed replay must not fetch or install again");
    } finally {
      await f.cleanup();
    }
  });

  for (const mode of ["modified", "symlink"] as const)
    it(`preserves an unsafe ${mode} destination before any installer call`, async () => {
      const f = await fixture();
      try {
        const candidate = await f.candidate();
        const target = join(f.prior.install.targets[0]!.root, f.skill.skillName);
        if (mode === "modified") await writeFile(join(target, "SKILL.md"), "Owner modification.\n");
        else {
          await rm(target, { recursive: true });
          await symlink(f.source, target, process.platform === "win32" ? "junction" : "dir");
        }
        const before = await controlBytes(f.root);
        await assert.rejects(
          applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
            runner: f.runner,
            skipDoctor: true,
          }),
          { code: "RESEARCH_SETUP_INSTALL_DESTINATION_UNSAFE" },
        );
        assert.deepEqual(await controlBytes(f.root), before);
        assert.equal(f.installs.length, 0);
        if (mode === "modified")
          assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "Owner modification.\n");
      } finally {
        await f.cleanup();
      }
    });

  it("rejects a stale candidate configuration before downloading", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate();
      const config = await loadWorkspaceConfig(f.root);
      config.budget.maxCostUsd = 17;
      await writeJsonAtomic(workspacePaths(f.root).config, config);
      const before = await controlBytes(f.root);
      await assert.rejects(
        applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
          runner: f.runner,
          skipDoctor: true,
        }),
        { code: "RESEARCH_SETUP_UPGRADE_CONFLICT" },
      );
      assert.deepEqual(await controlBytes(f.root), before);
      assert.equal(f.installs.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a rewritten transition even when its local self-hash was recomputed", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate();
      await assert.rejects(
        applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
          runner: f.runner,
          skipDoctor: true,
          upgradeCheckpoint: async (point) => {
            if (point === "prepared") throw new Error("pause prepared candidate");
          },
        }),
      );
      const unchanged = await controlBytes(f.root);
      const dir = join(workspacePaths(f.root).control, "setup-upgrades", candidate.planSha256);
      const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
      const forged = await loadWorkspaceConfig(f.root);
      forged.budget.maxCostUsd = 9999;
      const bytes = JSON.stringify(forged, null, 2) + "\n";
      const hash = sha256Text(bytes);
      await writeFile(join(dir, "objects", hash), bytes);
      state.files.find((file: { key: string }) => file.key === "config").after.sha256 = hash;
      const { stateSha256: _ignored, ...core } = state;
      await writeJsonAtomic(join(dir, "state.json"), {
        ...core,
        stateSha256: sha256Text(canonicalJson(core)),
      });
      await assert.rejects(
        applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
          runner: f.runner,
          skipDoctor: true,
        }),
        { code: "RESEARCH_SETUP_UPGRADE_CONFLICT" },
      );
      assert.deepEqual(await controlBytes(f.root), unchanged);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses rollback before any control write when the owner changed configuration", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate();
      const path = candidatePath(f.root, candidate.planSha256);
      await applyResearchSetupPlan(path, { runner: f.runner, skipDoctor: true });
      const config = await loadWorkspaceConfig(f.root);
      config.budget.maxCostUsd = 17;
      await writeJsonAtomic(workspacePaths(f.root).config, config);
      const before = await controlBytes(f.root);
      await assert.rejects(rollbackResearchSetupUpgrade(path, f.root), {
        code: "RESEARCH_SETUP_UPGRADE_CONFLICT",
      });
      assert.deepEqual(await controlBytes(f.root), before);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps an interrupted rollback closed and resumes it without provider work", async () => {
    const f = await fixture();
    try {
      const before = await controlBytes(f.root);
      const candidate = await f.candidate();
      const path = candidatePath(f.root, candidate.planSha256);
      await applyResearchSetupPlan(path, { runner: f.runner, skipDoctor: true });
      const rollback = rollbackResearchSetupUpgrade as (
        candidate: string,
        root: string,
        options?: { checkpoint: (point: string) => Promise<void> },
      ) => Promise<unknown>;
      let reached = false;
      await assert.rejects(
        rollback(path, f.root, {
          checkpoint: async (point) => {
            if (point === "after-rollback-file:plan") {
              reached = true;
              throw new Error("interrupt rollback");
            }
          },
        }),
      );
      assert.equal(reached, true);
      await assert.rejects(requireCurrentRuntimeLock(f.root), {
        code: "RESEARCH_SETUP_UPGRADE_PENDING",
      });
      await rollbackResearchSetupUpgrade(path, f.root);
      assert.deepEqual(await controlBytes(f.root), before);
      assert.equal(f.installs.length, 2);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps a staged source failure outside the active generation and retries only missing work", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate();
      const before = await controlBytes(f.root);
      let fail = true;
      const runner: SetupCommandRunner = async (input) => {
        if (input.command === "npx" && f.installs.length === 1 && fail) {
          fail = false;
          return { exitCode: 1, stdout: "", stderr: "synthetic installer interruption" };
        }
        return f.runner(input);
      };
      await assert.rejects(
        applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
          runner,
          skipDoctor: true,
        }),
      );
      assert.deepEqual(await controlBytes(f.root), before);
      assert.equal(f.installs.length, 1);
      await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
        runner,
        skipDoctor: true,
      });
      assert.equal(f.installs.length, 2, "the first verified staged target is reused");
    } finally {
      await f.cleanup();
    }
  });

  for (const recovery of ["resume", "rollback"] as const)
    it(`recovers a two-root interrupted commit by explicit ${recovery}`, async () => {
      const f = await fixture();
      try {
        const before = await controlBytes(f.root);
        const candidate = await f.candidate();
        let injected = false;
        const options = {
          runner: f.runner,
          skipDoctor: true,
          upgradeCheckpoint: async (point: string) => {
            if (!injected && point === `after-tree:${candidate.install.targets[0]!.agent}`) {
              injected = true;
              throw new Error("synthetic commit interruption");
            }
          },
        } as ApplyResearchSetupOptions;
        await assert.rejects(
          applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), options),
        );
        assert.equal(injected, true);
        await assert.rejects(requireCurrentRuntimeLock(f.root), {
          code: "RESEARCH_SETUP_UPGRADE_PENDING",
        });
        assert.equal(f.installs.length, 2, "all source work finishes before active replacement");
        if (recovery === "resume") {
          await applyResearchSetupPlan(candidatePath(f.root, candidate.planSha256), {
            runner: f.runner,
            skipDoctor: true,
          });
          for (const target of candidate.install.targets)
            assert.equal(await hashRegularTree(join(target.root, f.skill.skillName)), f.newHash);
        } else {
          let stdout = "",
            stderr = "";
          const exitCode = await runCli(
            [
              "research",
              "setup",
              "upgrade",
              "--rollback",
              "--candidate",
              candidatePath(f.root, candidate.planSha256),
              "--workspace",
              f.root,
              "--json",
            ],
            {
              stdout: {
                write: (x: string) => {
                  stdout += x;
                },
              },
              stderr: {
                write: (x: string) => {
                  stderr += x;
                },
              },
              env: {},
            },
          );
          assert.equal(exitCode, 0, stderr);
          assert.equal(JSON.parse(stdout).status, "rolled-back");
          assert.deepEqual(await controlBytes(f.root), before);
          for (const target of f.prior.install.targets)
            assert.equal(await hashRegularTree(join(target.root, f.skill.skillName)), f.oldHash);
        }
        assert.equal((await inspectResearchContext(f.root)).role, "workspace");
        assert.equal(f.installs.length, 2);
      } finally {
        await f.cleanup();
      }
    });
});

function candidatePath(root: string, hash: string) {
  return join(workspacePaths(root).control, "setup-candidates", `${hash}.json`);
}

async function controlBytes(root: string) {
  const paths = workspacePaths(root);
  const names = [
    paths.marker,
    paths.runtimeLock,
    paths.config,
    paths.setupPlan,
    paths.setupState,
    paths.capabilityDeclarations,
    paths.capabilityLock,
    paths.setupConfig,
    paths.setupReport,
    join(paths.control, "setup-instruction-routing.json"),
    join(root, "AGENTS.md"),
    join(root, ".claude/rules/tiangong-auto-research.md"),
  ];
  return Promise.all(
    names.map(async (path) => [path, await readFile(path, "utf8").catch(() => null)]),
  );
}

async function fixture(priorVersion?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tiangong-upgrade-test-")));
  const skill = RESEARCH_SETUP_SKILLS.find((x) => x.id === "tiangong.auto-research")!;
  const catalogHash = skill.expectedTreeSha256;
  const sourceDef = RESEARCH_SETUP_SOURCES.find((x) => x.id === skill.sourceId)!;
  const sourceRoot = join(
    workspacePaths(root).setupSources,
    `${sourceDef.id}-${sourceDef.immutableRef.slice(0, 12)}`,
  );
  const source = join(sourceRoot, skill.sourceRelativePath);
  const makeTree = async (directory: string, text: string) => {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `Use scripts/research_cli.mjs. ${text}\n`);
    await writeFile(join(directory, "scripts/research_cli.mjs"), `// ${text} fixture resolver\n`);
  };
  try {
    for (const agent of [".agents", ".claude"])
      await makeTree(join(root, agent, "skills", skill.skillName), "Prior");
    const oldHash = await hashRegularTree(join(root, ".agents/skills", skill.skillName));
    skill.expectedTreeSha256 = oldHash;
    const buildPrior = async () => {
      const prior = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        agents: ["codex", "claude-code"],
        acceptedLicenseIds: [skill.license.id],
        confirmNetworkDownloads: true,
        reviewerExecution: { transport: "sandbox-bridge" },
        agentRoutes: {
          producerAgent: "codex",
          reviewerAgent: "claude",
          producerModel: "producer-fixture",
          reviewerModel: "reviewer-fixture",
        },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: async () => {
          throw new Error("prior trees are already installed");
        },
      });
      return prior;
    };
    const prior = priorVersion
      ? await withFactoryVersion(priorVersion, buildPrior)
      : await buildPrior();
    const config = await loadWorkspaceConfig(root);
    config.budget.maxCostUsd = 23;
    await writeJsonAtomic(workspacePaths(root).config, config);
    await writeFile(join(root, "research-notes.txt"), "Owner evidence remains unchanged.\n");
    await makeTree(source, "Candidate");
    await mkdir(join(sourceRoot, ".git"), { recursive: true });
    const newHash = await hashRegularTree(source);
    skill.expectedTreeSha256 = newHash;
    const installs: string[] = [];
    const runner: SetupCommandRunner = async (input) => {
      if (input.command === "git")
        return {
          exitCode: 0,
          stdout: input.args.includes("get-url") ? sourceDef.locator : sourceDef.immutableRef,
          stderr: "",
        };
      if (input.command === "npm")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: RESEARCH_SETUP_INSTALLER.version,
            "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
            gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
          }),
          stderr: "",
        };
      assert.equal(input.command, "npx");
      assert.notEqual(input.cwd, root, "installer must prepare outside active roots");
      const agent = input.args[input.args.indexOf("--agent") + 1]!;
      const destination = join(
        input.cwd,
        agent === "codex" ? ".agents" : ".claude",
        "skills",
        skill.skillName,
      );
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(source, destination, { recursive: true });
      installs.push(agent);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return {
      root,
      skill,
      source,
      oldHash,
      newHash,
      prior,
      installs,
      runner,
      candidate: () =>
        createResearchSetupUpgradePlan({
          workspace: root,
          acceptedLicenseIds: [skill.license.id],
          confirmUpgrade: true,
        }),
      cleanup: async () => {
        skill.expectedTreeSha256 = catalogHash;
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    skill.expectedTreeSha256 = catalogHash;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// This isolates package metadata for a synthetic historical factory. It never
// edits a plan/hash or the repository package.json, and is not a released-binary claim.
async function withFactoryVersion<T>(version: string, action: () => Promise<T>): Promise<T> {
  const original = fs.readFileSync;
  const packagePath = join(packageRoot(), "package.json");
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const value = original(...args);
    if (String(args[0]) !== packagePath) return value;
    const changed = JSON.stringify({ ...JSON.parse(value.toString()), version });
    return typeof value === "string" ? changed : Buffer.from(changed);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
}

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import { packageVersion } from "../src/research/workspace/constants.js";
import {
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SKILLS,
  RESEARCH_SETUP_SOURCES,
} from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  createResearchSetupUpgradePlan,
  loadAndVerifyResearchSetupPlan,
  type ApplyResearchSetupOptions,
  type SetupCommandRunner,
} from "../src/research/workspace/setup.js";
import {
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

  it("keeps a staged source failure outside the active generation and retries only missing work", async () => {
    const f = await fixture();
    try {
      const candidate = await f.candidate();
      const before = await controlBytes(f.root);
      let fail = true;
      const runner: SetupCommandRunner = async (input) => {
        if (input.command === "npx" && input.args.includes("claude-code") && fail) {
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
            if (!injected && point === "after-tree:codex") {
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

async function fixture() {
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

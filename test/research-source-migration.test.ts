import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { verifyCapabilities } from "../src/research/workspace/capabilities.js";
import { configureTiangongSciCapability } from "../src/research/workspace/external-skills.js";
import {
  RESEARCH_SETUP_INSTALLER,
  setupSkill,
  setupSource,
} from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
} from "../src/research/workspace/setup.js";
import { hashRegularTree, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

const legacy = "https://github.com/tiangong-ai/skills.git";
const canonical = "https://github.com/tiangong-ai/agent-skills.git";

describe("research source organization migration", () => {
  it("prepares through the upgrade source-cache path without rewriting a legacy origin", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "source-cache-migration-")));
    const skill = setupSkill("tiangong.kb-sci-search");
    const originalHash = skill.expectedTreeSha256;
    try {
      await initializeResearchWorkspace(root, undefined);
      const source = setupSource(skill.sourceId);
      const oldCheckout = join(
        workspacePaths(root).setupSources,
        `${source.id}-${source.immutableRef.slice(0, 12)}`,
      );
      await mkdir(oldCheckout, { recursive: true });
      await writeFile(join(oldCheckout, "preserve.txt"), "Owner's verified legacy cache\n");
      const fixture = join(root, "fixture-sci");
      await mkdir(fixture);
      await writeFile(
        join(fixture, "SKILL.md"),
        "---\nname: tiangong-kb-sci-search\ndescription: Search SCI evidence.\n---\n",
      );
      skill.expectedTreeSha256 = await hashRegularTree(fixture);
      const stage = join(root, "upgrade-stage");
      await mkdir(stage);
      const plan = await createResearchSetupPlan({
        workspace: stage,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: [skill.license.id],
        confirmNetworkDownloads: true,
        settings: { "tiangong.sci.endpoint": "https://database.example.test/sci" },
        credentialEnvironment: { "tiangong.sci.api-key": "MIGRATION_SCI_API_KEY" },
      });
      const origins = new Map([[oldCheckout, legacy]]);
      const ready = new Set([oldCheckout]);
      const initialized: string[] = [];
      const result = await applyResearchSetupPlan(workspacePaths(stage).setupPlan, {
        sourceCacheWorkspace: root,
        skipDoctor: true,
        environment: { PATH: process.env.PATH, MIGRATION_SCI_API_KEY: "offline-fixture-key" },
        runner: async ({ command, args }) => {
          if (command === "npm") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                version: RESEARCH_SETUP_INSTALLER.version,
                "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
                gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
              }),
              stderr: "",
            };
          }
          if (command === "git" && args[0] === "init") {
            const checkout = args.at(-1)!;
            assert.notEqual(checkout, oldCheckout);
            initialized.push(checkout);
            await mkdir(checkout, { recursive: true });
          } else if (command === "git") {
            const checkout = args[1]!;
            if (args[2] === "remote" && args[3] === "get-url") {
              return { exitCode: 0, stdout: origins.get(checkout) ?? "", stderr: "" };
            }
            if (args[2] === "rev-parse") {
              return {
                exitCode: ready.has(checkout) ? 0 : 1,
                stdout: ready.has(checkout) ? source.immutableRef : "",
                stderr: "",
              };
            }
            assert.notEqual(checkout, oldCheckout, "legacy cache must remain untouched");
            if (args[2] === "remote" && args[3] === "add") {
              assert.equal(args.at(-1), canonical);
              origins.set(checkout, canonical);
            }
            if (args[2] === "checkout") {
              await cp(fixture, join(checkout, skill.sourceRelativePath), { recursive: true });
              ready.add(checkout);
            }
          } else if (command === "npx") {
            await cp(fixture, join(plan.install.targets[0]!.root, skill.skillName), {
              recursive: true,
            });
          } else {
            throw new Error(`Unexpected setup command: ${command}`);
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      assert.ok(result.state.completedSteps.includes("source-checkout"));
      assert.equal(initialized.length, 1);
      assert.equal(origins.get(oldCheckout), legacy);
      assert.equal(
        await readFile(join(oldCheckout, "preserve.txt"), "utf8"),
        "Owner's verified legacy cache\n",
      );
    } finally {
      skill.expectedTreeSha256 = originalHash;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the final repository for new plans without changing the reviewed content pin", () => {
    const source = setupSource("tiangong-ai-skills");
    assert.equal(source.repository, "tiangong-ai/agent-skills");
    assert.equal(source.locator, canonical);
    assert.equal(source.immutableRef, "8516fbb974d35dd930262d4e83b1a21d87369496");
  });

  it("verifies a legacy installed capability and upgrades its source through configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-migration-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(root, "installed", "tiangong-kb-sci-search");
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: tiangong-kb-sci-search\ndescription: Search SCI evidence.\n---\n",
      );
      const expectedTreeSha256 = await hashRegularTree(skillPath);
      const source = {
        type: "git" as const,
        locator: legacy,
        immutableRef: "a".repeat(40),
        expectedTreeSha256,
        license: "MIT",
        catalogId: "first-party.tiangong.kb-sci-search",
      };
      const input = {
        workspace: root,
        skillPath,
        endpoint: "https://database.example.test/sci",
        source,
      };
      await configureTiangongSciCapability(input);
      const paths = workspacePaths(root);
      const legacyDeclarations = await readFile(paths.capabilityDeclarations, "utf8");
      const legacyLock = await readFile(paths.capabilityLock, "utf8");
      assert.equal((await verifyCapabilities(root)).status, "verified");
      assert.equal(await readFile(paths.capabilityLock, "utf8"), legacyLock);
      assert.equal(await readFile(paths.capabilityDeclarations, "utf8"), legacyDeclarations);

      await configureTiangongSciCapability({ ...input, source: { ...source, locator: canonical } });
      assert.equal((await verifyCapabilities(root)).status, "verified");
      const current = JSON.parse(await readFile(paths.capabilityDeclarations, "utf8")) as {
        capabilities: Array<{ source: typeof source; http: { endpoint: string } }>;
      };
      assert.equal(current.capabilities.length, 1);
      assert.equal(current.capabilities[0]?.source.locator, canonical);
      assert.equal(current.capabilities[0]?.source.immutableRef, source.immutableRef);
      assert.equal(current.capabilities[0]?.source.expectedTreeSha256, expectedTreeSha256);
      assert.equal(current.capabilities[0]?.http.endpoint, input.endpoint);
      assert.equal(await hashRegularTree(skillPath), expectedTreeSha256);

      const upgradedLock = await readFile(paths.capabilityLock, "utf8");
      for (const locator of [
        "https://github.com/tiangong-ai-staging/agent-skills.git",
        "https://github.com/acme/agent-skills.git",
        "https://github.com/tiangong-ai/agent-skills.git?ref=main",
        "https://github.com/tiangong-ai/agent-skills.git#main",
        "https://github.com/tiangong-ai/agent-skills.git/extra",
        "https://user@github.com/tiangong-ai/agent-skills.git",
        "https://github.com.evil.test/tiangong-ai/agent-skills.git",
      ]) {
        await assert.rejects(
          configureTiangongSciCapability({ ...input, source: { ...source, locator } }),
          /source identity is not the reviewed first-party catalog entry/,
        );
        assert.equal(await readFile(paths.capabilityLock, "utf8"), upgradedLock);
      }
      await writeFile(join(skillPath, "SKILL.md"), "tampered installed content\n");
      await assert.rejects(
        configureTiangongSciCapability({ ...input, source: { ...source, locator: canonical } }),
        /drift|verified|bytes differ/i,
      );
      assert.equal(await readFile(paths.capabilityLock, "utf8"), upgradedLock);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { verifyCapabilities } from "../src/research/workspace/capabilities.js";
import { configureTiangongSciCapability } from "../src/research/workspace/external-skills.js";
import { setupSource } from "../src/research/workspace/setup-catalog.js";
import { hashRegularTree, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

const legacy = "https://github.com/tiangong-ai/skills.git";
const canonical = "https://github.com/tiangong-ai/agent-skills.git";

describe("research source organization migration", () => {
  it("uses the final repository for new plans without changing the reviewed content pin", () => {
    const source = setupSource("tiangong-ai-skills");
    assert.equal(source.repository, "tiangong-ai/agent-skills");
    assert.equal(source.locator, canonical);
    assert.equal(source.immutableRef, "c5f8fe3ff43313f69b8deb4d970261c4013c5310");
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

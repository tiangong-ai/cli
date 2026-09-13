import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import {
  lockCapabilities,
  stageLockedCapabilities,
} from "../src/research/workspace/capabilities.js";
import {
  configureExternalSkillProfile,
  configureTiangongDatabaseCapability,
  configureTiangongSciCapability,
  doctorExternalCapabilities,
  importExternalCapability,
  inspectExternalSkillCatalog,
} from "../src/research/workspace/external-skills.js";
import { hashRegularTree, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("external research Skill catalog", () => {
  it("lists only pinned external recommendations with per-Skill setup and explicit status", async () => {
    const root = await temporaryDirectory();
    const skillRoot = join(root, "installed-skills");
    try {
      await mkdir(skillRoot);
      const catalog = await inspectExternalSkillCatalog({
        selectedPath: root,
        skillRoot,
      });
      assert.equal(catalog.policy.implementations, "external-only");
      assert.equal(catalog.policy.runtimeInstall, false);
      assert.equal(catalog.summary.required, 2);
      assert.equal(catalog.summary.enhanced, 1);
      assert.equal(catalog.summary.conditional, 2);
      assert.equal(catalog.summary.evaluated, 11);
      assert.equal(catalog.summary.notSelected, 6);
      assert.equal(catalog.summary.installed, 0);
      assert.equal(catalog.entries.length, 5);
      assert.equal(catalog.evaluatedAlternatives.length, 6);
      assert.ok(catalog.entries.every((entry) => entry.installation.status === "missing"));
      assert.ok(
        catalog.entries.every(
          (entry) =>
            entry.source.repository === "brave/brave-search-skills" &&
            /^[0-9a-f]{40}$/.test(entry.source.immutableRef) &&
            /^[0-9a-f]{64}$/.test(entry.source.expectedTreeSha256) &&
            entry.install.projectPlan.commands.at(-1)?.includes(`--skill ${entry.skillName}`) &&
            entry.install.automaticAtRuntime === false,
        ),
      );
      assert.ok(
        catalog.entries.every(
          (entry) =>
            !entry.source.locator.includes("tiangong-ai/skills") &&
            entry.configuration.discoveryScopes.includes("public-internet"),
        ),
      );
      assert.equal(catalog.credentials[0]?.id, "brave.search.api-key");
      assert.equal(catalog.customExternalCapabilities.supported, true);
      assert.ok(
        catalog.evaluatedAlternatives.every(
          (entry) =>
            entry.recommended === false &&
            entry.installation.status === "missing" &&
            /^[0-9a-f]{64}$/.test(entry.source.expectedTreeSha256) &&
            entry.install.projectPlan.verification.expectedTrees[0]?.sha256 ===
              entry.source.expectedTreeSha256,
        ),
      );
      assert.equal(
        catalog.evaluatedAlternatives.find((entry) => entry.skillName === "local-pois")
          ?.configuration.status,
        "requires-explicit-import",
      );
      assert.equal(
        catalog.evaluatedAlternatives.find((entry) => entry.skillName === "answers")?.configuration
          .status,
        "not-supported",
      );
      assert.match(catalog.installer.projectPlan.commands.at(-1) ?? "", /skills@1\.5\.22/);
      assert.match(
        catalog.installer.allRecommendedProjectPlan.commands.at(-1) ?? "",
        /images-search/,
      );
      assert.match(
        catalog.installer.allRecommendedProjectPlan.commands.at(-1) ?? "",
        /videos-search/,
      );
      assert.ok(
        catalog.installer.projectPlan.commands.some((command) =>
          command.includes("checkout --detach FETCH_HEAD"),
        ),
      );
      assert.ok(
        catalog.installer.projectPlan.commands.some((command) =>
          command.includes("rev-parse HEAD"),
        ),
      );
      assert.equal(
        JSON.stringify(catalog).includes(".git#3e088af66eb61f1c207c22b2be0278ca8744d1d1"),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured actionable error when the pinned profile is not installed", async () => {
    const root = await temporaryDirectory();
    const skillRoot = join(root, "installed-skills");
    try {
      await mkdir(skillRoot);
      await initializeResearchWorkspace(root, undefined);
      const result = await invoke([
        "research",
        "capability",
        "configure",
        "--workspace",
        root,
        "--skill-root",
        skillRoot,
        "--json",
      ]);
      assert.equal(result.exitCode, 3);
      assert.equal(result.stdout, "");
      const payload = JSON.parse(result.stderr) as {
        error: {
          code: string;
          details: {
            status: string;
            installPlan: { commands: string[] };
            remediation: string;
          };
        };
      };
      assert.equal(payload.error.code, "RESEARCH_EXTERNAL_SKILL_NOT_READY");
      assert.equal(payload.error.details.status, "missing");
      assert.match(payload.error.details.installPlan.commands.at(-1) ?? "", /skills@1\.5\.22/);
      assert.match(payload.error.details.remediation, /outside the research runtime/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("external database capability admission and doctor", () => {
  it("stages the exact configured Tiangong SCI endpoint for broker discovery", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(root, "installed-skills", "tiangong-kb-sci-search");
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: tiangong-kb-sci-search\ndescription: Search SCI evidence.\n---\n",
      );
      const expectedTreeSha256 = await hashRegularTree(skillPath);
      const endpoint = "https://database.example.test/functions/v1/sci_search";
      await configureTiangongSciCapability({
        workspace: root,
        skillPath,
        endpoint,
        region: "test-region",
        source: {
          type: "git",
          locator: "https://github.com/tiangong-ai/skills.git",
          immutableRef: "a".repeat(40),
          expectedTreeSha256,
          license: "MIT",
          catalogId: "first-party.tiangong.kb-sci-search",
        },
      });
      const declarations = JSON.parse(
        await readFile(workspacePaths(root).capabilityDeclarations, "utf8"),
      ) as { capabilities: Array<{ id: string; http: { endpoint: string } }> };
      assert.equal(declarations.capabilities[0]?.http.endpoint, endpoint);

      const staged = join(root, "staged-capabilities");
      await stageLockedCapabilities(root, staged);
      const manifest = JSON.parse(await readFile(join(staged, "manifest.json"), "utf8")) as {
        capabilities: Array<{ id: string; http: { endpoint: string } }>;
      };
      assert.equal(manifest.capabilities[0]?.http.endpoint, endpoint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("configures report and patent as distinct locked database capabilities", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      for (const fixture of [
        {
          kind: "report" as const,
          skillName: "tiangong-kb-report-search",
          endpoint: "https://database.example.test/functions/v1/report_search",
          catalogId: "first-party.tiangong.kb-report-search",
        },
        {
          kind: "patent" as const,
          skillName: "tiangong-kb-patent-search",
          endpoint: "https://database.example.test/functions/v1/patent_search",
          catalogId: "first-party.tiangong.kb-patent-search",
        },
      ]) {
        const skillPath = join(root, "installed-skills", fixture.skillName);
        await mkdir(skillPath, { recursive: true });
        await writeFile(
          join(skillPath, "SKILL.md"),
          `---\nname: ${fixture.skillName}\ndescription: Fixture.\n---\n`,
        );
        await configureTiangongDatabaseCapability({
          kind: fixture.kind,
          workspace: root,
          skillPath,
          endpoint: fixture.endpoint,
          source: {
            type: "git",
            locator: "https://github.com/tiangong-ai/skills.git",
            immutableRef: "b".repeat(40),
            expectedTreeSha256: await hashRegularTree(skillPath),
            license: "MIT",
            catalogId: fixture.catalogId,
          },
        });
      }
      const declarations = JSON.parse(
        await readFile(workspacePaths(root).capabilityDeclarations, "utf8"),
      ) as {
        capabilities: Array<{
          id: string;
          coverage: { sourceTypes: string[]; discoveryScopes: string[] };
          credentials: Array<{ id: string }>;
        }>;
      };
      assert.deepEqual(declarations.capabilities.map((capability) => capability.id).sort(), [
        "database.tiangong.patent-search",
        "database.tiangong.report-search",
      ]);
      const report = declarations.capabilities.find(
        (capability) => capability.id === "database.tiangong.report-search",
      );
      assert.deepEqual(report?.coverage.sourceTypes, [
        "industry-report",
        "policy-report",
        "whitepaper",
      ]);
      assert.deepEqual(report?.coverage.discoveryScopes, ["database:tiangong-report"]);
      assert.deepEqual(
        report?.credentials.map((credential) => credential.id),
        ["tiangong.report.api-key"],
      );
      const patent = declarations.capabilities.find(
        (capability) => capability.id === "database.tiangong.patent-search",
      );
      assert.deepEqual(patent?.coverage.sourceTypes, ["patent"]);
      assert.deepEqual(patent?.coverage.discoveryScopes, ["database:tiangong-patent"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured error for an unreadable capability definition", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = join(root, "invalid-capability.json");
      await writeFile(definitionPath, '{"id":"incomplete"');
      const result = await invoke([
        "research",
        "capability",
        "import",
        "--definition",
        definitionPath,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      const payload = JSON.parse(result.stderr) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "RESEARCH_CAPABILITY_IMPORT_INVALID");
      assert.match(payload.error.message, /invalid JSON/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("locks a custom external Skill, checks its credentialed provider, and stages a safe manifest", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      const imported = await importExternalCapability({ workspace: root, definitionPath });
      assert.equal(imported.imported.id, "database.acme.search");
      assert.match(imported.imported.sourceLocatorSha256, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(imported).includes("github.com/acme"), false);

      const fakeSecret = "fixture-owner-secret-value";
      const configuredCredential = await invoke(
        [
          "research",
          "capability",
          "credential",
          "set",
          "--id",
          "database.acme.api-key",
          "--from-env",
          "ACME_DATABASE_API_KEY",
          "--workspace",
          root,
          "--json",
        ],
        { ACME_DATABASE_API_KEY: fakeSecret },
      );
      assert.equal(configuredCredential.exitCode, 0, configuredCredential.stderr);
      assert.equal(configuredCredential.stdout.includes(fakeSecret), false);
      assert.equal(configuredCredential.stderr.includes(fakeSecret), false);
      assert.equal(
        (await readFile(workspacePaths(root).journal, "utf8")).includes(fakeSecret),
        false,
      );

      let observedHeader = "";
      let observedTarget = "";
      let probeAttempts = 0;
      const retrySleeps: number[] = [];
      const doctor = await doctorExternalCapabilities(root, {
        live: true,
        sleeper: async (milliseconds) => void retrySleeps.push(milliseconds),
        fetcher: async (input, init) => {
          probeAttempts += 1;
          observedTarget = String(input);
          observedHeader = new Headers(init?.headers).get("authorization") ?? "";
          if (probeAttempts === 1) {
            return new Response('{"status":"rate-limited"}', {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "2" },
            });
          }
          return new Response('{"status":"ok"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(doctor.status, "ready", JSON.stringify(doctor));
      assert.equal(observedTarget, "https://database.example.test/health?query=connectivity");
      assert.equal(observedHeader, `Bearer ${fakeSecret}`);
      assert.equal(probeAttempts, 2);
      assert.deepEqual(retrySleeps, [2_000]);
      assert.equal(doctor.capabilities[0]?.health.status, "pass");
      assert.equal(doctor.capabilities[0]?.health.host, "database.example.test");
      assert.match(doctor.capabilities[0]?.health.targetSha256 ?? "", /^[0-9a-f]{64}$/);
      const serializedDoctor = JSON.stringify(doctor);
      assert.equal(serializedDoctor.includes(fakeSecret), false);
      assert.equal(serializedDoctor.includes(observedTarget), false);

      const staged = join(root, "staged");
      await stageLockedCapabilities(root, staged);
      const manifest = JSON.parse(await readFile(join(staged, "manifest.json"), "utf8")) as {
        capabilities: Array<Record<string, unknown>>;
      };
      assert.equal(manifest.capabilities.length, 1);
      assert.equal(manifest.capabilities[0]?.id, "database.acme.search");
      assert.equal(manifest.capabilities[0]?.requiredForDiscovery, true);
      assert.deepEqual(
        (manifest.capabilities[0]?.coverage as { discoveryScopes: string[] }).discoveryScopes,
        ["database:acme"],
      );
      const serializedManifest = JSON.stringify(manifest);
      assert.equal(serializedManifest.includes(fakeSecret), false);
      assert.equal(serializedManifest.includes("github.com/acme"), false);

      const catalog = await inspectExternalSkillCatalog({
        selectedPath: root,
        workspace: root,
        skillRoot: skillParent,
      });
      const configured = catalog.workspaceCapabilities.find(
        (capability) => capability.id === "database.acme.search",
      );
      assert.equal(configured?.externalSource, true);
      assert.equal(configured?.status.credential, "configured");
      assert.equal(JSON.stringify(configured).includes("github.com/acme"), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("auto-selects one declared credential and defaults credentialed broker calls to bypass", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      await importExternalCapability({ workspace: root, definitionPath });
      const fakeSecret = "fixture-owner-secret-value";
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.acme.api-key":"${fakeSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);
      let observedAuthorization = "";
      let providerCalls = 0;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://database.example.test/")) {
          return originalFetch(input, init);
        }
        providerCalls += 1;
        observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response('{"records":[{"id":"evidence-1"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const capsuleProject = join(root, ".tiangong-research", "runtime", "broker", "project");
      await mkdir(capsuleProject, { recursive: true });
      const broker = await startCapabilityBroker(root, "credential-broker", capsuleProject);
      assert.ok(broker);
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.acme.search",
            url: "https://database.example.test/search?q=evidence",
          },
        });
        const result = response.result as Record<string, unknown>;
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const receipt = JSON.parse(
          String(((result.content as Array<Record<string, unknown>>)[0] ?? {}).text),
        ) as Record<string, unknown>;
        assert.equal(receipt.credentialId, "database.acme.api-key");
        assert.equal(receipt.cacheHit, false);
        assert.deepEqual(receipt.boundedContext, {
          encoding: "utf8",
          text: '[{"id":"evidence-1"}]\n',
        });
        assert.equal(
          (
            receipt.candidates as Array<{
              origin: { jsonPointer: string };
            }>
          )[0]?.origin.jsonPointer,
          "/records/0",
        );
        assert.equal(observedAuthorization, `Bearer ${fakeSecret}`);
        assert.equal(providerCalls, 1);

        const rejected = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.acme.search",
            url: "https://database.example.test/search?q=evidence",
            cache_mode: "prefer",
          },
        });
        assert.equal((rejected.result as Record<string, unknown>).isError, true);
        assert.equal(providerCalls, 1);
        const journal = await readFile(workspacePaths(root).journal, "utf8");
        assert.match(journal, /capability\.fetch\.completed/);
        assert.equal(journal.includes(fakeSecret), false);
      } finally {
        await broker.stop();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("distinguishes missing broker credentials from provider authentication failure", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    const fakeSecret = "fixture-broker-auth-secret";
    let providerCalls = 0;
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      await importExternalCapability({ workspace: root, definitionPath });
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://database.example.test/")) {
          return originalFetch(input, init);
        }
        providerCalls += 1;
        return new Response('{"error":"credential rejected"}', {
          status: 401,
          headers: { "content-type": "application/json", "x-request-id": "safe-request-1" },
        });
      };
      const capsuleProject = join(root, ".tiangong-research", "runtime", "diagnostic", "project");
      await mkdir(capsuleProject, { recursive: true });

      const missingBroker = await startCapabilityBroker(root, "missing-credential", capsuleProject);
      assert.ok(missingBroker);
      try {
        const response = await rpc(missingBroker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.acme.search",
            url: "https://database.example.test/search?q=evidence",
          },
        });
        const text = String(
          (
            (
              (response.result as Record<string, unknown>).content as Array<Record<string, unknown>>
            )[0] ?? {}
          ).text ?? "",
        );
        const diagnostic = JSON.parse(text) as {
          code: string;
          details: Record<string, unknown>;
        };
        assert.equal(diagnostic.code, "BROKER_CREDENTIAL_NOT_CONFIGURED");
        assert.equal(diagnostic.details.executionMode, "broker");
        assert.equal(diagnostic.details.credentialScope, "broker");
        assert.equal(diagnostic.details.networkAttempted, false);
        assert.equal(providerCalls, 0);
      } finally {
        await missingBroker.stop();
      }

      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.acme.api-key":"${fakeSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);
      const rejectedBroker = await startCapabilityBroker(
        root,
        "rejected-credential",
        capsuleProject,
      );
      assert.ok(rejectedBroker);
      try {
        const response = await rpc(rejectedBroker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.acme.search",
            url: "https://database.example.test/search?q=evidence",
          },
        });
        const text = String(
          (
            (
              (response.result as Record<string, unknown>).content as Array<Record<string, unknown>>
            )[0] ?? {}
          ).text ?? "",
        );
        const diagnostic = JSON.parse(text) as {
          code: string;
          details: Record<string, unknown>;
        };
        assert.equal(diagnostic.code, "PROVIDER_AUTHENTICATION_FAILED");
        assert.equal(diagnostic.details.networkAttempted, true);
        assert.equal(diagnostic.details.status, 401);
        assert.equal(providerCalls, 1);
        assert.equal(text.includes(fakeSecret), false);
        assert.equal(text.includes("credential rejected"), false);
      } finally {
        await rejectedBroker.stop();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports authentication and rate-limit failures without leaking credentials or targets", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      await importExternalCapability({ workspace: root, definitionPath });
      const fakeSecret = "fixture-owner-secret-value";
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.acme.api-key":"${fakeSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);

      for (const [status, code] of [
        [401, "PROVIDER_AUTHENTICATION_FAILED"],
        [429, "PROVIDER_RATE_LIMITED"],
      ] as const) {
        const doctor = await doctorExternalCapabilities(root, {
          live: true,
          sleeper: async () => undefined,
          fetcher: async () =>
            new Response(`token=${fakeSecret}`, {
              status,
              headers: {
                "content-type": "application/json",
                "retry-after": "7",
                authorization: `Bearer ${fakeSecret}`,
              },
            }),
        });
        assert.equal(doctor.status, "blocked");
        assert.equal(doctor.capabilities[0]?.health.code, code);
        assert.equal(doctor.capabilities[0]?.health.retryAfterSeconds, 7);
        assert.equal(doctor.capabilities[0]?.health.executionMode, "broker");
        assert.equal(doctor.capabilities[0]?.health.credentialScope, "broker");
        assert.equal(doctor.capabilities[0]?.health.networkAttempted, true);
        assert.equal(JSON.stringify(doctor).includes(fakeSecret), false);
        assert.equal(JSON.stringify(doctor).includes("query=connectivity"), false);
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("retains bounded sanitized provider diagnostics for an unsupported subscription option", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const fakeSecret = "fixture-owner-secret-value";
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      await importExternalCapability({ workspace: root, definitionPath });
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.acme.api-key":"${fakeSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);

      const doctor = await doctorExternalCapabilities(root, {
        live: true,
        fetcher: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "OPTION_NOT_IN_PLAN",
                detail: `The option is not subscribed; api_key=${fakeSecret}`,
                id: "req_safe-123",
                authorization: `Bearer ${fakeSecret}`,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      });

      assert.equal(doctor.status, "blocked");
      const health = doctor.capabilities[0]?.health;
      assert.equal(health?.code, "request-rejected");
      assert.equal(health?.providerCode, "OPTION_NOT_IN_PLAN");
      assert.equal(health?.providerRequestId, "req_safe-123");
      assert.match(health?.detail ?? "", /option is not subscribed/i);
      assert.match(health?.minimumAction ?? "", /baseline|subscription/i);
      const serialized = JSON.stringify(doctor);
      assert.equal(serialized.includes(fakeSecret), false);
      assert.equal(serialized.includes("Bearer"), false);
      assert.equal(serialized.includes("query=connectivity"), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("binds source identity to the installed tree and never blesses existing drift", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      const definition = JSON.parse(await readFile(definitionPath, "utf8")) as Record<
        string,
        unknown
      >;
      const source = definition.source as Record<string, unknown>;
      const expectedTreeSha256 = source.expectedTreeSha256;
      source.expectedTreeSha256 = "0".repeat(64);
      await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
      await assert.rejects(
        importExternalCapability({ workspace: root, definitionPath }),
        /source tree hash does not match installed bytes/i,
      );

      source.expectedTreeSha256 = expectedTreeSha256;
      await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
      await importExternalCapability({ workspace: root, definitionPath });
      const lockBeforeDrift = await readFile(workspacePaths(root).capabilityLock, "utf8");
      const skillPath = definition.skillPath as string;
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: acme-database-search\ndescription: Mutated after locking.\n---\n\n# Mutated\n",
      );

      await assert.rejects(lockCapabilities(root), /source tree hash does not match/i);
      assert.equal(await readFile(workspacePaths(root).capabilityLock, "utf8"), lockBeforeDrift);

      definition.id = "database.acme.secondary";
      source.expectedTreeSha256 = await hashRegularTree(skillPath);
      await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
      await assert.rejects(
        importExternalCapability({ workspace: root, definitionPath }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "RESEARCH_CAPABILITY_DRIFT",
      );
      await assert.rejects(
        configureExternalSkillProfile({
          workspace: root,
          profile: "internet-research",
          skillRoot: join(root, "not-installed"),
        }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "RESEARCH_CAPABILITY_DRIFT",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects internal sources, sensitive health URLs, and symlinked credential files", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const definitionPath = await writeDatabaseCapability(root, skillParent);
      const definition = JSON.parse(await readFile(definitionPath, "utf8")) as Record<
        string,
        unknown
      >;
      const source = definition.source as Record<string, unknown>;
      for (const locator of [
        "https://github.com/tiangong-ai/skills.git?ref=external-looking",
        "https://github.com/tiangong-ai/agent-skills.git?ref=external-looking",
      ]) {
        source.locator = locator;
        await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
        await assert.rejects(
          importExternalCapability({ workspace: root, definitionPath }),
          /external Skill source/,
        );
      }

      source.locator = "https://github.com/acme/database-search-skill.git";
      const healthCheck = definition.healthCheck as Record<string, unknown>;
      healthCheck.url = "https://database.example.test/health?api_key=must-not-appear";
      await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
      await assert.rejects(
        importExternalCapability({ workspace: root, definitionPath }),
        /sensitive query parameters/,
      );

      healthCheck.url = "https://database.example.test/health?query=connectivity";
      await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
      await importExternalCapability({ workspace: root, definitionPath });
      const realEnvironment = join(root, "credential-source.env");
      await writeFile(
        realEnvironment,
        'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.acme.api-key":"fixture-owner-secret-value"}\n',
        { mode: 0o600 },
      );
      await symlink(realEnvironment, workspacePaths(root).env);
      const doctor = await doctorExternalCapabilities(root);
      assert.equal(doctor.status, "blocked");
      assert.match(doctor.credentialEnvironment.detail, /non-symlink/i);
      assert.equal(JSON.stringify(doctor).includes("fixture-owner-secret-value"), false);

      const catalog = await inspectExternalSkillCatalog({
        selectedPath: root,
        workspace: root,
        skillRoot: skillParent,
      });
      assert.equal(catalog.credentialEnvironment?.status, "blocked");
      assert.match(catalog.credentialEnvironment?.detail ?? "", /non-symlink/i);
      assert.equal(catalog.workspaceCapabilities[0]?.status.credential, "blocked");
      assert.equal(JSON.stringify(catalog).includes("fixture-owner-secret-value"), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

async function writeDatabaseCapability(root: string, skillParent: string): Promise<string> {
  const skillPath = join(skillParent, "acme-database-search");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: acme-database-search\ndescription: Search the owner-authorized ACME evidence database.\n---\n\n# ACME database search\n",
  );
  const expectedTreeSha256 = await hashRegularTree(skillPath);
  const definitionPath = join(root, "external-database-capability.json");
  await writeFile(
    definitionPath,
    `${JSON.stringify(
      {
        id: "database.acme.search",
        skillPath,
        source: {
          type: "git",
          locator: "https://github.com/acme/database-search-skill.git",
          immutableRef: "b".repeat(40),
          expectedTreeSha256,
          license: "MIT",
          catalogId: null,
        },
        requiredForDiscovery: true,
        permissions: ["project-read", "candidate-write", "brokered-network"],
        allowedHosts: ["database.example.test"],
        http: {
          endpoint: "https://database.example.test/",
          accept: "application/json",
          allowedContentTypes: ["application/json"],
          maxResponseBytes: 262_144,
          maxItems: 100,
        },
        coverage: {
          dimensions: ["*"],
          sourceTypes: ["*"],
          discoveryScopes: ["database:acme"],
          fullText: true,
          publicationDates: true,
        },
        credentials: [
          {
            id: "database.acme.api-key",
            allowedHosts: ["database.example.test"],
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        ],
        healthCheck: {
          url: "https://database.example.test/health?query=connectivity",
          credentialId: "database.acme.api-key",
          expectedContentTypes: ["application/json"],
        },
      },
      null,
      2,
    )}\n`,
  );
  return definitionPath;
}

async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env,
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-external-skills-test-"));
}

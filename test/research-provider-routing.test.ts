import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { CliError } from "../src/errors.js";
import {
  executeAgent,
  fingerprintAgentRoute,
  sameRuntimeFingerprint,
} from "../src/research/workspace/executor.js";
import { inspectReviewerStatus } from "../src/research/workspace/review-executor.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";
import { workspacePaths, writeJsonAtomic } from "../src/research/workspace/storage.js";
import { researchPlatformCapabilities } from "../src/research/workspace/platform-capabilities.js";
import { schemaForStage } from "../src/research/workspace/schemas.js";

it(
  "binds effective Claude model mappings and endpoint precedence without exposing private values",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-routing-config-"));
    try {
      const config = join(root, "config");
      await mkdir(config);
      const binary = join(root, "fake-claude");
      await writeFile(binary, '#!/bin/sh\necho "fake-claude 1.0"\n');
      await chmod(binary, 0o755);
      const settings = join(config, "settings.json");
      const writeSettings = async (host: string, model: string) =>
        writeFile(
          settings,
          JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: host,
              ANTHROPIC_DEFAULT_SONNET_MODEL: model,
              ANTHROPIC_API_KEY: "synthetic-settings-key",
            },
          }),
          { mode: 0o600 },
        );
      await writeSettings(
        "https://custom.example.test/private?token=synthetic-query",
        "mapped-model-a",
      );
      const route = { agent: "claude" as const, binary, model: "sonnet" };
      const environment = { CLAUDE_CONFIG_DIR: config, PATH: process.env.PATH };
      const first = await fingerprintAgentRoute(route, environment);
      assert.equal(first.providerRouting?.endpointOrigin, "https://custom.example.test");
      assert.equal(first.providerRouting?.endpointSource, "claude-settings-env");
      assert.equal(first.providerRouting?.identityVerification, "unverified");
      assert.equal(
        first.providerRouting?.modelMappingSources.ANTHROPIC_DEFAULT_SONNET_MODEL,
        "claude-settings-env",
      );
      assert.doesNotMatch(
        JSON.stringify(first),
        /synthetic-settings-key|synthetic-query|\/private|mapped-model-a/,
      );
      await writeSettings(
        "https://custom.example.test/private?token=synthetic-query",
        "mapped-model-b",
      );
      const changed = await fingerprintAgentRoute(route, environment);
      assert.equal(changed.binarySha256, first.binarySha256);
      assert.notEqual(
        changed.providerRouting?.configurationSha256,
        first.providerRouting?.configurationSha256,
      );
      const explicit = {
        ...environment,
        ANTHROPIC_BASE_URL: "https://chosen.example.test",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "chosen-model",
      };
      const override = await fingerprintAgentRoute(route, explicit);
      await writeSettings("https://ignored.example.test", "ignored-model");
      assert.deepEqual(await fingerprintAgentRoute(route, explicit), override);
      assert.equal(override.providerRouting?.endpointOrigin, "https://chosen.example.test");
      assert.equal(override.providerRouting?.endpointSource, "process-environment");
      assert.equal(
        override.providerRouting?.modelMappingSources.ANTHROPIC_DEFAULT_SONNET_MODEL,
        "process-environment",
      );
      await writeSettings("https://chosen.example.test", "chosen-model");
      const movedSource = await fingerprintAgentRoute(route, environment);
      assert.equal(sameRuntimeFingerprint(movedSource, override), true);
      await rm(settings);
      const defaults = await fingerprintAgentRoute(route, environment);
      assert.equal(defaults.providerRouting?.endpointOrigin, null);
      assert.equal(defaults.providerRouting?.endpointSource, "runtime-default");
      assert.equal(defaults.providerRouting?.identityVerification, "unverified");
      await assert.rejects(
        fingerprintAgentRoute(route, {
          ...environment,
          ANTHROPIC_BASE_URL: "https://user:synthetic-password@example.test",
        }),
        /without embedded credentials/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("reports sanitized configured reviewer identity through status and offline doctor without model execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-routing-status-"));
  try {
    await initializeResearchWorkspace(root, "Synthetic routing status");
    const config = await loadWorkspaceConfig(root);
    config.reviewer.agent = "claude";
    config.reviewer.binary = process.execPath;
    config.reviewer.model = "sonnet";
    await writeJsonAtomic(workspacePaths(root).config, config);
    const environment = {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, "empty-config"),
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL: "https://gateway.example.test/private?token=synthetic-routing-token",
    };
    const status = (await inspectReviewerStatus(root, environment)) as {
      runtime: { providerRouting: { endpointOrigin: string; identityVerification: string } };
    };
    assert.equal(status.runtime.providerRouting.endpointOrigin, "https://gateway.example.test");
    assert.equal(status.runtime.providerRouting.identityVerification, "unverified");
    const doctor = await doctorResearchWorkspace(root, {
      environment,
      executor: async () => {
        assert.fail("offline doctor invoked a model");
      },
    });
    const check = doctor.checks.find((item) => item.id === "reviewer-configured-routing");
    assert.equal(check?.status, "pass");
    const description = JSON.parse(check!.detail);
    assert.equal(description.cliFamily, "claude");
    assert.equal(description.configuredModelAlias, "sonnet");
    assert.equal(description.providerRouting.endpointSource, "process-environment");
    assert.doesNotMatch(JSON.stringify({ status, doctor }), /synthetic-routing-token|\/private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it(
  "rejects Claude endpoint drift before sending material with an unchanged executable",
  { skip: !researchPlatformCapabilities().nativeReviewerExecution },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-routing-"));
    try {
      const home = join(root, "source-home");
      const config = join(home, ".claude");
      const projectRoot = join(root, "capsule", "project");
      await mkdir(config, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      const binary = join(root, "fake-claude");
      await writeFile(
        binary,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "fake-claude 1.0"; exit 0; fi',
          "printf invoked > invoked.txt",
          "printf '%s' \"$ANTHROPIC_DEFAULT_SONNET_MODEL\" > model.txt",
          'printf \'%s\\n\' \'{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}\'',
          "",
        ].join("\n"),
      );
      await chmod(binary, 0o755);
      const settings = join(config, "settings.json");
      await writeFile(
        settings,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://first.example.test" } }),
      );
      const route = { agent: "claude" as const, binary, model: "sonnet" };
      const environment = { HOME: home, PATH: process.env.PATH };
      const expectedRuntime = await fingerprintAgentRoute(route, environment);
      await writeFile(
        settings,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://second.example.test/private?token=synthetic-private-token",
          },
        }),
      );
      const request = {
        route,
        environment,
        expectedRuntime,
        prompt: "Synthetic private review material",
        outputSchema: schemaForStage("doctor"),
        requestId: "routing-drift",
        purpose: "primary" as const,
        capsuleRoot: join(root, "capsule"),
        projectRoot,
        workspaceRoot: root,
        timeoutSeconds: 10,
        maxTurns: 1,
        maxOutputTokens: 100,
        maxCostUsd: 1,
        toolPolicy: "none" as const,
        brokerUrl: null,
      };
      await assert.rejects(executeAgent(request), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RESEARCH_EXECUTOR_DRIFT");
        assert.doesNotMatch(JSON.stringify(error.details), /synthetic-private-token|\/private/);
        return true;
      });
      assert.equal(
        await readFile(join(projectRoot, "invoked.txt"), "utf8").catch(() => null),
        null,
      );
      await writeFile(
        settings,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://first.example.test",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "approved-custom-model",
          },
        }),
      );
      await assert.rejects(executeAgent(request), /runtime drifted/);
      const currentRuntime = await fingerprintAgentRoute(route, environment);
      const { providerRouting: omittedRouting, ...legacyRuntime } = currentRuntime;
      assert.ok(omittedRouting);
      await assert.rejects(
        executeAgent({ ...request, expectedRuntime: legacyRuntime }),
        /runtime drifted/,
      );
      assert.equal(
        await readFile(join(projectRoot, "invoked.txt"), "utf8").catch(() => null),
        null,
      );
      const result = await executeAgent({ ...request, expectedRuntime: currentRuntime });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, '{"ok":true}');
      assert.equal(await readFile(join(projectRoot, "model.txt"), "utf8"), "approved-custom-model");
      assert.equal(result.runtime?.providerRouting?.endpointOrigin, "https://first.example.test");
      assert.equal(result.runtime?.providerRouting?.identityVerification, "unverified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { CliError } from "../src/errors.js";
import { executeAgent, fingerprintAgentRoute } from "../src/research/workspace/executor.js";
import { researchPlatformCapabilities } from "../src/research/workspace/platform-capabilities.js";
import { schemaForStage } from "../src/research/workspace/schemas.js";

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
      await assert.rejects(
        executeAgent({
          route,
          environment,
          expectedRuntime,
          prompt: "Synthetic private review material",
          outputSchema: schemaForStage("doctor"),
          requestId: "routing-drift",
          purpose: "primary",
          capsuleRoot: join(root, "capsule"),
          projectRoot,
          workspaceRoot: root,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none",
          brokerUrl: null,
        }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_EXECUTOR_DRIFT");
          assert.doesNotMatch(JSON.stringify(error.details), /synthetic-private-token|\/private/);
          return true;
        },
      );
      assert.equal(
        await readFile(join(projectRoot, "invoked.txt"), "utf8").catch(() => null),
        null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

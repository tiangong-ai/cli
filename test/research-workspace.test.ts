import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runCli } from "../src/cli.js";
import { projectBudgetView } from "../src/research/workspace/project-budget.js";
import { CliError } from "../src/errors.js";
import { lockCapabilities, verifyCapabilities } from "../src/research/workspace/capabilities.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import { executeAgent, fingerprintAgentRoute } from "../src/research/workspace/executor.js";
import { researchPlatformCapabilities } from "../src/research/workspace/platform-capabilities.js";
import {
  readAndVerifyProjectInputPlan,
  renderInputLineContext,
} from "../src/research/workspace/input-plan.js";
import { parseStructuredStageOutput, schemaForStage } from "../src/research/workspace/schemas.js";
import {
  addProjectInput,
  forkProject,
  initializeProject,
  loadProject,
  saveProject,
  setProjectBudget,
  retryProjectPackage,
} from "../src/research/workspace/projects.js";
import { evaluateProjectPreflight } from "../src/research/workspace/preflight.js";
import {
  abortNativeResearchStage,
  prepareNativeResearchStage,
  requestResearchHandoff,
  resolveResearchHandoff,
  runResearchWorkspace as runNativeControlledWorkspace,
  runResearchWorkspaceWithInjectedProducerForTesting as runResearchWorkspace,
  submitNativeResearchStage,
  type PackageExecutor,
} from "../src/research/workspace/runtime.js";
import { recordNativeResearchActivity } from "../src/research/workspace/native-activity.js";
import {
  hashRegularTree,
  regularTreeFiles,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";

describe("research workspace lifecycle", () => {
  it("orders regular tree paths by normalized UTF-8 bytes instead of process collation", async () => {
    const root = await temporaryDirectory();
    try {
      for (const name of ["ä.txt", "a.txt", "中.txt", "Z.txt"]) {
        await writeFile(join(root, name), `${name}\n`);
      }
      assert.deepEqual(
        (await regularTreeFiles(root)).map((path) => basename(path)),
        ["Z.txt", "a.txt", "ä.txt", "中.txt"],
      );
      assert.equal(
        await hashRegularTree(root),
        "8440a5d09a4b3a4187e84a9190108f0f93448cdef197408f3bad1a44fe749f8b",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a read-only JSON destination", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "capabilities.lock.json");
    try {
      await writeJsonAtomic(destination, { revision: 1 }, 0o444);
      await writeJsonAtomic(destination, { revision: 2 }, 0o444);
      assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { revision: 2 });
      if (platform() !== "win32") {
        assert.equal((await lstat(destination)).mode & 0o222, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes one current workspace format and resolves its role", async () => {
    const root = await temporaryDirectory();
    try {
      const before = await inspectResearchContext(root);
      assert.equal(before.role, "unmanaged");
      assert.deepEqual(before.allowedOperations, [
        "research.context.inspect",
        "research.capability.catalog",
        "research.workspace.init",
        "research.setup.catalog",
        "research.setup.plan",
      ]);

      const initialized = await initializeResearchWorkspace(root, "Climate materials study");
      assert.equal(initialized.workspace, root);
      assert.equal(initialized.created.length, 6);
      const paths = workspacePaths(root);
      const marker = JSON.parse(await readFile(paths.marker, "utf8")) as Record<string, unknown>;
      assert.equal(marker.kind, "tiangong-research-workspace");
      assert.equal(marker.name, "Climate materials study");

      const after = await inspectResearchContext(join(root, ".tiangong-research", "projects"));
      assert.equal(after.role, "workspace");
      assert.equal(after.root, root);
      assert.ok(after.allowedOperations.includes("research.run"));

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "ready");
      assert.ok(doctor.checks.every((check) => check.status !== "fail"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a partial state directory as invalid", async () => {
    const root = await temporaryDirectory();
    try {
      await mkdir(join(root, ".tiangong-research"));
      const result = await inspectResearchContext(root);
      assert.equal(result.role, "invalid");
      assert.equal(result.violations[0]?.code, "WORKSPACE_MARKER_MISSING");
      assert.deepEqual(result.allowedOperations, ["research.context.inspect"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported workspace credential keys", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      await writeFile(paths.env, "UNSCOPED_TOKEN=not-a-real-value\n", { mode: 0o600 });
      await chmod(paths.env, 0o600);
      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      assert.equal(
        doctor.checks.find((check) => check.id === "credential-environment")?.status,
        "fail",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects control-directory files as project inputs", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "protected-input", "Evaluate one protected input boundary.");
      const credentialPath = workspacePaths(root).env;
      await writeFile(
        credentialPath,
        'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"source.example.api":"secret-value"}\n',
        { mode: 0o600 },
      );
      await assert.rejects(
        addProjectInput(root, "protected-input", credentialPath, "primary"),
        /cannot come from a research control directory/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks mutation when the workspace runtime version differs", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const lock = JSON.parse(await readFile(paths.runtimeLock, "utf8")) as {
        packageVersion: string;
      };
      lock.packageVersion = "0.0.0";
      await writeFile(paths.runtimeLock, `${JSON.stringify(lock, null, 2)}\n`);

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      assert.equal(doctor.checks.find((check) => check.id === "runtime-lock")?.status, "fail");
      await assert.rejects(
        initializeProject(root, "wrong-runtime", "Evaluate a pinned runtime boundary."),
        /active CLI/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research capability locks", () => {
  it("locks a regular skill tree and detects content drift", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(skillParent, "sample-evidence");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: sample-evidence\ndescription: Gather bounded evidence for a declared question.\n---\n\n# Sample\n",
      );
      await writeFile(join(skillPath, "method.txt"), "stable method\n");
      const declarations = {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.evidence",
            skillPath,
            permissions: ["project-read", "candidate-write"],
            credentials: [],
          },
        ],
      };
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );

      const lock = await lockCapabilities(root);
      assert.equal(lock.capabilities.length, 1);
      assert.match(lock.capabilities[0]!.treeSha256, /^[0-9a-f]{64}$/);
      assert.match(lock.capabilities[0]!.policySha256, /^[0-9a-f]{64}$/);
      assert.equal((await verifyCapabilities(root)).status, "verified");

      declarations.capabilities[0]!.permissions.push("controlled-command");
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      assert.equal((await verifyCapabilities(root)).status, "drifted");
      declarations.capabilities[0]!.permissions.pop();
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      await writeFile(join(skillPath, "method.txt"), "changed method\n");
      const drift = await verifyCapabilities(root);
      assert.equal(drift.status, "drifted");
      assert.match(drift.errors[0] ?? "", /differs/);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("exposes a scoped MCP broker and refuses non-HTTPS targets", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(skillParent, "public-source-fetch");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: public-source-fetch\ndescription: Fetch a bounded public source for an admitted research task.\n---\n\n# Public Source Fetch\n",
      );
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capabilities: [
              {
                id: "method.public-source",
                skillPath,
                permissions: ["project-read", "candidate-write", "brokered-network"],
                allowedHosts: ["example.test"],
                http: {
                  endpoint: "https://example.test/",
                  accept: "application/json",
                  allowedContentTypes: ["application/json"],
                  maxResponseBytes: 64 * 1024,
                  maxItems: 10,
                },
                credentials: [],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await lockCapabilities(root);
      const capsuleProject = join(root, ".tiangong-research", "runtime", "broker-test", "project");
      await mkdir(capsuleProject, { recursive: true });
      const broker = await startCapabilityBroker(root, "broker-test", capsuleProject);
      assert.ok(broker);
      try {
        const listed = await rpc(broker.url, "tools/list", {});
        assert.equal(
          (
            (
              (listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>
            )[0] ?? {}
          ).name,
          "fetch_candidate_source",
        );
        const called = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "http://example.test/source",
          },
        });
        const result = called.result as Record<string, unknown>;
        assert.equal(result.isError, true);
        assert.match(
          String(((result.content as Array<Record<string, unknown>>)[0] ?? {}).text),
          /BROKER_CREDENTIAL_INJECTION_REJECTED/,
        );
        const outsideScope = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://other.test/source",
          },
        });
        assert.match(
          String(
            (
              (
                (outsideScope.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
          /BROKER_CREDENTIAL_INJECTION_REJECTED/,
        );
      } finally {
        await broker.stop();
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("research project execution", () => {
  it(
    "handles Claude structured results and declared errors instead of trusting final text",
    {
      skip: !researchPlatformCapabilities().nativeReviewerExecution,
    },
    async () => {
      const secret = "claude-result-error-boundary-secret";
      for (const message of [
        { type: "result", subtype: "success", is_error: false, structured_output: { ok: true } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Informal summary, not JSON",
          structured_output: { ok: true },
        },
        {
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          result: '{"ok":true}',
          errors: ["x".repeat(990) + secret],
        },
      ]) {
        const capsule = await temporaryDirectory();
        try {
          const projectRoot = join(capsule, "project");
          await mkdir(projectRoot);
          const binary = join(capsule, "fake-claude-result.mjs");
          await writeFile(
            binary,
            `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake-claude-result 1');process.exit(0)}\nprocess.stdout.write(JSON.stringify(${JSON.stringify(message)}));\n`,
          );
          await chmod(binary, 0o755);
          const result = await executeAgent({
            route: { agent: "claude", binary, model: "test-model" },
            prompt: "Return the requested result.",
            outputSchema: schemaForStage("doctor"),
            requestId: "claude-result-shape",
            purpose: "doctor",
            capsuleRoot: capsule,
            projectRoot,
            workspaceRoot: capsule,
            timeoutSeconds: 10,
            maxTurns: 2,
            maxOutputTokens: 100,
            maxCostUsd: 1,
            toolPolicy: "none",
            brokerUrl: null,
            environment: { PATH: process.env.PATH, RESEARCH_API_KEY: secret },
          });
          if (message.is_error) {
            assert.notEqual(
              result.exitCode,
              0,
              "A declared provider error cannot become success through result text",
            );
            assert.match(
              result.telemetry?.providerErrors.join("; ") ?? "",
              /error_max_structured_output_retries/u,
            );
            assert.doesNotMatch(
              JSON.stringify(result),
              /claude-result-error-boundary/u,
              "Sanitize complete provider errors before truncating at a secret boundary",
            );
            assert.ok(
              !result.telemetry?.providerErrors.join("; ").includes(secret.slice(0, 10)),
              "Even the ten-character secret fragment left by premature truncation must be absent",
            );
          } else {
            assert.equal(result.exitCode, 0, result.stderr);
            assert.equal(result.stdout, '{"ok":true}');
          }
        } finally {
          await rm(capsule, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "streams large Codex and Claude prompts over stdin instead of argv",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const largePrompt = `${"x".repeat(500_000)}\nlarge-prompt-stdin-sentinel`;
      for (const agent of ["codex", "claude"] as const) {
        const capsule = await temporaryDirectory();
        try {
          const projectRoot = join(capsule, "project");
          const capturedPrompt = join(capsule, `${agent}-prompt.txt`);
          const binary = join(capsule, `fake-${agent}-stdin`);
          await mkdir(projectRoot);
          await writeFile(
            binary,
            [
              "#!/bin/sh",
              `if [ "$1" = "--version" ]; then printf '%s\\n' "fake-${agent} 1.0"; exit 0; fi`,
              'case "$*" in *"large-prompt-stdin-sentinel"*) exit 92;; esac',
              `cat > ${JSON.stringify(capturedPrompt)}`,
              `grep -q "large-prompt-stdin-sentinel" ${JSON.stringify(capturedPrompt)} || exit 93`,
              ...(agent === "codex"
                ? [
                    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}'`,
                    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}'`,
                  ]
                : [
                    `printf '%s\\n' '{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}'`,
                  ]),
              "",
            ].join("\n"),
          );
          await chmod(binary, 0o755);

          const result = await executeAgent({
            route: { agent, binary, model: "test-model" },
            prompt: largePrompt,
            outputSchema: schemaForStage("doctor"),
            requestId: `${agent}-large-stdin-test`,
            purpose: "doctor",
            capsuleRoot: capsule,
            projectRoot,
            workspaceRoot: capsule,
            timeoutSeconds: 10,
            maxTurns: 1,
            maxOutputTokens: 100,
            maxCostUsd: 1,
            toolPolicy: "none",
            environment: { PATH: process.env.PATH },
            brokerUrl: null,
          });

          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stdout, '{"ok":true}');
          assert.equal(await readFile(capturedPrompt, "utf8"), largePrompt);
        } finally {
          await rm(capsule, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "runs an executor inside the platform capsule and parses accounting",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const credentialPath = join(capsule, ".tiangong-research", ".env");
        await mkdir(join(capsule, ".tiangong-research"));
        await writeFile(credentialPath, "sandbox-secret-value\n", { mode: 0o600 });
        const binary = join(capsule, "fake-codex");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-codex 1.0"; exit 0; fi',
            'case "$*" in *"--dangerously-bypass-approvals-and-sandbox"*"--dangerously-bypass-approvals-and-sandbox"*|*"--sandbox read-only"*)',
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"conflicting isolation flags"}}\'',
            "  exit 0;;",
            "esac",
            'case "$*" in *"--dangerously-bypass-approvals-and-sandbox"*"--disable apps"*"--disable shell_tool"*"--disable unified_exec"*"include_environment_context=false"*\'model_reasoning_effort="minimal"\'*\'model_verbosity="high"\'*) ;; *)',
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"missing isolation flags"}}\'',
            "  exit 0;;",
            "esac",
            'case "$*" in *\'project_root_markers=[".tiangong-research-capsule-root"]\'*) ;; *)',
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"missing capsule root boundary"}}\'',
            "  exit 0;;",
            "esac",
            `if [ "$HOME" != ${JSON.stringify(join(capsule, "home"))} ]; then`,
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"wrong home"}}\'',
            'elif [ ! -f "$PWD/.tiangong-research-capsule-root" ]; then',
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"missing capsule root marker"}}\'',
            'elif ! mkdir -p "$HOME/.codex" || ! : > "$HOME/.codex/state.sqlite"; then',
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"home not writable"}}\'',
            `elif cat ${JSON.stringify(credentialPath)} >/dev/null 2>&1; then`,
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"credential readable"}}\'',
            "else",
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"bounded result"}}\'',
            "fi",
            'printf \'%s\\n\' \'{"type":"error","message":"provider failed at https://example.test/path?token=telemetry-secret-9f4c2a7d Authorization: Bearer telemetry-secret-9f4c2a7d"}\'',
            'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":7,"output_tokens":3}}\'',
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
        const result = await executeAgent({
          route: {
            agent: "codex",
            binary,
            model: null,
            effort: "minimal",
            verbosity: "high",
            pricing: {
              inputUsdPerMillionTokens: 1,
              cachedInputUsdPerMillionTokens: 0.1,
              outputUsdPerMillionTokens: 2,
            },
          },
          prompt: "Perform the bounded task.",
          outputSchema: schemaForStage("doctor"),
          requestId: "executor-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none",
          environment: {
            PATH: process.env.PATH,
            RESEARCH_API_KEY: "telemetry-secret-9f4c2a7d",
          },
          brokerUrl: null,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, "bounded result");
        assert.equal(result.tokens, 13);
        assert.equal(result.inputTokens, 3);
        assert.equal(result.cachedInputTokens, 7);
        assert.equal(result.outputTokens, 3);
        assert.equal(result.costUsd, 0.00001);
        assert.equal(result.runtime?.effort, "minimal");
        assert.equal(result.runtime?.verbosity, "high");
        assert.equal(result.telemetry?.toolCalls, 0);
        assert.equal(result.telemetry?.providerTurns, 1);
        assert.equal(result.telemetry?.eventCounts["item.completed"], 1);
        assert.equal(result.telemetry?.eventCounts.error, 1);
        assert.equal(result.telemetry?.eventCounts["turn.completed"], 1);
        assert.equal(result.telemetry?.providerErrors.length, 1);
        assert.match(result.telemetry?.providerErrors[0] ?? "", /\[REDACTED\]/);
        assert.doesNotMatch(
          JSON.stringify(result.telemetry),
          /telemetry-secret|token=telemetry-secret|Bearer telemetry-secret/,
        );
        assert.match(result.runtime?.binarySha256 ?? "", /^[0-9a-f]{64}$/);
        assert.match(result.runtime?.wrapperSha256 ?? "", /^[0-9a-f]{64}$/);
        assert.match(result.runtime?.adapterSha256 ?? "", /^[0-9a-f]{64}$/);
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it(
    "reserves capture space for explicitly allowed bounded MCP tool context",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const events = join(capsule, "large-codex-events.jsonl");
        const boundedContext = "x".repeat(90 * 1024);
        await writeFile(
          events,
          [
            JSON.stringify({
              type: "item.completed",
              item: { type: "mcp_tool_call", result: { boundedContext } },
            }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: '{"ok":true}' },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 },
            }),
            "",
          ].join("\n"),
        );
        const binary = join(capsule, "fake-codex-large-context");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-codex 1.0"; exit 0; fi',
            `exec /bin/cat ${JSON.stringify(events)}`,
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);

        const result = await executeAgent({
          route: { agent: "codex", binary, model: null },
          prompt: "Use the bounded broker context.",
          outputSchema: schemaForStage("doctor"),
          requestId: "large-tool-context-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxToolContextTokens: 40_000,
          maxCostUsd: 1,
          toolPolicy: "workspace-read",
          environment: { PATH: process.env.PATH },
          brokerUrl: null,
        });

        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, '{"ok":true}');
        assert.equal(result.telemetry?.toolCalls, 1);
        assert.equal(result.telemetry?.itemCounts.mcp_tool_call, 1);
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it(
    "reports an outer-sandbox denial as a structured nested-sandbox error",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const binary = join(capsule, "fake-nested-sandbox-reviewer");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-claude 1.0"; exit 0; fi',
            "printf '%s\\n' 'sandbox-exec: sandbox_apply: Operation not permitted' >&2",
            "exit 71",
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);

        await assert.rejects(
          executeAgent({
            route: { agent: "claude", binary, model: "test-reviewer" },
            prompt: 'Return exactly {"ok":true}.',
            outputSchema: schemaForStage("doctor"),
            requestId: "outer-sandbox-denial-test",
            purpose: "doctor",
            capsuleRoot: capsule,
            projectRoot,
            workspaceRoot: capsule,
            timeoutSeconds: 10,
            maxTurns: 1,
            maxOutputTokens: 100,
            maxCostUsd: 1,
            toolPolicy: "none",
            environment: { PATH: process.env.PATH },
            brokerUrl: null,
          }),
          (error: unknown) => {
            assert.ok(error instanceof CliError);
            assert.equal(error.code, "RESEARCH_NESTED_SANDBOX_UNSUPPORTED");
            assert.match(error.message, /sandboxed IDE|sandbox-bridge/i);
            assert.doesNotMatch(JSON.stringify(error.details), /execution\.sb|credential|token/i);
            return true;
          },
        );
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it(
    "pins a wrapper, its explicit agent target, and the internal adapter independently",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const target = join(capsule, "fake-codex-target");
        const wrapper = join(capsule, "agent-wrapper-posix.sh");
        const targetScript = [
          "#!/bin/sh",
          'if [ -n "${TIANGONG_RESEARCH_AGENT_BINARY:-}" ]; then exit 65; fi',
          'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-codex-target 1.0"; exit 0; fi',
          'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\'',
          'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}\'',
          "",
        ].join("\n");
        await writeFile(target, targetScript);
        await writeFile(
          wrapper,
          [
            "#!/bin/sh",
            "set -eu",
            'case "${TIANGONG_RESEARCH_AGENT_BINARY:-}" in /*) ;; *) exit 64 ;; esac',
            'target="$TIANGONG_RESEARCH_AGENT_BINARY"',
            "unset TIANGONG_RESEARCH_AGENT_BINARY",
            'exec "$target" "$@"',
            "",
          ].join("\n"),
        );
        await chmod(target, 0o755);
        await chmod(wrapper, 0o755);
        const route = {
          agent: "codex" as const,
          binary: wrapper,
          wrapperTargetBinary: target,
          model: "test-model",
          effort: "low" as const,
          verbosity: "low" as const,
        };
        await assert.rejects(
          fingerprintAgentRoute(
            { ...route, wrapperTargetBinary: "codex" },
            {
              PATH: process.env.PATH,
            },
          ),
          /absolute paths/,
        );
        const expectedRuntime = await fingerprintAgentRoute(route, { PATH: process.env.PATH });
        const result = await executeAgent({
          route,
          prompt: 'Return exactly {"ok":true}.',
          outputSchema: schemaForStage("doctor"),
          requestId: "wrapped-executor-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          expectedRuntime,
          toolPolicy: "none",
          environment: { PATH: process.env.PATH },
          brokerUrl: null,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, '{"ok":true}');
        assert.equal(result.runtime?.binarySha256, await sha256File(target));
        assert.equal(result.runtime?.wrapperSha256, await sha256File(wrapper));
        assert.match(result.runtime?.adapterSha256 ?? "", /^[0-9a-f]{64}$/);
        assert.notEqual(result.runtime?.binarySha256, result.runtime?.wrapperSha256);

        await writeFile(target, `${targetScript}# deterministic drift\n`);
        await chmod(target, 0o755);
        await assert.rejects(
          executeAgent({
            route,
            prompt: 'Return exactly {"ok":true}.',
            outputSchema: schemaForStage("doctor"),
            requestId: "wrapped-executor-drift-test",
            purpose: "doctor",
            capsuleRoot: capsule,
            projectRoot,
            workspaceRoot: capsule,
            timeoutSeconds: 10,
            maxTurns: 1,
            maxOutputTokens: 100,
            maxCostUsd: 1,
            expectedRuntime,
            toolPolicy: "none",
            environment: { PATH: process.env.PATH },
            brokerUrl: null,
          }),
          /runtime drifted/,
        );
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it(
    "forwards only the selected agent authentication environment into the capsule",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const binary = join(capsule, "fake-claude");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-claude 1.0"; exit 0; fi',
            "prompt=$(cat)",
            "schema_ok=false",
            'case "$prompt" in',
            '  "Return the doctor result.") case "$*" in *"--json-schema"*) schema_ok=true;; esac;;',
            '  "Repair the result.") case "$*" in *"--json-schema"*) ;; *) schema_ok=true;; esac;;',
            "esac",
            'if [ "$schema_ok" = true ] && [ "$ANTHROPIC_API_KEY" = "anthropic-test-secret-value" ] && [ -z "$OPENAI_API_KEY" ] && [ "$CLAUDE_CODE_TMPDIR" = "$TMPDIR" ] && [ "$CLAUDE_TMPDIR" = "$TMPDIR" ] && [ "$BUN_TMPDIR" = "$TMPDIR" ] && case "$*" in *"--permission-mode default"*"--max-turns 1"*"--effort xhigh"*) true;; *) false;; esac; then',
            '  printf \'%s\\n\' \'{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}\'',
            "else",
            '  printf \'%s\\n\' \'{"result":"{\\"ok\\":false}","usage":{"input_tokens":2,"output_tokens":1}}\'',
            "fi",
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
        const result = await executeAgent({
          route: { agent: "claude", binary, model: "test-model", effort: "xhigh" },
          prompt: "Return the doctor result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "claude-auth-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          environment: {
            PATH: process.env.PATH,
            ANTHROPIC_API_KEY: "anthropic-test-secret-value",
            OPENAI_API_KEY: "openai-test-secret-value",
          },
          brokerUrl: null,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, '{"ok":true}');
        assert.equal(result.runtime?.effort, "xhigh");
        assert.equal(result.runtime?.verbosity, null);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /test-secret-value/);
        const repair = await executeAgent({
          route: { agent: "claude", binary, model: "test-model", effort: "xhigh" },
          prompt: "Repair the result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "claude-repair-test",
          purpose: "repair",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          environment: {
            PATH: process.env.PATH,
            ANTHROPIC_API_KEY: "anthropic-test-secret-value",
          },
          brokerUrl: null,
        });
        assert.equal(repair.exitCode, 0, repair.stderr);
        assert.equal(repair.stdout, '{"ok":true}');
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it(
    "reuses identical capsule authentication for repair and rejects source drift",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      const sourceHome = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        const sourceCodex = join(sourceHome, ".codex");
        await mkdir(projectRoot);
        await mkdir(sourceCodex, { mode: 0o700 });
        const sourceAuth = join(sourceCodex, "auth.json");
        await writeFile(sourceAuth, '{"access_token":"capsule-auth-secret-one"}\n', {
          mode: 0o600,
        });
        const binary = join(capsule, "fake-auth-codex");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-auth-codex 1.0"; exit 0; fi',
            'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\'',
            'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}\'',
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
        const request = {
          route: { agent: "codex" as const, binary, model: "test-model" },
          prompt: "Return the doctor result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "codex-auth-reuse-test",
          purpose: "doctor" as const,
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none" as const,
          environment: { HOME: sourceHome, PATH: process.env.PATH },
          brokerUrl: null,
        };
        const first = await executeAgent(request);
        const destinationAuth = join(capsule, "home", ".codex", "auth.json");
        const copiedSha256 = await sha256File(destinationAuth);
        const repair = await executeAgent({
          ...request,
          requestId: "codex-auth-reuse-repair-test",
          purpose: "repair",
        });
        assert.equal(first.exitCode, 0, first.stderr);
        assert.equal(repair.exitCode, 0, repair.stderr);
        assert.equal(await sha256File(destinationAuth), copiedSha256);

        await writeFile(sourceAuth, '{"access_token":"capsule-auth-secret-two"}\n');
        await assert.rejects(
          executeAgent({ ...request, requestId: "codex-auth-drift-test" }),
          /authentication material changed while the capsule was active/,
        );
        assert.equal(await sha256File(destinationAuth), copiedSha256);
      } finally {
        await Promise.all([
          rm(capsule, { recursive: true, force: true }),
          rm(sourceHome, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it(
    "persists refreshed Claude subscription credentials after reviewer execution",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      const sourceHome = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        const sourceConfig = join(sourceHome, ".claude");
        await mkdir(projectRoot);
        await mkdir(sourceConfig, { mode: 0o700 });
        const sourceAuth = join(sourceConfig, ".credentials.json");
        const originalCredentials =
          '{"claudeAiOauth":{"accessToken":"oauth-access-before","refreshToken":"oauth-refresh-before"}}\n';
        const refreshedCredentials =
          '{"claudeAiOauth":{"accessToken":"oauth-access-after","refreshToken":"oauth-refresh-after"}}\n';
        await writeFile(sourceAuth, originalCredentials, { mode: 0o600 });
        const binary = join(capsule, "fake-refreshing-claude");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-refreshing-claude 1.0"; exit 0; fi',
            "cat >/dev/null",
            `printf '%s\\n' '${refreshedCredentials.trim()}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
            `printf '%s\\n' '{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}'`,
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);

        const result = await executeAgent({
          route: { agent: "claude", binary, model: "test-model" },
          prompt: "Return the doctor result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "claude-oauth-refresh-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none",
          environment: { HOME: sourceHome, PATH: process.env.PATH },
          brokerUrl: null,
        });

        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(await readFile(sourceAuth, "utf8"), refreshedCredentials);
        if (platform() !== "win32") {
          assert.equal((await lstat(sourceAuth)).mode & 0o077, 0);
        }
      } finally {
        await Promise.all([
          rm(capsule, { recursive: true, force: true }),
          rm(sourceHome, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it(
    "refuses to overwrite concurrently changed Claude subscription credentials",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      const sourceHome = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        const sourceConfig = join(sourceHome, ".claude");
        await mkdir(projectRoot);
        await mkdir(sourceConfig, { mode: 0o700 });
        const sourceAuth = join(sourceConfig, ".credentials.json");
        const ownerCredentials =
          '{"claudeAiOauth":{"accessToken":"oauth-owner-concurrent","refreshToken":"oauth-owner-refresh"}}\n';
        const capsuleCredentials =
          '{"claudeAiOauth":{"accessToken":"oauth-capsule-refreshed","refreshToken":"oauth-capsule-refresh"}}\n';
        await writeFile(
          sourceAuth,
          '{"claudeAiOauth":{"accessToken":"oauth-access-before","refreshToken":"oauth-refresh-before"}}\n',
          { mode: 0o600 },
        );
        const marker = join(projectRoot, "claude-started");
        const binary = join(capsule, "fake-concurrent-claude");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-concurrent-claude 1.0"; exit 0; fi',
            "cat >/dev/null",
            "printf '%s\\n' started > claude-started",
            "sleep 1",
            `printf '%s\\n' '${capsuleCredentials.trim()}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
            `printf '%s\\n' '{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}'`,
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);

        const execution = executeAgent({
          route: { agent: "claude", binary, model: "test-model" },
          prompt: "Return the doctor result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "claude-oauth-concurrent-test",
          purpose: "doctor",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none",
          environment: { HOME: sourceHome, PATH: process.env.PATH },
          brokerUrl: null,
        });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (await lstat(marker).catch(() => null)) break;
          await delay(10);
        }
        assert.ok(await lstat(marker).catch(() => null));
        await writeFile(sourceAuth, ownerCredentials, { mode: 0o600 });

        await assert.rejects(
          execution,
          (error: unknown) =>
            error instanceof CliError &&
            error.code === "RESEARCH_EXECUTOR_AUTH_RECONCILIATION_FAILED",
        );
        assert.equal(await readFile(sourceAuth, "utf8"), ownerCredentials);
        assert.equal(
          await readFile(join(capsule, "home", ".claude", ".credentials.json"), "utf8"),
          capsuleCredentials,
        );
      } finally {
        await Promise.all([
          rm(capsule, { recursive: true, force: true }),
          rm(sourceHome, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("retains a package capsule when authentication reconciliation fails", async () => {
    const root = await temporaryDirectory();
    let retainedCapsule = "";
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(root, "auth-reconciliation", "Preserve refreshed reviewer auth.");

      await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          retainedCapsule = request.capsuleRoot;
          throw new CliError("Refreshed authentication requires owner reconciliation.", {
            code: "RESEARCH_EXECUTOR_AUTH_RECONCILIATION_FAILED",
            exitCode: 3,
            details: { retainCapsule: true },
          });
        },
      );

      assert.ok(retainedCapsule);
      assert.equal((await lstat(retainedCapsule)).isDirectory(), true);
      assert.match(
        await readFile(workspacePaths(root).journal, "utf8"),
        /"capsuleDisposition":"retained-auth-reconciliation"/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "extracts only whitelisted Claude settings authentication into the capsule",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const capsule = await temporaryDirectory();
      const sourceHome = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        const sourceConfig = join(sourceHome, ".claude");
        await mkdir(projectRoot);
        await mkdir(sourceConfig);
        const settingsPath = join(sourceConfig, "settings.json");
        await writeFile(
          settingsPath,
          `${JSON.stringify({
            env: {
              ANTHROPIC_API_KEY: "settings-auth-secret-value",
              ANTHROPIC_BASE_URL: "https://gateway.example.test",
              UNADMITTED_VALUE: "must-not-enter-capsule",
            },
            permissions: { additionalDirectories: [sourceHome] },
          })}\n`,
        );
        const binary = join(capsule, "fake-settings-claude");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf \'%s\\n\' "fake-settings-claude 1.0"; exit 0; fi',
            'if [ "$ANTHROPIC_API_KEY" = "settings-auth-secret-value" ] && [ "$ANTHROPIC_BASE_URL" = "https://gateway.example.test" ] && [ -z "$UNADMITTED_VALUE" ] && [ ! -e "$CLAUDE_CONFIG_DIR/settings.json" ]; then',
            '  printf \'%s\\n\' \'{"result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":1}}\'',
            "else",
            '  printf \'%s\\n\' \'{"result":"{\\"ok\\":false}","usage":{"input_tokens":2,"output_tokens":1}}\'',
            "fi",
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
        const request = {
          route: { agent: "claude" as const, binary, model: "test-model", effort: "low" as const },
          prompt: "Return the doctor result.",
          outputSchema: schemaForStage("doctor"),
          requestId: "claude-settings-auth-test",
          purpose: "doctor" as const,
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          environment: { HOME: sourceHome, PATH: process.env.PATH },
          brokerUrl: null,
        };
        await chmod(settingsPath, 0o644);
        await assert.rejects(executeAgent(request), /owner-only/);
        await chmod(settingsPath, 0o600);
        const result = await executeAgent(request);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, '{"ok":true}');
        assert.equal(
          await lstat(join(capsule, "home", ".claude", "settings.json")).catch(() => null),
          null,
        );
        assert.doesNotMatch(
          `${result.stdout}\n${result.stderr}`,
          /settings-auth-secret|must-not-enter-capsule/,
        );
      } finally {
        await Promise.all([
          rm(capsule, { recursive: true, force: true }),
          rm(sourceHome, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("keeps producer reasoning in the native host and launches only the reviewer", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const budgetConfig = await loadWorkspaceConfig(root);
      budgetConfig.reviewer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(root).config, budgetConfig);
      await lockCapabilities(root);
      await initializeProject(root, "native-host", "Evaluate a native-host research flow.");
      const inputPath = join(root, "native-evidence.txt");
      await writeFile(inputPath, "Measured native-host evidence.\n");
      await addProjectInput(root, "native-host", inputPath, "primary");

      let unexpectedProducerCalls = 0;
      const stopped = await runNativeControlledWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async () => {
          unexpectedProducerCalls += 1;
          throw new Error("the control plane must not launch a producer");
        },
      );
      assert.equal(stopped.stopReason, "native-stage-required");
      assert.equal(unexpectedProducerCalls, 0);

      const nativeAgents: string[] = [];
      const nativeExecutor = fakeExecutor(nativeAgents);
      let nativeReservedTokens = 0;
      for (const stage of ["discover", "acquire", "analyze", "synthesize"] as const) {
        const packet = await prepareNativeResearchStage({
          root,
          projectId: "native-host",
          stage,
          hostAgent: "codex",
        });
        assert.match(packet.prompt, /current interactive host session/i);
        assert.match(packet.prompt, /do not launch codex exec/i);
        assert.match(
          packet.prompt,
          /Save only the final schema-conforming JSON object to a new regular file/,
        );
        assert.doesNotMatch(packet.prompt, /Operate only inside this isolated research capsule/);
        assert.doesNotMatch(packet.prompt, /Do not write stage output files directly/);
        if (stage === "acquire") {
          assert.match(packet.prompt, /provisionally admitted sources/);
          assert.match(packet.prompt, /bindDownload/);
          assert.match(packet.prompt, /registerArtifact/);
          assert.doesNotMatch(packet.prompt, /No new evidence acquisition/);
        } else if (stage === "analyze" || stage === "synthesize") {
          assert.match(packet.prompt, /No new evidence acquisition/);
        }
        assert.equal(packet.commands.submit.argv.includes("--confirm-model"), false);
        nativeReservedTokens += packet.limits.reservedPackageTokens;
        if (stage === "discover") {
          assert.ok(packet.discovery);
          assert.ok(packet.commands.registerCandidate);
          assert.ok(packet.commands.recordActivity);
          assert.ok(packet.commands.recordAssessment);
          assert.equal(
            (
              packet.commands.recordAssessment.recordSchema.properties as {
                assessments: { maxItems: number };
              }
            ).assessments.maxItems,
            25,
          );
          assert.equal(packet.discovery.calls.max, 6);
          assert.equal(packet.discovery.calls.hardLimit, 24);
          assert.equal(packet.discovery.recommendedAction, "assess-unassessed-candidates");
          assert.ok(
            packet.limits.reservedPackageTokens < 230_000,
            "compact discovery must reserve its derived budget rather than the package hard ceiling",
          );
          const status = await invoke([
            "research",
            "status",
            "--workspace",
            root,
            "--project",
            "native-host",
            "--json",
          ]);
          assert.equal(status.exitCode, 0, status.stderr);
          const statusValue = JSON.parse(status.stdout) as {
            projects: Array<{
              discovery: { calls: { max: number }; candidates: { unique: number } };
              nativeStage: { status: string };
              snapshot: { status: string };
              recommendedAction: string;
            }>;
          };
          assert.equal(statusValue.projects[0]?.discovery.calls.max, 6);
          assert.equal(statusValue.projects[0]?.discovery.candidates.unique, 1);
          assert.equal(statusValue.projects[0]?.nativeStage.status, "active");
          assert.equal(statusValue.projects[0]?.snapshot.status, "absent");
          assert.match(statusValue.projects[0]?.recommendedAction ?? "", /resume/i);
        } else {
          assert.equal(packet.discovery, null);
          if (stage === "acquire") assert.ok(packet.commands.bindDownload);
        }
        const session = JSON.parse(
          await readFile(
            join(workspacePaths(root).projects, "native-host", "native", "active.json"),
            "utf8",
          ),
        ) as { capsuleRoot: string; capsuleProject: string };
        const execution = await nativeExecutor({
          route: {
            agent: "codex",
            executionMode: "native-host",
            binary: "codex",
            model: packet.expectedModel,
          },
          prompt: packet.prompt,
          outputSchema: packet.outputSchema,
          requestId: packet.sessionId,
          purpose: "primary",
          capsuleRoot: session.capsuleRoot,
          projectRoot: session.capsuleProject,
          workspaceRoot: root,
          timeoutSeconds: packet.limits.maxWallSeconds,
          maxTurns: 1,
          maxOutputTokens: packet.limits.maxOutputTokens,
          maxCostUsd: packet.limits.reservedMaxCostUsd,
          toolPolicy: "none",
          environment: {},
          brokerUrl: null,
        });
        const outputPath = join(root, `${stage}-${packet.sessionId}.json`);
        await writeFile(outputPath, execution.stdout);
        await submitNativeResearchStage({
          root,
          projectId: "native-host",
          sessionId: packet.sessionId,
          outputPath,
          confirmedModel: packet.expectedModel,
        });
      }

      await setProjectBudget(root, "native-host", 50, true);
      const launched: string[] = [];
      const reviewerExecutor = fakeExecutor(launched);
      let reviewCalls = 0;
      const executeReview: PackageExecutor = async (request) => {
        assert.match(request.prompt, /Operate only inside this isolated research capsule/);
        assert.match(request.prompt, /Do not write stage output files directly/);
        assert.match(request.prompt, /Your final response must be only the JSON object/);
        assert.match(request.prompt, /No new evidence acquisition/);
        assert.doesNotMatch(request.prompt, /Save only the final schema-conforming JSON object/);
        assert.equal(request.toolPolicy, "packet-read");
        assert.equal(request.brokerUrl, null);
        const funded = await loadProject(root, "native-host");
        assert.ok(
          funded.budget?.entries.some(
            (entry) => entry.kind === "review" && entry.status === "reserved",
          ),
          "the regular reviewer must be funded durably before execution",
        );
        reviewCalls++;
        return {
          ...(await reviewerExecutor(request)),
          costUsd: reviewCalls === 1 ? 0.02 : 0.03,
          exitCode: reviewCalls === 1 ? 1 : 0,
        };
      };
      const failed = await runNativeControlledWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        executeReview,
      );
      assert.notEqual(failed.status, "complete");
      const failedBudget = projectBudgetView(await loadProject(root, "native-host"), budgetConfig);
      assert.equal(
        failedBudget.accountedEstimateUsd,
        0.02,
        "returned failure usage must settle the reservation",
      );
      assert.equal(failedBudget.outstandingReservationsUsd, 0);
      await retryProjectPackage(root, "native-host", "review");
      const completed = await runNativeControlledWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        executeReview,
      );
      assert.equal(completed.status, "complete", JSON.stringify(completed));
      assert.deepEqual(nativeAgents, ["codex", "codex", "codex", "codex"]);
      assert.deepEqual(launched, ["claude", "claude"]);
      const project = await loadProject(root, "native-host");
      assert.equal(project.status, "complete");
      const budget = projectBudgetView(project, budgetConfig);
      assert.equal(budget.accountedEstimateUsd, 0.05);
      assert.equal(budget.outstandingReservationsUsd, 0);
      assert.equal(project.usage.tokens, nativeReservedTokens + 20);
      const runFiles = await regularTreeFiles(
        join(workspacePaths(root).projects, "native-host", "runs"),
      );
      const runRecords = await Promise.all(
        runFiles.map(
          async (path) =>
            JSON.parse(await readFile(path, "utf8")) as {
              packageId: string;
              accountingMode?: string;
            },
        ),
      );
      assert.ok(
        runRecords
          .filter((record) =>
            ["discover", "acquire", "analyze", "synthesize"].includes(record.packageId),
          )
          .every((record) => record.accountingMode === "reserved-native-host"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits incremental discovery context above the output ceiling but below the input ceiling", async () => {
    const fixture = await nativeDiscoveryContextFixture(24_000);
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      assert.ok(fixture.contextTokens > config.budget.maxOutputTokens);
      assert.ok(fixture.contextTokens < config.budget.maxInputContextTokens);
      const packet = await prepareNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        stage: "acquire",
        hostAgent: "codex",
      });
      assert.match(packet.prompt, /### outputs\/evidence\.json/);
      assert.equal(packet.limits.maxOutputTokens, config.budget.maxOutputTokens);
      assert.equal(await sha256File(fixture.evidencePath), fixture.evidenceSha256);
      await abortNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not turn a large legacy context planning hint into an indirect preflight admission ceiling", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const config = await loadWorkspaceConfig(root);
      const baseline = await evaluateProjectPreflight(
        root,
        "Estimate on-demand artifact reads.",
        null,
        null,
      );
      config.budget.maxInputContextTokens = 5_000_000;
      await writeFile(workspacePaths(root).config, JSON.stringify(config));
      const largeHint = await evaluateProjectPreflight(
        root,
        "Estimate on-demand artifact reads.",
        null,
        null,
      );
      assert.deepEqual(
        largeHint.budget.preCallTokenReservations,
        baseline.budget.preCallTokenReservations,
      );
      assert.deepEqual(
        largeHint.gaps.filter((gap) => gap.startsWith("package-precall-reservation-exceeds-")),
        baseline.gaps.filter((gap) => gap.startsWith("package-precall-reservation-exceeds-")),
        "a planning hint cannot introduce additional package admission failures",
      );
      assert.equal(
        (largeHint.budget as unknown as { inputContextTokenLimit: number | null })
          .inputContextTokenLimit,
        null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves a rough initial acquire context without enlarging the output ceiling", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const config = await loadWorkspaceConfig(root);
      const preflight = await evaluateProjectPreflight(
        root,
        "Bound acquire stage inputs.",
        null,
        null,
      );
      assert.equal(
        preflight.budget.stageContextTokenReservations.acquire,
        Math.min(config.budget.maxInputContextTokens, 8_000),
      );
      assert.equal(preflight.budget.maxOutputTokens, config.budget.maxOutputTokens);
      assert.ok(
        preflight.budget.preCallTokenReservations.acquire <= config.budget.packageMaxTokens.acquire,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares acquire above 32,000 context tokens without rewriting frozen evidence", async () => {
    const fixture = await nativeDiscoveryContextFixture(125_000, 32_000);
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      assert.ok(fixture.contextTokens > config.budget.maxInputContextTokens);
      const packet = await prepareNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        stage: "acquire",
        hostAgent: "codex",
      });
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.equal(project.packages.find((item) => item.id === "acquire")?.attempts, 1);
      assert.equal(await sha256File(fixture.evidencePath), fixture.evidenceSha256);
      assert.equal(packet.limits.maxOutputTokens, config.budget.maxOutputTokens);
      await abortNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reads exact stage artifacts on demand without truncating a large object or changing scope", async () => {
    const fixture = await nativeDiscoveryContextFixture(125_000, 32_000);
    try {
      const packet = await prepareNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        stage: "acquire",
        hostAgent: "codex",
      });
      assert.ok(
        Buffer.byteLength(packet.prompt) < 32_000 * 3,
        "Large material should be referenced, not all embedded in the initial prompt.",
      );
      const call = (action: string, options: string[] = []) =>
        invoke([
          "research",
          "project",
          "stage",
          action,
          fixture.projectId,
          "--session",
          packet.sessionId,
          "--workspace",
          fixture.root,
          "--json",
          ...options,
        ]);
      const listed = await call("artifacts", ["--limit", "1000"]);
      assert.equal(listed.exitCode, 0, listed.stderr);
      assert.equal(listed.stdout.includes(fixture.root), false);
      const directory = JSON.parse(listed.stdout);
      const evidence = directory.items.find(
        (item: { path: string }) => item.path === "outputs/evidence.json",
      );
      assert.equal(evidence.sha256, fixture.evidenceSha256);
      const read = await call("read", ["--artifact", evidence.objectId, "--length", "all"]);
      assert.equal(read.exitCode, 0, read.stderr);
      const view = JSON.parse(read.stdout);
      assert.equal(view.content, await readFile(fixture.evidencePath, "utf8"));
      assert.equal(view.receipt.objectSha256, fixture.evidenceSha256);
      assert.equal(view.receipt.packetSha256, packet.packetSha256);
      assert.equal(view.hasMore, false);
      const unknown = await call("read", ["--artifact", "../credentials.json"]);
      assert.equal(unknown.exitCode, 3);
      assert.equal(unknown.stderr.includes(fixture.root), false);
      await abortNativeResearchStage({
        root: fixture.root,
        projectId: fixture.projectId,
        sessionId: packet.sessionId,
      });
      const stale = await call("read", ["--artifact", evidence.objectId]);
      assert.notEqual(stale.exitCode, 0);
      assert.equal(await sha256File(fixture.evidencePath), fixture.evidenceSha256);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("records a WorkBuddy native stage without allowing a child producer executor", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const config = await loadWorkspaceConfig(root);
      await writeJsonAtomic(workspacePaths(root).config, {
        ...config,
        producer: {
          ...config.producer,
          agent: "workbuddy",
          binary: "workbuddy-native-host",
          model: "hy3",
          verbosity: undefined,
        },
        reviewerExecution: {
          transport: "sandbox-bridge",
          isolationProvider: "platform-capsule",
        },
      });
      await lockCapabilities(root);
      await initializeProject(root, "workbuddy-native", "Evaluate a WorkBuddy native stage.");
      const evidencePath = join(root, "workbuddy-evidence.txt");
      await writeFile(evidencePath, "Observed WorkBuddy native-host evidence.\n");
      await addProjectInput(root, "workbuddy-native", evidencePath, "primary");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "workbuddy-native",
        stage: "discover",
        hostAgent: "workbuddy",
      });
      assert.equal(packet.hostAgent, "workbuddy");
      assert.equal(packet.expectedModel, "hy3");
      const status = await invoke([
        "research",
        "status",
        "--workspace",
        root,
        "--project",
        "workbuddy-native",
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      const statusValue = JSON.parse(status.stdout) as {
        execution: {
          producer: { host: string };
          reviewer: { transport: string; isolationProvider: string };
        };
      };
      assert.equal(statusValue.execution.producer.host, "workbuddy");
      assert.equal(statusValue.execution.reviewer.transport, "sandbox-bridge");
      assert.equal(statusValue.execution.reviewer.isolationProvider, "platform-capsule");
      await assert.rejects(
        executeAgent({
          route: {
            agent: "workbuddy",
            executionMode: "native-host",
            binary: "workbuddy-native-host",
            model: "hy3",
          },
          prompt: packet.prompt,
          outputSchema: packet.outputSchema,
          requestId: packet.sessionId,
          purpose: "primary",
          capsuleRoot: join(workspacePaths(root).runtime, "forbidden-child"),
          projectRoot: root,
          workspaceRoot: root,
          timeoutSeconds: 10,
          maxTurns: 1,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "none",
          environment: {},
          brokerUrl: null,
        }),
        (error: unknown) => error instanceof CliError && error.code === "RESEARCH_EXECUTOR_INVALID",
      );
      const sessionPath = join(
        workspacePaths(root).projects,
        "workbuddy-native",
        "native",
        "active.json",
      );
      const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
        capsuleRoot: string;
        capsuleProject: string;
      };
      const execution = await fakeExecutor([])({
        route: {
          agent: "workbuddy",
          executionMode: "native-host",
          binary: "workbuddy-native-host",
          model: packet.expectedModel,
        },
        prompt: packet.prompt,
        outputSchema: packet.outputSchema,
        requestId: packet.sessionId,
        purpose: "primary",
        capsuleRoot: session.capsuleRoot,
        projectRoot: session.capsuleProject,
        workspaceRoot: root,
        timeoutSeconds: packet.limits.maxWallSeconds,
        maxTurns: 1,
        maxOutputTokens: packet.limits.maxOutputTokens,
        maxCostUsd: packet.limits.reservedMaxCostUsd,
        toolPolicy: "none",
        environment: {},
        brokerUrl: null,
      });
      const outputPath = join(root, "workbuddy-discover-output.json");
      await writeFile(outputPath, execution.stdout);
      await submitNativeResearchStage({
        root,
        projectId: "workbuddy-native",
        sessionId: packet.sessionId,
        outputPath,
        confirmedModel: packet.expectedModel,
      });
      assert.equal(await lstat(sessionPath).catch(() => null), null);
      assert.equal((await lstat(session.capsuleRoot)).isDirectory(), true);
      assert.match(
        await readFile(workspacePaths(root).journal, "utf8"),
        /"capsuleDisposition":"retained-outer-sandbox"/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains WorkBuddy work-package capsules instead of requesting bulk deletion", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const config = await loadWorkspaceConfig(root);
      await writeJsonAtomic(workspacePaths(root).config, {
        ...config,
        producer: {
          ...config.producer,
          agent: "workbuddy",
          binary: "workbuddy-native-host",
          model: "hy3",
          verbosity: undefined,
        },
        reviewerExecution: {
          transport: "sandbox-bridge",
          isolationProvider: "platform-capsule",
        },
      });
      await lockCapabilities(root);
      await initializeProject(root, "workbuddy-packages", "Evaluate retained package capsules.");
      const evidencePath = join(root, "workbuddy-package-evidence.txt");
      await writeFile(evidencePath, "Observed WorkBuddy package evidence.\n");
      await addProjectInput(root, "workbuddy-packages", evidencePath, "primary");

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        fakeExecutor([]),
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      const runtimeFiles = await regularTreeFiles(workspacePaths(root).runtime);
      assert.ok(runtimeFiles.some((path) => basename(path) === "project.json"));
      const events = (await readFile(workspacePaths(root).journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      const reviewCompleted = events.find(
        (event) => event.type === "package.completed" && event.payload.packageId === "review",
      );
      assert.equal(reviewCompleted?.payload.capsuleDisposition, "retained-outer-sandbox");
      assert.match(String(reviewCompleted?.payload.retainedCapsuleId), /^[A-Za-z0-9-]+$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports binding drift as a stale native session with explicit recovery", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(root, "stale-native", "Evaluate stale native session reporting.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "stale-native",
        stage: "discover",
        hostAgent: "codex",
      });
      const added = join(root, "late-input.txt");
      await writeFile(added, "late immutable evidence\n");
      await addProjectInput(root, "stale-native", added, "primary");
      const status = await invoke([
        "research",
        "status",
        "--workspace",
        root,
        "--project",
        "stale-native",
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      const value = JSON.parse(status.stdout) as {
        projects: Array<{
          nativeStage: { status: string; reasonCode: string; recommendedAction: string };
          recommendedAction: string;
        }>;
      };
      assert.equal(value.projects[0]?.nativeStage.status, "stale");
      assert.equal(value.projects[0]?.nativeStage.reasonCode, "binding-drift");
      assert.match(value.projects[0]?.recommendedAction ?? "", /stage abort/);
      await abortNativeResearchStage({
        root,
        projectId: "stale-native",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers immutable inputs and closes through different agent families", async () => {
    const root = await temporaryDirectory();
    const inputParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "gpu-resource-impact",
        "How do advanced GPU process nodes change environmental resource burdens?",
      );
      const inputPath = join(inputParent, "inventory.csv");
      await writeFile(inputPath, "node,water_liters\n5nm,42\n3nm,57\n");
      const input = await addProjectInput(root, "gpu-resource-impact", inputPath, "primary");
      assert.equal(input.role, "primary");
      assert.match(input.sha256, /^[0-9a-f]{64}$/);

      const agents: string[] = [];
      const baseExecutor = fakeExecutor(agents);
      const inspectingExecutor: PackageExecutor = async (request) => {
        const capsuleState = JSON.parse(
          await readFile(join(request.projectRoot, "project.json"), "utf8"),
        ) as { inputs: Array<{ path: string }> };
        assert.ok(capsuleState.inputs.every((item) => item.path.startsWith("inputs/")));
        assert.equal(JSON.stringify(capsuleState).includes(inputParent), false);
        return baseExecutor(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        inspectingExecutor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.equal(result.stopReason, "all-projects-complete");
      assert.equal(result.cycles, 6);
      assert.deepEqual(agents, ["codex", "codex", "codex", "codex", "claude"]);

      const project = await loadProject(root, "gpu-resource-impact");
      assert.equal(project.status, "complete");
      assert.ok(project.packages.every((workPackage) => workPackage.status === "complete"));
      const closure = JSON.parse(
        await readFile(
          join(root, ".tiangong-research", "projects", project.id, "outputs", "closure.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(closure.status, "complete");
      assert.equal((closure.artifacts as unknown[]).length, 6);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(inputParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("runs independent projects concurrently", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "project-alpha",
        "Assess water impacts of a manufacturing change.",
      );
      await initializeProject(
        root,
        "project-beta",
        "Assess energy impacts of a manufacturing change.",
      );
      const sharedInput = join(root, "shared-evidence.txt");
      await writeFile(sharedInput, "measured manufacturing evidence\n");
      await addProjectInput(root, "project-alpha", sharedInput, "primary");
      await addProjectInput(root, "project-beta", sharedInput, "primary");
      let active = 0;
      let maximumActive = 0;
      let releaseConcurrentExecutors!: () => void;
      let rejectConcurrentExecutors!: (error: Error) => void;
      const concurrentExecutorsReady = new Promise<void>((resolvePromise, rejectPromise) => {
        releaseConcurrentExecutors = resolvePromise;
        rejectConcurrentExecutors = rejectPromise;
      });
      const concurrencyTimeout = setTimeout(
        () => rejectConcurrentExecutors(new Error("Two independent executors did not overlap.")),
        5_000,
      );
      const base = fakeExecutor([]);
      const concurrentExecutor: PackageExecutor = async (request) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (active >= 2) {
            clearTimeout(concurrencyTimeout);
            releaseConcurrentExecutors();
          }
          await concurrentExecutorsReady;
          return await base(request);
        } finally {
          active -= 1;
        }
      };

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 2, maxCycles: 10, dryRun: false, environment: {} },
        concurrentExecutor,
      ).finally(() => {
        clearTimeout(concurrencyTimeout);
      });
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.ok(maximumActive >= 2);
      assert.equal(result.projects.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps runnable projects ready when a historical sibling is blocked", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "blocked-sibling", "Evaluate an isolated failure.");
      await initializeProject(root, "runnable-sibling", "Evaluate independent progress.");
      const blockedInput = join(root, "blocked.txt");
      const runnableInput = join(root, "runnable.txt");
      await writeFile(blockedInput, "blocked evidence\n");
      await writeFile(runnableInput, "runnable evidence\n");
      await addProjectInput(root, "blocked-sibling", blockedInput, "primary");
      await addProjectInput(root, "runnable-sibling", runnableInput, "primary");
      const normal = fakeExecutor([]);
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 2, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          const result = await normal(request);
          const capsuleProject = JSON.parse(
            await readFile(join(request.projectRoot, "project.json"), "utf8"),
          ) as { id: string };
          return capsuleProject.id === "blocked-sibling"
            ? {
                ...result,
                exitCode: 22,
                stdout: "",
                stderr: "HTTP 422 deterministic failure",
              }
            : result;
        },
      );
      assert.equal(result.status, "ready", JSON.stringify(result));
      assert.equal(result.stopReason, "cycle-limit");
      assert.equal(
        result.projects.find((project) => project.id === "runnable-sibling")?.readyPackage,
        "acquire",
      );
      assert.equal(
        result.projects.find((project) => project.id === "blocked-sibling")?.status,
        "blocked",
      );
      const blockedBeforeScopedRun = await loadProject(root, "blocked-sibling");

      const scoped = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 10,
          dryRun: false,
          environment: {},
          projectId: "runnable-sibling",
        },
        normal,
      );
      assert.equal(scoped.status, "complete", JSON.stringify(scoped));
      assert.equal(scoped.projectId, "runnable-sibling");
      assert.deepEqual(
        scoped.projects.map((project) => project.id),
        ["runnable-sibling"],
      );
      assert.deepEqual(await loadProject(root, "blocked-sibling"), blockedBeforeScopedRun);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start an agent when the package budget cannot be reserved", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxTokens: number };
      };
      config.budget.maxTokens = 5;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "bounded-project", "Evaluate one bounded evidence question.");

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        fakeExecutor([]),
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.stopReason, "project-blocked");
      const project = await loadProject(root, "bounded-project");
      assert.equal(project.usage.tokens, 0);
      assert.equal(project.packages[0]?.status, "failed");
      await assert.rejects(
        readFile(
          join(root, ".tiangong-research", "projects", project.id, "outputs", "evidence.json"),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start an agent when prompt, schema, output, and repair cannot fit", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { packageMaxTokens: { discover: number } };
      };
      config.budget.packageMaxTokens.discover = 20_000;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "precall-bounded", "Evaluate complete pre-call reservation.");
      let calls = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          calls += 1;
          return fakeExecutor([])(request);
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 0);
      const project = await loadProject(root, "precall-bounded");
      assert.equal(project.usage.tokens, 0);
      assert.equal(project.packages[0]?.lastFailureKind, "budget");
      assert.match(project.packages[0]?.lastError ?? "", /pre-call input\/output reservation/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows mechanical closure at the exact agent budget", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: {
          maxTokens: number;
          packageMaxTokens: Record<
            "discover" | "acquire" | "analyze" | "synthesize" | "review",
            number
          >;
        };
      };
      config.budget.maxTokens = 295_000;
      config.budget.packageMaxTokens = {
        discover: 50_000,
        acquire: 50_000,
        analyze: 50_000,
        synthesize: 45_000,
        review: 100_000,
      };
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "exact-budget", "Evaluate exact budget closure behavior.");
      const inputPath = join(root, "exact-budget-evidence.txt");
      await writeFile(inputPath, "measured exact-budget evidence\n");
      await addProjectInput(root, "exact-budget", inputPath, "primary");

      const normal = fakeExecutor([]);
      const packageTokenUsage = [50_000, 50_000, 50_000, 45_000, 100_000];
      let agentCall = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 6, dryRun: false, environment: {} },
        async (request) => {
          const value = await normal(request);
          const tokens = packageTokenUsage[agentCall++]!;
          return {
            ...value,
            tokens,
            inputTokens: tokens - value.outputTokens,
            cachedInputTokens: 0,
          };
        },
      );
      assert.equal(
        result.status,
        "complete",
        JSON.stringify({ result, project: await loadProject(root, "exact-budget") }),
      );
      assert.equal(result.stopReason, "all-projects-complete");
      assert.equal(result.projects[0]?.usage.tokens, 295_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks execution when producer and reviewer use the same agent family", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        reviewer: {
          agent: string;
          executionMode: "native-host" | "headless-cli";
          binary: string;
          model: string | null;
        };
      };
      config.reviewer = {
        agent: "codex",
        executionMode: "headless-cli",
        binary: "codex",
        model: null,
      };
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "same-family", "Evaluate one independently reviewed question.");

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      await assert.rejects(
        runResearchWorkspace(
          root,
          { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
          fakeExecutor([]),
        ),
        /different agent families/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research workspace CLI", () => {
  it("renders leaf-command help without resolving or validating a workspace", async () => {
    for (const argv of [
      ["research", "context", "inspect", "--help"],
      ["research", "workspace", "init", "--help"],
      ["research", "workspace", "doctor", "--help"],
      ["research", "capability", "catalog", "--help"],
      ["research", "capability", "configure", "--help"],
      ["research", "capability", "doctor", "--help"],
      ["research", "capability", "credential", "set", "--help"],
      ["research", "project", "preflight", "--help"],
      ["research", "project", "init", "--help"],
      ["research", "project", "input", "add", "--help"],
      ["research", "project", "retry", "--help"],
      ["research", "project", "fork", "--help"],
      ["research", "project", "addendum", "--help"],
      ["research", "project", "evidence", "candidate", "register", "--help"],
      ["research", "project", "evidence", "artifact", "register", "--help"],
      ["research", "schema", "show", "--help"],
      ["research", "status", "--help"],
      ["research", "run", "--help"],
    ]) {
      const result = await invoke(argv);
      assert.equal(result.exitCode, 0, `${argv.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Research workspace commands:/);
      assert.equal(result.stderr, "");
    }
  });

  it("derives bounded text contexts from non-overlapping declared line ranges", async () => {
    const root = await temporaryDirectory();
    try {
      const source = join(root, "source.txt");
      await writeFile(source, "one\ntwo\nthree\nfour\nfive\n");
      const planPath = join(root, "ranges.json");
      const plan = {
        schemaVersion: 1,
        inputs: [
          {
            path: source,
            contextRanges: [
              { startLine: 4, endLine: 5 },
              { startLine: 1, endLine: 2 },
            ],
            role: "primary",
            dimensions: ["question"],
            sourceType: "primary",
            fullText: true,
            publicationDate: "2025-01-01",
          },
        ],
      };
      await writeFile(planPath, `${JSON.stringify(plan)}\n`);
      const verified = await readAndVerifyProjectInputPlan(planPath);
      assert.deepEqual(verified.inputs[0]?.contextRanges, [
        { startLine: 1, endLine: 2 },
        { startLine: 4, endLine: 5 },
      ]);
      assert.equal(
        await renderInputLineContext(source, verified.inputs[0]!.contextRanges!),
        "one\ntwo\nfour\nfive\n",
      );
      assert.equal(verified.inputs[0]?.contextBytes, 18);

      plan.inputs[0]!.contextRanges = [
        { startLine: 1, endLine: 3 },
        { startLine: 3, endLine: 4 },
      ];
      await writeFile(planPath, `${JSON.stringify(plan)}\n`);
      await assert.rejects(readAndVerifyProjectInputPlan(planPath), /must not overlap/i);
      plan.inputs[0]!.contextRanges = [{ startLine: 1, endLine: 99 }];
      await writeFile(planPath, `${JSON.stringify(plan)}\n`);
      await assert.rejects(readAndVerifyProjectInputPlan(planPath), /exceeds the source file/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes only the current command family", async () => {
    const root = await temporaryDirectory();
    try {
      const initialized = await invoke(["research", "workspace", "init", root, "--json"]);
      assert.equal(initialized.exitCode, 0);
      assert.equal((JSON.parse(initialized.stdout) as Record<string, unknown>).workspace, root);

      const context = await invoke(["research", "context", "inspect", "--path", root, "--json"]);
      assert.equal(context.exitCode, 0);
      assert.equal((JSON.parse(context.stdout) as Record<string, unknown>).role, "workspace");

      const project = await invoke([
        "research",
        "project",
        "init",
        "current-interface",
        "--workspace",
        root,
        "--question",
        "What evidence is required to evaluate the declared system?",
        "--json",
      ]);
      assert.equal(project.exitCode, 0);

      const dryRun = await invoke([
        "research",
        "run",
        "--workspace",
        root,
        "--project",
        "current-interface",
        "--dry-run",
        "--json",
      ]);
      assert.equal(dryRun.exitCode, 0);
      const dryRunValue = JSON.parse(dryRun.stdout) as {
        status: string;
        projectId: string | null;
        projects: Array<{ id: string }>;
      };
      assert.equal(dryRunValue.status, "dry-run");
      assert.equal(dryRunValue.projectId, "current-interface");
      assert.deepEqual(
        dryRunValue.projects.map((item) => item.id),
        ["current-interface"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hides superseded projects by default and exposes them only with --all", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "status-source",
        "Evaluate superseded status filtering behavior.",
      );
      // A real committed successor, not manually forged mutable supersession.
      await forkProject(root, "status-source", "status-addendum");

      const visible = await invoke(["research", "status", "--workspace", root, "--json"]);
      assert.equal(visible.exitCode, 0, visible.stderr);
      const visibleValue = JSON.parse(visible.stdout) as {
        hiddenSupersededProjects: number;
        projects: Array<{ id: string }>;
      };
      assert.equal(visibleValue.hiddenSupersededProjects, 1);
      assert.deepEqual(
        visibleValue.projects.map((project) => project.id),
        ["status-addendum"],
      );

      const all = await invoke(["research", "status", "--workspace", root, "--all", "--json"]);
      assert.equal(all.exitCode, 0, all.stderr);
      const allValue = JSON.parse(all.stdout) as {
        hiddenSupersededProjects: number;
        projects: Array<{ id: string; status: string }>;
      };
      assert.equal(allValue.hiddenSupersededProjects, 0);
      assert.deepEqual(
        allValue.projects.map((project) => project.id),
        ["status-addendum", "status-source"],
      );
      assert.equal(
        allValue.projects.find((project) => project.id === "status-source")?.status,
        "stale",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes recovery forks authoritative and records explicit historical dispositions", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "authority-v1", "Evaluate authoritative project lineage.");
      const firstFork = await invoke([
        "research",
        "project",
        "fork",
        "authority-v1",
        "--to",
        "authority-v2",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(firstFork.exitCode, 0, firstFork.stderr);
      assert.equal((await loadProject(root, "authority-v1")).lineage.supersededBy, "authority-v2");
      assert.equal((await loadProject(root, "authority-v1")).status, "stale");

      const staleFork = await invoke([
        "research",
        "project",
        "fork",
        "authority-v1",
        "--to",
        "wrong-branch",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(staleFork.exitCode, 3);
      assert.match(staleFork.stderr, /authority-v2/);

      const secondFork = await invoke([
        "research",
        "project",
        "fork",
        "authority-v2",
        "--to",
        "authority-v3",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(secondFork.exitCode, 0, secondFork.stderr);
      const visible = JSON.parse(
        (await invoke(["research", "status", "--workspace", root, "--json"])).stdout,
      ) as { projects: Array<{ id: string; authority: { state: string; projectId: string } }> };
      assert.deepEqual(visible.projects, [
        {
          ...visible.projects[0]!,
          id: "authority-v3",
          authority: { state: "authoritative", projectId: "authority-v3" },
        },
      ]);

      const all = JSON.parse(
        (await invoke(["research", "status", "--workspace", root, "--all", "--json"])).stdout,
      ) as { projects: Array<{ id: string; authority: { state: string; projectId: string } }> };
      assert.deepEqual(
        all.projects.map((project) => [project.id, project.authority]),
        [
          ["authority-v1", { state: "superseded", projectId: "authority-v3" }],
          ["authority-v2", { state: "superseded", projectId: "authority-v3" }],
          ["authority-v3", { state: "authoritative", projectId: "authority-v3" }],
        ],
      );

      const archived = await invoke([
        "research",
        "project",
        "archive",
        "authority-v1",
        "--reason",
        "Retain the superseded baseline for audit.",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(archived.exitCode, 0, archived.stderr);
      const abandoned = await invoke([
        "research",
        "project",
        "abandon",
        "authority-v3",
        "--reason",
        "The user no longer wants this unfinished branch.",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(abandoned.exitCode, 0, abandoned.stderr);
      const finalStatus = JSON.parse(
        (await invoke(["research", "status", "--workspace", root, "--json"])).stdout,
      ) as {
        hiddenArchivedProjects: number;
        hiddenAbandonedProjects: number;
        projects: unknown[];
      };
      assert.equal(finalStatus.hiddenArchivedProjects, 1);
      assert.equal(finalStatus.hiddenAbandonedProjects, 1);
      assert.deepEqual(finalStatus.projects, []);
      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "ready", JSON.stringify(doctor.checks));
      assert.equal(doctor.checks.find((check) => check.id === "project-state")?.status, "pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an uncommitted recovery fork as invalid instead of authoritative", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "partial-source",
        "Retain source authority after a failed fork.",
      );
      const partial = await initializeProject(
        root,
        "partial-target",
        "Do not trust a target without a fork commit marker.",
      );
      partial.lineage.kind = "fork";
      partial.lineage.derivedFrom = "partial-source";
      partial.lineage.supersedes = "partial-source";
      await saveProject(root, partial);

      const status = JSON.parse(
        (await invoke(["research", "status", "--workspace", root, "--all", "--json"])).stdout,
      ) as { projects: Array<{ id: string; authority: { state: string; projectId: string } }> };
      assert.deepEqual(
        status.projects.map((project) => [project.id, project.authority]),
        [
          ["partial-source", { state: "authoritative", projectId: "partial-source" }],
          ["partial-target", { state: "invalid", projectId: "partial-target" }],
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably separates agent work, user action, and external-response waiting", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "handoff-state", "Evaluate durable research handoff states.");
      const input = join(root, "handoff-input.txt");
      await writeFile(input, "bounded evidence\n");
      await addProjectInput(root, "handoff-state", input, "primary");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "handoff-state",
        stage: "discover",
        hostAgent: "codex",
      });
      assert.ok(packet.commands.requestHandoff);
      await recordNativeResearchActivity({
        root,
        projectId: "handoff-state",
        value: {
          schemaVersion: 1,
          kind: "browser-navigation",
          channel: "codex.browser",
          input: "publisher access page",
          candidateIds: [],
          resultCount: 0,
          status: "blocked",
          challenge: "captcha",
        },
      });
      const output = join(root, "blocked-closeout.json");
      await writeFile(
        output,
        JSON.stringify({
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "missing" }],
          gaps: ["Publisher challenge unresolved."],
        }),
      );
      await assert.rejects(
        submitNativeResearchStage({
          root,
          projectId: "handoff-state",
          sessionId: packet.sessionId,
          outputPath: output,
          confirmedModel: packet.expectedModel,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_PROJECT_HANDOFF_REQUIRED",
      );

      const userHandoff = await requestResearchHandoff({
        root,
        projectId: "handoff-state",
        value: {
          schemaVersion: 2,
          kind: "interactive-challenge",
          state: "user-action-required",
          reasonCode: "human-challenge",
          summary: "A human must complete the publisher challenge without automation.",
          requestedActions: ["Complete the visible challenge and confirm authorized access."],
          evidenceGaps: ["Publisher full text remains unavailable."],
        },
      });
      assert.equal(userHandoff.status, "waiting-user");
      assert.equal((await doctorResearchWorkspace(root)).status, "ready");
      assert.equal((await loadProject(root, "handoff-state")).packages[0]?.attempts, 0);
      const waiting = await runNativeControlledWorkspace(
        root,
        {
          projectId: "handoff-state",
          maxParallel: 1,
          maxCycles: 2,
          dryRun: false,
          environment: {},
        },
        fakeExecutor([]),
      );
      assert.equal(waiting.status, "waiting");
      assert.equal(waiting.stopReason, "handoff-required");

      const resumed = await resolveResearchHandoff({
        root,
        projectId: "handoff-state",
        note: "The authorized user completed the challenge successfully.",
      });
      assert.equal(resumed.status, "ready");
      await prepareNativeResearchStage({
        root,
        projectId: "handoff-state",
        stage: "discover",
        hostAgent: "codex",
      });
      const external = await requestResearchHandoff({
        root,
        projectId: "handoff-state",
        value: {
          schemaVersion: 2,
          kind: "external-wait",
          state: "external-response-required",
          reasonCode: "official-data-request-pending",
          summary: "The public evidence ceiling is reached and an official response is pending.",
          requestedActions: ["Wait for the authorized agency data response."],
          evidenceGaps: ["The requested non-public official dataset is not yet available."],
        },
      });
      assert.equal(external.status, "waiting-external");
      assert.equal((await doctorResearchWorkspace(root)).status, "ready");
      const status = await invoke([
        "research",
        "status",
        "--workspace",
        root,
        "--project",
        "handoff-state",
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      const statusValue = JSON.parse(status.stdout) as {
        projects: Array<{ status: string; recommendedAction: string }>;
      };
      assert.equal(statusValue.projects[0]?.status, "waiting-external");
      assert.match(statusValue.projects[0]?.recommendedAction ?? "", /Do not continue/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown project status in both doctor and the project loader", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const project = await initializeProject(
        root,
        "unknown-status",
        "Reject corrupt project state.",
      );
      await writeJsonAtomic(join(workspacePaths(root).projects, project.id, "project.json"), {
        ...project,
        status: "unrecognized-terminal-state",
      });
      await assert.rejects(
        loadProject(root, project.id),
        (error: unknown) => error instanceof CliError && error.code === "RESEARCH_PROJECT_INVALID",
      );
      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      assert.equal(doctor.checks.find((check) => check.id === "project-state")?.status, "fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes authoritative schemas and a JSONL progress stream", async () => {
    const root = await temporaryDirectory();
    try {
      const schema = await invoke(["research", "schema", "show", "discover", "--json"]);
      assert.equal(schema.exitCode, 0, schema.stderr);
      const schemaValue = JSON.parse(schema.stdout) as Record<string, unknown>;
      assert.equal(
        schemaValue.$id,
        "https://schemas.tiangong.ai/research/discovery-closeout-v2.json",
      );
      for (const stage of [
        "discover",
        "acquire",
        "analyze",
        "synthesize",
        "review",
        "doctor",
      ] as const) {
        assertProviderSchemaCompatibility(schemaForStage(stage, "a".repeat(64)));
      }
      assert.throws(
        () =>
          parseStructuredStageOutput(
            "analyze",
            JSON.stringify({
              schemaVersion: 2,
              inferenceSnapshotSha256: "a".repeat(64),
              analysisRun: {
                id: "analysis-run-1",
                mode: "qualitative",
                status: "not-applicable",
                implementationSha256s: [],
                environmentSha256s: [],
                inputArtifactSha256s: [],
                command: null,
                randomSeed: null,
                limitations: [],
              },
              findings: [
                {
                  id: "finding-1",
                  statement: "A supported statement.",
                  evidence: ["source-1", "source-1"],
                  evidenceAtomIds: [],
                  claimIds: [],
                  analysisArtifactSha256s: [],
                  uncertainty: "Bounded uncertainty.",
                  applicability: "Applies to the declared comparison.",
                },
              ],
              limitations: [],
            }),
          ),
        /semantic validation/,
      );

      await invoke(["research", "workspace", "init", root, "--json"]);
      const run = await invoke([
        "research",
        "run",
        "--workspace",
        root,
        "--progress-jsonl",
        "--json",
      ]);
      assert.equal(run.exitCode, 0, run.stderr);
      const events = run.stderr
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        events.map((event) => event.type),
        ["run.started", "run.completed"],
      );
      assert.ok(events.every((event) => event.requestId === events[0]?.requestId));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports requirement-to-capability and broker-context gaps during preflight", async () => {
    const root = await temporaryDirectory();
    try {
      await invoke(["research", "workspace", "init", root, "--json"]);
      const requirementsPath = join(root, "requirements.json");
      await writeFile(
        requirementsPath,
        `${JSON.stringify({
          dimensions: ["energy"],
          sourceTypes: ["primary", "industry-report"],
          requiredCapabilityIds: ["database.tiangong.report-search"],
          requiredDiscoveryScopes: ["database:tiangong-report"],
          minSources: 2,
          minFullTextSources: 1,
          minDatedSources: 1,
          publicationDateFrom: "2020-01-01",
          publicationDateTo: "2026-12-31",
        })}\n`,
      );
      const preflight = await invoke([
        "research",
        "project",
        "preflight",
        "--workspace",
        root,
        "--question",
        "What is the bounded energy impact?",
        "--requirements",
        requirementsPath,
        "--json",
      ]);
      assert.equal(preflight.exitCode, 3, preflight.stderr);
      const value = JSON.parse(preflight.stdout) as {
        gaps: string[];
        coverageGaps: Array<{
          kind: string;
          requirement: string;
          affectedDimensions: string[];
          affectedSourceTypes: string[];
          alternativeCanSatisfyMinimumCoverage: boolean;
          minimumAction: string;
        }>;
        budget: { maxBrokerContextTokens: number };
      };
      assert.ok(value.gaps.includes("no-evidence-acquisition-plan"));
      assert.ok(value.gaps.includes("evidence-plan-dimension-uncovered:energy"));
      assert.ok(value.gaps.includes("evidence-plan-source-type-uncovered:primary"));
      assert.ok(value.gaps.includes("evidence-plan-source-type-uncovered:industry-report"));
      assert.ok(
        value.gaps.includes("evidence-plan-capability-unavailable:database.tiangong.report-search"),
      );
      assert.ok(
        value.gaps.includes("evidence-plan-discovery-scope-uncovered:database:tiangong-report"),
      );
      assert.deepEqual(value.coverageGaps[0], {
        kind: "capability-unavailable",
        requirement: "database.tiangong.report-search",
        affectedDimensions: ["energy"],
        affectedSourceTypes: ["industry-report", "primary"],
        alternativeCanSatisfyMinimumCoverage: false,
        minimumAction:
          "Rerun the setup Wizard, select tiangong.kb-report-search, review its license and exact endpoint, securely configure tiangong.report.api-key, apply the replacement immutable plan, and pass capability live doctor.",
      });
      assert.ok(value.gaps.includes("evidence-plan-min-sources-insufficient:0/2"));
      assert.ok(value.gaps.includes("evidence-plan-full-text-insufficient:0/1"));
      assert.ok(value.gaps.includes("evidence-plan-dated-sources-insufficient:0/1"));
      assert.equal(value.budget.maxBrokerContextTokens, 12_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives heterogeneous production discovery a high finite budget without a package deadlock", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      await declareExternalPublicCapability(root, skillParent);
      await lockCapabilities(root);
      const preflight = await evaluateProjectPreflight(
        root,
        "How should local government govern productive and safe generative AI adoption?",
        {
          dimensions: [
            "productivity",
            "accuracy-risk",
            "privacy-security",
            "procurement-governance",
            "adoption-evidence",
            "counterevidence",
          ],
          sourceTypes: [
            "peer-reviewed",
            "government",
            "official-data",
            "news",
            "vendor",
            "independent-analysis",
          ],
          requiredCapabilityIds: ["method.external-public-search"],
          requiredCompanionIds: [],
          requiredDiscoveryScopes: ["public-internet"],
          minSources: 8,
          minFullTextSources: 0,
          minDatedSources: 6,
          publicationDateFrom: "2023-01-01",
          publicationDateTo: "2026-08-11",
        },
        null,
      );
      assert.equal(preflight.budget.discoveryPlan?.maxCalls, 14);
      assert.equal(preflight.budget.maxBrokerCalls, 256);
      assert.equal(preflight.budget.maxTokens, 50_000_000);
      assert.equal(preflight.budget.packageMaxTokens.discover, 12_000_000);
      assert.ok(
        preflight.budget.preCallTokenReservations.discover <=
          preflight.budget.packageMaxTokens.discover,
      );
      assert.ok(
        !preflight.gaps.some((gap) => gap.startsWith("package-precall-reservation-exceeds-")),
        JSON.stringify(preflight.gaps),
      );
      assert.ok(preflight.budget.maxBrokerCalls < Number.MAX_SAFE_INTEGER);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(skillParent, { recursive: true, force: true });
    }
  });

  it("reports a compact discover-output reservation gap", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        producer: { model: string | null; pricing?: Record<string, number> };
        reviewer: { model: string | null; pricing?: Record<string, number> };
        budget: {
          maxOutputTokens: number;
          maxRepairTokens: number;
          maxInputContextTokens: number;
        };
      };
      config.producer.model = "producer-model";
      config.reviewer.model = "reviewer-model";
      config.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      config.reviewer.pricing = { ...config.producer.pricing };
      config.budget.maxOutputTokens = 1_000;
      config.budget.maxRepairTokens = 500;
      config.budget.maxInputContextTokens = 1_500;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await lockCapabilities(root);

      const requirementsPath = join(root, "requirements.json");
      await writeFile(
        requirementsPath,
        `${JSON.stringify({
          dimensions: ["energy"],
          sourceTypes: ["primary"],
          minSources: 4,
          minFullTextSources: 0,
          minDatedSources: 0,
          publicationDateFrom: null,
          publicationDateTo: null,
        })}\n`,
      );
      const preflight = await invoke([
        "research",
        "project",
        "preflight",
        "--workspace",
        root,
        "--question",
        "Can the configured reservations hold a complete evidence object?",
        "--requirements",
        requirementsPath,
        "--json",
      ]);
      assert.equal(preflight.exitCode, 3, preflight.stderr);
      const value = JSON.parse(preflight.stdout) as {
        gaps: string[];
        budget: { outputTokenLimitEnforcement: Record<string, string> };
      };
      assert.ok(
        value.gaps.includes("discover-output-reservation-below-schema-recommendation:1000/1024"),
      );
      assert.deepEqual(value.budget.outputTokenLimitEnforcement, {
        producer: "reserved-native-host-on-submit",
        reviewer: "post-execution",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production admission when only local evidence is available", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      await lockCapabilities(root);
      const source = join(root, "local-source.txt");
      await writeFile(source, "Local evidence alone is not an internet discovery plan.\n");
      const planPath = join(root, "local-only-plan.json");
      await writeFile(
        planPath,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: source,
              role: "primary",
              dimensions: ["question"],
              sourceType: "primary",
              fullText: true,
              publicationDate: "2026-01-01",
            },
          ],
        })}\n`,
      );
      const plan = await readAndVerifyProjectInputPlan(planPath);
      const preflight = await evaluateProjectPreflight(
        root,
        "What does all available evidence say?",
        {
          dimensions: ["question"],
          sourceTypes: ["primary"],
          minSources: 1,
          minFullTextSources: 1,
          minDatedSources: 1,
          publicationDateFrom: null,
          publicationDateTo: null,
        },
        plan,
      );
      assert.equal(preflight.readyToInitialize, false);
      assert.ok(preflight.gaps.includes("production-public-internet-capability-missing"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records explicit owner-input trust and safe role-based defaults", async () => {
    const root = await temporaryDirectory();
    try {
      await invoke(["research", "workspace", "init", root, "--json"]);
      const uncertain = join(root, "uncertain-owner-model.txt");
      const reproduced = join(root, "reproduced-owner-model.txt");
      await writeFile(uncertain, "Owner says this model may be incorrect.\n");
      await writeFile(reproduced, "Independently reproduced owner-provided values.\n");

      const defaulted = await invoke([
        "research",
        "project",
        "init",
        "input-trust",
        "--workspace",
        root,
        "--question",
        "How should owner-provided inputs be trusted?",
        "--json",
      ]);
      assert.equal(defaulted.exitCode, 0, defaulted.stderr);
      const reference = await invoke([
        "research",
        "project",
        "input",
        "add",
        "input-trust",
        "--path",
        uncertain,
        "--role",
        "reference",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(reference.exitCode, 0, reference.stderr);
      assert.equal(JSON.parse(reference.stdout).trustStatus, "reference-only");
      assert.equal(JSON.parse(reference.stdout).independentlyReproduced, false);

      const verified = await invoke([
        "research",
        "project",
        "input",
        "add",
        "input-trust",
        "--path",
        reproduced,
        "--role",
        "primary",
        "--trust-status",
        "verified-owner-input",
        "--independently-reproduced",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(verified.exitCode, 0, verified.stderr);
      assert.equal(JSON.parse(verified.stdout).trustStatus, "verified-owner-input");
      assert.equal(JSON.parse(verified.stdout).independentlyReproduced, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked and duplicate-content project input plans", async () => {
    const root = await temporaryDirectory();
    try {
      await invoke(["research", "workspace", "init", root, "--json"]);
      const source = join(root, "source.txt");
      const duplicate = join(root, "duplicate.txt");
      const linkedSource = join(root, "linked-source.txt");
      await writeFile(source, "same immutable evidence\n");
      await writeFile(duplicate, "same immutable evidence\n");
      await symlink(source, linkedSource);
      const symlinkPlan = join(root, "symlink-plan.json");
      await writeFile(
        symlinkPlan,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: linkedSource,
              role: "primary",
              dimensions: ["energy"],
              sourceType: "primary",
              fullText: true,
              publicationDate: "2025-01-01",
            },
          ],
        })}\n`,
      );
      const symlinked = await invoke([
        "research",
        "project",
        "preflight",
        "--workspace",
        root,
        "--question",
        "Does the symlinked evidence plan remain immutable?",
        "--input-plan",
        symlinkPlan,
        "--json",
      ]);
      assert.equal(symlinked.exitCode, 2);
      assert.match(symlinked.stderr, /regular file/i);

      const duplicatePlan = join(root, "duplicate-plan.json");
      await writeFile(
        duplicatePlan,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [source, duplicate].map((path) => ({
            path,
            role: "primary",
            dimensions: ["energy"],
            sourceType: "primary",
            fullText: true,
            publicationDate: "2025-01-01",
          })),
        })}\n`,
      );
      const duplicated = await invoke([
        "research",
        "project",
        "preflight",
        "--workspace",
        root,
        "--question",
        "Does the duplicate evidence plan remain honest?",
        "--input-plan",
        duplicatePlan,
        "--json",
      ]);
      assert.equal(duplicated.exitCode, 2);
      assert.match(duplicated.stderr, /same content more than once/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights and atomically admits local inputs only alongside an external internet capability", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await invoke([
        "research",
        "workspace",
        "init",
        root,
        "--mode",
        "production-research",
        "--json",
      ]);
      const workspaceConfigPath = workspacePaths(root).config;
      const workspaceConfig = JSON.parse(await readFile(workspaceConfigPath, "utf8")) as {
        producer: { model: string | null; pricing?: Record<string, number> };
        reviewer: { model: string | null; pricing?: Record<string, number> };
      };
      workspaceConfig.producer.model = "producer-model";
      workspaceConfig.reviewer.model = "reviewer-model";
      workspaceConfig.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      workspaceConfig.reviewer.pricing = { ...workspaceConfig.producer.pricing };
      await writeFile(workspaceConfigPath, `${JSON.stringify(workspaceConfig, null, 2)}\n`);
      await declareExternalPublicCapability(root, skillParent);
      const corporateSource = join(root, "corporate-source.txt");
      const peerReviewedSource = join(root, "peer-reviewed-source.txt");
      await writeFile(corporateSource, "Corporate primary evidence.\n");
      await writeFile(peerReviewedSource, "Peer-reviewed full-text evidence.\n");
      const requirementsPath = join(root, "requirements.json");
      await writeFile(
        requirementsPath,
        `${JSON.stringify({
          dimensions: ["energy", "water"],
          sourceTypes: ["corporate-primary", "peer-reviewed"],
          minSources: 2,
          minFullTextSources: 2,
          minDatedSources: 2,
          publicationDateFrom: "2020-01-01",
          publicationDateTo: "2026-12-31",
        })}\n`,
      );
      const inputPlanPath = join(root, "input-plan.json");
      await writeFile(
        inputPlanPath,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: corporateSource,
              role: "primary",
              dimensions: ["energy", "water"],
              sourceType: "corporate-primary",
              fullText: true,
              publicationDate: "2025-01-01",
            },
            {
              path: peerReviewedSource,
              role: "primary",
              dimensions: ["energy"],
              sourceType: "peer-reviewed",
              fullText: true,
              publicationDate: "2024-01-01",
            },
          ],
        })}\n`,
      );
      const reorderedPlanPath = join(root, "reordered-input-plan.json");
      const reorderedPlan = JSON.parse(await readFile(inputPlanPath, "utf8")) as {
        schemaVersion: 1;
        inputs: unknown[];
      };
      reorderedPlan.inputs.reverse();
      await writeFile(reorderedPlanPath, `${JSON.stringify(reorderedPlan)}\n`);
      assert.equal(
        (await readAndVerifyProjectInputPlan(reorderedPlanPath)).sha256,
        (await readAndVerifyProjectInputPlan(inputPlanPath)).sha256,
      );
      const locked = await invoke([
        "research",
        "capability",
        "lock",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(locked.exitCode, 0, locked.stderr);
      const doctor = await doctorResearchWorkspace(root, {
        agentSmoke: true,
        capabilitySmoke: true,
        capabilityFetcher: async () =>
          new Response('{"status":"ok"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        environment: {},
        executor: async (request) => ({
          exitCode: 0,
          stdout: '{"ok":true}',
          stderr: "",
          tokens: 3,
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
          costUsd: 0.000001,
          wallSeconds: 0.01,
          model: request.route.model,
          runtime: {
            agent: request.route.agent,
            model: request.route.model,
            effort: request.route.effort ?? "low",
            verbosity: request.route.agent === "codex" ? (request.route.verbosity ?? "low") : null,
            binarySha256: (request.route.agent === "codex" ? "a" : "c").repeat(64),
            wrapperSha256: "b".repeat(64),
            adapterSha256: "d".repeat(64),
            binaryVersion: `mock-${request.route.agent} 1.0.0`,
            platform: process.platform,
            architecture: process.arch,
          },
          isolation: {
            provider: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
            policySha256: "e".repeat(64),
            readScopes: ["platform-runtime", "agent-runtime", "private-capsule"],
            writeScopes: ["private-capsule"],
            networkPolicy: "reviewer-provider-only",
            toolPolicy: "none",
          },
        }),
      });
      assert.equal(doctor.status, "ready", JSON.stringify(doctor));
      const preflight = await invoke([
        "research",
        "project",
        "preflight",
        "--workspace",
        root,
        "--question",
        "How do energy and water burdens compare?",
        "--requirements",
        requirementsPath,
        "--input-plan",
        inputPlanPath,
        "--json",
      ]);
      assert.equal(preflight.exitCode, 0, preflight.stderr || preflight.stdout);
      const preflightValue = JSON.parse(preflight.stdout) as {
        readyToInitialize: boolean;
        gaps: string[];
        inputPlan: { sha256: string; inputs: Array<{ id: string }> };
        doctorAttestation: { status: string; attestationSha256: string };
        budget: {
          packageMaxTokens: Record<
            "discover" | "acquire" | "analyze" | "synthesize" | "review",
            number
          >;
          recommendedDiscoverOutputTokens: number;
          plannedBrokerCalls: number;
          maxBrokerContextTokens: number;
          embeddedStageContextReservation: number;
          stageContextTokenReservations: Record<
            "acquire" | "analyze" | "synthesize" | "review",
            number
          >;
          maxInputContextTokens: number;
          outputTokenLimitEnforcement: { producer: string; reviewer: string };
          preCallTokenReservations: Record<
            "discover" | "acquire" | "analyze" | "synthesize" | "review",
            number
          >;
          maxTurns: Record<
            "discover" | "acquire" | "analyze" | "synthesize" | "review" | "repair",
            number
          >;
        };
        executionPolicy: {
          producer: { turnLimitEnforcement: string };
          reviewer: { turnLimitEnforcement: string };
        };
      };
      assert.equal(preflightValue.readyToInitialize, true, preflight.stdout);
      assert.deepEqual(preflightValue.gaps, []);
      assert.match(preflightValue.inputPlan.sha256, /^[a-f0-9]{64}$/);
      assert.equal(preflightValue.inputPlan.inputs.length, 2);
      assert.ok(preflightValue.inputPlan.inputs.every((input) => input.id.startsWith("input-")));
      assert.equal(preflightValue.doctorAttestation.status, "verified");
      assert.match(preflightValue.doctorAttestation.attestationSha256, /^[a-f0-9]{64}$/);
      assert.equal(preflightValue.budget.recommendedDiscoverOutputTokens, 1_024);
      assert.ok(
        preflightValue.budget.embeddedStageContextReservation <=
          preflightValue.budget.maxInputContextTokens,
      );
      assert.deepEqual(preflightValue.budget.stageContextTokenReservations, {
        acquire: 8_000,
        analyze: 8_000,
        synthesize: 8_000,
        review: 24_000,
      });
      assert.deepEqual(preflightValue.budget.outputTokenLimitEnforcement, {
        producer: "reserved-native-host-on-submit",
        reviewer: "post-execution",
      });
      assert.deepEqual(preflightValue.budget.maxTurns, {
        discover: 1,
        acquire: 2,
        analyze: 2,
        synthesize: 2,
        review: 3,
        repair: 1,
      });
      assert.equal(
        preflightValue.executionPolicy.producer.turnLimitEnforcement,
        "native-host-instruction-and-reserved-accounting",
      );
      assert.equal(preflightValue.executionPolicy.reviewer.turnLimitEnforcement, "provider");
      assert.ok(
        preflightValue.budget.preCallTokenReservations.review >
          preflightValue.budget.preCallTokenReservations.synthesize,
      );
      for (const stage of ["discover", "acquire", "analyze", "synthesize", "review"] as const) {
        assert.ok(
          preflightValue.budget.preCallTokenReservations[stage] <=
            preflightValue.budget.packageMaxTokens[stage],
          `${stage} preflight reservation must fit the package budget`,
        );
      }
      assert.ok(
        preflightValue.budget.preCallTokenReservations.discover >=
          preflightValue.budget.plannedBrokerCalls * preflightValue.budget.maxBrokerContextTokens,
        "discover preflight must reserve every planned bounded broker context",
      );
      assert.equal(preflight.stdout.includes(corporateSource), false);
      assert.equal(preflight.stdout.includes(peerReviewedSource), false);

      const insufficientPlanPath = join(root, "insufficient-input-plan.json");
      await writeFile(
        insufficientPlanPath,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: corporateSource,
              role: "primary",
              dimensions: ["energy", "water"],
              sourceType: "corporate-primary",
              fullText: true,
              publicationDate: "2025-01-01",
            },
          ],
        })}\n`,
      );
      const blocked = await invoke([
        "research",
        "project",
        "init",
        "insufficient-plan",
        "--workspace",
        root,
        "--question",
        "How do energy and water burdens compare?",
        "--requirements",
        requirementsPath,
        "--input-plan",
        insufficientPlanPath,
        "--confirm-budget",
        "--json",
      ]);
      assert.equal(blocked.exitCode, 3);
      assert.match(blocked.stderr, /blocked by preflight/i);

      const verifiedPlan = await readAndVerifyProjectInputPlan(inputPlanPath);
      await writeFile(corporateSource, "Changed after input plan verification.\n");
      await assert.rejects(
        initializeProject(
          root,
          "changed-plan",
          "How do energy and water burdens compare?",
          {
            dimensions: ["energy", "water"],
            sourceTypes: ["corporate-primary", "peer-reviewed"],
            minSources: 2,
            minFullTextSources: 2,
            minDatedSources: 2,
            publicationDateFrom: "2020-01-01",
            publicationDateTo: "2026-12-31",
          },
          true,
          verifiedPlan,
        ),
        /content changed before project admission/i,
      );
      await writeFile(corporateSource, "Corporate primary evidence.\n");

      const initialized = await invoke([
        "research",
        "project",
        "init",
        "planned-inputs",
        "--workspace",
        root,
        "--question",
        "How do energy and water burdens compare?",
        "--requirements",
        requirementsPath,
        "--input-plan",
        inputPlanPath,
        "--confirm-budget",
        "--json",
      ]);
      assert.equal(initialized.exitCode, 0, initialized.stderr);
      const project = JSON.parse(initialized.stdout) as {
        inputs: Array<{ id: string; path: string; sha256: string }>;
      };
      assert.equal(project.inputs.length, 2);
      assert.deepEqual(
        new Set(project.inputs.map((input) => input.path)),
        new Set([corporateSource, peerReviewedSource]),
      );
      assert.ok(project.inputs.every((input) => /^[a-f0-9]{64}$/.test(input.sha256)));
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(corporateSource), false);
      assert.equal(journal.includes(peerReviewedSource), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

async function nativeDiscoveryContextFixture(relevanceBytes: number, contextCeiling?: number) {
  const root = await temporaryDirectory();
  const projectId = "incremental-context";
  await initializeResearchWorkspace(root, undefined);
  if (contextCeiling !== undefined) {
    const config = await loadWorkspaceConfig(root);
    await writeJsonAtomic(workspacePaths(root).config, {
      ...config,
      budget: { ...config.budget, maxInputContextTokens: contextCeiling },
    });
  }
  await lockCapabilities(root);
  await initializeProject(root, projectId, "Bound incremental evidence metadata at acquisition.");
  const inputPath = join(root, "context-source.txt");
  await writeFile(inputPath, "Observed source evidence.\n");
  await addProjectInput(root, projectId, inputPath, "primary");
  const packet = await prepareNativeResearchStage({
    root,
    projectId,
    stage: "discover",
    hostAgent: "codex",
  });
  const candidate = (await listEvidenceCandidates(root, projectId))[0]!;
  await recordDiscoveryAssessmentBatch({
    root,
    projectId,
    value: {
      schemaVersion: 1,
      assessments: [
        {
          decision: "admit",
          candidateId: candidate.id,
          sourceId: "source-1",
          sourceType: "primary",
          relevance: "Measured scope. "
            .repeat(Math.ceil(relevanceBytes / 16))
            .slice(0, relevanceBytes),
          quality: { level: "primary", rationale: "Direct measurement." },
          applicability: "The declared bounded question.",
          coverageDimensions: ["research-question"],
          limitations: [],
        },
      ],
    },
  });
  const outputPath = join(root, "discovery-closeout.json");
  await writeJsonAtomic(outputPath, {
    schemaVersion: 2,
    limitations: [],
    dimensionJudgments: [{ id: "research-question", status: "covered" }],
    gaps: [],
  });
  await submitNativeResearchStage({
    root,
    projectId,
    sessionId: packet.sessionId,
    outputPath,
    confirmedModel: packet.expectedModel,
  });
  const evidencePath = join(workspacePaths(root).projects, projectId, "outputs", "evidence.json");
  return {
    root,
    projectId,
    evidencePath,
    evidenceSha256: await sha256File(evidencePath),
    contextTokens: Math.ceil(
      Buffer.byteLength(
        `### outputs/evidence.json\n${(await readFile(evidencePath, "utf8")).trimEnd()}`,
      ) / 3,
    ),
  };
}

function fakeExecutor(agentLog: string[]): PackageExecutor {
  return async (request) => {
    agentLog.push(request.route.agent);
    const stage = request.prompt.match(/^Stage: ([a-z]+)$/m)?.[1];
    const outputs = join(request.projectRoot, "outputs");
    let structured: Record<string, unknown>;
    if (stage === "discover") {
      const capsuleState = JSON.parse(
        await readFile(join(request.projectRoot, "project.json"), "utf8"),
      ) as { id: string; inputs: Array<{ id: string; path: string }> };
      const admittedInput = capsuleState.inputs[0];
      const candidate = admittedInput
        ? (await listEvidenceCandidates(request.workspaceRoot, capsuleState.id)).find(
            (item) => item.origin.inputId === admittedInput.id,
          )
        : undefined;
      if (admittedInput && candidate) {
        await recordDiscoveryAssessmentBatch({
          root: request.workspaceRoot,
          projectId: capsuleState.id,
          value: {
            schemaVersion: 1,
            assessments: [
              {
                decision: "admit",
                candidateId: candidate.id,
                sourceId: "source-1",
                sourceType: "primary",
                relevance: "Directly measures the declared comparison.",
                quality: { level: "primary", rationale: "Direct measurement." },
                applicability: "Applies to the declared bounded comparison.",
                coverageDimensions: ["research-question"],
                limitations: [],
              },
            ],
          },
        });
      }
      structured = {
        schemaVersion: 2,
        limitations: [],
        dimensionJudgments: [
          {
            id: "research-question",
            status: admittedInput ? "covered" : "missing",
          },
        ],
        gaps: admittedInput ? [] : ["No admitted source."],
      };
    } else if (stage === "acquire") {
      const capsuleState = JSON.parse(
        await readFile(join(request.projectRoot, "project.json"), "utf8"),
      ) as { id: string };
      const evidence = JSON.parse(
        await readFile(join(request.projectRoot, "outputs", "evidence.json"), "utf8"),
      ) as {
        sources: Array<{ id: string; provenance: { kind: "input" | "broker"; id: string } }>;
      };
      const candidates = await listEvidenceCandidates(request.workspaceRoot, capsuleState.id);
      structured = {
        schemaVersion: 1,
        decisions: evidence.sources.map((source) => {
          const candidate = candidates.find((item) =>
            source.provenance.kind === "input"
              ? item.origin.inputId === source.provenance.id
              : item.origin.receiptId === source.provenance.id,
          );
          assert.ok(candidate);
          return {
            sourceId: source.id,
            candidateId: candidate.id,
            artifactIds: [],
            status: "accepted",
            rationale: "The registered immutable source is usable within scope.",
            limitations: [],
          };
        }),
        limitations: [],
        gaps: [],
      };
    } else if (stage === "analyze") {
      const inference = JSON.parse(
        await readFile(join(request.projectRoot, "outputs", "inference-snapshot.json"), "utf8"),
      ) as {
        snapshotSha256: string;
        sources: Array<{ id: string }>;
        atoms: Array<{ atomId: string; sourceId: string }>;
        artifactSha256s: string[];
      };
      const sourceId = inference.sources[0]?.id ?? "source-1";
      const atomId = inference.atoms.find((atom) => atom.sourceId === sourceId)?.atomId;
      structured = {
        schemaVersion: 2,
        inferenceSnapshotSha256: inference.snapshotSha256,
        analysisRun: {
          id: "deterministic-analysis-run",
          mode: "qualitative",
          status: "not-applicable",
          implementationSha256s: [],
          environmentSha256s: [],
          inputArtifactSha256s: inference.artifactSha256s.slice(0, 1),
          command: null,
          randomSeed: null,
          limitations: [],
        },
        findings: [
          {
            id: "finding-1",
            statement: "The admitted inventory supports a bounded comparison.",
            evidence: [sourceId],
            evidenceAtomIds: atomId ? [atomId] : [],
            claimIds: [],
            analysisArtifactSha256s: [],
            uncertainty: "Bounded by the admitted inventory.",
            applicability: "The declared manufacturing comparison.",
          },
        ],
        limitations: [],
      };
    } else if (stage === "synthesize") {
      structured = {
        schemaVersion: 1,
        reportMarkdown:
          "# Findings\n\nThe admitted inventory supports a bounded comparison.\n\n# Limitations\n\nBounded evidence.",
      };
    } else if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as { packetSha256: string };
      structured = {
        schemaVersion: 1,
        packetSha256: packet.packetSha256,
        decision: "pass",
        issues: [],
        rationale: "Claims remain within the admitted evidence.",
      };
    } else {
      throw new Error(`Unexpected stage: ${stage ?? "missing"}`);
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(structured),
      stderr: "",
      tokens: 10,
      inputTokens: 6,
      cachedInputTokens: 1,
      outputTokens: 3,
      costUsd: 0.01,
      wallSeconds: 0.1,
      model: request.route.model,
      runtime: null,
    };
  };
}

function assertProviderSchemaCompatibility(value: unknown, path = "schema"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertProviderSchemaCompatibility(item, `${path}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  assert.equal(schema.$schema, undefined, `${path} pins a provider-incompatible schema dialect`);
  assert.equal(schema.uniqueItems, undefined, `${path} uses unsupported uniqueItems`);
  if (schema.properties && typeof schema.properties === "object") {
    const properties = schema.properties as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    assert.deepEqual(
      [...required].sort(),
      Object.keys(properties).sort(),
      `${path} must require every property`,
    );
    for (const [name, property] of Object.entries(properties)) {
      assert.ok(
        property && typeof property === "object" && "type" in property,
        `${path}/properties/${name} must declare type`,
      );
    }
  }
  for (const [name, item] of Object.entries(schema)) {
    assertProviderSchemaCompatibility(item, `${path}/${name}`);
  }
}

async function invoke(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function declareExternalPublicCapability(root: string, skillParent: string): Promise<void> {
  const skillPath = join(skillParent, "external-public-search");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: external-public-search\ndescription: Search a bounded external public index.\n---\n\n# Search\n",
  );
  const expectedTreeSha256 = await hashRegularTree(skillPath);
  await writeFile(
    workspacePaths(root).capabilityDeclarations,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.external-public-search",
            skillPath,
            source: {
              type: "git",
              locator: "https://github.com/example/external-public-search.git",
              immutableRef: "a".repeat(40),
              expectedTreeSha256,
              license: "MIT",
              catalogId: null,
            },
            requiredForDiscovery: false,
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["search.example.test"],
            http: {
              endpoint: "https://search.example.test/",
              accept: "application/json",
              allowedContentTypes: ["application/json"],
              maxResponseBytes: 64 * 1024,
              maxItems: 10,
            },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["*"],
              discoveryScopes: ["public-internet"],
              fullText: false,
              publicationDates: true,
            },
            credentials: [],
            healthCheck: {
              url: "https://search.example.test/health?query=connectivity",
              credentialId: null,
              expectedContentTypes: ["application/json"],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-workspace-test-"));
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

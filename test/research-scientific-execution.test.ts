import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";
import { openArtifactViews } from "../src/research/workspace/artifact-views.js";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";
import {
  prepareScientificReview,
  submitScientificReview,
  type ScientificReviewPacket,
} from "../src/research/workspace/scientific-review.js";
import { executeScientificReview } from "../src/research/workspace/scientific-review-execution.js";
import {
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
  sha256Text,
} from "../src/research/workspace/storage.js";
import type { ExecutionResult, ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";
import { appendJournalEvent, readVerifiedJournal } from "../src/research/workspace/journal.js";

describe("explicit isolated scientific review execution", () => {
  it("reserves the same affordable turn and cost envelope that the reviewer is allowed to execute", async () => {
    const fixture = await preparedFixture("execution-affordable-envelope");
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      config.reviewer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(fixture.root).config, config);
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          const event = (await readVerifiedJournal(workspacePaths(fixture.root).journal)).findLast(
            (x) => x.type === "scientific-review.execution.started",
          )!;
          const reserved = Number(event.payload.reservedTokens);
          const initialPromptTokens = Math.ceil(Buffer.byteLength(request.prompt) / 3);
          assert.ok(request.maxTurns >= 1 && request.maxTurns <= 64);
          assert.ok(
            reserved >= initialPromptTokens * request.maxTurns,
            "the reservation must cover at least the repeated initial prompt for every allowed turn",
          );
          assert.ok(reserved <= config.budget.earlyScientificReviewMaxTokens);
          assert.ok(
            request.maxCostUsd <= Number(event.payload.reservedCostUsd) + 0.000001,
            "the executor must not receive a larger spending envelope than was reserved",
          );
          return result(fixture.packet);
        },
      );
      assert.equal(executed.status, "passed", "a smaller affordable envelope should remain usable");
    } finally {
      await fixture.cleanup();
    }
  });

  it("accounts a numeric-budget review once and does not charge or execute again on replay", async () => {
    const fixture = await preparedFixture("execution-project-cost-budget");
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      config.reviewer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(fixture.root).config, config);
      let stdout = "",
        stderr = "";
      const code = await runCli(
        [
          "research",
          "project",
          "budget",
          "set",
          fixture.projectId,
          "--max-cost-usd",
          "50",
          "--confirm-budget",
          "--workspace",
          fixture.root,
          "--json",
        ],
        {
          env: {},
          stdout: {
            write: (s: string) => {
              stdout += s;
            },
          },
          stderr: {
            write: (s: string) => {
              stderr += s;
            },
          },
        },
      );
      assert.equal(code, 0, stderr);
      let calls = 0,
        charged = 0;
      const executor = async (
        request: Parameters<NonNullable<Parameters<typeof executeScientificReview>[1]>>[0],
      ) => {
        calls++;
        assert.ok(request.maxCostUsd > 0 && request.maxCostUsd <= 50);
        charged = Math.min(request.maxCostUsd, 0.02);
        return { ...result(fixture.packet), costUsd: charged };
      };
      const input = {
        ...fixture,
        role: "research-design" as const,
        confirmCost: true,
        environment: {},
      };
      await executeScientificReview(input, executor);
      const replay = await executeScientificReview(input, executor);
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1);
      stdout = "";
      stderr = "";
      assert.equal(
        await runCli(
          [
            "research",
            "status",
            "--project",
            fixture.projectId,
            "--workspace",
            fixture.root,
            "--json",
          ],
          {
            env: {},
            stdout: {
              write: (s: string) => {
                stdout += s;
              },
            },
            stderr: {
              write: (s: string) => {
                stderr += s;
              },
            },
          },
        ),
        0,
        stderr,
      );
      const budget = JSON.parse(stdout).projects[0].budget;
      assert.equal(budget.accountedEstimateUsd, charged);
      assert.equal(budget.outstandingReservationsUsd, 0);
      assert.equal(budget.providerInvoiceUsd, null);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains a completed over-budget response without accepting it or spending on recovery", async () => {
    const fixture = await preparedFixture("execution-over-budget-retention");
    try {
      const response = { ...result(fixture.packet), tokens: 200001, inputTokens: 199981 };
      let calls = 0;
      let recordBinding: { locator: string; sha256: string } | undefined;
      const execute = async () => {
        calls++;
        return response;
      };
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          execute,
        ),
        (error: unknown) => {
          const value = error as {
            code?: string;
            details?: { executionRecord?: typeof recordBinding };
          };
          assert.equal(value.code, "RESEARCH_BUDGET_EXCEEDED");
          recordBinding = value.details?.executionRecord;
          assert.ok(recordBinding, "the error must locate the safely retained returned result");
          return true;
        },
      );
      const paths = workspacePaths(fixture.root);
      assert.ok(recordBinding);
      assert.equal(
        recordBinding.locator,
        `projects/${fixture.projectId}/scientific/failed-executions/${recordBinding.sha256}.json`,
      );
      const bytes = await readFile(join(paths.control, recordBinding.locator), "utf8");
      assert.equal(sha256Text(bytes), recordBinding.sha256);
      const record = JSON.parse(bytes);
      assert.equal(record.acceptance, "not-submitted");
      assert.equal(record.packetSha256, fixture.packet.packetSha256);
      assert.equal(record.reviewerSessionSha256, fixture.packet.reviewer.sessionSha256);
      assert.equal(record.failureCode, "RESEARCH_BUDGET_EXCEEDED");
      assert.equal(record.output.disposition, "retained-json");
      assert.equal(record.output.stdout, response.stdout);
      assert.equal(record.output.sha256, sha256Text(response.stdout));
      assert.equal(record.reportedUsage.tokens, 200001);
      assert.equal(record.reportedUsage.inputTokens, 199981);
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.equal(project.usage.tokens, 200001);
      assert.equal(project.scientificDesign?.gates["research-design"].status, "prepared");
      const event = (await readVerifiedJournal(paths.journal)).findLast(
        (entry) => entry.type === "scientific-review.execution.failed",
      )!;
      assert.deepEqual(event.payload.executionRecord, recordBinding);
      assert.equal(event.payload.runId, record.runId);
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          execute,
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_RETRY_REQUIRED" },
      );
      assert.equal(calls, 1, "inspection/recovery never reruns the paid provider implicitly");
      const acceptedOutputs = await readdir(
        join(paths.projects, fixture.projectId, "scientific/execution-outputs"),
      ).catch(() => []);
      assert.deepEqual(acceptedOutputs, []);
      const retry = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, retry: true, environment: {} },
        async () => {
          calls++;
          return result(fixture.packet);
        },
      );
      assert.equal(retry.status, "passed");
      assert.equal(calls, 2);
      assert.equal(
        await readFile(join(paths.control, recordBinding.locator), "utf8"),
        bytes,
        "a new accepted retry does not overwrite the prior unaccepted result",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  for (const scenario of [
    "nonzero",
    "binding",
    "malformed",
    "sensitive",
    "escaped-secret",
    "oversized",
    "invalid-usage",
  ] as const) {
    it(`records a bounded unaccepted ${scenario} result without promoting or leaking it`, async () => {
      const fixture = await preparedFixture(`execution-retention-${scenario}`);
      try {
        const secret = "retention-private-value-1234";
        const config = await loadWorkspaceConfig(fixture.root);
        const response = result(fixture.packet);
        let expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED";
        let disposition = "retained-json";
        if (scenario === "nonzero") response.exitCode = 1;
        if (scenario === "binding") {
          response.stdout = JSON.stringify({
            ...review(fixture.packet),
            packetSha256: "0".repeat(64),
          });
          expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID";
        }
        if (scenario === "malformed") {
          response.stdout = '{"broken":';
          expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_INVALID";
          disposition = "omitted-invalid-json";
        }
        if (scenario === "sensitive" || scenario === "escaped-secret") {
          response.stdout = JSON.stringify({
            ...review(fixture.packet),
            boundedRecommendation: secret,
          });
          if (scenario === "escaped-secret")
            response.stdout = response.stdout.replace(
              secret,
              [...secret]
                .map((character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))
                .join(""),
            );
          expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE";
          disposition = "omitted-unsafe";
        }
        if (scenario === "oversized") {
          response.stdout = JSON.stringify({
            ...review(fixture.packet),
            boundedRecommendation: "x".repeat(config.budget.maxOutputTokens * 16 + 1),
          });
          expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE";
          disposition = "omitted-oversized";
        }
        if (scenario === "invalid-usage") {
          response.tokens = -1;
          expectedCode = "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID";
        }
        await assert.rejects(
          executeScientificReview(
            {
              ...fixture,
              role: "research-design",
              confirmCost: true,
              environment: { ANTHROPIC_API_KEY: secret },
            },
            async () => response,
          ),
          { code: expectedCode },
        );
        const paths = workspacePaths(fixture.root);
        const event = (await readVerifiedJournal(paths.journal)).findLast(
          (entry) => entry.type === "scientific-review.execution.failed",
        )!;
        const binding = event.payload.executionRecord as { locator: string; sha256: string };
        assert.ok(
          binding,
          "every returned result has a safe failure record, even when its body cannot be retained",
        );
        const bytes = await readFile(join(paths.control, binding.locator), "utf8");
        assert.equal(sha256Text(bytes), binding.sha256);
        const record = JSON.parse(bytes);
        assert.equal(record.acceptance, "not-submitted");
        assert.equal(record.failureCode, expectedCode);
        assert.equal(record.output.disposition, disposition);
        assert.equal(record.output.bytes, Buffer.byteLength(response.stdout));
        assert.equal(record.output.sha256, sha256Text(response.stdout));
        assert.equal(
          record.output.stdout,
          disposition === "retained-json" ? response.stdout : null,
        );
        assert.equal(record.reportedUsage === null, scenario === "invalid-usage");
        assert.ok(!bytes.includes(secret));
        assert.ok(!JSON.stringify(event).includes(secret));
        assert.equal(
          (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
            "research-design"
          ].status,
          "prepared",
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("reports unavailable failure storage without replacing the original execution error", async () => {
    const fixture = await preparedFixture("execution-retention-storage-failure");
    try {
      await writeTextAtomic(
        join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "scientific/failed-executions",
        ),
        "not a directory",
      );
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => ({ ...result(fixture.packet), tokens: 200001, inputTokens: 199981 }),
        ),
        (error: unknown) => {
          const value = error as { code?: string; details?: Record<string, unknown> };
          assert.equal(value.code, "RESEARCH_BUDGET_EXCEEDED");
          assert.equal(value.details?.outputRetention, "storage-unavailable");
          assert.equal(value.details?.executionRecord, undefined);
          return true;
        },
      );
      const event = (await readVerifiedJournal(workspacePaths(fixture.root).journal)).findLast(
        (entry) => entry.type === "scientific-review.execution.failed",
      )!;
      assert.equal(event.payload.outputRetention, "storage-unavailable");
      assert.equal(event.payload.executionRecord, undefined);
      assert.equal((await loadProject(fixture.root, fixture.projectId)).usage.tokens, 200001);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps successful review replay free of failure-capture files and extra executor calls", async () => {
    const fixture = await preparedFixture("execution-success-no-failure-capture");
    try {
      let calls = 0;
      const input = {
        ...fixture,
        role: "research-design" as const,
        confirmCost: true,
        environment: {},
      };
      const execute = async () => {
        calls++;
        return result(fixture.packet);
      };
      const accepted = await executeScientificReview(input, execute);
      const replay = await executeScientificReview(input, execute);
      assert.equal(accepted.status, "passed");
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1);
      assert.deepEqual(
        await readdir(
          join(
            workspacePaths(fixture.root).projects,
            fixture.projectId,
            "scientific/failed-executions",
          ),
        ).catch(() => []),
        [],
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("uses the approved finite cost ceiling instead of treating a rough read-cost estimate as exact", async () => {
    const fixture = await preparedFixture("execution-estimated-read-cost");
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      config.reviewer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 5,
      };
      await writeJsonAtomic(workspacePaths(fixture.root).config, config);
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.ok(
            request.maxCostUsd > 2,
            "a rough sub-dollar read estimate is not the owner's hard cost ceiling",
          );
          return { ...result(fixture.packet), costUsd: 2 };
        },
      );
      assert.equal(executed.status, "passed");
    } finally {
      await fixture.cleanup();
    }
  });
  it("does not execute a reviewer for a derived project without its authority commit", async () => {
    const fixture = await preparedFixture("execution-uncommitted-target");
    try {
      const project = await loadProject(fixture.root, fixture.projectId);
      project.lineage.kind = "fork";
      project.lineage.derivedFrom = "source";
      project.lineage.supersedes = "source";
      await saveProject(fixture.root, project);
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            calls += 1;
            return result(fixture.packet);
          },
        ),
        { code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE" },
      );
      assert.equal(calls, 0);
      assert.deepEqual((await loadProject(fixture.root, fixture.projectId)).usage, project.usage);
    } finally {
      await fixture.cleanup();
    }
  });

  it("replays only a bounded execution receipt from the exact project namespace", async () => {
    const fixture = await preparedFixture("execution-receipt-size");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const paths = workspacePaths(fixture.root);
      const event = (await readVerifiedJournal(paths.journal)).findLast(
        (item) => item.type === "scientific-review.execution.completed",
      )!;
      const original = JSON.parse(
        await readFile(join(paths.control, String(event.payload.receiptLocator)), "utf8"),
      );
      const oversized = JSON.stringify({ ...original, padding: "x".repeat(2 * 1024 * 1024) });
      const receiptSha256 = sha256Text(oversized);
      const receiptLocator = `projects/${fixture.projectId}/scientific/execution-receipts/${receiptSha256}.json`;
      await writeTextAtomic(join(paths.control, receiptLocator), oversized);
      await appendJournalEvent(paths.journal, event.type, event.scope, {
        ...event.payload,
        receiptLocator,
        receiptSha256,
      });
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically accepts only the matching completed submission during execution recovery", async () => {
    const fixture = await preparedFixture("execution-submit-replay");
    try {
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const replay = {
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design" as const,
        reviewPath: join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "scientific/execution-outputs",
          `${executed.reviewSha256}.json`,
        ),
        executionBinding: {
          packetSha256: fixture.packet.packetSha256,
          reviewSha256: executed.reviewSha256,
        },
      };
      assert.equal((await submitScientificReview(replay)).status, "passed");
      const mismatched = {
        ...replay,
        executionBinding: { ...replay.executionBinding, reviewSha256: "0".repeat(64) },
      };
      await assert.rejects(submitScientificReview(mismatched), {
        code: "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
      });
      assert.equal(
        (await readVerifiedJournal(workspacePaths(fixture.root).journal)).filter(
          (event) => event.type === "scientific-review.submitted",
        ).length,
        1,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("settles observed wall time after exceptions while retaining unknown token reservations", async () => {
    const fixture = await preparedFixture("execution-wall-throw");
    try {
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("interrupted call");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.ok(project.usage.tokens > 0);
      assert.ok(project.usage.wallSeconds > 0);
      assert.ok(project.usage.wallSeconds < 60);
    } finally {
      await fixture.cleanup();
    }
  });

  it("revalidates immutable submitted proof before replaying a completed execution", async () => {
    const fixture = await preparedFixture("execution-replay-drift");
    try {
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const path = join(
        workspacePaths(fixture.root).projects,
        fixture.projectId,
        "scientific/reviews/research-design",
        executed.reviewSha256 + ".json",
      );
      await chmod(path, 0o600);
      await writeFile(path, "{}\n");
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_GATE_INVALID" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses recovered submission when its authoritative project became abandoned", async () => {
    const fixture = await preparedFixture("execution-recovered-authority");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const project = await loadProject(fixture.root, fixture.projectId);
      project.status = "abandoned";
      project.scientificDesign!.gates["research-design"].status = "prepared";
      project.scientificDesign!.gates["research-design"].reviewSha256 = null;
      await saveProject(fixture.root, project);
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves conservative reservation when a failed call returns no usage", async () => {
    const fixture = await preparedFixture("execution-unknown-usage");
    try {
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => ({
            ...result(fixture.packet),
            exitCode: 86,
            stdout: "",
            tokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
          }),
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      assert.ok((await loadProject(fixture.root, fixture.projectId)).usage.tokens > 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reserves finite wall time before a call can be interrupted", async () => {
    const fixture = await preparedFixture("execution-wall-reserve");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.ok(
            (await loadProject(fixture.root, fixture.projectId)).usage.wallSeconds >=
              request.timeoutSeconds,
          );
          return result(fixture.packet);
        },
      );
      assert.equal((await loadProject(fixture.root, fixture.projectId)).usage.wallSeconds, 0.01);
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers oversized approved Policy through packet-bound reads without a context rejection", async () => {
    const policy =
      "# Reviewed Policy\nHuman rule: retain conflicting observations and test uncertainty.\n".repeat(
        6_000,
      );
    const fixture = await preparedFixture("execution-large-policy", true, policy);
    try {
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.equal(request.toolPolicy, "packet-read");
          assert.ok(request.artifactViews);
          assert.ok(Buffer.byteLength(request.prompt) < 128_000 * 3);
          const views = await openArtifactViews(
            request.projectRoot,
            request.artifactViews!.index,
            fixture.packet.packetSha256,
          );
          const item = views.index.objects.find((item) =>
            item.path.endsWith(`${sha256Text(policy)}.md`),
          )!;
          const read = await views.read({ objectId: item.objectId, length: null });
          assert.equal(read.content, policy);
          const value = result(fixture.packet);
          value.isolation = {
            ...value.isolation!,
            toolPolicy: "packet-read",
            networkPolicy: "reviewer-provider-and-local-artifacts",
          };
          value.artifactReads = views.receipts();
          return value;
        },
      );
      assert.equal(executed.status, "passed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("stages and embeds small approved Policy Markdown in the packet-read review", async () => {
    const fixture = await preparedFixture(
      "execution-policy-text",
      true,
      "# Reviewed Policy\nHuman rule: distinguish field observations from simulations.\n",
    );
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.match(
            request.prompt,
            /Human rule: distinguish field observations from simulations/u,
          );
          return result(fixture.packet);
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("requires explicit cost consent before invoking a reviewer", async () => {
    const fixture = await preparedFixture("execution-consent");
    try {
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: false, environment: {} },
          async () => {
            calls++;
            return result(fixture.packet);
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_COST_CONFIRMATION_REQUIRED" },
      );
      assert.equal(calls, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("executes one bound packet-read reviewer, commits proof, and replays without a model call", async () => {
    const fixture = await preparedFixture("execution-success");
    try {
      let calls = 0;
      const executor = async (
        request: Parameters<NonNullable<Parameters<typeof executeScientificReview>[1]>>[0],
      ) => {
        calls++;
        assert.equal(request.route.agent, "claude");
        assert.equal(request.toolPolicy, "packet-read");
        assert.equal(request.brokerUrl, null);
        assert.match(request.prompt, new RegExp(fixture.packet.packetSha256));
        const views = await openArtifactViews(
          request.projectRoot,
          request.artifactViews!.index,
          fixture.packet.packetSha256,
        );
        const design = views.index.objects.find(
          (item) => item.path === fixture.packet.design.objectLocator,
        )!;
        assert.match(
          (await views.read({ objectId: design.objectId, length: null })).content,
          /model-comparison|cross-model/u,
        );
        assert.equal(request.expectedRuntime, undefined);
        return result(fixture.packet);
      };
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        executor,
      );
      assert.equal(executed.status, "passed");
      assert.match(executed.receiptSha256, /^[a-f0-9]{64}$/u);
      const replay = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        executor,
      );
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "passed",
      );
      const journal = await readFile(workspacePaths(fixture.root).journal, "utf8");
      assert.match(journal, /scientific-review.execution.completed/u);
      assert.doesNotMatch(journal, /secret-execution-token/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows a mechanically nonpassing packet to receive an independent stop verdict", async () => {
    const fixture = await preparedFixture("execution-stop", false);
    try {
      assert.equal(fixture.packet.mechanicalAssessment.canPass, false);
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet, "stop"),
      );
      assert.equal(executed.status, "stopped");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records failed execution without submitting and requires an explicit bounded retry", async () => {
    const fixture = await preparedFixture("execution-failure");
    try {
      let calls = 0;
      const executor = async () => {
        calls++;
        return { ...result(fixture.packet), exitCode: 1, stderr: "synthetic provider failure" };
      };
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          executor,
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          executor,
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_RETRY_REQUIRED" },
      );
      assert.equal(calls, 1);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "prepared",
      );
      const recovered = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, retry: true, environment: {} },
        async () => result(fixture.packet),
      );
      assert.equal(recovered.status, "passed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains bounded sanitized startup diagnostics for a failed scientific reviewer", async () => {
    const fixture = await preparedFixture("execution-diagnostic");
    try {
      const secret = "scientific-review-diagnostic-secret";
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          {
            ...fixture,
            role: "research-design",
            confirmCost: true,
            environment: { ANTHROPIC_API_KEY: secret },
          },
          async () => {
            calls++;
            return {
              ...result(fixture.packet),
              exitCode: 2,
              stderr: `Unknown reviewer option. Authorization: Bearer ${secret}\nCookie: session=${secret}\n${fixture.root}/runtime/file\n${"x".repeat(5000)}`,
              telemetry: {
                eventCounts: { result: 1 },
                itemCounts: {},
                toolCalls: 0,
                providerTurns: 1,
                reasoningOutputTokens: 0,
                providerErrors: ["error_during_execution: precise provider cause"],
              },
            };
          },
        ),
        (error: unknown) => {
          const value = error as { code?: string; details?: Record<string, unknown> };
          assert.equal(value.code, "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED");
          assert.equal(value.details?.exitCode, 2);
          assert.match(String(value.details?.diagnostic), /Unknown reviewer option/u);
          assert.match(
            String(value.details?.diagnostic),
            /^error_during_execution: precise provider cause/u,
          );
          assert.ok(String(value.details?.diagnostic).length <= 2048);
          assert.doesNotMatch(JSON.stringify(value.details), new RegExp(secret));
          assert.ok(!JSON.stringify(value.details).includes(fixture.root));
          return true;
        },
      );
      const failed = (await readVerifiedJournal(workspacePaths(fixture.root).journal)).findLast(
        (event) => event.type === "scientific-review.execution.failed",
      )!;
      assert.equal(failed.payload.exitCode, 2);
      assert.match(String(failed.payload.diagnostic), /Unknown reviewer option/u);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
      assert.ok(!JSON.stringify(failed).includes(fixture.root));
      assert.equal(calls, 1);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "prepared",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks before execution when the reservation cannot fit", async () => {
    const fixture = await preparedFixture("execution-budget");
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      config.budget.earlyScientificReviewMaxTokens = 1;
      await writeJsonAtomic(workspacePaths(fixture.root).config, config);
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            calls++;
            return result(fixture.packet);
          },
        ),
        { code: "RESEARCH_BUDGET_EXCEEDED" },
      );
      assert.equal(calls, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("never persists a reflected secret and leaves the scientific gate unpassed", async () => {
    const fixture = await preparedFixture("execution-secret");
    try {
      await assert.rejects(
        executeScientificReview(
          {
            ...fixture,
            role: "research-design",
            confirmCost: true,
            environment: { ANTHROPIC_API_KEY: "secret-execution-token" },
          },
          async () => ({
            ...result(fixture.packet),
            stdout: JSON.stringify({
              ...review(fixture.packet),
              boundedRecommendation: "secret-execution-token",
            }),
          }),
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE" },
      );
      const journal = await readFile(workspacePaths(fixture.root).journal, "utf8");
      assert.doesNotMatch(journal, /secret-execution-token/u);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "prepared",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

async function preparedFixture(projectId: string, passing = true, policyText?: string) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-execute-"));
  await initializeResearchWorkspace(root, "Scientific execution fixture");
  await lockCapabilities(root);
  const config = await loadWorkspaceConfig(root);
  config.budget.earlyScientificReviewMaxTokens = 200000;
  config.budget.maxInputContextTokens = 128000;
  config.budget.maxTokens = 2000000;
  await writeJsonAtomic(workspacePaths(root).config, config);
  const policy: ResearchPolicyBinding = {
    goal: "top-journal",
    projectId,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
    targetJournal: "International Journal of Pavement Engineering",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
  };
  const design = await scientificDesignInput(root, projectId, {
    targetJournal: policy.targetJournal,
  });
  if (policyText) {
    const sha256 = sha256Text(policyText);
    const objectLocator = `policies/objects/${sha256}.md`;
    await writeTextAtomic(join(workspacePaths(root).control, objectLocator), policyText);
    policy.documents.push({
      id: "human-rule",
      kind: "baseline",
      logicalPath: "baseline.md",
      sha256,
      sourceClass: "human-customized",
      objectLocator,
    });
  }
  const project = await initializeProject(
    root,
    projectId,
    "How can model discrepancy be bounded without inventing validation?",
    undefined,
    false,
    undefined,
    policy,
    design,
  );
  const assessmentPath = join(root, "assessment.json");
  await writeJsonAtomic(assessmentPath, {
    schemaVersion: 1,
    role: "research-design",
    designSha256: project.scientificDesign!.designSha256,
    recommendation: passing ? "pass" : "stop",
    checks: {
      identityCoherent: true,
      estimandObservable: true,
      claimGraphComplete: true,
      endpointTruthRolesCorrect: true,
      quantityOntologyComplete: true,
      validationSemanticsCorrect: true,
      knownGapDispositionComplete: true,
      lifecycleFeasible: passing,
    },
    findings: [],
  });
  const packet = await prepareScientificReview({
    root,
    projectId,
    role: "research-design",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: "execution-" + projectId,
  });
  return { root, projectId, packet, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function review(packet: ScientificReviewPacket, decision: "pass" | "stop" = "pass") {
  return {
    schemaVersion: 1,
    role: packet.role,
    packetSha256: packet.packetSha256,
    reviewerSessionSha256: packet.reviewer.sessionSha256,
    decision,
    findings: [],
    boundedRecommendation: "Only the provided immutable context was independently reviewed.",
  };
}

function result(
  packet: ScientificReviewPacket,
  decision: "pass" | "stop" = "pass",
): ExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(review(packet, decision)),
    stderr: "",
    tokens: 100,
    inputTokens: 80,
    cachedInputTokens: 0,
    outputTokens: 20,
    costUsd: 0,
    wallSeconds: 0.01,
    model: null,
    runtime: {
      agent: "claude",
      model: null,
      binarySha256: "1".repeat(64),
      wrapperSha256: "2".repeat(64),
      adapterSha256: "3".repeat(64),
      binaryVersion: "fixture",
      platform: process.platform,
      architecture: process.arch,
    },
    isolation: {
      provider: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
      policySha256: "4".repeat(64),
      readScopes: ["platform-runtime", "agent-runtime", "private-capsule"],
      writeScopes: ["private-capsule"],
      networkPolicy: "reviewer-provider-and-local-artifacts",
      toolPolicy: "packet-read",
    },
  };
}

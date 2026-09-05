import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { createDataRegistry } from "../src/data/catalog.js";
import { builtInDataRegistry } from "../src/data/builtins.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import type { CliIO } from "../src/io.js";
import { stringifyJson } from "../src/io.js";
import {
  executeResearchDataCapability,
  projectResearchDataExecutionResult,
  projectResearchDataCapabilities,
  readResearchDataEvidence,
} from "../src/research/workspace/data-evidence-adapter.js";
import {
  researchDataCredentialId,
  researchDataCredentialIds,
  setCapabilityCredentialValue,
} from "../src/research/workspace/credentials.js";
import { loadProjectEvidenceReceipts } from "../src/research/workspace/evidence.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import { initializeProject } from "../src/research/workspace/projects.js";
import {
  abortNativeResearchStage,
  prepareNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import { workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

function request(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "test.synthetic",
    capabilityVersion: "1.0.0",
    operationId: "echo",
    operationVersion: "1.0.0",
    input: { value: "research evidence" },
  };
}

async function invokeCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

describe("research data evidence adapter", () => {
  it("projects every registered operation without a per-capability research adapter", () => {
    const projection = projectResearchDataCapabilities(createDataRegistry([syntheticConnector()]));

    assert.equal(projection.capabilities.length, 1);
    assert.equal(projection.capabilities[0]?.id, "data:test.synthetic:echo");
    assert.equal(projection.capabilities[0]?.capabilityId, "test.synthetic");
    assert.equal(projection.capabilities[0]?.operationId, "echo");
    assert.equal(projection.capabilities[0]?.summary, "Echo one validated string.");
    assert.match(projection.capabilities[0]?.manifestDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(projection.catalogDigest, /^[a-f0-9]{64}$/);
  });

  it("executes the shared TypeScript runtime and only adds research evidence state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-adapter-"));
    const registry = createDataRegistry([syntheticConnector()]);
    const clock = () => new Date("2026-08-31T00:00:00.000Z");
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-evidence", "Use one structured data result.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-evidence",
        stage: "discover",
        hostAgent: "codex",
      });

      const standalone = await executeDataRun(request(), { registry, environment: {}, clock });
      const adapted = await executeResearchDataCapability({
        root,
        projectId: "data-evidence",
        request: request(),
        registry,
        clock,
      });

      assert.deepEqual(adapted.coreResult, standalone);
      assert.equal(adapted.evidenceReceipt?.evidenceKind, "data");
      assert.equal(
        adapted.evidenceReceipt?.data?.coreReceiptDigest,
        standalone.receipt.receiptDigest,
      );
      assert.equal(adapted.evidenceReceipt?.capabilityId, "data:test.synthetic:echo");
      assert.equal(adapted.candidate?.origin.kind, "data");
      assert.equal(adapted.candidate?.origin.receiptId, adapted.evidenceReceipt?.attemptId);

      const [receipt] = await loadProjectEvidenceReceipts(root, "data-evidence");
      assert.equal(receipt?.data?.coreReceiptDigest, standalone.receipt.receiptDigest);
      const persisted = JSON.parse(
        await readFile(join(workspacePaths(root).control, receipt!.locator), "utf8"),
      ) as { receipt: { receiptDigest: string } };
      assert.equal(persisted.receipt.receiptDigest, standalone.receipt.receiptDigest);
      assert.equal((await listEvidenceCandidates(root, "data-evidence")).length, 1);

      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /data\.capability\.requested/);
      assert.match(journal, /data\.capability\.completed/);
      await abortNativeResearchStage({
        root,
        projectId: "data-evidence",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps acquisition limits intact and applies item budgets only to the Agent context view", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-view-budget-"));
    let observedLimits: { maxRecords: number; maxResponseBytes: number } | undefined;
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.tiangong.ai/data/test/synthetic-records-output.v1.json",
      type: "object",
      additionalProperties: false,
      required: ["records"],
      properties: {
        records: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "value"],
            properties: {
              id: { type: "integer" },
              value: { type: "string" },
            },
          },
        },
      },
    } as const;
    const records = Array.from({ length: 144 }, (_, id) => ({ id, value: `record-${id}` }));
    const registry = createDataRegistry([
      syntheticConnector({
        limits: { maxRecords: 1_000, maxResponseBytes: 1_048_576 },
        outputSchema,
        execute: (context) => {
          observedLimits = {
            maxRecords: context.limits.maxRecords,
            maxResponseBytes: context.limits.maxResponseBytes,
          };
          return {
            status: "success",
            data: { records },
            summary: {
              recordCount: records.length,
              pageCount: 1,
              chunkCount: 1,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [],
          };
        },
      }),
    ]);
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-view-budget", "Preserve all returned data records.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-view-budget",
        stage: "discover",
        hostAgent: "codex",
      });

      const result = await executeResearchDataCapability({
        root,
        projectId: "data-view-budget",
        request: request(),
        registry,
      });

      assert.deepEqual(observedLimits, { maxRecords: 1_000, maxResponseBytes: 1_048_576 });
      assert.equal(result.coreResult.summary.recordCount, 144);
      assert.equal(result.coreResult.summary.truncated, false);
      assert.equal(result.communication?.requestCoverage.status, "complete");
      assert.equal(result.communication?.contextView.status, "projected");
      assert.equal(result.communication?.contextView.strategy, "record-prefix");
      assert.equal(result.communication?.contextView.itemCount, 100);
      assert.equal(result.communication?.contextView.totalItems, 144);
      assert.equal(result.evidenceReceipt?.contextItems, 100);
      assert.equal(result.evidenceReceipt?.contextTotalItems, 144);
      assert.equal(result.evidenceReceipt?.contextNextOffset, 100);
      assert.equal(result.evidenceReceipt?.contextTruncated, true);
      assert.equal(result.evidenceReceipt?.data?.coverage?.status, "complete");
      assert.equal(result.evidenceReceipt?.data?.contextView?.status, "projected");

      const bounded = JSON.parse(result.boundedContext!.text) as {
        data: { contextView: { itemCount: number }; value: { records: unknown[] } };
      };
      assert.equal(bounded.data.contextView.itemCount, 100);
      assert.equal(bounded.data.value.records.length, 100);
      const persisted = JSON.parse(
        await readFile(join(workspacePaths(root).control, result.evidenceReceipt!.locator), "utf8"),
      ) as { data: { records: unknown[] } };
      assert.equal(persisted.data.records.length, 144);
      assert.match(result.candidate?.excerpt ?? "", /Request coverage is complete/);
      assert.match(result.candidate?.excerpt ?? "", /100\/144/);
      assert.match(result.candidate?.excerpt ?? "", /continue reading/i);

      const publicResult = projectResearchDataExecutionResult(result);
      const serializedPublicResult = stringifyJson(publicResult, true);
      assert.equal("coreResult" in publicResult, false);
      assert.equal("boundedContext" in publicResult, false);
      assert.ok(
        Buffer.byteLength(serializedPublicResult, "utf8") <= publicResult.outputBudget.maxBytes,
      );
      assert.doesNotMatch(serializedPublicResult, /record-100/);
      assert.equal(publicResult.contextView?.itemCount, 100);
      assert.equal(
        (
          publicResult.contextView?.content as {
            records?: unknown[];
          }
        ).records?.length,
        100,
      );

      const second = await readResearchDataEvidence({
        root,
        projectId: "data-view-budget",
        receiptId: result.evidenceReceipt!.attemptId,
        cursor: result.communication!.contextView.nextCursor!,
      });
      assert.equal(second.communication.contextView.offset, 100);
      assert.equal(second.communication.contextView.itemCount, 44);
      assert.equal(second.communication.contextView.remainingItems, 0);
      assert.equal(second.communication.contextView.nextCursor, null);
      const secondPage = JSON.parse(second.boundedContext.text) as {
        data: { value: { records: Array<{ id: number }> } };
      };
      assert.deepEqual(
        secondPage.data.value.records.map((record) => record.id),
        Array.from({ length: 44 }, (_, index) => index + 100),
      );

      const cliRead = await invokeCli([
        "research",
        "project",
        "evidence",
        "data",
        "read",
        "data-view-budget",
        "--receipt",
        result.evidenceReceipt!.attemptId,
        "--cursor",
        result.communication!.contextView.nextCursor!,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(cliRead.exitCode, 0, cliRead.stderr);
      const cliPage = JSON.parse(cliRead.stdout) as {
        contextView: {
          offset: number;
          nextCursor: string | null;
          content: { records: Array<{ id: number }> };
        };
        outputBudget: { maxBytes: number };
      };
      assert.equal("boundedContext" in cliPage, false);
      assert.ok(Buffer.byteLength(cliRead.stdout, "utf8") <= cliPage.outputBudget.maxBytes);
      assert.equal(cliPage.contextView.offset, 100);
      assert.equal(cliPage.contextView.nextCursor, null);
      assert.equal(cliPage.contextView.content.records.length, 44);

      const projected = projectResearchDataCapabilities(registry).capabilities[0];
      assert.equal(projected?.resultShape, "record-list");
      await abortNativeResearchStage({
        root,
        projectId: "data-view-budget",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes the built-in data registry through the native discover packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-packet-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-packet", "Discover structured public evidence.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-packet",
        stage: "discover",
        hostAgent: "codex",
      });

      assert.ok(packet.commands.runDataCapability);
      assert.ok(packet.commands.runDataCapability.readArgv);
      assert.equal(packet.commands.runDataCapability.executionKind, "workspace-cli-relative-argv");
      assert.equal(
        packet.commands.runDataCapability.catalog.capabilities.length,
        packet.commands.runDataCapability.catalog.capabilities.filter((capability) =>
          capability.id.startsWith("data:"),
        ).length,
      );
      const registeredOperationCount = builtInDataRegistry
        .catalog()
        .capabilities.filter((capability) => capability.availability.status === "available")
        .reduce((total, capability) => total + capability.operations.length, 0);
      assert.equal(
        packet.commands.runDataCapability.catalog.capabilities.length,
        registeredOperationCount,
      );
      assert.deepEqual(packet.commands.runDataCapability.argv.slice(0, 5), [
        "research",
        "project",
        "evidence",
        "data",
        "run",
      ]);
      assert.equal(packet.commands.runDataCapability.readArgv[0], "research");
      assert.deepEqual(packet.commands.runDataCapability.describeArgv, [
        "data",
        "describe",
        "<capability-id>",
        "--json",
      ]);
      assert.equal(
        packet.commands.runDataCapability.catalog.capabilities.some((capability) =>
          capability.capabilityId.startsWith("regulations-gov."),
        ),
        false,
      );
      assert.match(packet.prompt, /structured data capabilities/i);
      await abortNativeResearchStage({
        root,
        projectId: "data-packet",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects a namespaced owner-only credential without leaking it into evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-credential-"));
    const registry = createDataRegistry([syntheticConnector({ credential: true })]);
    const secret = "research-data-secret-marker";
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-credential", "Use credentialed structured data.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-credential",
        stage: "discover",
        hostAgent: "codex",
      });
      const credentialId = researchDataCredentialId("test.synthetic", "api-token");
      await setCapabilityCredentialValue({
        root,
        declaredCredentialIds: researchDataCredentialIds(registry),
        credentialId,
        value: secret,
        minimumUtf8Bytes: 8,
      });

      const result = await executeResearchDataCapability({
        root,
        projectId: "data-credential",
        request: request(),
        registry,
      });

      assert.equal(result.coreResult.status, "success");
      assert.equal(result.evidenceReceipt?.evidenceKind, "data");
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.doesNotMatch(journal, new RegExp(secret));
      const evidence = await readFile(
        join(workspacePaths(root).control, result.evidenceReceipt!.locator),
        "utf8",
      );
      assert.doesNotMatch(evidence, new RegExp(secret));
      await abortNativeResearchStage({
        root,
        projectId: "data-credential",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit provider credentials from the host environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-ambient-credential-"));
    let networkRequests = 0;
    const registry = createDataRegistry([
      syntheticConnector({
        credential: true,
        execute: async (context) => {
          const response = await context.http.request({
            endpointId: "primary",
            method: "GET",
            path: "/v1/echo",
            credentialId: "api-token",
          });
          return {
            status: "success",
            data: { echoed: response.text() },
            summary: {
              recordCount: 1,
              pageCount: 1,
              chunkCount: 0,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [response.observation],
          };
        },
      }),
    ]);
    const previous = process.env.TIANGONG_DATA_TEST_TOKEN;
    process.env.TIANGONG_DATA_TEST_TOKEN = "ambient-provider-secret";
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-ambient", "Reject ambient provider credentials.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-ambient",
        stage: "discover",
        hostAgent: "codex",
      });

      const result = await executeResearchDataCapability({
        root,
        projectId: "data-ambient",
        request: request(),
        registry,
        fetchImpl: async () => {
          networkRequests += 1;
          return new Response('"network-result"', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      await abortNativeResearchStage({
        root,
        projectId: "data-ambient",
        sessionId: packet.sessionId,
      });

      assert.equal(result.coreResult.status, "blocked");
      assert.equal(result.coreResult.errors[0]?.code, "credential-missing");
      assert.equal(result.evidenceReceipt, null);
      assert.equal(result.candidate, null);
      assert.equal(networkRequests, 0);
    } finally {
      if (previous === undefined) delete process.env.TIANGONG_DATA_TEST_TOKEN;
      else process.env.TIANGONG_DATA_TEST_TOKEN = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

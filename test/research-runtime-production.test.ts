import assert from "node:assert/strict";
import { openArtifactViews } from "../src/research/workspace/artifact-views.js";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { registerEvidenceArtifact } from "../src/research/workspace/artifacts.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import {
  fetchNativeCandidateSource,
  startCapabilityBroker,
} from "../src/research/workspace/broker.js";
import { readAndVerifyProjectInputPlan } from "../src/research/workspace/input-plan.js";
import { appendJournalEvent } from "../src/research/workspace/journal.js";
import { doctorExternalCapabilities } from "../src/research/workspace/external-skills.js";
import {
  loadProjectEvidenceReceipts,
  stageProjectEvidence,
} from "../src/research/workspace/evidence.js";
import {
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "../src/research/workspace/evidence-ledger.js";
import { inspectEvidenceAccessStatus } from "../src/research/workspace/evidence-exhaustion.js";
import type { AgentExecutionRequest } from "../src/research/workspace/executor.js";
import {
  addProjectInput,
  forkProject,
  initializeProject,
  loadProject,
  nextReadyPackage,
  retryProjectPackage,
  saveProject,
  setProjectBudget,
} from "../src/research/workspace/projects.js";
import {
  abortNativeResearchStage,
  nativeEvidenceRequestSchema,
  prepareNativeResearchStage,
  runResearchWorkspaceWithInjectedProducerForTesting as runResearchWorkspace,
  type PackageExecutor,
} from "../src/research/workspace/runtime.js";
import {
  hashRegularTree,
  regularTreeFiles,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import type { ExecutionResult, ResearchPolicyBinding } from "../src/research/workspace/types.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
  verifyDoctorAttestation,
} from "../src/research/workspace/workspace.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";

describe("production research evidence and broker", () => {
  it("publishes the acquisition route required by scientific broker requests", () => {
    const ordinary = nativeEvidenceRequestSchema(false) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const scientific = nativeEvidenceRequestSchema(true) as {
      required: string[];
      properties: Record<string, unknown>;
    };

    assert.equal(ordinary.required.includes("acquisition_route_id"), false);
    assert.equal(scientific.required.includes("acquisition_route_id"), true);
    assert.ok(scientific.properties.acquisition_route_id);
    assert.deepEqual(scientific.properties.acquisition_route_id, {
      type: "string",
      description: "Exact broker-capability route ID from the frozen scientific design.",
    });
  });

  it("auto-selects and paginates known provider result collections", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "provider-result-collections", "Bound provider results.");
      await installNetworkCapability(root, skillParent);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "provider-result-collections",
        stage: "discover",
        hostAgent: "codex",
      });
      globalThis.fetch = async (request) => {
        const shape = new URL(String(request)).searchParams.get("shape");
        const results = [0, 1, 2].map((index) => ({
          title: `${shape}-${index}`,
          url: `https://source.test/${shape}/${index}`,
        }));
        return new Response(
          JSON.stringify(shape === "web" ? { web: { results } } : { type: "news", results }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      for (const shape of ["news", "web"] as const) {
        const result = await fetchNativeCandidateSource({
          root,
          projectId: "provider-result-collections",
          request: {
            capability_id: "method.public-source",
            url: `https://source.test/items?shape=${shape}`,
            max_items: 2,
          },
        });
        assert.equal(result.contextItems, 2);
        assert.equal(result.contextTotalItems, 3);
        assert.equal(result.contextNextOffset, 2);
        assert.equal(result.contextTruncated, true);
        assert.equal((result.candidates as unknown[]).length, 2);
        assert.deepEqual(
          (result.candidates as Array<{ origin: { jsonPointer: string } }>).map(
            (candidate) => candidate.origin.jsonPointer,
          ),
          [
            `/${shape === "web" ? "web/results" : "results"}/0`,
            `/${shape === "web" ? "web/results" : "results"}/1`,
          ],
        );
        const bounded = result.boundedContext as { encoding: string; text: string };
        assert.equal(bounded.encoding, "utf8");
        assert.equal((JSON.parse(bounded.text) as unknown[]).length, 2);
      }
      await abortNativeResearchStage({
        root,
        projectId: "provider-result-collections",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("persists a safe derivative when a JSON provider response contains credential-like metadata", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "sensitive-provider-response", "Reject unsafe provider data.");
      await installNetworkCapability(root, skillParent);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "sensitive-provider-response",
        stage: "discover",
        hostAgent: "codex",
      });
      globalThis.fetch = async () =>
        new Response(
          '{"results":[{"title":"Safe result","url":"https://source.test/public","api_key":"provider-secret-marker"}]}',
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );

      const result = await fetchNativeCandidateSource({
        root,
        projectId: "sensitive-provider-response",
        request: {
          capability_id: "method.public-source",
          url: "https://source.test/items?q=sensitive-response",
          json_pointer: "/results",
        },
      });
      assert.equal(result.redactions, 1);
      assert.equal((result.candidates as unknown[]).length, 1);
      const receipts = await loadProjectEvidenceReceipts(root, "sensitive-provider-response");
      assert.equal(receipts.length, 1);
      const persisted = await readFile(
        join(workspacePaths(root).control, receipts[0]!.locator),
        "utf8",
      );
      assert.match(persisted, /Safe result/);
      assert.doesNotMatch(persisted, /api_key|provider-secret-marker/);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /capability\.fetch\.completed/);
      assert.doesNotMatch(journal, /provider-secret-marker/);
      await abortNativeResearchStage({
        root,
        projectId: "sensitive-provider-response",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("preserves ordinary academic Basic phrases in provider responses", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "ordinary-basic-phrases", "Admit ordinary academic text.");
      await installNetworkCapability(root, skillParent);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "ordinary-basic-phrases",
        stage: "discover",
        hostAgent: "codex",
      });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Basic conception and basic principle",
                url: "https://source.test/basic-conception",
                abstract: "Basic approaches remain ordinary academic prose.",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );

      const result = await fetchNativeCandidateSource({
        root,
        projectId: "ordinary-basic-phrases",
        request: {
          capability_id: "method.public-source",
          url: "https://source.test/items?q=basic-principle",
          json_pointer: "/results",
        },
      });

      assert.equal((result.candidates as unknown[]).length, 1);
      const bounded = result.boundedContext as { encoding: string; text: string };
      assert.equal(bounded.encoding, "utf8");
      assert.match(bounded.text, /Basic conception and basic principle/);
      assert.match(bounded.text, /Basic approaches remain ordinary academic prose/);
      await abortNativeResearchStage({
        root,
        projectId: "ordinary-basic-phrases",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("returns a structured sanitized error for an unprojectable sensitive text response", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "sensitive-text-response", "Reject unsafe provider text.");
      await installNetworkCapability(root, skillParent, {
        accept: "text/plain",
        allowedContentTypes: ["text/plain"],
        maxResponseBytes: 64 * 1024,
        maxItems: 20,
      });
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "sensitive-text-response",
        stage: "discover",
        hostAgent: "codex",
      });
      globalThis.fetch = async () =>
        new Response("Authorization: Bearer provider-secret-marker", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });

      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId: "sensitive-text-response",
          request: {
            capability_id: "method.public-source",
            url: "https://source.test/items?q=sensitive-text",
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_BROKER_RESPONSE_REJECTED");
          assert.doesNotMatch(error.message, /provider-secret-marker/);
          return true;
        },
      );
      assert.equal((await loadProjectEvidenceReceipts(root, "sensitive-text-response")).length, 0);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /capability\.fetch\.failed/);
      assert.doesNotMatch(journal, /provider-secret-marker/);
      await abortNativeResearchStage({
        root,
        projectId: "sensitive-text-response",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("binds one native-host evidence fetch to the active discover stage", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "native-fetch", "Evaluate native broker evidence.");
      await installNetworkCapability(root, skillParent);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "native-fetch",
        stage: "discover",
        hostAgent: "codex",
      });
      assert.ok(packet.commands.fetchEvidence);
      globalThis.fetch = async () =>
        new Response('{"records":[{"id":"native"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const receipt = await fetchNativeCandidateSource({
        root,
        projectId: "native-fetch",
        request: {
          capability_id: "method.public-source",
          url: "https://source.test/items?q=native",
        },
      });
      assert.match(String(receipt.locator), /^evidence\/objects\//);
      assert.equal((receipt.brokerBudget as { startedCalls: number }).startedCalls, 1);
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId: "native-fetch",
          request: {
            capability_id: "method.public-source",
            url: "https://source.test/items?api_key=must-not-leak",
          },
        }),
        /locked endpoint or method policy/i,
      );
      assert.doesNotMatch(await readFile(workspacePaths(root).journal, "utf8"), /must-not-leak/);
      await abortNativeResearchStage({
        root,
        projectId: "native-fetch",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("binds a broker terminal event to one exact scientific acquisition route", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    const projectId = "broker-acquisition-route";
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      const policy = scientificPolicyBinding(projectId);
      const design = await scientificDesignInput(root, projectId, {
        targetJournal: policy.targetJournal,
        brokerCapabilityId: "method.public-source",
      });
      const project = await initializeProject(
        root,
        projectId,
        "Can all configured broker routes retrieve the required scientific evidence?",
        undefined,
        false,
        undefined,
        policy,
        design,
      );
      const discover = project.packages.find((workPackage) => workPackage.id === "discover");
      assert.ok(discover);
      discover.status = "running";
      discover.startedAt = new Date().toISOString();
      project.status = "running";
      await saveProject(root, project);
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId,
          request: {
            capability_id: "method.public-source",
            url: "https://source.test/items?q=unbound",
          },
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_EVIDENCE_ACQUISITION_ROUTE_INVALID",
      );

      globalThis.fetch = async () =>
        new Response('{"error":"invalid request"}', {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId,
          request: {
            acquisition_route_id: "route-native-public-search",
            capability_id: "method.public-source",
            url: "https://source.test/items?q=invalid-request",
          },
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_BROKER_HTTP_ERROR",
      );
      const invalidRequestStatus = await inspectEvidenceAccessStatus(root, projectId);
      assert.deepEqual(invalidRequestStatus.untriedRequiredAgentRouteIds, [
        "route-native-public-search",
      ]);

      globalThis.fetch = async () =>
        new Response('{"error":"subscription required"}', {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId,
          request: {
            acquisition_route_id: "route-native-public-search",
            capability_id: "method.public-source",
            url: "https://source.test/items?q=licensed",
          },
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "PROVIDER_AUTHENTICATION_FAILED",
      );
      const blockedStatus = await inspectEvidenceAccessStatus(root, projectId);
      assert.deepEqual(blockedStatus.untriedRequiredAgentRouteIds, []);
      assert.equal(
        blockedStatus.routes[0]?.terminalEvents.at(-1)?.classification,
        "access-blocked",
      );

      globalThis.fetch = async () =>
        new Response('{"results":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      await fetchNativeCandidateSource({
        root,
        projectId,
        request: {
          acquisition_route_id: "route-native-public-search",
          capability_id: "method.public-source",
          url: "https://source.test/items?q=bound",
        },
      });
      const access = await inspectEvidenceAccessStatus(root, projectId);
      assert.deepEqual(access.untriedRequiredAgentRouteIds, []);
      assert.match(access.routes[0]?.terminalEventHashes[0] ?? "", /^[a-f0-9]{64}$/);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("reuses an equivalent project request without another provider call while bounding views", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      const configPath = workspacePaths(root).config;
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        budget: { maxBrokerCalls: number };
      };
      config.budget.maxBrokerCalls = 2;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "project-request-reuse", "Deduplicate one project request.");
      await installNetworkCapability(root, skillParent);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "project-request-reuse",
        stage: "discover",
        hostAgent: "codex",
      });
      let providerCalls = 0;
      globalThis.fetch = async () => {
        providerCalls += 1;
        return new Response(
          '{"records":[{"title":"Stable source","url":"https://source.test/public"}]}',
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const request = {
        capability_id: "method.public-source",
        url: "https://source.test/items?q=stable",
        json_pointer: "/records",
        cache_mode: "bypass",
      };
      const first = await fetchNativeCandidateSource({
        root,
        projectId: "project-request-reuse",
        request,
      });
      const second = await fetchNativeCandidateSource({
        root,
        projectId: "project-request-reuse",
        request,
      });
      assert.equal(providerCalls, 1);
      assert.equal(first.networkAttempted, true);
      assert.equal(second.networkAttempted, false);
      assert.equal(second.reuseScope, "project");
      assert.equal((second.brokerBudget as { startedCalls: number }).startedCalls, 2);
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId: "project-request-reuse",
          request,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_BROKER_CALL_LIMIT_EXCEEDED",
      );
      assert.equal(providerCalls, 1);
      assert.equal((await loadProjectEvidenceReceipts(root, "project-request-reuse")).length, 2);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /capability\.fetch\.reused/);
      await abortNativeResearchStage({
        root,
        projectId: "project-request-reuse",
        sessionId: packet.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("funds concurrent HTTP operations before network access and reuses both caches for free", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    const brokers: Array<NonNullable<Awaited<ReturnType<typeof startCapabilityBroker>>>> = [];
    let networkCalls = 0;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "priced-broker", "Exercise HTTP budget admission.");
      await installNetworkCapability(root, skillParent, {
        endpoint: "https://source.test/items",
        accept: "application/json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 64 * 1024,
        maxItems: 2,
      });
      await setProjectBudget(root, "priced-broker", 9, true);
      const capsule = join(workspacePaths(root).runtime, "priced-broker", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "priced-broker", capsule);
      assert.ok(broker);
      brokers.push(broker);
      const call = (url: string, endpoint = broker.url) => callBroker(endpoint, url);
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://source.test/")) return originalFetch(input, init);
        networkCalls++;
        const state = await loadProject(root, "priced-broker");
        assert.ok(
          state.budget!.entries.some(
            (entry) => entry.status === "reserved" && entry.maxCostUsd === 4,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (String(input).includes("failure"))
          return new Response("limited", {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        return new Response('{"records":[{"id":1}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      assert.match(
        JSON.stringify(await call("https://source.test/items?unknown")),
        /RESEARCH_PROJECT_BUDGET_PRICE_REQUIRED/,
      );
      assert.equal(networkCalls, 0);
      await setProjectBudget(root, "priced-broker", 9, true, { "method.public-source": 4 });
      const urls = [1, 2, 3].map((id) => `https://source.test/items?id=${id}`);
      const results = await Promise.all(urls.map((url) => call(url)));
      assert.equal(results.filter((result) => !JSON.parse(result).code).length, 2);
      assert.equal(
        results.filter((result) =>
          JSON.stringify(result).includes("RESEARCH_BUDGET_RESERVATION_FAILED"),
        ).length,
        1,
      );
      assert.equal(networkCalls, 2);
      const ledger = (await loadProject(root, "priced-broker")).budget!;
      assert.equal(ledger.entries.length, 2);
      assert.ok(
        ledger.entries.every(
          (entry) =>
            entry.status === "settled" &&
            entry.accountedCostUsd === 4 &&
            entry.settlementBasis === "allocated-upper-bound",
        ),
      );
      const reusedUrl = urls[results.findIndex((result) => !JSON.parse(result).code)]!;
      const local = await call(reusedUrl);
      assert.equal(JSON.parse(local).reuseScope, "project", local);
      assert.doesNotMatch(JSON.stringify(local), /RESEARCH_BUDGET_RESERVATION_FAILED/);
      await initializeProject(root, "cache-consumer", "Reuse already fetched public evidence.");
      await setProjectBudget(root, "cache-consumer", 1, true);
      const second = await startCapabilityBroker(root, "cache-consumer", capsule);
      assert.ok(second);
      brokers.push(second);
      const shared = await call(reusedUrl, second.url);
      assert.equal(JSON.parse(shared).reuseScope, "workspace", shared);
      assert.doesNotMatch(JSON.stringify(shared), /PRICE_REQUIRED/);
      assert.equal((await loadProject(root, "cache-consumer")).budget!.entries.length, 0);
      assert.equal(networkCalls, 2);
      await setProjectBudget(root, "priced-broker", 13, true);
      const failed = await call("https://source.test/items?failure");
      assert.match(JSON.stringify(failed), /RESEARCH_BROKER_HTTP_ERROR/);
      assert.equal(networkCalls, 4, "one logical allocation includes the bounded retry");
      const final = (await loadProject(root, "priced-broker")).budget!;
      assert.equal(final.entries.length, 3);
      assert.equal(
        final.entries.reduce((sum, entry) => sum + (entry.accountedCostUsd ?? 0), 0),
        12,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all(brokers.map((broker) => broker.stop()));
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("drains provider accounting after the MCP caller disconnects", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    let broker: Awaited<ReturnType<typeof startCapabilityBroker>>;
    let release = () => {};
    let entered = () => {};
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const providerReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "disconnected-budget",
        "Keep obligations after transport disconnect.",
      );
      await installNetworkCapability(root, skillParent);
      await setProjectBudget(root, "disconnected-budget", 5, true, { "method.public-source": 4 });
      const capsule = join(workspacePaths(root).runtime, "disconnected", "project");
      await mkdir(capsule, { recursive: true });
      broker = await startCapabilityBroker(root, "disconnected-budget", capsule);
      assert.ok(broker);
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://source.test/")) return originalFetch(input, init);
        entered();
        await providerReleased;
        return new Response('{"records":[{"id":1}]}', {
          headers: { "content-type": "application/json" },
        });
      };
      const controller = new AbortController();
      const pending = originalFetch(broker.url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fetch_candidate_source",
            arguments: { capability_id: "method.public-source", url: "https://source.test/items" },
          },
        }),
      }).catch(() => undefined);
      await providerEntered;
      controller.abort();
      await pending;
      let stopped = false;
      const stopping = broker.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        stopped,
        false,
        "socket closure cannot complete shutdown before funded work settles",
      );
      release();
      await stopping;
      await broker.stop();
      const entries = (await loadProject(root, "disconnected-budget")).budget!.entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.status, "settled");
      assert.equal(entries[0]!.accountedCostUsd, 4);
      assert.equal((await loadProjectEvidenceReceipts(root, "disconnected-budget")).length, 1);
    } finally {
      release();
      await broker?.stop();
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("persists exact broker evidence and includes verified objects in the review packet", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "broker-evidence", "Evaluate one broker evidence chain.");
      await installNetworkCapability(root, skillParent, {
        endpoint: "https://source.test/items",
        accept: "application/vnd.source+json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 64 * 1024,
        maxItems: 2,
      });
      let observedAccept = "";
      let sourceFetches = 0;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://source.test/")) {
          sourceFetches += 1;
          observedAccept = new Headers(init?.headers).get("accept") ?? "";
          return new Response(JSON.stringify({ records: [{ id: 1 }, { id: 2 }, { id: 3 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      const prefetchCapsule = join(workspacePaths(root).runtime, "prefetch", "project");
      await mkdir(prefetchCapsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "broker-evidence", prefetchCapsule);
      assert.ok(broker);
      let receipt!: Record<string, unknown>;
      let paginatedReceipt!: Record<string, unknown>;
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            max_items: 1,
          },
        });
        const result = response.result as Record<string, unknown>;
        assert.notEqual(result.isError, true, JSON.stringify(result));
        receipt = JSON.parse(
          String(((result.content as Array<Record<string, unknown>>)[0] ?? {}).text),
        ) as Record<string, unknown>;
        const cachedResponse = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            max_items: 1,
          },
        });
        const cachedReceipt = JSON.parse(
          String(
            (
              (
                (cachedResponse.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
        assert.equal(cachedReceipt.cacheHit, true);
        assert.equal(cachedReceipt.sha256, receipt.sha256);
        const paginatedResponse = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            item_offset: 1,
            max_items: 1,
          },
        });
        paginatedReceipt = JSON.parse(
          String(
            (
              (
                (paginatedResponse.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
        const outsideEndpoint = await callBroker(broker.url, "https://source.test/outside");
        assert.match(JSON.stringify(outsideEndpoint), /BROKER_CREDENTIAL_INJECTION_REJECTED/);
      } finally {
        await broker.stop();
      }
      await rm(join(workspacePaths(root).runtime, "prefetch"), {
        recursive: true,
        force: true,
      });

      assert.equal(observedAccept, "application/vnd.source+json");
      assert.equal(sourceFetches, 1);
      assert.match(String(receipt.locator), /^evidence\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      assert.equal(receipt.contextItems, 1);
      assert.equal(receipt.contextOffset, 0);
      assert.equal(receipt.contextTotalItems, 3);
      assert.equal(receipt.contextNextOffset, 1);
      assert.equal(receipt.contextTruncated, true);
      assert.equal(paginatedReceipt.cacheHit, true);
      assert.equal(paginatedReceipt.sha256, receipt.sha256);
      assert.equal(paginatedReceipt.contextOffset, 1);
      assert.equal(paginatedReceipt.contextTotalItems, 3);
      assert.equal(paginatedReceipt.contextNextOffset, 2);
      const rawPath = join(workspacePaths(root).control, String(receipt.locator));
      const contextPath = join(workspacePaths(root).control, String(receipt.contextLocator));
      assert.deepEqual(JSON.parse(await readFile(rawPath, "utf8")), {
        records: [{ id: 1 }, { id: 2 }, { id: 3 }],
      });
      assert.deepEqual(JSON.parse(await readFile(contextPath, "utf8")), [{ id: 1 }]);
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(workspacePaths(root).control, String(paginatedReceipt.contextLocator)),
            "utf8",
          ),
        ),
        [{ id: 2 }],
      );

      const fundedConfig = await loadWorkspaceConfig(root);
      for (const route of [fundedConfig.producer, fundedConfig.reviewer])
        route.pricing = {
          inputUsdPerMillionTokens: 1,
          cachedInputUsdPerMillionTokens: 0.1,
          outputUsdPerMillionTokens: 2,
        };
      await writeJsonAtomic(workspacePaths(root).config, fundedConfig);
      await setProjectBudget(root, "broker-evidence", 100, true, { "method.public-source": 4 });
      let reviewVerified = false;
      const normal = brokerBackedExecutor(() => {
        reviewVerified = true;
      });
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        async (request) => {
          if (stageFrom(request) === "discover") {
            assert.ok(request.brokerUrl);
            const fetched = JSON.parse(
              await callBroker(request.brokerUrl, "https://source.test/items?page=2"),
            );
            assert.equal(fetched.networkAttempted, true, JSON.stringify(fetched));
          }
          return normal(request);
        },
      );
      const providerEntries = (await loadProject(root, "broker-evidence")).budget!.entries.filter(
        (entry) => entry.kind === "provider-operation",
      );
      assert.equal(
        providerEntries.length,
        1,
        "package completion preserves provider ledger writes made while the executor was running",
      );
      assert.equal(providerEntries[0]!.accountedCostUsd, 4);
      assert.equal(sourceFetches, 2);
      assert.equal(
        result.status,
        "complete",
        JSON.stringify({ result, project: await loadProject(root, "broker-evidence") }),
      );
      assert.equal(reviewVerified, true);
      const review = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "broker-evidence", "outputs", "review.json"),
          "utf8",
        ),
      ) as { packetSha256: string };
      const persistentPacketPath = join(
        workspacePaths(root).projects,
        "broker-evidence",
        "review",
        "packets",
        `${review.packetSha256}.json`,
      );
      const persistentPacket = JSON.parse(await readFile(persistentPacketPath, "utf8")) as {
        packetSha256: string;
        reviewEvidenceContext: { path: string; sha256: string };
      };
      assert.equal(persistentPacket.packetSha256, review.packetSha256);
      assert.equal(
        persistentPacket.reviewEvidenceContext.path,
        `review/contexts/${persistentPacket.reviewEvidenceContext.sha256}.txt`,
      );
      assert.ok(
        await readFile(
          join(
            workspacePaths(root).projects,
            "broker-evidence",
            persistentPacket.reviewEvidenceContext.path,
          ),
        ),
      );
      const closure = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "broker-evidence", "outputs", "closure.json"),
          "utf8",
        ),
      ) as { reviewPacket: { path: string; packetSha256: string } };
      assert.equal(closure.reviewPacket.packetSha256, review.packetSha256);
      assert.equal(closure.reviewPacket.path, `review/packets/${review.packetSha256}.json`);
      assert.deepEqual(
        await readFile(rawPath),
        Buffer.from(JSON.stringify({ records: [{ id: 1 }, { id: 2 }, { id: 3 }] })),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("globally bounds reviewer excerpts while retaining every permanent broker object", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "bounded-review-context", "Review several large responses.");
      await installNetworkCapability(root, skillParent, {
        endpoint: "https://source.test/",
        accept: "application/json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 256 * 1024,
        maxItems: 2,
      });
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          return new Response(
            JSON.stringify({
              request: String(input),
              records: [
                { id: 1, body: "x".repeat(18_000) },
                { id: 2, body: "y".repeat(18_000) },
                { id: 3, body: "z".repeat(18_000) },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "bounded-review-prefetch", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "bounded-review-context", capsule);
      assert.ok(broker);
      try {
        for (let page = 1; page <= 4; page += 1) {
          const response = await rpc(broker.url, "tools/call", {
            name: "fetch_candidate_source",
            arguments: {
              capability_id: "method.public-source",
              url: `https://source.test/search?page=${page}`,
              json_pointer: "/records",
              max_items: 2,
            },
          });
          assert.notEqual(
            (response.result as Record<string, unknown>).isError,
            true,
            JSON.stringify(response),
          );
        }
      } finally {
        await broker.stop();
      }
      await rm(join(workspacePaths(root).runtime, "bounded-review-prefetch"), {
        recursive: true,
        force: true,
      });

      let reviewed = false;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        brokerBackedExecutor(
          async (request) => {
            assert.ok(
              request.maxTurns > 3 && request.maxTurns <= 64,
              "retain useful multi-turn packet reading within the affordable envelope",
            );
            assert.equal(request.reservationTurns, request.maxTurns);
            const budgetConfig = await loadWorkspaceConfig(root);
            const repeatedPrompt =
              Math.ceil(Buffer.byteLength(request.prompt) / 3) * request.maxTurns;
            assert.ok(
              repeatedPrompt + request.maxOutputTokens <=
                budgetConfig.budget.packageMaxTokens.review,
              "every permitted turn must fit the package reservation",
            );
            const views = await openArtifactViews(
              request.projectRoot,
              request.artifactViews!.index,
              request.artifactViews!.packetSha256,
            );
            const object = views.index.objects.find(
              (item) => item.path === "inputs/review-evidence-context.txt",
            )!;
            const excerpt = (await views.read({ objectId: object.objectId, length: null })).content;
            assert.doesNotMatch(request.prompt, /### inputs\/review-packet\.json/);
            assert.match(excerpt, /TRUNCATED: the full object/);
            assert.match(excerpt, /jsonPointer: \/records\/0/);
            assert.match(excerpt, /"id": 1/);
            assert.doesNotMatch(excerpt, /"id": 2/);
            const contextPath = join(request.projectRoot, "inputs", "review-evidence-context.txt");
            const contextInfo = await lstat(contextPath);
            const config = JSON.parse(await readFile(workspacePaths(root).config, "utf8")) as {
              budget: { maxInputContextTokens: number };
            };
            assert.ok(contextInfo.size <= config.budget.maxInputContextTokens * 3);
            const packet = JSON.parse(
              await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
            ) as {
              evidenceReceipts: Array<{ locator: string }>;
              evidenceFiles: Array<{ path: string; bytes: number }>;
            };
            assert.equal(packet.evidenceReceipts.length, 4);
            assert.ok(packet.evidenceFiles.some((file) => file.bytes > contextInfo.size));
            for (const receipt of packet.evidenceReceipts) {
              assert.ok(await readFile(join(request.projectRoot, receipt.locator)));
            }
            reviewed = true;
          },
          false,
          "/records/0",
        ),
      );
      assert.equal(
        result.status,
        "complete",
        JSON.stringify({ result, project: await loadProject(root, "bounded-review-context") }),
      );
      assert.equal(reviewed, true);
      assert.equal((await loadProjectEvidenceReceipts(root, "bounded-review-context")).length, 4);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("enforces the configured broker call budget before an extra provider fetch", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "broker-call-budget", "Use a bounded broker call budget.");
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxBrokerCalls: number };
      };
      config.budget.maxBrokerCalls = 1;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await installNetworkCapability(root, skillParent);
      let providerFetches = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          providerFetches += 1;
          return new Response('{"records":[{"id":1}]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };
      const capsule = join(paths.runtime, "broker-call-budget", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "broker-call-budget", capsule);
      assert.ok(broker);
      try {
        const first = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/first",
          },
        });
        const firstResult = first.result as Record<string, unknown>;
        assert.notEqual(firstResult.isError, true, JSON.stringify(first));
        const firstReceipt = JSON.parse(
          String(((firstResult.content as Array<Record<string, unknown>>)[0] ?? {}).text),
        ) as { brokerBudget: { maxCalls: number; startedCalls: number; remainingCalls: number } };
        assert.deepEqual(firstReceipt.brokerBudget, {
          maxCalls: 1,
          startedCalls: 1,
          remainingCalls: 0,
        });

        const rejected = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/second",
          },
        });
        assert.match(JSON.stringify(rejected), /RESEARCH_BROKER_CALL_LIMIT_EXCEEDED/);
        assert.deepEqual(broker.usage(), {
          maxCalls: 1,
          startedCalls: 1,
          remainingCalls: 0,
        });
      } finally {
        await broker.stop();
      }
      assert.equal(providerFetches, 1);
      assert.equal((await loadProjectEvidenceReceipts(root, "broker-call-budget")).length, 1);
      assert.match(await readFile(paths.journal, "utf8"), /RESEARCH_BROKER_CALL_LIMIT_EXCEEDED/);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports sanitized HTTP failures, Retry-After, and request IDs", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          return new Response(
            'token=should-not-leak Authorization: Bearer should-not-leak {"error":"limited"}',
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "7",
                "x-request-id": "request-safe-123",
              },
            },
          );
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "http-error", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "http-errors", capsule);
      assert.ok(broker);
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/limited?query=request-secret",
          },
        });
        const text = JSON.stringify(response);
        assert.match(text, /RESEARCH_BROKER_HTTP_ERROR/);
        assert.match(text, /retryAfterSeconds\\?":7/);
        assert.match(text, /request-safe-123/);
        assert.doesNotMatch(text, /should-not-leak|request-secret/);
      } finally {
        await broker.stop();
      }
      const workspaceText = await readWorkspaceText(root);
      assert.match(workspaceText, /request-safe-123/);
      assert.doesNotMatch(workspaceText, /should-not-leak|request-secret/);
      assert.equal((await loadProjectEvidenceReceipts(root, "http-errors")).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("retries one short 429 in place and persists only the successful response", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      let providerFetches = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          providerFetches += 1;
          if (providerFetches === 1) {
            return new Response('{"error":"briefly-limited"}', {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "0",
                "x-request-id": "retry-safe-123",
              },
            });
          }
          return new Response('{"records":[{"id":"admitted"}]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "short-429", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "short-429", capsule);
      assert.ok(broker);
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?query=public",
          },
        });
        assert.notEqual((response.result as Record<string, unknown>).isError, true);
      } finally {
        await broker.stop();
      }
      assert.equal(providerFetches, 2);
      assert.equal((await loadProjectEvidenceReceipts(root, "short-429")).length, 1);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /capability\.fetch\.retry\.scheduled/);
      assert.match(journal, /retry-safe-123/);
      assert.doesNotMatch(journal, /items\?query=public/);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("bounds staged broker context by estimated tokens without truncating permanent evidence", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxBrokerContextTokens: number };
      };
      config.budget.maxBrokerContextTokens = 16;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await installNetworkCapability(root, skillParent);
      const body = JSON.stringify({ records: [{ value: "x".repeat(200) }, { value: "small" }] });
      globalThis.fetch = async (input, init) =>
        String(input).startsWith("https://source.test/")
          ? new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : originalFetch(input, init);
      const capsule = join(paths.runtime, "context-budget", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "context-budget", capsule);
      assert.ok(broker);
      let receipt!: Record<string, unknown>;
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/large-context",
            json_pointer: "/records",
          },
        });
        receipt = JSON.parse(
          String(
            (
              (
                (response.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
      } finally {
        await broker.stop();
      }
      assert.equal(receipt.contextTruncated, true);
      assert.equal(receipt.contextItems, 0);
      assert.ok(Number(receipt.contextEstimatedTokens) <= 16);
      assert.equal(await readFile(join(paths.control, String(receipt.locator)), "utf8"), body);
      assert.deepEqual(
        JSON.parse(await readFile(join(paths.control, String(receipt.contextLocator)), "utf8")),
        [],
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects oversized and undeclared response content without evidence promotion", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent, {
        accept: "application/json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 20,
        maxItems: 10,
      });
      let responseKind: "oversized" | "content-type" = "oversized";
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          return responseKind === "oversized"
            ? new Response("x".repeat(21), {
                status: 200,
                headers: { "content-type": "application/json", "content-length": "21" },
              })
            : new Response("plain response", {
                status: 200,
                headers: { "content-type": "text/plain" },
              });
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "bounded", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "bounded-broker", capsule);
      assert.ok(broker);
      try {
        const oversized = await callBroker(broker.url, "https://source.test/oversized");
        assert.match(oversized, /size limit/);
        responseKind = "content-type";
        const mismatched = await callBroker(broker.url, "https://source.test/plain");
        assert.match(mismatched, /unsupported content type/);
      } finally {
        await broker.stop();
      }
      assert.equal((await loadProjectEvidenceReceipts(root, "bounded-broker")).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("checks every redirect before fetching the next page", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      const fetched: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://source.test/")) return originalFetch(input, init);
        fetched.push(url);
        if (url.endsWith("/start")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://source.test/final" },
          });
        }
        if (url.endsWith("/outside")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.test/blocked" },
          });
        }
        return new Response('{"page":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const capsule = join(workspacePaths(root).runtime, "redirect", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "redirect-project", capsule);
      assert.ok(broker);
      try {
        const admitted = await callBroker(broker.url, "https://source.test/start");
        assert.doesNotMatch(admitted, /isError|outside/);
        const blocked = await callBroker(broker.url, "https://source.test/outside");
        assert.match(blocked, /outside capability scope/);
      } finally {
        await broker.stop();
      }
      assert.deepEqual(fetched, [
        "https://source.test/start",
        "https://source.test/final",
        "https://source.test/outside",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("detects missing or tampered content-addressed evidence before staging", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      globalThis.fetch = async (input, init) =>
        String(input).startsWith("https://source.test/")
          ? new Response('{"ok":true}', {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : originalFetch(input, init);
      const capsule = join(workspacePaths(root).runtime, "tamper-source", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "tamper-project", capsule);
      assert.ok(broker);
      try {
        const text = await callBroker(broker.url, "https://source.test/object");
        assert.doesNotMatch(text, /error/i);
      } finally {
        await broker.stop();
      }
      const [receipt] = await loadProjectEvidenceReceipts(root, "tamper-project");
      assert.ok(receipt);
      const objectPath = join(workspacePaths(root).control, receipt.locator);
      await chmod(objectPath, 0o600);
      await writeFile(objectPath, "tampered");
      await assert.rejects(
        stageProjectEvidence(root, "tamper-project", join(root, "stage-target")),
        /missing or invalid|hash mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("production research control plane", () => {
  it("binds selected acquired text into producer, reviewer, claim, and review ledgers", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "artifact-review-binding",
        "Evaluate acquired artifact binding.",
      );
      const input = join(root, "artifact-seed.txt");
      const acquired = join(root, "acquired-full-text.txt");
      await writeFile(input, "seed evidence\n");
      await writeFile(acquired, "unique acquired full-text evidence\n");
      await addProjectInput(root, "artifact-review-binding", input, "primary");
      const normal = deterministicExecutor();
      let artifactId: string | null = null;
      let producerSawArtifact = false;
      let reviewerSawArtifact = false;
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        if (stage === "acquire" && request.purpose === "primary") {
          const [candidate] = await listEvidenceCandidates(
            request.workspaceRoot,
            "artifact-review-binding",
          );
          assert.ok(candidate);
          const artifact = await registerEvidenceArtifact({
            root: request.workspaceRoot,
            projectId: "artifact-review-binding",
            candidateId: candidate.id,
            path: acquired,
          });
          artifactId = artifact.artifactId;
          const evidence = JSON.parse(
            await readFile(join(request.projectRoot, "outputs", "evidence.json"), "utf8"),
          ) as { sources: Array<{ id: string }> };
          return execution(
            JSON.stringify({
              schemaVersion: 1,
              decisions: evidence.sources.map((source) => ({
                sourceId: source.id,
                candidateId: candidate.id,
                artifactIds: [artifact.artifactId],
                status: "accepted",
                rationale: "Exact text artifact registered.",
                limitations: [],
              })),
              limitations: [],
              gaps: [],
            }),
          );
        }
        if (stage === "analyze") {
          producerSawArtifact = request.prompt.includes("unique acquired full-text evidence");
        }
        if (stage === "review") {
          const context = await readFile(
            join(request.projectRoot, "inputs", "review-evidence-context.txt"),
            "utf8",
          );
          reviewerSawArtifact = context.includes("unique acquired full-text evidence");
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.ok(artifactId);
      assert.equal(producerSawArtifact, true);
      assert.equal(reviewerSawArtifact, true);
      const ledger = await readFile(evidenceLedgerPath(root, "artifact-review-binding"), "utf8");
      assert.match(ledger, /"type":"claim\.used"/);
      assert.match(ledger, /"type":"review\.bound"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses one capability probe and skips paid reviewer smoke after a blocking failure", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      await lockCapabilities(root);
      let liveCalls = 0;
      const capabilityDoctor = await doctorExternalCapabilities(root, {
        live: true,
        fetcher: async () => {
          liveCalls += 1;
          return new Response('{"error":"unavailable"}', {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        },
      });
      assert.equal(capabilityDoctor.status, "blocked");
      let agentCalls = 0;
      const report = await doctorResearchWorkspace(root, {
        capabilitySmoke: true,
        agentSmoke: true,
        capabilityDoctorResult: capabilityDoctor,
        capabilityFetcher: async () => {
          throw new Error("duplicate capability probe");
        },
        executor: async () => {
          agentCalls += 1;
          throw new Error("paid smoke must be skipped");
        },
      });
      assert.equal(report.status, "blocked");
      assert.equal(liveCalls, 1);
      assert.equal(agentCalls, 0);
      assert.equal(
        report.checks.find((check) => check.id === "agent-sandbox-smoke.skipped")?.status,
        "fail",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("binds full local evidence while embedding only bounded reviewer context", async () => {
    const root = await temporaryDirectory();
    const sourceRoot = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const fullPath = join(sourceRoot, "full-source.txt");
      const contextPath = join(sourceRoot, "bounded-context.txt");
      await writeFile(fullPath, `${"Full evidence line.\n".repeat(200)}END\n`);
      await writeFile(contextPath, "Bounded evidence excerpt with provenance.\n");
      const planPath = join(sourceRoot, "input-plan.json");
      await writeFile(
        planPath,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: fullPath,
              contextPath,
              role: "primary",
              dimensions: ["research-question"],
              sourceType: "primary",
              fullText: true,
              publicationDate: "2025-01-01",
            },
          ],
        })}\n`,
      );
      const plan = await readAndVerifyProjectInputPlan(planPath);
      await initializeProject(
        root,
        "bounded-local-context",
        "Evaluate bounded local context staging and full evidence review.",
        undefined,
        false,
        plan,
      );
      const base = deterministicExecutor();
      let reviewedFullEvidence = false;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        async (request) => {
          const stage = stageFrom(request);
          const [input] = JSON.parse(
            await readFile(join(request.projectRoot, "inputs", "manifest.json"), "utf8"),
          ) as Array<{
            id: string;
            path: string;
            sha256: string;
            contextPath: string;
            contextSha256: string;
            fullTextStaged: boolean;
          }>;
          assert.ok(input);
          assert.equal(
            await readFile(join(request.projectRoot, input.contextPath), "utf8"),
            await readFile(contextPath, "utf8"),
          );
          if (stage !== "review") {
            assert.equal(input.fullTextStaged, false);
            assert.equal(
              await lstat(join(request.projectRoot, input.path)).catch(() => null),
              null,
            );
            if (stage === "discover") {
              assert.match(request.prompt, /Bounded evidence excerpt with provenance/);
              assert.doesNotMatch(request.prompt, /Full evidence line/);
              assert.match(request.prompt, new RegExp(input.id));
              const schema = request.outputSchema as {
                $id: string;
                properties: Record<string, unknown>;
              };
              assert.equal(
                schema.$id,
                "https://schemas.tiangong.ai/research/discovery-closeout-v2.json",
              );
              assert.equal("admissions" in schema.properties, false);
            }
            if (stage === "analyze") {
              assert.equal(request.toolPolicy, "none");
              assert.equal(request.brokerUrl, null);
              assert.match(request.prompt, /"title":\s*"full-source\.txt"/);
            }
            if (stage === "synthesize") {
              assert.equal(request.toolPolicy, "none");
              assert.equal(request.brokerUrl, null);
              assert.match(request.prompt, /The admitted evidence supports a bounded finding/);
            }
          } else {
            assert.equal(input.fullTextStaged, true);
            assert.equal(request.toolPolicy, "packet-read");
            assert.ok(
              request.maxTurns > 3 && request.maxTurns <= 64,
              "retain useful multi-turn packet reading within the affordable envelope",
            );
            assert.equal(request.reservationTurns, request.maxTurns);
            const budgetConfig = await loadWorkspaceConfig(root);
            const repeatedPrompt =
              Math.ceil(Buffer.byteLength(request.prompt) / 3) * request.maxTurns;
            assert.ok(
              repeatedPrompt + request.maxOutputTokens <=
                budgetConfig.budget.packageMaxTokens.review,
              "every permitted turn must fit the package reservation",
            );
            assert.equal(request.brokerUrl, null);
            assert.doesNotMatch(request.prompt, /### inputs\/review-packet\.json/);
            assert.match(request.prompt, /### inputs\/review-evidence-context\.txt/);
            assert.match(request.prompt, /Bounded evidence excerpt with provenance/);
            assert.doesNotMatch(request.prompt, /Full evidence line/);
            assert.equal(
              await readFile(join(request.projectRoot, input.path), "utf8"),
              await readFile(fullPath, "utf8"),
            );
            const packet = JSON.parse(
              await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
            ) as {
              reviewEvidenceContext: { path: string; sha256: string };
              inputFiles: Array<{ path: string; sha256: string }>;
            };
            assert.match(
              packet.reviewEvidenceContext.path,
              /^review\/contexts\/[0-9a-f]{64}\.txt$/,
            );
            assert.match(packet.reviewEvidenceContext.sha256, /^[0-9a-f]{64}$/);
            assert.deepEqual(
              new Set(packet.inputFiles.map((file) => file.sha256)),
              new Set([input.sha256, input.contextSha256]),
            );
            reviewedFullEvidence = true;
          }
          return base(request);
        },
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.equal(reviewedFullEvidence, true);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not count returned usage twice when the run record fails after project save", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "post-save-usage",
        "Preserve one accounting result across persistence failure.",
      );
      const config = await loadWorkspaceConfig(root);
      config.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(root).config, config);
      await setProjectBudget(root, "post-save-usage", 50, true);
      const input = join(root, "input.txt");
      await writeFile(input, "Synthetic admitted input.");
      await addProjectInput(root, "post-save-usage", input, "primary");
      let calls = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          calls++;
          const runs = join(workspacePaths(root).projects, "post-save-usage", "runs");
          await rm(runs, { recursive: true, force: true });
          await writeFile(runs, "A file deliberately prevents run-record directory creation.");
          return {
            ...execution(JSON.stringify(await inputEvidenceValue(request)), 10),
            costUsd: 0.02,
          };
        },
      ).catch((error: unknown) => error);
      assert.ok(result);
      assert.equal(calls, 1);
      const state = await loadProject(root, "post-save-usage");
      assert.equal(state.budget!.entries.length, 1);
      assert.equal(state.budget!.entries[0]!.accountedCostUsd, 0.02);
      assert.equal(
        state.usage.tokens,
        10,
        "the post-save catch must not apply the same result again",
      );
      assert.equal(state.usage.costUsd, 0.02);
      assert.match(state.packages[0]!.lastError!, /EEXIST|ENOTDIR|already exists|not a directory/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the package reservation when formatting repair throws with unknown usage", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "uncertain-repair", "Preserve the unknown repair obligation.");
      const config = await loadWorkspaceConfig(root);
      config.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      await writeJsonAtomic(workspacePaths(root).config, config);
      await setProjectBudget(root, "uncertain-repair", 50, true);
      const input = join(root, "input.txt");
      await writeFile(input, "Synthetic admitted input.");
      await addProjectInput(root, "uncertain-repair", input, "primary");
      let calls = 0;
      let envelope = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          calls++;
          if (request.purpose === "primary") {
            envelope = request.maxCostUsd;
            return { ...execution('{"schemaVersion":1,', 5), costUsd: 0.02 };
          }
          assert.equal(request.maxTurns, 1);
          assert.ok(Math.abs(request.maxCostUsd + 0.02 - envelope) < 1e-9);
          throw new Error("Synthetic transport failure after repair admission; usage unknown.");
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 2);
      const state = await loadProject(root, "uncertain-repair");
      assert.equal(state.budget!.entries.length, 1);
      assert.equal(state.budget!.entries[0]!.status, "reserved");
      assert.equal(state.budget!.entries[0]!.maxCostUsd, envelope);
      assert.equal(state.usage.costUsd, 0.02, "only known primary telemetry may be recorded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs malformed structured output once without retrying the whole package", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "repair-json", "Evaluate structured output repair behavior.");
      const input = join(root, "evidence.txt");
      await writeFile(input, "measured evidence\n");
      await addProjectInput(root, "repair-json", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "discover" && request.purpose === "primary") {
          return execution('{"schemaVersion":1,', 5);
        }
        if (stage === "discover" && request.purpose === "repair") {
          assert.equal(request.maxTurns, 1);
          return execution(JSON.stringify(await inputEvidenceValue(request)), 2);
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(calls.slice(0, 2), [
        { stage: "discover", purpose: "primary" },
        { stage: "discover", purpose: "repair" },
      ]);
      const project = await loadProject(root, "repair-json");
      assert.equal(project.packages[0]?.attempts, 1);
      assert.equal(project.usage.tokens, 47);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mechanically normalizes literal Markdown newline artifacts before review", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "repair-markdown", "Evaluate Markdown repair behavior.");
      const input = join(root, "evidence.txt");
      await writeFile(input, "measured evidence\n");
      await addProjectInput(root, "repair-markdown", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "synthesize" && request.purpose === "primary") {
          return execution(
            JSON.stringify({
              schemaVersion: 1,
              reportMarkdown:
                "# Findings/n- Supported [finding](https://example.test/n-path)./n/n## Limitations/n- Bounded evidence.",
            }),
            5,
          );
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(
        calls.filter((call) => call.stage === "synthesize"),
        [{ stage: "synthesize", purpose: "primary" }],
      );
      const report = await readFile(
        join(workspacePaths(root).projects, "repair-markdown", "outputs", "report.md"),
        "utf8",
      );
      assert.match(report, /# Findings\n- Supported \[finding\]/);
      assert.match(report, /https:\/\/example\.test\/n-path/);
      assert.doesNotMatch(report, /Findings\/n-|\.\)\/n\/n##|Limitations\/n-/);
      assert.match(
        await readFile(workspacePaths(root).journal, "utf8"),
        /package\.output\.normalized.*synthesis-markdown-newline-artifacts/,
      );
      const project = await loadProject(root, "repair-markdown");
      assert.equal(project.packages[2]?.attempts, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs polluted report URLs before starting the independent reviewer", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "repair-report-url",
        "Evaluate report URL validation behavior.",
      );
      const input = join(root, "url-evidence.txt");
      await writeFile(input, "measured evidence\n");
      await addProjectInput(root, "repair-report-url", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "synthesize" && request.purpose === "primary") {
          return execution(
            JSON.stringify({
              schemaVersion: 1,
              reportMarkdown:
                "# Findings\n\nPolluted official URL: `https://example.test/download%60`.\n\n# Limitations\n\nMust be repaired.",
            }),
            5,
          );
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(
        calls.filter((call) => call.stage === "synthesize"),
        [
          { stage: "synthesize", purpose: "primary" },
          { stage: "synthesize", purpose: "repair" },
        ],
      );
      assert.equal(calls.filter((call) => call.stage === "review").length, 1);
      const report = await readFile(
        join(workspacePaths(root).projects, "repair-report-url", "outputs", "report.md"),
        "utf8",
      );
      assert.doesNotMatch(report, /%60|`https?:\/\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a Markdown link followed by an inline evidence ID", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "markdown-link-evidence-id",
        "Evaluate valid Markdown URL boundary behavior.",
      );
      const input = join(root, "link-evidence.txt");
      await writeFile(input, "measured evidence\n");
      await addProjectInput(root, "markdown-link-evidence-id", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "synthesize") {
          return execution(
            JSON.stringify({
              schemaVersion: 1,
              reportMarkdown:
                "# Findings\n\n[Bound source](https://example.test/evidence)（`source-1`） and [second source](https://example.test/second)（`source-2`） support the finding.\n\n# Limitations\n\nBounded context only.",
            }),
            5,
          );
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(
        result.status,
        "complete",
        JSON.stringify({
          result,
          project: await loadProject(root, "markdown-link-evidence-id"),
        }),
      );
      assert.deepEqual(
        calls.filter((call) => call.stage === "synthesize"),
        [{ stage: "synthesize", purpose: "primary" }],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a mechanically invalid discovery closeout without repeating research", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "repair-provenance", "Evaluate provenance repair behavior.");
      const input = join(root, "evidence.txt");
      await writeFile(input, "measured evidence\n");
      const admitted = await addProjectInput(root, "repair-provenance", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "discover" && request.purpose === "primary") {
          const value = (await inputEvidenceValue(request)) as {
            dimensionJudgments: Array<{ id: string; status: string }>;
          } & Record<string, unknown>;
          value.dimensionJudgments[0]!.id = "not-a-reviewed-dimension";
          return execution(JSON.stringify(value), 5);
        }
        if (stage === "discover" && request.purpose === "repair") {
          assert.equal(request.maxTurns, 1);
          assert.match(request.prompt, /dimension judgments/i);
          assert.ok(admitted.id);
          return execution(JSON.stringify(await inputEvidenceValue(request)), 2);
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(calls.slice(0, 2), [
        { stage: "discover", purpose: "primary" },
        { stage: "discover", purpose: "repair" },
      ]);
      const project = await loadProject(root, "repair-provenance");
      assert.equal(project.packages[0]?.attempts, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on deterministic 422 failures but schedules 429 with Retry-After semantics", async () => {
    const deterministicRoot = await temporaryDirectory();
    const rateRoot = await temporaryDirectory();
    const budgetRoot = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(deterministicRoot, undefined);
      await initializeProject(
        deterministicRoot,
        "deterministic-http",
        "Evaluate deterministic HTTP failure behavior.",
      );
      const deterministic = await runResearchWorkspace(
        deterministicRoot,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async () => execution("", 1, 22, "HTTP 422 invalid Accept header"),
      );
      assert.equal(deterministic.status, "blocked");
      const failed = await loadProject(deterministicRoot, "deterministic-http");
      assert.equal(failed.packages[0]?.attempts, 1);
      assert.equal(failed.packages[0]?.status, "failed");
      assert.equal(failed.packages[0]?.lastFailureKind, "deterministic");

      await initializeResearchWorkspace(rateRoot, undefined);
      await initializeProject(rateRoot, "rate-limited", "Evaluate rate limit retry behavior.");
      const rateLimited = await runResearchWorkspace(
        rateRoot,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async () => execution("", 1, 29, "HTTP 429 rate limit; Retry-After: 60"),
      );
      assert.equal(rateLimited.status, "ready");
      assert.equal(rateLimited.stopReason, "no-ready-work");
      const retry = await loadProject(rateRoot, "rate-limited");
      assert.equal(retry.packages[0]?.status, "retry");
      assert.equal(retry.packages[0]?.lastFailureKind, "rate-limit");
      assert.ok(Date.parse(retry.packages[0]?.retryNotBefore ?? "") - Date.now() > 55_000);

      await initializeResearchWorkspace(budgetRoot, undefined);
      await initializeProject(budgetRoot, "provider-budget", "Evaluate provider budget failure.");
      const providerBudget = await runResearchWorkspace(
        budgetRoot,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async () =>
          execution(
            "",
            1,
            1,
            '{"terminal_reason":"budget_exhausted","subtype":"error_max_budget_usd","session_id":"provider-session-value"}',
          ),
      );
      assert.equal(providerBudget.status, "blocked");
      const budgetFailure = await loadProject(budgetRoot, "provider-budget");
      assert.equal(budgetFailure.packages[0]?.lastFailureKind, "budget");
      assert.doesNotMatch(await readWorkspaceText(budgetRoot), /provider-session-value/);
      assert.match(await readWorkspaceText(budgetRoot), /\[REDACTED\]/);

      await initializeProject(
        budgetRoot,
        "provider-turn-limit",
        "Evaluate structured-output turn limit classification.",
      );
      const turnLimited = await runResearchWorkspace(
        budgetRoot,
        {
          maxParallel: 1,
          maxCycles: 1,
          dryRun: false,
          environment: {},
          projectId: "provider-turn-limit",
        },
        async () =>
          execution(
            "",
            1,
            1,
            '{"subtype":"error_max_turns","errors":["Reached maximum number of turns (1)"]}',
          ),
      );
      assert.equal(turnLimited.status, "blocked");
      assert.equal(
        (await loadProject(budgetRoot, "provider-turn-limit")).packages[0]?.lastFailureKind,
        "budget",
      );
    } finally {
      await Promise.all([
        rm(deterministicRoot, { recursive: true, force: true }),
        rm(rateRoot, { recursive: true, force: true }),
        rm(budgetRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("promotes evidence diagnostics but blocks analyze when coverage is insufficient", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "coverage-gate", "Evaluate evidence coverage gating.", {
        dimensions: ["impact", "cost"],
        sourceTypes: ["primary"],
        minSources: 2,
        minFullTextSources: 1,
        minDatedSources: 0,
        publicationDateFrom: null,
        publicationDateTo: null,
      });
      const input = join(root, "one-source.txt");
      await writeFile(input, "one source\n");
      await addProjectInput(root, "coverage-gate", input, "primary");
      let calls = 0;
      const events: Record<string, unknown>[] = [];
      const result = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 5,
          dryRun: false,
          environment: {},
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async (request) => {
          calls += 1;
          const value = await inputEvidenceValue(request, {
            dimensions: ["impact"],
            coverageDimensions: ["impact"],
            decision: "insufficient",
            gaps: ["missing cost and second source"],
          });
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 1);
      const project = await loadProject(root, "coverage-gate");
      assert.equal(project.packages[0]?.lastFailureKind, "configuration");
      assert.match(project.packages[0]?.lastError ?? "", /requires 2 source/);
      assert.equal(project.packages[1]?.status, "pending");
      assert.match(JSON.stringify(events), /requires 2 source/);
      assert.ok(
        await readFile(
          join(workspacePaths(root).projects, project.id, "outputs", "evidence.json"),
          "utf8",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks downstream work when a required external discovery Skill was not exercised", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      const declarations = JSON.parse(
        await readFile(workspacePaths(root).capabilityDeclarations, "utf8"),
      ) as {
        capabilities: Array<{ requiredForDiscovery?: boolean }>;
      };
      declarations.capabilities[0]!.requiredForDiscovery = true;
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await initializeProject(
        root,
        "required-external-skill",
        "What does the external and local evidence jointly establish?",
      );
      const input = join(root, "input.txt");
      await writeFile(input, "Local evidence cannot substitute for a required external search.\n");
      await addProjectInput(root, "required-external-skill", input, "primary");
      let calls = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async (request) => {
          calls += 1;
          assert.match(request.prompt, /requiredForDiscovery=true/);
          assert.match(request.prompt, /skills\/manifest\.json/);
          return deterministicExecutor()(request);
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 1);
      const project = await loadProject(root, "required-external-skill");
      assert.equal(project.packages[0]?.lastFailureKind, "configuration");
      assert.match(
        project.packages[0]?.lastError ?? "",
        /was not exercised: method\.public-source/,
      );
      assert.equal(project.packages[1]?.status, "pending");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("distinguishes a failed required discovery attempt from a capability never exercised", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      const declarations = JSON.parse(
        await readFile(workspacePaths(root).capabilityDeclarations, "utf8"),
      ) as {
        capabilities: Array<{ requiredForDiscovery?: boolean }>;
      };
      declarations.capabilities[0]!.requiredForDiscovery = true;
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await initializeProject(
        root,
        "failed-required-skill",
        "What does the available evidence establish?",
      );
      const input = join(root, "input.txt");
      await writeFile(input, "A valid local source does not replace a required public index.\n");
      await addProjectInput(root, "failed-required-skill", input, "primary");
      const attemptId = "failed-required-capability-attempt";
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.fetch.attempted",
        "failed-required-skill",
        {
          attemptId,
          projectId: "failed-required-skill",
          capabilityId: "method.public-source",
        },
      );
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.fetch.failed",
        "failed-required-skill",
        {
          attemptId,
          capabilityId: "method.public-source",
          failureKind: "rate-limit",
        },
      );
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(result.status, "blocked");
      const project = await loadProject(root, "failed-required-skill");
      assert.match(project.packages[0]?.lastError ?? "", /produced no admissible receipt/);
      assert.match(project.packages[0]?.lastError ?? "", /failure kinds: rate-limit/);
      assert.doesNotMatch(project.packages[0]?.lastError ?? "", /was not exercised/);
      assert.equal(project.packages[1]?.status, "pending");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("normalizes derived coverage fields while preserving usable partial coverage", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "partial-coverage", "Evaluate partial evidence coverage.");
      const input = join(root, "partial-source.txt");
      await writeFile(input, "partial source\n");
      await addProjectInput(root, "partial-coverage", input, "primary");
      const normal = deterministicExecutor();
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        async (request) => {
          if (stageFrom(request) !== "discover") return normal(request);
          const value = await inputEvidenceValue(request, {
            gaps: ["No directly normalized comparison."],
          });
          const dimensions = value.dimensionJudgments as Array<{ status: string }>;
          dimensions[0]!.status = "partial";
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      const evidence = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "partial-coverage", "outputs", "evidence.json"),
          "utf8",
        ),
      ) as {
        sources: Array<{ fullTextAvailable: boolean }>;
        coverage: {
          dimensions: Array<{ status: string }>;
          sourceTypes: string[];
          fullTextSources: number;
          datedSources: number;
          decision: string;
          gaps: string[];
        };
      };
      assert.equal(evidence.coverage.dimensions[0]?.status, "partial");
      assert.equal(evidence.sources[0]?.fullTextAvailable, true);
      assert.deepEqual(evidence.coverage.sourceTypes, ["primary"]);
      assert.equal(evidence.coverage.fullTextSources, 1);
      assert.equal(evidence.coverage.datedSources, 0);
      assert.equal(evidence.coverage.decision, "pass");
      assert.deepEqual(evidence.coverage.gaps, ["No directly normalized comparison."]);
      const snapshot = JSON.parse(
        await readFile(
          join(
            workspacePaths(root).projects,
            "partial-coverage",
            "outputs",
            "evidence-snapshot.json",
          ),
          "utf8",
        ),
      ) as { coverage: { dimensions: Array<{ status: string }> } };
      assert.equal(snapshot.coverage.dimensions[0]?.status, "partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist sensitive URL parameters, headers, cookies, or tokens", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "sensitive-output", "Evaluate output sanitization behavior.");
      const input = join(root, "source.txt");
      await writeFile(input, "source\n");
      await addProjectInput(root, "sensitive-output", input, "primary");
      const secret = "do-not-persist-secret";
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        async (request) => {
          const value = await inputEvidenceValue(request);
          const admission = (value.admissions as Array<Record<string, unknown>>)[0]!;
          admission.candidateId = "unknown-sensitive-candidate";
          admission.relevance = `Authorization: Bearer ${secret}; Cookie: session=${secret}; https://proxy-user:proxy-password@example.test/paper?token=${secret}`;
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "blocked");
      const workspaceText = await readWorkspaceText(root);
      assert.doesNotMatch(workspaceText, new RegExp(secret));
      assert.doesNotMatch(workspaceText, /Bearer do-not|session=do-not/);
      assert.doesNotMatch(workspaceText, /proxy-user|proxy-password/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts configured opaque secrets from failures, journal records, and progress", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "opaque-secret", "Evaluate opaque error redaction behavior.");
      const secret = "opaque-value-9f4c2a7d";
      const events: Record<string, unknown>[] = [];
      const result = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 1,
          dryRun: false,
          environment: { RESEARCH_API_KEY: secret },
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async () => {
          throw new Error(`provider returned opaque value ${secret}`);
        },
      );
      assert.equal(result.status, "blocked");
      assert.doesNotMatch(await readWorkspaceText(root), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
      assert.match(await readWorkspaceText(root), /\[REDACTED\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks downstream work when dated evidence falls outside the required publication range", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "date-coverage", "Evaluate publication date coverage.", {
        dimensions: ["research-question"],
        sourceTypes: ["primary"],
        minSources: 1,
        minFullTextSources: 1,
        minDatedSources: 1,
        publicationDateFrom: "2020-01-01",
        publicationDateTo: "2024-12-31",
      });
      const input = join(root, "dated-source.txt");
      await writeFile(input, "dated source\n");
      await addProjectInput(root, "date-coverage", input, "primary");
      const datedProject = await loadProject(root, "date-coverage");
      datedProject.inputs[0]!.publicationDate = "2019-06-01";
      await saveProject(root, datedProject);
      let calls = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async (request) => {
          calls += 1;
          return execution(
            JSON.stringify(
              await inputEvidenceValue(request, {
                publicationDate: "2019-06-01",
                decision: "insufficient",
                gaps: ["publication date is outside the required range"],
              }),
            ),
          );
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 1);
      const project = await loadProject(root, "date-coverage");
      assert.equal(project.packages[0]?.lastFailureKind, "configuration");
      assert.match(project.packages[0]?.lastError ?? "", /coverage is insufficient/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered journal before mutating package state", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "journal-guard", "Evaluate journal integrity admission.");
      await appendFile(workspacePaths(root).journal, '{"tampered":true}\n');
      await assert.rejects(
        runResearchWorkspace(
          root,
          { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
          deterministicExecutor(),
        ),
        /journal event|hash check/i,
      );
      const project = await loadProject(root, "journal-guard");
      assert.equal(project.status, "ready");
      assert.equal(project.packages[0]?.status, "ready");
      assert.equal(project.packages[0]?.attempts, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires production preflight inputs and an explicit real sandbox smoke", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      await installNetworkCapability(root, skillParent);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        producer: { model: string | null; pricing?: Record<string, number> };
        reviewer: { model: string | null; pricing?: Record<string, number> };
      };
      config.producer.model = "producer-model-pinned";
      config.reviewer.model = "reviewer-model-pinned";
      config.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      config.reviewer.pricing = { ...config.producer.pricing };
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await lockCapabilities(root);
      await assert.rejects(
        initializeProject(root, "missing-preflight", "Evaluate production preflight behavior."),
        /explicit evidence requirements/,
      );
      await assert.rejects(
        initializeProject(
          root,
          "missing-confirmation",
          "Evaluate production budget confirmation.",
          {
            dimensions: ["question"],
            sourceTypes: ["primary"],
            minSources: 1,
            minFullTextSources: 1,
            minDatedSources: 1,
            publicationDateFrom: null,
            publicationDateTo: null,
          },
        ),
        /explicit confirmation/,
      );
      const withoutSmoke = await doctorResearchWorkspace(root);
      assert.equal(withoutSmoke.status, "blocked");
      assert.equal(
        withoutSmoke.checks.find((check) => check.id === "agent-sandbox-smoke")?.status,
        "fail",
      );
      const smokeRequests: AgentExecutionRequest[] = [];
      const mockRuntime = (route: AgentExecutionRequest["route"]) => ({
        agent: route.agent,
        model: route.model,
        binarySha256: "a".repeat(64),
        wrapperSha256: "b".repeat(64),
        adapterSha256: "d".repeat(64),
        binaryVersion: "mock 1.0.0",
        platform: process.platform,
        architecture: process.arch,
      });
      const withSmoke = await doctorResearchWorkspace(root, {
        agentSmoke: true,
        capabilitySmoke: true,
        capabilityFetcher: async () =>
          new Response('{"status":"ok"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        environment: {},
        executor: async (request) => {
          smokeRequests.push(request);
          return {
            ...execution('{"ok":true}', 1, 0, "", request.route.model, mockRuntime(request.route)),
            isolation: {
              provider:
                process.platform === "darwin" ? ("sandbox-exec" as const) : ("bubblewrap" as const),
              policySha256: "e".repeat(64),
              readScopes: ["platform-runtime", "agent-runtime", "private-capsule"] as const,
              writeScopes: ["private-capsule"] as const,
              networkPolicy: "reviewer-provider-only" as const,
              toolPolicy: "none" as const,
            },
          };
        },
      });
      assert.equal(withSmoke.status, "ready", JSON.stringify(withSmoke));
      assert.deepEqual(
        smokeRequests.map((request) => request.route.agent),
        ["claude"],
      );
      assert.ok(smokeRequests.every((request) => request.purpose === "doctor"));
      assert.equal((await verifyDoctorAttestation(root)).status, "verified");
      const reused = await doctorResearchWorkspace(root, {
        environment: {},
        runtimeFingerprinter: async (route) => mockRuntime(route),
      });
      assert.equal(reused.status, "ready", JSON.stringify(reused));
      assert.equal(
        reused.checks.find((check) => check.id === "capability-live-smoke")?.status,
        "pass",
      );
      assert.equal(
        reused.checks.find((check) => check.id === "agent-sandbox-smoke")?.status,
        "pass",
      );
      assert.equal(
        reused.checks.find((check) => check.id === "doctor-attestation")?.status,
        "pass",
      );
      const runtimeDrift = await doctorResearchWorkspace(root, {
        environment: {},
        runtimeFingerprinter: async (route) => ({
          ...mockRuntime(route),
          binarySha256: route.agent === "claude" ? "c".repeat(64) : "a".repeat(64),
        }),
      });
      assert.equal(runtimeDrift.status, "blocked");
      assert.match(
        runtimeDrift.checks.find((check) => check.id === "doctor-attestation")?.detail ?? "",
        /claude runtime fingerprint drifted/,
      );
      const driftedConfig = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxInputContextTokens: number };
      };
      driftedConfig.budget.maxInputContextTokens += 1;
      await writeFile(paths.config, `${JSON.stringify(driftedConfig, null, 2)}\n`);
      assert.equal((await verifyDoctorAttestation(root)).status, "drifted");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("emits JSONL-ready progress and supports explicit retry and fork recovery", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "recover-source", "Evaluate recovery command behavior.");
      const input = join(root, "source.txt");
      await writeFile(input, "source\n");
      await addProjectInput(root, "recover-source", input, "primary");
      const events: Record<string, unknown>[] = [];
      let failOnce = true;
      const normal = deterministicExecutor();
      const first = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 10,
          dryRun: false,
          environment: {},
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async (request) => {
          if (stageFrom(request) === "analyze" && failOnce) {
            failOnce = false;
            return execution("", 1, 2, "deterministic validation failure");
          }
          return normal(request);
        },
      );
      assert.equal(first.status, "blocked");
      assert.deepEqual(await readdir(workspacePaths(root).runtime), []);
      assert.equal(events[0]?.type, "run.started");
      assert.equal(events.at(-1)?.type, "run.completed");
      assert.ok(events.every((event) => event.requestId === first.requestId));
      const retried = await retryProjectPackage(root, "recover-source", "analyze");
      assert.equal(retried.packages[2]?.status, "ready");
      const completed = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        normal,
      );
      assert.equal(completed.status, "complete", JSON.stringify(completed));

      const forked = await forkProject(root, "recover-source", "recover-fork", "analyze");
      assert.equal(forked.packages[0]?.status, "complete");
      assert.equal(forked.packages[1]?.status, "complete");
      assert.equal(forked.packages[2]?.status, "complete");
      assert.equal(forked.packages[3]?.status, "ready");
      const forkResult = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        normal,
      );
      assert.equal(forkResult.status, "complete", JSON.stringify(forkResult));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a recovery target and preserves source authority when fork validation fails", async () => {
    const root = await temporaryDirectory();
    const sourceId = "fork-rollback-source";
    const targetId = "fork-rollback-target";
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, sourceId, "Keep failed recovery forks side-effect free.");
      const input = join(root, "fork-rollback-source.txt");
      await writeFile(input, "source evidence\n");
      await addProjectInput(root, sourceId, input, "primary");
      const completed = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(completed.status, "complete", JSON.stringify(completed));
      await writeFile(
        join(workspacePaths(root).projects, sourceId, "outputs", "analysis.json"),
        '{"schemaVersion":2}\n',
      );

      await assert.rejects(forkProject(root, sourceId, targetId, "analyze"));
      assert.equal(
        await lstat(join(workspacePaths(root).projects, targetId)).catch(() => null),
        null,
      );
      assert.equal((await loadProject(root, sourceId)).lineage.supersededBy, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens synthesis after reviewer revision while preserving the prior report", async () => {
    const root = await temporaryDirectory();
    const projectId = "reviewer-revision";
    try {
      await initializeResearchWorkspace(root, undefined);
      const project = await initializeProject(
        root,
        projectId,
        "Allow an auditable report revision after independent review.",
      );
      const now = new Date().toISOString();
      for (const stage of ["discover", "acquire", "analyze", "synthesize"] as const) {
        const workPackage = project.packages.find((item) => item.stage === stage)!;
        workPackage.status = "complete";
        workPackage.completedAt = now;
      }
      const review = project.packages.find((item) => item.stage === "review")!;
      review.status = "failed";
      review.completedAt = now;
      review.lastError = "Independent review requested revision.";
      review.lastFailureKind = "configuration";
      await saveProject(root, project);

      const reportPath = join(workspacePaths(root).projects, projectId, "outputs", "report.md");
      const originalReport = "# Report\n\nRevision one with an incorrect graph hash.\n";
      await writeFile(reportPath, originalReport);

      const retried = await retryProjectPackage(root, projectId, "synthesize");
      assert.equal(retried.packages.find((item) => item.stage === "synthesize")?.status, "ready");
      assert.equal(retried.packages.find((item) => item.stage === "review")?.status, "pending");
      assert.equal(retried.packages.find((item) => item.stage === "close")?.status, "pending");
      assert.equal(nextReadyPackage(retried)?.id, "synthesize");
      assert.equal(await readFile(reportPath, "utf8"), originalReport);

      const revisionRoot = join(
        workspacePaths(root).projects,
        projectId,
        "outputs",
        "revisions",
        "synthesize",
      );
      const revisions = await readdir(revisionRoot);
      assert.equal(revisions.length, 1);
      const archivedReport = join(revisionRoot, revisions[0]!, "report.md");
      assert.equal(await readFile(archivedReport, "utf8"), originalReport);
      assert.equal((await lstat(archivedReport)).mode & 0o222, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses closure when the persistent review packet or context is tampered", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "tampered-review-packet", "Evaluate packet immutability.");
      const input = join(root, "packet-source.txt");
      await writeFile(input, "hash-bound source evidence\n");
      await addProjectInput(root, "tampered-review-packet", input, "primary");

      const reviewed = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(reviewed.status, "ready", JSON.stringify(reviewed));
      const review = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "tampered-review-packet", "outputs", "review.json"),
          "utf8",
        ),
      ) as { packetSha256: string };
      const packetPath = join(
        workspacePaths(root).projects,
        "tampered-review-packet",
        "review",
        "packets",
        `${review.packetSha256}.json`,
      );
      const originalPacket = await readFile(packetPath, "utf8");
      const packet = JSON.parse(originalPacket) as {
        reviewEvidenceContext: { path: string };
        snapshotChain: Array<{ path: string }>;
      };
      await writeFile(
        packetPath,
        `${JSON.stringify({ packetSha256: review.packetSha256, tampered: true })}\n`,
      );

      const closure = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(closure.status, "blocked", JSON.stringify(closure));
      const project = await loadProject(root, "tampered-review-packet");
      assert.equal(project.packages.at(-1)?.lastFailureKind, "configuration");
      assert.equal(
        await lstat(
          join(workspacePaths(root).projects, "tampered-review-packet", "outputs", "closure.json"),
        ).catch(() => null),
        null,
      );

      await retryProjectPackage(root, "tampered-review-packet", "close");
      await writeFile(packetPath, originalPacket);
      const contextPath = join(
        workspacePaths(root).projects,
        "tampered-review-packet",
        packet.reviewEvidenceContext.path,
      );
      const originalContext = await readFile(contextPath);
      await writeFile(contextPath, "tampered review evidence context\n");
      const contextClosure = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(contextClosure.status, "blocked", JSON.stringify(contextClosure));
      assert.match(
        (await loadProject(root, "tampered-review-packet")).packages.at(-1)?.lastError ?? "",
        /review evidence context/i,
      );

      await retryProjectPackage(root, "tampered-review-packet", "close");
      await writeFile(contextPath, originalContext);
      const snapshotRecord = packet.snapshotChain[0]!;
      const snapshotPath = join(
        workspacePaths(root).projects,
        "tampered-review-packet",
        snapshotRecord.path,
      );
      await chmod(snapshotPath, 0o600);
      await writeFile(snapshotPath, '{"tampered":true}\n');
      const snapshotClosure = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(snapshotClosure.status, "blocked", JSON.stringify(snapshotClosure));
      assert.match(
        (await loadProject(root, "tampered-review-packet")).packages.at(-1)?.lastError ?? "",
        /snapshot|immutable copy/i,
      );
      assert.equal(
        await lstat(
          join(workspacePaths(root).projects, "tampered-review-packet", "outputs", "closure.json"),
        ).catch(() => null),
        null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function installNetworkCapability(
  root: string,
  skillParent: string,
  http: {
    endpoint?: string;
    accept: string;
    allowedContentTypes: string[];
    maxResponseBytes: number;
    maxItems: number;
  } = {
    accept: "application/json",
    allowedContentTypes: ["application/json"],
    maxResponseBytes: 64 * 1024,
    maxItems: 10,
  },
): Promise<void> {
  const { endpoint = "https://source.test/", ...httpPolicy } = http;
  const healthUrl = new URL(endpoint);
  healthUrl.searchParams.set("query", "connectivity");
  const skillPath = join(skillParent, "public-source-fetch");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: public-source-fetch\ndescription: Fetch bounded public evidence.\n---\n\n# Fetch\n",
  );
  const expectedTreeSha256 = await hashRegularTree(skillPath);
  await writeFile(
    workspacePaths(root).capabilityDeclarations,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.public-source",
            skillPath,
            source: {
              type: "git",
              locator: "https://github.com/example/public-source-skill.git",
              immutableRef: "a".repeat(40),
              expectedTreeSha256,
              license: "MIT",
              catalogId: null,
            },
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["source.test"],
            http: { endpoint, ...httpPolicy },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["*"],
              discoveryScopes: ["public-internet"],
              fullText: true,
              publicationDates: true,
            },
            credentials: [],
            healthCheck: {
              url: healthUrl.toString(),
              credentialId: null,
              expectedContentTypes: [httpPolicy.allowedContentTypes[0]!],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await lockCapabilities(root);
}

function scientificPolicyBinding(projectId: string): ResearchPolicyBinding {
  return {
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
}

function brokerBackedExecutor(
  onReview: (request: AgentExecutionRequest) => void | Promise<void>,
  assertSmallPaginatedContext = true,
  sourceJsonPointer = "/records/0",
): PackageExecutor {
  return async (request) => {
    const stage = stageFrom(request);
    if (stage === "discover") {
      assert.equal(request.toolPolicy, "none");
      assert.match(
        await readFile(join(request.projectRoot, "inputs/capability-documentation.txt"), "utf8"),
        /name: public-source-fetch/,
      );
      assert.match(request.prompt, /name: public-source-fetch/);
      const state = JSON.parse(
        await readFile(join(request.projectRoot, "project.json"), "utf8"),
      ) as { id: string };
      const [candidate] = await listEvidenceCandidates(request.workspaceRoot, state.id);
      assert.ok(candidate);
      assert.equal(candidate.origin.jsonPointer, sourceJsonPointer);
      await recordDiscoveryAssessmentBatch({
        root: request.workspaceRoot,
        projectId: state.id,
        value: {
          schemaVersion: 1,
          assessments: [admissionAssessment(candidate.id, "broker-source")],
        },
      });
      return execution(
        JSON.stringify({
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
        }),
      );
    }
    if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as {
        packetSha256: string;
        evidenceFiles: Array<{ path: string; sha256: string }>;
        evidenceReceipts: Array<{ attemptId: string; locator: string; sha256: string }>;
      };
      assert.ok(packet.evidenceFiles.length >= 1);
      assert.ok(packet.evidenceReceipts.length >= 1);
      assert.match(request.prompt, /### inputs\/review-evidence-context\.txt/);
      if (assertSmallPaginatedContext) {
        assert.match(request.prompt, /"id": 1/);
        assert.doesNotMatch(request.prompt, /"id": 2/);
        assert.doesNotMatch(request.prompt, /"id": 3/);
      }
      for (const file of packet.evidenceFiles) {
        assert.ok(await readFile(join(request.projectRoot, file.path)));
      }
      await onReview(request);
      return execution(JSON.stringify(reviewValue(packet.packetSha256)));
    }
    return deterministicExecutor()(request);
  };
}

function deterministicExecutor(): PackageExecutor {
  return async (request) => {
    const stage = stageFrom(request);
    if (stage === "discover") return execution(JSON.stringify(await inputEvidenceValue(request)));
    if (stage === "acquire") {
      return execution(JSON.stringify(await acquisitionValue(request)));
    }
    if (stage === "analyze") {
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
      return execution(
        JSON.stringify({
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
              statement: "The admitted evidence supports a bounded finding.",
              evidence: [sourceId],
              evidenceAtomIds: atomId ? [atomId] : [],
              claimIds: [],
              analysisArtifactSha256s: [],
              uncertainty: "Limited to admitted evidence.",
              applicability: "Declared question.",
            },
          ],
          limitations: [],
        }),
      );
    }
    if (stage === "synthesize") {
      return execution(
        JSON.stringify({
          schemaVersion: 1,
          reportMarkdown:
            "# Findings\n\nA bounded finding.\n\n# Uncertainty\n\nLimited evidence.\n\n# Next actions\n\nReview.",
        }),
      );
    }
    if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as { packetSha256: string };
      return execution(JSON.stringify(reviewValue(packet.packetSha256)));
    }
    throw new Error(`Unexpected stage ${stage}`);
  };
}

async function acquisitionValue(request: AgentExecutionRequest): Promise<Record<string, unknown>> {
  const state = JSON.parse(await readFile(join(request.projectRoot, "project.json"), "utf8")) as {
    id: string;
  };
  const evidence = JSON.parse(
    await readFile(join(request.projectRoot, "outputs", "evidence.json"), "utf8"),
  ) as {
    sources: Array<{ id: string; provenance: { kind: "input" | "broker"; id: string } }>;
  };
  const candidates = await listEvidenceCandidates(request.workspaceRoot, state.id);
  return {
    schemaVersion: 1,
    decisions: evidence.sources.map((source) => {
      const candidate = candidates.find((item) =>
        source.provenance.kind === "input"
          ? item.origin.inputId === source.provenance.id
          : item.origin.receiptId === source.provenance.id,
      );
      assert.ok(candidate, `missing ledger candidate for ${source.id}`);
      return {
        sourceId: source.id,
        candidateId: candidate.id,
        artifactIds: [],
        status: "accepted",
        rationale: "The immutable input or broker record is usable within its declared scope.",
        limitations: [],
      };
    }),
    limitations: [],
    gaps: [],
  };
}

async function inputEvidenceValue(
  request: AgentExecutionRequest,
  override: {
    dimensions?: string[];
    coverageDimensions?: string[];
    decision?: "pass" | "insufficient";
    gaps?: string[];
    publicationDate?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  const state = JSON.parse(await readFile(join(request.projectRoot, "project.json"), "utf8")) as {
    id: string;
    inputs: Array<{ id: string; path: string }>;
    evidenceRequirements: { dimensions: string[] };
  };
  const input = state.inputs[0];
  assert.ok(input);
  const candidate = (await listEvidenceCandidates(request.workspaceRoot, state.id)).find(
    (item) => item.origin.inputId === input.id,
  );
  assert.ok(candidate);
  const coverageDimensions = override.coverageDimensions ?? ["research-question"];
  const dimensions = state.evidenceRequirements.dimensions;
  void override.dimensions;
  void override.decision;
  void override.publicationDate;
  await recordDiscoveryAssessmentBatch({
    root: request.workspaceRoot,
    projectId: state.id,
    value: {
      schemaVersion: 1,
      assessments: [admissionAssessment(candidate.id, "source-1", coverageDimensions)],
    },
  });
  return {
    schemaVersion: 2,
    limitations: [],
    dimensionJudgments: dimensions.map((id) => ({
      id,
      status: coverageDimensions.includes(id) ? "covered" : "missing",
    })),
    gaps: override.gaps ?? [],
  };
}

function admissionAssessment(
  candidateId: string,
  sourceId: string,
  coverageDimensions: string[] = ["research-question"],
): Record<string, unknown> {
  return {
    decision: "admit",
    candidateId,
    sourceId,
    sourceType: "primary",
    relevance: "Direct evidence.",
    quality: { level: "primary", rationale: "Direct input or response." },
    applicability: "Declared question.",
    coverageDimensions,
    limitations: [],
  };
}

function reviewValue(packetSha256: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packetSha256,
    decision: "pass",
    issues: [],
    rationale: "All claims are traceable to verified evidence.",
  };
}

function execution(
  stdout: string,
  tokens = 10,
  exitCode = 0,
  stderr = "",
  model: string | null = null,
  runtime: ExecutionResult["runtime"] = null,
): ExecutionResult {
  const inputTokens = Math.max(0, tokens - 4);
  const cachedInputTokens = tokens > 1 ? 1 : 0;
  const outputTokens = tokens - inputTokens - cachedInputTokens;
  return {
    exitCode,
    stdout,
    stderr,
    tokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: 0,
    wallSeconds: 0.01,
    model,
    runtime,
  };
}

function stageFrom(request: AgentExecutionRequest): string {
  return request.prompt.match(/^Stage: ([a-z]+)$/m)?.[1] ?? "unknown";
}

async function callBroker(url: string, target: string): Promise<string> {
  const response = await rpc(url, "tools/call", {
    name: "fetch_candidate_source",
    arguments: { capability_id: "method.public-source", url: target },
  });
  return String(
    (
      ((response.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0] ??
      {}
    ).text,
  );
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

async function readWorkspaceText(root: string): Promise<string> {
  const files = await regularTreeFiles(workspacePaths(root).control);
  const chunks: string[] = [];
  for (const path of files) chunks.push(await readFile(path, "utf8").catch(() => ""));
  return chunks.join("\n");
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-production-test-"));
}

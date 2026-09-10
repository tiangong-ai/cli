import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError } from "../../errors.js";
import { resolveAgentAcquisitionRoute } from "./acquisition-routes.js";
import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { loadCapabilityCredentialMap } from "./credentials.js";
import {
  loadBrokerEvidenceCache,
  loadProjectEvidenceReceipts,
  persistBrokerEvidence,
  storeBrokerEvidenceCache,
} from "./evidence.js";
import { registerBrokerCandidates } from "./evidence-ledger.js";
import { deriveDiscoveryPlan } from "./discovery-planning.js";
import { appendJournalEvent, readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { assertProjectAuthority, readProjectAuthorityIndex } from "./project-authority.js";
import { reserveProviderOperation, settleProviderOperation } from "./provider-budget.js";
import { sanitizeResearchRecord, sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  resolveContained,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import type { CapabilityDeclaration } from "./types.js";
import { loadWorkspaceConfig } from "./workspace.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const BROKER_CONTEXT_BYTES_PER_TOKEN = 3;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_INLINE_RETRY_DELAY_SECONDS = 5;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 1;

export interface CapabilityBroker {
  url: string;
  usage(): { maxCalls: number; startedCalls: number; remainingCalls: number };
  stop(): Promise<void>;
}

export async function fetchNativeCandidateSource(input: {
  root: string;
  projectId: string;
  request: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const project = await loadProject(input.root, input.projectId);
  const discover = project.packages.find((workPackage) => workPackage.stage === "discover");
  if (discover?.status !== "running" || discover.executor !== "producer") {
    throw new CliError("Native evidence fetch is allowed only during an active discover stage.", {
      code: "RESEARCH_NATIVE_STAGE_REQUIRED",
      exitCode: 3,
    });
  }
  const declarations = await loadCapabilityDeclarations(input.root);
  const capabilities = declarations.capabilities.filter((capability) =>
    capability.permissions.includes("brokered-network"),
  );
  const verification = await verifyCapabilities(input.root);
  if (verification.status !== "verified") {
    throw new CliError("Native evidence fetch requires verified capability locks.", {
      code: "RESEARCH_CAPABILITY_DRIFT",
      exitCode: 3,
      details: verification,
    });
  }
  const config = await loadWorkspaceConfig(input.root);
  const priorCalls = (await readJournal(workspacePaths(input.root).journal)).filter(
    (event) => event.scope === input.projectId && event.type === "capability.fetch.requested",
  ).length;
  const discoveryPlan = deriveDiscoveryPlan(
    project.evidenceRequirements,
    config,
    capabilities.map((capability) => capability.id),
  );
  const credentialMap = await loadCapabilityCredentialMap(input.root, declarations.capabilities);
  const receipt = await fetchCandidateSource({
    root: input.root,
    projectId: input.projectId,
    capsuleProject: null,
    capabilities,
    credentialMap,
    workspaceResponseBytes: config.budget.maxBrokerResponseBytes,
    workspaceContextTokens: config.budget.maxBrokerContextTokens,
    workspaceMaxItems: config.budget.maxBrokerItems,
    arguments: input.request,
    onBrokerRequest: () => {
      if (priorCalls >= discoveryPlan.maxCalls)
        throw brokerCallLimitError(discoveryPlan.maxCalls, priorCalls);
    },
  });
  const startedCalls = (await readJournal(workspacePaths(input.root).journal)).filter(
    (event) => event.scope === input.projectId && event.type === "capability.fetch.requested",
  ).length;
  return {
    ...receipt,
    brokerBudget: {
      maxCalls: discoveryPlan.maxCalls,
      hardCallLimit: discoveryPlan.hardCallLimit,
      startedCalls,
      remainingCalls: Math.max(0, discoveryPlan.maxCalls - startedCalls),
    },
  };
}

interface BrokerCallBudget {
  maxCalls: number;
  startedCalls: number;
}

export async function startCapabilityBroker(
  root: string,
  projectId: string,
  capsuleProject: string,
): Promise<CapabilityBroker | undefined> {
  const declarations = await loadCapabilityDeclarations(root);
  const networkCapabilities = declarations.capabilities.filter((capability) =>
    capability.permissions.includes("brokered-network"),
  );
  if (!networkCapabilities.length) return undefined;
  const verification = await verifyCapabilities(root);
  if (verification.status !== "verified") {
    throw new CliError("Capability broker requires verified capability locks.", {
      code: "RESEARCH_CAPABILITY_DRIFT",
      exitCode: 3,
      details: verification,
    });
  }
  const credentialMap = await loadCapabilityCredentialMap(root, declarations.capabilities);
  const config = await loadWorkspaceConfig(root);
  const projectPath = join(workspacePaths(root).projects, projectId, "project.json");
  const project = (await pathExists(projectPath)) ? await loadProject(root, projectId) : null;
  const maxCalls = project
    ? deriveDiscoveryPlan(
        project.evidenceRequirements,
        config,
        networkCapabilities.map((capability) => capability.id),
      ).maxCalls
    : config.budget.maxBrokerCalls;
  const priorCalls = (await readJournal(workspacePaths(root).journal)).filter(
    (event) => event.scope === projectId && event.type === "capability.fetch.requested",
  ).length;
  const callBudget: BrokerCallBudget = {
    maxCalls,
    startedCalls: priorCalls,
  };
  const routeToken = randomUUID().replaceAll("-", "");
  const route = `/mcp/${routeToken}`;
  const inFlight = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const operation = handleMcpRequest({
      request,
      response,
      route,
      root,
      projectId,
      capsuleProject,
      capabilities: networkCapabilities,
      credentialMap,
      workspaceResponseBytes: config.budget.maxBrokerResponseBytes,
      workspaceContextTokens: config.budget.maxBrokerContextTokens,
      workspaceMaxItems: config.budget.maxBrokerItems,
      callBudget,
      requireAcquisitionRoute: Boolean(project?.scientificDesign),
    });
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Capability broker did not receive a TCP address.");
  }
  let stopping: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    usage: () => ({
      maxCalls: callBudget.maxCalls,
      startedCalls: callBudget.startedCalls,
      remainingCalls: Math.max(0, callBudget.maxCalls - callBudget.startedCalls),
    }),
    stop: () =>
      (stopping ??= (async () => {
        await new Promise<void>((resolvePromise, reject) => {
          server.close((error) => (error ? reject(error) : resolvePromise()));
        });
        // A disconnected caller can leave an outbound operation running after its
        // socket closes. Drain its evidence and accounting writes before returning.
        await Promise.allSettled([...inFlight]);
      })()),
  };
}

async function handleMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  route: string;
  root: string;
  projectId: string;
  capsuleProject: string;
  capabilities: CapabilityDeclaration[];
  credentialMap: Map<string, string>;
  workspaceResponseBytes: number;
  workspaceContextTokens: number;
  workspaceMaxItems: number;
  callBudget: BrokerCallBudget;
  requireAcquisitionRoute: boolean;
}): Promise<void> {
  try {
    if (input.request.method !== "POST" || input.request.url !== input.route) {
      sendJson(input.response, 404, { error: "not_found" });
      return;
    }
    const body = await readRequestJson(input.request);
    if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      sendRpcError(input.response, body, -32600, "Invalid Request");
      return;
    }
    if (body.method === "notifications/initialized") {
      input.response.writeHead(202).end();
      return;
    }
    if (body.method === "initialize") {
      sendRpcResult(input.response, body, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tiangong-research-broker", version: "1" },
      });
      return;
    }
    if (body.method === "tools/list") {
      sendRpcResult(input.response, body, {
        tools: [
          {
            name: "fetch_candidate_source",
            description: `Fetch one bounded HTTPS candidate source through a locked capability, persist the raw response, and return content-addressed provenance plus a bounded context view. This run permits at most ${input.callBudget.maxCalls} total calls.`,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: [
                ...(input.requireAcquisitionRoute ? ["acquisition_route_id"] : []),
                "capability_id",
                "url",
              ],
              properties: {
                acquisition_route_id: {
                  type: "string",
                  description:
                    "Exact broker-capability route ID from the frozen scientific design. Required for scientific projects.",
                },
                capability_id: { type: "string" },
                credential_id: {
                  type: "string",
                  description:
                    "Logical credential ID. It is selected automatically when the capability declares exactly one credential.",
                },
                url: { type: "string" },
                request_body: {
                  type: "object",
                  description:
                    "JSON request body. Required only when the locked capability explicitly authorizes POST.",
                },
                json_pointer: { type: "string" },
                item_offset: { type: "integer", minimum: 0 },
                max_items: { type: "integer", minimum: 1 },
                cache_mode: {
                  enum: ["prefer", "bypass"],
                  description:
                    "Defaults to bypass for credentialed requests and prefer for public requests. Credentialed responses are never cached.",
                },
              },
            },
          },
        ],
      });
      return;
    }
    if (body.method === "tools/call") {
      const params = body.params;
      if (
        !isObject(params) ||
        params.name !== "fetch_candidate_source" ||
        !isObject(params.arguments)
      ) {
        sendToolError(input.response, body, "Unsupported tool call.");
        return;
      }
      try {
        const receipt = await fetchCandidateSource({
          root: input.root,
          projectId: input.projectId,
          capsuleProject: input.capsuleProject,
          capabilities: input.capabilities,
          credentialMap: input.credentialMap,
          workspaceResponseBytes: input.workspaceResponseBytes,
          workspaceContextTokens: input.workspaceContextTokens,
          workspaceMaxItems: input.workspaceMaxItems,
          arguments: params.arguments,
          onBrokerRequest: () => {
            if (input.callBudget.startedCalls >= input.callBudget.maxCalls) {
              throw brokerCallLimitError(input.callBudget.maxCalls, input.callBudget.startedCalls);
            }
            input.callBudget.startedCalls += 1;
          },
        });
        sendRpcResult(input.response, body, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...receipt,
                brokerBudget: {
                  maxCalls: input.callBudget.maxCalls,
                  startedCalls: input.callBudget.startedCalls,
                  remainingCalls: Math.max(
                    0,
                    input.callBudget.maxCalls - input.callBudget.startedCalls,
                  ),
                },
              }),
            },
          ],
        });
      } catch (error) {
        if (error instanceof CliError && error.code === "RESEARCH_BROKER_CALL_LIMIT_EXCEEDED") {
          await appendJournalEvent(
            workspacePaths(input.root).journal,
            "capability.fetch.rejected",
            input.projectId,
            {
              projectId: input.projectId,
              code: error.code,
              maxCalls: input.callBudget.maxCalls,
              startedCalls: input.callBudget.startedCalls,
            },
          );
        }
        const detail =
          error instanceof CliError
            ? JSON.stringify({ code: error.code, message: error.message, details: error.details })
            : error instanceof Error
              ? error.message
              : String(error);
        sendToolError(
          input.response,
          body,
          sanitizeResearchText(detail, [...input.credentialMap.values()]),
        );
      }
      return;
    }
    sendRpcError(input.response, body, -32601, "Method not found");
  } catch (error) {
    sendJson(input.response, 500, {
      error: sanitizeResearchText(error instanceof Error ? error.message : String(error), [
        ...input.credentialMap.values(),
      ]),
    });
  }
}

async function fetchCandidateSource(input: {
  root: string;
  projectId: string;
  capsuleProject: string | null;
  capabilities: CapabilityDeclaration[];
  credentialMap: Map<string, string>;
  workspaceResponseBytes: number;
  workspaceContextTokens: number;
  workspaceMaxItems: number;
  arguments: Record<string, unknown>;
  onBrokerRequest?: () => void;
}): Promise<Record<string, unknown>> {
  const capabilityId = input.arguments.capability_id;
  const requestedAcquisitionRouteId = input.arguments.acquisition_route_id;
  const credentialId = input.arguments.credential_id;
  const rawUrl = input.arguments.url;
  const requestBody = input.arguments.request_body;
  const jsonPointer = input.arguments.json_pointer;
  const requestedItemOffset = input.arguments.item_offset ?? 0;
  const requestedMaxItems = input.arguments.max_items;
  const requestedCacheMode = input.arguments.cache_mode;
  if (typeof capabilityId !== "string" || typeof rawUrl !== "string") {
    throw new Error("capability_id and url are required strings");
  }
  if (credentialId !== undefined && typeof credentialId !== "string") {
    throw new Error("credential_id must be a string when provided");
  }
  if (
    requestedAcquisitionRouteId !== undefined &&
    typeof requestedAcquisitionRouteId !== "string"
  ) {
    throw new Error("acquisition_route_id must be a string when provided");
  }
  if (
    jsonPointer !== undefined &&
    (typeof jsonPointer !== "string" || !validJsonPointer(jsonPointer))
  ) {
    throw new Error("json_pointer must be an RFC 6901 JSON Pointer when provided");
  }
  if (
    typeof requestedItemOffset !== "number" ||
    !Number.isInteger(requestedItemOffset) ||
    requestedItemOffset < 0
  ) {
    throw new Error("item_offset must be a non-negative integer when provided");
  }
  if (
    requestedMaxItems !== undefined &&
    (typeof requestedMaxItems !== "number" ||
      !Number.isInteger(requestedMaxItems) ||
      requestedMaxItems < 1)
  ) {
    throw new Error("max_items must be a positive integer when provided");
  }
  if (
    requestedCacheMode !== undefined &&
    requestedCacheMode !== "prefer" &&
    requestedCacheMode !== "bypass"
  ) {
    throw new Error('cache_mode must be "prefer" or "bypass"');
  }
  const capability = input.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!capability) {
    throw brokerDiagnosticError(
      "CAPABILITY_NOT_DECLARED",
      "The requested evidence capability is not present in the locked manifest.",
      false,
      "Have the workspace owner select or import the exact reviewed capability, configure it, rebuild the capability lock, and pass doctor before retrying.",
      { capabilityId },
    );
  }
  if (!capability.http) {
    throw brokerDiagnosticError(
      "CAPABILITY_NOT_DECLARED",
      "The requested capability has no locked broker HTTP policy.",
      false,
      "Replace the capability declaration with a reviewed brokered-network capability and rebuild the lock.",
      { capabilityId },
    );
  }
  const projectPath = join(workspacePaths(input.root).projects, input.projectId, "project.json");
  const project = (await pathExists(projectPath))
    ? await loadProject(input.root, input.projectId)
    : null;
  if (!project && requestedAcquisitionRouteId !== undefined) {
    throw new CliError("A broker acquisition route requires an initialized research project.", {
      code: "RESEARCH_EVIDENCE_ACQUISITION_ROUTE_INVALID",
      exitCode: 3,
    });
  }
  if (project) assertProjectAuthority(project, await readProjectAuthorityIndex(input.root));
  const acquisitionRoute = project
    ? await resolveAgentAcquisitionRoute({
        root: input.root,
        project,
        routeId: requestedAcquisitionRouteId,
        routeClasses: ["broker-capability"],
        capabilityId,
      })
    : null;
  const acquisitionRouteId = acquisitionRoute?.id ?? null;
  let target: URL;
  let encodedRequestBody: string | null;
  try {
    target = validateHttpsUrl(rawUrl);
    assertEndpointScope(target, capability.http.endpoint);
    encodedRequestBody = validateBrokerRequestBody(
      capability.http.method,
      requestBody,
      capability.http.maxRequestBytes,
    );
  } catch {
    throw brokerDiagnosticError(
      "BROKER_CREDENTIAL_INJECTION_REJECTED",
      "The broker rejected the request before credential injection because it does not match the locked endpoint or method policy.",
      false,
      "Use only the exact locked capability ID, endpoint, HTTP method, and non-secret request shape.",
      { capabilityId },
    );
  }
  const credential = credentialId
    ? capability.credentials.find((candidate) => candidate.id === credentialId)
    : capability.credentials.length === 1
      ? capability.credentials[0]
      : undefined;
  if (credentialId && !credential) {
    throw brokerDiagnosticError(
      "BROKER_CREDENTIAL_INJECTION_REJECTED",
      "The requested logical credential is not declared by the locked capability.",
      false,
      "Use the logical credential ID declared by the capability manifest; never pass credential values through tool arguments.",
      { capabilityId, credentialId },
    );
  }
  if (!credentialId && capability.credentials.length > 1) {
    throw brokerDiagnosticError(
      "BROKER_CREDENTIAL_INJECTION_REJECTED",
      "The capability declares multiple logical credentials and requires an explicit credential ID.",
      false,
      "Select one logical credential ID from the locked capability declaration without including its value.",
      { capabilityId },
    );
  }
  const effectiveCredentialId = credential?.id ?? null;
  const cacheMode = requestedCacheMode ?? (credential ? "bypass" : "prefer");
  if (credential && cacheMode === "prefer") {
    throw brokerDiagnosticError(
      "BROKER_CREDENTIAL_INJECTION_REJECTED",
      "Credentialed broker requests cannot use the shared response cache.",
      false,
      "Retry the locked capability request with cache_mode=bypass.",
      { capabilityId, credentialId: credential.id },
    );
  }
  try {
    assertAllowedHost(target, capability.allowedHosts, "capability");
    if (credential) assertAllowedHost(target, credential.allowedHosts, "credential");
  } catch {
    throw brokerDiagnosticError(
      "BROKER_CREDENTIAL_INJECTION_REJECTED",
      "The broker refused credential injection because the target host is outside the locked policy.",
      false,
      "Use the exact credential-free HTTPS endpoint and host declared by the locked capability.",
      { capabilityId, credentialId: credential?.id ?? null },
    );
  }
  const attemptId = randomUUID();
  const maxItems = Math.min(
    (requestedMaxItems as number | undefined) ?? capability.http.maxItems,
    capability.http.maxItems,
    input.workspaceMaxItems,
  );
  const cacheKeySha256 = sha256Text(
    canonicalJson({
      capabilityId,
      targetSha256: sha256Text(target.toString()),
      method: capability.http.method,
      requestBodySha256: encodedRequestBody ? sha256Text(encodedRequestBody) : null,
      accept: capability.http.accept,
    }),
  );
  input.onBrokerRequest?.();
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "capability.fetch.requested",
    input.projectId,
    {
      attemptId,
      projectId: input.projectId,
      acquisitionRouteId,
      capabilityId,
      credentialId: effectiveCredentialId,
      targetSha256: sha256Text(target.toString()),
      method: capability.http.method,
      requestBodySha256: encodedRequestBody ? sha256Text(encodedRequestBody) : null,
      cacheMode,
      cacheKeySha256,
    },
  );
  const projectReuse = await findProjectRequestReuse(
    input.root,
    input.projectId,
    cacheKeySha256,
    effectiveCredentialId,
  );
  if (projectReuse) {
    const raw = await readFile(
      resolveContained(workspacePaths(input.root).control, projectReuse.locator),
    );
    const context = buildContextView(
      raw,
      projectReuse.contentType,
      jsonPointer as string | undefined,
      requestedItemOffset,
      maxItems,
      input.workspaceContextTokens * BROKER_CONTEXT_BYTES_PER_TOKEN,
    );
    const receipt = await persistBrokerEvidence(
      input.root,
      {
        attemptId,
        projectId: input.projectId,
        capabilityId,
        credentialId: effectiveCredentialId,
        status: projectReuse.status,
        contentType: projectReuse.contentType,
        sourceSha256: projectReuse.sourceSha256,
        contextItems: context.items,
        contextOffset: context.offset,
        contextTotalItems: context.totalItems,
        contextNextOffset: context.nextOffset,
        contextTruncated: context.truncated,
        redactions: projectReuse.redactions,
        retrievedAt: projectReuse.retrievedAt,
        cacheHit: true,
      },
      raw,
      context.bytes,
    );
    if (input.capsuleProject) {
      await stageContextObject(input.capsuleProject, receipt.contextLocator, context.bytes);
    }
    const candidates = await registerBrokerCandidates({
      root: input.root,
      projectId: input.projectId,
      receipt,
      contextBytes: context.bytes,
      selectedJsonPointer: context.selectedJsonPointer,
      itemOffset: context.offset,
    });
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "capability.fetch.reused",
      input.projectId,
      {
        attemptId,
        reusedAttemptId: projectReuse.attemptId,
        projectId: input.projectId,
        acquisitionRouteId,
        capabilityId,
        credentialId: effectiveCredentialId,
        cacheKeySha256,
        contextOffset: context.offset,
        contextItems: context.items,
        candidateCount: candidates.length,
      },
    );
    await appendCompletedReceipt(
      input.root,
      input.projectId,
      receipt,
      cacheKeySha256,
      candidates.length,
      false,
      "project",
      acquisitionRouteId,
    );
    return brokerToolResult(
      receipt,
      context.bytes,
      projectReuse.contentType,
      candidates,
      "project",
      acquisitionRouteId,
    );
  }
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "capability.fetch.attempted",
    input.projectId,
    {
      attemptId,
      projectId: input.projectId,
      acquisitionRouteId,
      capabilityId,
      credentialId: effectiveCredentialId,
      targetSha256: sha256Text(target.toString()),
      method: capability.http.method,
      requestBodySha256: encodedRequestBody ? sha256Text(encodedRequestBody) : null,
      cacheMode,
      cacheKeySha256,
    },
  );
  let providerReservation: string | null = null;
  try {
    if (cacheMode === "prefer") {
      const cached = await loadBrokerEvidenceCache(input.root, cacheKeySha256);
      if (cached) {
        const raw = await readFile(
          resolveContained(workspacePaths(input.root).control, cached.locator),
        );
        const context = buildContextView(
          raw,
          cached.contentType,
          jsonPointer as string | undefined,
          requestedItemOffset,
          maxItems,
          input.workspaceContextTokens * BROKER_CONTEXT_BYTES_PER_TOKEN,
        );
        const receipt = await persistBrokerEvidence(
          input.root,
          {
            attemptId,
            projectId: input.projectId,
            capabilityId,
            credentialId: null,
            status: cached.status,
            contentType: cached.contentType,
            sourceSha256: cached.sourceSha256,
            contextItems: context.items,
            contextOffset: context.offset,
            contextTotalItems: context.totalItems,
            contextNextOffset: context.nextOffset,
            contextTruncated: context.truncated,
            redactions: cached.redactions,
            retrievedAt: cached.retrievedAt,
            cacheHit: true,
          },
          raw,
          context.bytes,
        );
        if (input.capsuleProject) {
          await stageContextObject(input.capsuleProject, receipt.contextLocator, context.bytes);
        }
        const candidates = await registerBrokerCandidates({
          root: input.root,
          projectId: input.projectId,
          receipt,
          contextBytes: context.bytes,
          selectedJsonPointer: context.selectedJsonPointer,
          itemOffset: context.offset,
        });
        await appendCompletedReceipt(
          input.root,
          input.projectId,
          receipt,
          cacheKeySha256,
          candidates.length,
          false,
          "workspace",
          acquisitionRouteId,
        );
        return brokerToolResult(
          receipt,
          context.bytes,
          cached.contentType,
          candidates,
          "workspace",
          acquisitionRouteId,
        );
      }
    }
    const headers = new Headers(capability.http.staticHeaders);
    headers.set("Accept", capability.http.accept);
    if (encodedRequestBody) headers.set("Content-Type", "application/json");
    if (credential) {
      const value = input.credentialMap.get(credential.id);
      if (!value) {
        throw brokerDiagnosticError(
          "BROKER_CREDENTIAL_NOT_CONFIGURED",
          "The locked capability's logical credential is not configured in the broker store.",
          false,
          "Use research setup credential set with hidden input, stdin, or an owner environment variable, then rerun capability doctor.",
          { capabilityId, credentialId: credential.id },
        );
      }
      headers.set(credential.headerName, `${credential.prefix}${value}`);
    }
    if (project) {
      providerReservation = await reserveProviderOperation(
        input.root,
        project,
        await loadWorkspaceConfig(input.root),
        capabilityId,
        attemptId,
      );
    }
    const responseLimit = Math.min(capability.http.maxResponseBytes, input.workspaceResponseBytes);
    let response!: Response;
    let finalUrl!: URL;
    let rateLimitRetries = 0;
    while (true) {
      ({ response, finalUrl } = await fetchWithRedirectPolicy(
        target,
        headers,
        capability.allowedHosts,
        credential?.allowedHosts,
        capability.http.method,
        encodedRequestBody,
        capability.http.endpoint,
      ));
      if (response.status !== 429 || rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) break;
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const retryDelaySeconds = retryAfterSeconds ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS;
      if (retryDelaySeconds > MAX_INLINE_RETRY_DELAY_SECONDS) break;
      const retryBytes = await readBoundedResponseBody(
        response,
        Math.min(responseLimit, MAX_ERROR_RESPONSE_BYTES),
        true,
      );
      assertConfiguredCredentialsAbsent(retryBytes, input.credentialMap.values());
      const retryContentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ??
        "application/octet-stream";
      rateLimitRetries += 1;
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "capability.fetch.retry.scheduled",
        input.projectId,
        {
          attemptId,
          projectId: input.projectId,
          acquisitionRouteId,
          capabilityId,
          credentialId: effectiveCredentialId,
          status: response.status,
          failureKind: "rate-limit",
          providerAttempt: rateLimitRetries,
          maxProviderAttempts: MAX_RATE_LIMIT_RETRIES + 1,
          retryAfterSeconds,
          retryDelaySeconds,
          responseExcerpt: safeResponseExcerpt(retryBytes, retryContentType, [
            ...input.credentialMap.values(),
          ]),
          requestId: safeResponseId(response.headers),
        },
      );
      if (retryDelaySeconds > 0) await delay(retryDelaySeconds * 1000);
    }
    const announcedLength = Number(response.headers.get("content-length") ?? "0");
    if (response.ok && announcedLength > responseLimit)
      throw new Error("response exceeds the broker size limit");
    const bytes = await readBoundedResponseBody(
      response,
      response.ok ? responseLimit : Math.min(responseLimit, MAX_ERROR_RESPONSE_BYTES),
      !response.ok,
    );
    assertConfiguredCredentialsAbsent(bytes, input.credentialMap.values());
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const excerpt = safeResponseExcerpt(bytes, contentType, [...input.credentialMap.values()]);
      if (response.status === 401 || response.status === 403) {
        throw brokerDiagnosticError(
          "PROVIDER_AUTHENTICATION_FAILED",
          "The provider rejected the broker-injected logical credential or entitlement.",
          true,
          "Verify the configured logical credential and provider entitlement, then rerun capability doctor before retrying research.",
          {
            capabilityId,
            credentialId: effectiveCredentialId,
            status: response.status,
            requestId: safeResponseId(response.headers),
          },
        );
      }
      throw new CliError(`HTTPS source returned status ${response.status}.`, {
        code: "RESEARCH_BROKER_HTTP_ERROR",
        exitCode: 3,
        details: {
          executionMode: "broker",
          credentialScope: "broker",
          networkAttempted: true,
          minimumAction:
            response.status === 429
              ? "Honor Retry-After or the provider quota reset, then retry through the same locked broker capability."
              : "Resolve the provider response or capability contract, then retry through the same locked broker capability.",
          status: response.status,
          retryAfterSeconds,
          responseExcerpt: excerpt,
          requestId: safeResponseId(response.headers),
        },
      });
    }
    if (!contentTypeAllowed(contentType, capability.http.allowedContentTypes)) {
      throw new CliError(`HTTPS source returned unsupported content type ${contentType}.`, {
        code: "RESEARCH_BROKER_CONTENT_TYPE_INVALID",
        exitCode: 3,
        details: { contentType, allowedContentTypes: capability.http.allowedContentTypes },
      });
    }
    const persistable = preparePersistableResponse(bytes, contentType);
    const context = buildContextView(
      persistable.bytes,
      contentType,
      jsonPointer as string | undefined,
      requestedItemOffset,
      maxItems,
      input.workspaceContextTokens * BROKER_CONTEXT_BYTES_PER_TOKEN,
    );
    const receipt = await persistBrokerEvidence(
      input.root,
      {
        attemptId,
        projectId: input.projectId,
        capabilityId,
        credentialId: effectiveCredentialId,
        status: response.status,
        contentType,
        sourceSha256: sha256Text(finalUrl.toString()),
        contextItems: context.items,
        contextOffset: context.offset,
        contextTotalItems: context.totalItems,
        contextNextOffset: context.nextOffset,
        contextTruncated: context.truncated,
        redactions: persistable.redactions,
        retrievedAt: new Date().toISOString(),
        cacheHit: false,
      },
      persistable.bytes,
      context.bytes,
    );
    if (input.capsuleProject) {
      await stageContextObject(input.capsuleProject, receipt.contextLocator, context.bytes);
    }
    if (!credential) await storeBrokerEvidenceCache(input.root, cacheKeySha256, receipt);
    const candidates = await registerBrokerCandidates({
      root: input.root,
      projectId: input.projectId,
      receipt,
      contextBytes: context.bytes,
      selectedJsonPointer: context.selectedJsonPointer,
      itemOffset: context.offset,
    });
    await appendCompletedReceipt(
      input.root,
      input.projectId,
      receipt,
      cacheKeySha256,
      candidates.length,
      true,
      null,
      acquisitionRouteId,
    );
    return brokerToolResult(
      receipt,
      context.bytes,
      contentType,
      candidates,
      null,
      acquisitionRouteId,
    );
  } catch (error) {
    const reportedError = structuredBrokerFailure(error, capabilityId, effectiveCredentialId);
    const safeDetails =
      reportedError instanceof CliError && isObject(reportedError.details)
        ? sanitizeResearchRecord(reportedError.details, [...input.credentialMap.values()])
        : {};
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "capability.fetch.failed",
      input.projectId,
      {
        attemptId,
        projectId: input.projectId,
        acquisitionRouteId,
        capabilityId,
        credentialId: effectiveCredentialId,
        error: bounded(
          sanitizeResearchText(reportedError.message, [...input.credentialMap.values()]),
          500,
        ),
        failureKind: brokerFailureKind(reportedError),
        ...safeDetails,
      },
    );
    throw reportedError;
  } finally {
    // Preserve paid evidence/failure diagnostics before conservative accounting.
    await settleProviderOperation(input.root, input.projectId, providerReservation);
  }
}

function structuredBrokerFailure(
  error: unknown,
  capabilityId: string,
  credentialId: string | null,
): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const disclosureRejected = /credential-like material|credential disclosure screening/i.test(
    message,
  );
  return new CliError(
    disclosureRejected
      ? "The provider response was rejected by disclosure screening and was not persisted."
      : bounded(sanitizeResearchText(message), 500),
    {
      code: disclosureRejected
        ? "RESEARCH_BROKER_RESPONSE_REJECTED"
        : "RESEARCH_BROKER_FETCH_FAILED",
      exitCode: 3,
      details: {
        executionMode: "broker",
        credentialScope: "broker",
        networkAttempted: true,
        minimumAction: disclosureRejected
          ? "Refine the request or capability response projection so credential-like provider fields are excluded before retrying."
          : "Inspect the sanitized broker failure, then retry only after correcting the deterministic request/provider condition or a transient network failure.",
        capabilityId,
        credentialId,
      },
    },
  );
}

function brokerToolResult(
  receipt: object,
  context: Buffer,
  contentType: string,
  candidates: Awaited<ReturnType<typeof registerBrokerCandidates>>,
  reuseScope: "project" | "workspace" | null,
  acquisitionRouteId: string | null,
): Record<string, unknown> {
  const inline = contentType.includes("json") || contentType.startsWith("text/");
  return {
    ...Object.fromEntries(Object.entries(receipt)),
    boundedContext: {
      encoding: inline ? "utf8" : "not-inlined",
      text: inline ? context.toString("utf8") : null,
    },
    candidates,
    acquisitionRouteId,
    networkAttempted: reuseScope === null,
    reuseScope,
  };
}

function preparePersistableResponse(
  bytes: Buffer,
  contentType: string,
): { bytes: Buffer; redactions: number } {
  if (!contentType.includes("json")) {
    assertNoSensitiveResponseMaterial(bytes, contentType);
    return { bytes, redactions: 0 };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("JSON response body is not valid JSON");
  }
  const result = redactSensitiveJson(value);
  const persistable = Buffer.from(JSON.stringify(result.value), "utf8");
  assertNoSensitiveResponseMaterial(persistable, contentType);
  return { bytes: persistable, redactions: result.redactions };
}

function redactSensitiveJson(value: unknown): { value: unknown; redactions: number } {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let redactions = 0;
    for (const item of value) {
      const result = redactSensitiveJson(item);
      items.push(result.value);
      redactions += result.redactions;
    }
    return { value: items, redactions };
  }
  if (!isObject(value)) {
    if (typeof value !== "string") return { value, redactions: 0 };
    const sanitized = sanitizeResearchText(value);
    return { value: sanitized, redactions: sanitized === value ? 0 : 1 };
  }
  const result: Record<string, unknown> = {};
  let redactions = 0;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveJsonKey(key)) {
      redactions += 1;
      continue;
    }
    const child = redactSensitiveJson(item);
    result[key] = child.value;
    redactions += child.redactions;
  }
  return { value: result, redactions };
}

function assertNoSensitiveResponseMaterial(bytes: Buffer, contentType: string): void {
  if (!contentType.includes("json") && !contentType.startsWith("text/")) return;
  const text = bytes.toString("utf8");
  if (
    /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)\s*:/i.test(text) ||
    /\b(access_token|api[_-]?key|apikey|password|secret|session|token)\s*=/i.test(text)
  ) {
    throw new Error("response contains credential-like material and was not persisted");
  }
  if (!contentType.includes("json")) return;
  try {
    const value = JSON.parse(text) as unknown;
    if (containsSensitiveJsonField(value)) {
      throw new Error("response contains credential-like material and was not persisted");
    }
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

function assertConfiguredCredentialsAbsent(bytes: Buffer, secrets: Iterable<string>): void {
  for (const secret of secrets) {
    if (bytes.includes(Buffer.from(secret, "utf8"))) {
      throw new Error("response failed credential disclosure screening");
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function containsSensitiveJsonField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveJsonField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (sensitiveJsonKey(key) && item !== null && item !== "") || containsSensitiveJsonField(item),
  );
}

function sensitiveJsonKey(key: string): boolean {
  return /^(access_token|api[_-]?key|apikey|authorization|cookie|password|secret|session|token)$/i.test(
    key,
  );
}

async function stageContextObject(
  capsuleProject: string,
  locator: string,
  bytes: Uint8Array,
): Promise<void> {
  const destination = resolveContained(capsuleProject, locator);
  await ensureDirectory(dirname(destination));
  try {
    await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(destination)).equals(Buffer.from(bytes))) {
      throw new Error("staged broker context object failed its integrity check");
    }
  }
}

async function appendCompletedReceipt(
  root: string,
  projectId: string,
  receipt: Awaited<ReturnType<typeof persistBrokerEvidence>>,
  cacheKeySha256: string,
  candidateCount: number,
  networkAttempted: boolean,
  reuseScope: "project" | "workspace" | null,
  acquisitionRouteId: string | null,
): Promise<void> {
  await appendJournalEvent(workspacePaths(root).journal, "capability.fetch.completed", projectId, {
    attemptId: receipt.attemptId,
    projectId: receipt.projectId,
    acquisitionRouteId,
    capabilityId: receipt.capabilityId,
    credentialId: receipt.credentialId,
    status: receipt.status,
    contentType: receipt.contentType,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceSha256: receipt.sourceSha256,
    locator: receipt.locator,
    contextLocator: receipt.contextLocator,
    contextSha256: receipt.contextSha256,
    contextBytes: receipt.contextBytes,
    contextEstimatedTokens: receipt.contextEstimatedTokens,
    contextItems: receipt.contextItems,
    contextOffset: receipt.contextOffset ?? 0,
    contextTotalItems: receipt.contextTotalItems ?? null,
    contextNextOffset: receipt.contextNextOffset ?? null,
    contextTruncated: receipt.contextTruncated,
    redactions: receipt.redactions,
    candidateCount,
    networkAttempted,
    reuseScope,
    retrievedAt: receipt.retrievedAt,
    servedAt: receipt.servedAt,
    cacheHit: receipt.cacheHit,
    cacheKeySha256,
  });
}

async function findProjectRequestReuse(
  root: string,
  projectId: string,
  cacheKeySha256: string,
  credentialId: string | null,
): Promise<Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>[number] | null> {
  const events = await readJournal(workspacePaths(root).journal);
  const completed = [...events]
    .reverse()
    .find(
      (event) =>
        event.scope === projectId &&
        event.type === "capability.fetch.completed" &&
        event.payload.cacheKeySha256 === cacheKeySha256 &&
        event.payload.credentialId === credentialId &&
        typeof event.payload.attemptId === "string",
    );
  if (!completed) return null;
  const receipts = await loadProjectEvidenceReceipts(root, projectId);
  return receipts.find((receipt) => receipt.attemptId === completed.payload.attemptId) ?? null;
}

function brokerCallLimitError(maxCalls: number, startedCalls: number): CliError {
  return new CliError("The derived broker call budget is exhausted.", {
    code: "RESEARCH_BROKER_CALL_LIMIT_EXCEEDED",
    exitCode: 3,
    details: {
      executionMode: "broker",
      networkAttempted: false,
      maxCalls,
      startedCalls,
      minimumAction:
        "Assess the registered candidates and coverage gaps; increase the reviewed hard ceiling only if a justified gap-fill batch remains.",
    },
  });
}

async function fetchWithRedirectPolicy(
  initialUrl: URL,
  headers: Headers,
  capabilityHosts: string[],
  credentialHosts: string[] | undefined,
  method: "GET" | "POST",
  body: string | null,
  endpoint: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertAllowedHost(current, capabilityHosts, "capability");
    if (credentialHosts) assertAllowedHost(current, credentialHosts, "credential");
    assertEndpointScope(current, endpoint);
    const response = await fetch(current, {
      method,
      headers,
      ...(body === null ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    if (method === "POST") {
      await response.body?.cancel();
      throw new Error("POST capability redirects are not authorized");
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("HTTPS source returned a redirect without a location");
    if (redirects === 5) throw new Error("HTTPS source exceeded the redirect limit");
    current = validateHttpsUrl(new URL(location, current).toString());
  }
  throw new Error("HTTPS source exceeded the redirect limit");
}

function validateBrokerRequestBody(
  method: "GET" | "POST",
  value: unknown,
  maxRequestBytes: number,
): string | null {
  if (method === "GET") {
    if (value !== undefined) throw new Error("GET capability does not accept request_body");
    return null;
  }
  if (!isObject(value)) throw new Error("POST capability requires request_body as an object");
  if (containsSensitiveJsonField(value)) {
    throw new Error("request_body contains credential-like fields");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxRequestBytes) {
    throw new Error("request_body exceeds the capability request size limit");
  }
  return encoded;
}

function assertAllowedHost(url: URL, allowedHosts: string[], scope: string): void {
  if (!allowedHosts.includes(url.host)) {
    throw new Error(`target host is outside ${scope} scope: ${url.host}`);
  }
}

function assertEndpointScope(target: URL, endpointValue: string): void {
  const endpoint = new URL(endpointValue);
  if (
    target.protocol !== endpoint.protocol ||
    target.host.toLowerCase() !== endpoint.host.toLowerCase() ||
    (endpoint.pathname !== "/" && target.pathname !== endpoint.pathname)
  ) {
    throw new Error("target URL is outside the capability endpoint scope");
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  truncate = false,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        if (truncate) {
          const remaining = maxBytes - chunks.reduce((sum, item) => sum + item.length, 0);
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          break;
        }
        throw new Error("response exceeds the broker size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function buildContextView(
  bytes: Buffer,
  contentType: string,
  jsonPointer: string | undefined,
  itemOffset: number,
  maxItems: number,
  maxContextBytes: number,
): {
  bytes: Buffer;
  items: number | null;
  offset: number;
  totalItems: number | null;
  nextOffset: number | null;
  truncated: boolean;
  selectedJsonPointer: string | null;
} {
  if (!Number.isInteger(maxContextBytes) || maxContextBytes < 1) {
    throw new Error("broker context byte limit is invalid");
  }
  if (!contentType.includes("json")) {
    if (itemOffset !== 0) throw new Error("item_offset is supported only for JSON collections");
    const boundedBytes = contentType.startsWith("text/")
      ? truncateUtf8(bytes, maxContextBytes)
      : bytes.subarray(0, maxContextBytes);
    return {
      bytes: boundedBytes,
      items: null,
      offset: 0,
      totalItems: null,
      nextOffset: null,
      truncated: boundedBytes.byteLength < bytes.byteLength,
      selectedJsonPointer: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("JSON response body is not valid JSON");
  }
  const automaticSelection = jsonPointer === undefined ? defaultCandidateCollection(parsed) : null;
  const selectedJsonPointer = jsonPointer ?? automaticSelection?.jsonPointer ?? null;
  const selected = automaticSelection
    ? automaticSelection.value
    : jsonPointer === undefined
      ? parsed
      : resolveJsonPointer(parsed, jsonPointer);
  if (Array.isArray(selected)) {
    const limited: unknown[] = [];
    for (const item of selected.slice(itemOffset, itemOffset + maxItems)) {
      const candidate = [...limited, item];
      if (jsonBytes(candidate).byteLength > maxContextBytes) break;
      limited.push(item);
    }
    const nextOffset =
      itemOffset + limited.length < selected.length ? itemOffset + limited.length : null;
    return {
      bytes: jsonBytes(limited),
      items: limited.length,
      offset: itemOffset,
      totalItems: selected.length,
      nextOffset,
      truncated: itemOffset > 0 || nextOffset !== null,
      selectedJsonPointer,
    };
  }
  if (isObject(selected)) {
    const entries = Object.entries(selected);
    const limited: Array<[string, unknown]> = [];
    for (const entry of entries.slice(itemOffset, itemOffset + maxItems)) {
      const candidate = [...limited, entry];
      if (jsonBytes(Object.fromEntries(candidate)).byteLength > maxContextBytes) break;
      limited.push(entry);
    }
    const nextOffset =
      itemOffset + limited.length < entries.length ? itemOffset + limited.length : null;
    return {
      bytes: jsonBytes(Object.fromEntries(limited)),
      items: limited.length,
      offset: itemOffset,
      totalItems: entries.length,
      nextOffset,
      truncated: itemOffset > 0 || nextOffset !== null,
      selectedJsonPointer,
    };
  }
  if (itemOffset !== 0) throw new Error("item_offset is supported only for JSON collections");
  const encoded = jsonBytes(selected);
  if (encoded.byteLength <= maxContextBytes) {
    return {
      bytes: encoded,
      items: 1,
      offset: 0,
      totalItems: 1,
      nextOffset: null,
      truncated: false,
      selectedJsonPointer,
    };
  }
  if (typeof selected !== "string") {
    throw new Error("selected JSON scalar exceeds the broker context token limit");
  }
  const characters = [...selected];
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (jsonBytes(characters.slice(0, middle).join("")).byteLength <= maxContextBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return {
    bytes: jsonBytes(characters.slice(0, lower).join("")),
    items: 1,
    offset: 0,
    totalItems: 1,
    nextOffset: null,
    truncated: true,
    selectedJsonPointer,
  };
}

function defaultCandidateCollection(
  value: unknown,
): { value: unknown[]; jsonPointer: string } | null {
  if (!isObject(value)) return null;
  for (const [jsonPointer, candidate] of [
    ["/web/results", isObject(value.web) ? value.web.results : undefined],
    ["/results", value.results],
    ["/records", value.records],
    ["/items", value.items],
    ["/data", value.data],
  ] as const) {
    if (Array.isArray(candidate)) return { value: candidate, jsonPointer };
  }
  return null;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function truncateUtf8(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    const candidate = bytes.subarray(0, end);
    try {
      decoder.decode(candidate);
      return Buffer.from(candidate);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let selected = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      Array.isArray(selected) &&
      /^(0|[1-9][0-9]*)$/.test(part) &&
      Number(part) < selected.length
    ) {
      selected = selected[Number(part)];
    } else if (isObject(selected) && Object.hasOwn(selected, part)) {
      selected = selected[part];
    } else {
      throw new Error("json_pointer does not resolve within the response");
    }
  }
  return selected;
}

function validJsonPointer(value: string): boolean {
  return value === "" || (value.startsWith("/") && !/~(?:[^01]|$)/.test(value));
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((pattern) => {
    const candidate = pattern.toLowerCase();
    if (candidate === "*/*" || candidate === normalized) return true;
    const escaped = candidate.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(normalized);
  });
}

function safeResponseExcerpt(bytes: Buffer, contentType: string, secrets: string[]): string {
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    return `[${bytes.length} non-text byte(s)]`;
  }
  return bounded(sanitizeResearchText(bytes.toString("utf8"), secrets).replace(/\s+/g, " "), 1000);
}

function safeResponseId(headers: Headers): string | null {
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
    const value = headers.get(name)?.trim();
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  }
  return null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function brokerDiagnosticError(
  code:
    | "CAPABILITY_NOT_DECLARED"
    | "BROKER_CREDENTIAL_NOT_CONFIGURED"
    | "BROKER_CREDENTIAL_INJECTION_REJECTED"
    | "PROVIDER_AUTHENTICATION_FAILED",
  message: string,
  networkAttempted: boolean,
  minimumAction: string,
  extra: Record<string, unknown> = {},
): CliError {
  return new CliError(message, {
    code,
    exitCode: 3,
    details: {
      executionMode: "broker",
      credentialScope: "broker",
      networkAttempted,
      minimumAction,
      ...extra,
    },
  });
}

function brokerFailureKind(error: unknown): string {
  if (error instanceof CliError && error.code === "PROVIDER_AUTHENTICATION_FAILED") {
    return "authentication";
  }
  if (error instanceof CliError && error.code === "RESEARCH_BROKER_HTTP_ERROR") {
    const status = isObject(error.details) ? error.details.status : undefined;
    if (status === 429) return "rate-limit";
    if (typeof status === "number" && status >= 500) return "server";
    return "deterministic";
  }
  return error instanceof TypeError ? "transient" : "deterministic";
}

function validateHttpsUrl(value: string): URL {
  const url = new URL(value);
  const sensitive =
    /^(access_token|api[_-]?key|apikey|auth|authorization|cookie|key|password|secret|session|sig|signature|token)$/i;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    [...url.searchParams.keys()].some((key) => sensitive.test(key))
  ) {
    throw new Error("broker URL must be credential-free HTTPS");
  }
  return url;
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("MCP request exceeds its size limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendRpcResult(
  response: ServerResponse,
  request: Record<string, unknown>,
  result: unknown,
): void {
  sendJson(response, 200, { jsonrpc: "2.0", id: request.id ?? null, result });
}

function sendRpcError(
  response: ServerResponse,
  request: unknown,
  code: number,
  message: string,
): void {
  const id = isObject(request) ? (request.id ?? null) : null;
  sendJson(response, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function sendToolError(
  response: ServerResponse,
  request: Record<string, unknown>,
  message: string,
): void {
  sendRpcResult(response, request, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

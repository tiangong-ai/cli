import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type {
  DataCredentialDeclaration,
  DataEndpointScope,
  DataExecutionLimits,
  DataHttpClient,
  DataHttpRequest,
  DataHttpResponse,
  DataSourceObservation,
  JsonValue,
} from "../contracts.js";
import { canonicalJson, sha256Bytes, sha256CanonicalJson } from "./canonical-json.js";
import { injectLogicalCredential, resolveDataCredentials } from "./credentials.js";
import { containsConfiguredSecret, DataRuntimeError } from "./errors.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_RESPONSE_HEADERS = new Set(["etag", "last-modified", "request-id", "x-request-id"]);
const SENSITIVE_QUERY_KEY =
  /^(access[_-]?token|api[_-]?key|apikey|auth|authorization|code|cookie|credential|key|password|secret|session|sig|signature|token)$/i;
const SENSITIVE_BODY_KEY =
  /(^|[_-])(authorization|auth|cookie|credential|password|private[_-]?key|secret|session|token|access[_-]?key|api[_-]?key)([_-]|$)/i;

export interface BoundedHttpClientOptions {
  capabilityId: string;
  endpoints: readonly DataEndpointScope[];
  credentials: readonly DataCredentialDeclaration[];
  environment: NodeJS.ProcessEnv;
  limits: DataExecutionLimits;
  fetchImpl?: typeof fetch | undefined;
}

export function createBoundedHttpClient(options: BoundedHttpClientOptions): DataHttpClient {
  const endpoints = new Map(options.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]));
  const declarations = new Map(
    options.credentials.map((credential) => [credential.credentialId, credential]),
  );
  const resolved = resolveDataCredentials(options.credentials, options.environment);
  const secrets = [...resolved.values.values()];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cookieJars = new Map<string, Map<string, string>>();

  return {
    configuredSecrets: () => [...secrets],
    request: async (request) => {
      const endpoint = endpoints.get(request.endpointId);
      if (!endpoint) {
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "The selected data endpoint is not declared by the capability manifest.",
          { details: { endpointId: request.endpointId } },
        );
      }
      if (!endpoint.allowedMethods.includes(request.method)) {
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "The HTTP method is not allowed by the selected data endpoint.",
          { details: { endpointId: endpoint.endpointId, method: request.method } },
        );
      }
      const safeTarget = buildTarget(endpoint, request);
      const timeoutMs = boundedOverride(request.timeoutMs, options.limits.timeoutMs, "timeoutMs");
      const maxResponseBytes = boundedOverride(
        request.maxResponseBytes,
        options.limits.maxResponseBytes,
        "maxResponseBytes",
      );
      const headers = new Headers({ Accept: endpoint.allowedContentTypes.join(", ") });
      let credential: DataCredentialDeclaration | undefined;
      let credentialedPath = request.path;
      if (request.credentialId) {
        credential = declarations.get(request.credentialId);
        if (!credential) {
          throw new DataRuntimeError(
            "credential-invalid",
            "The requested logical credential is not declared by the capability manifest.",
            { details: { credentialId: request.credentialId } },
          );
        }
        credentialedPath = injectLogicalCredential({
          declaration: credential,
          value: resolved.values.get(credential.credentialId),
          endpointId: endpoint.endpointId,
          headers,
          path: request.path,
        });
      }
      const target =
        credentialedPath === request.path
          ? safeTarget
          : buildTarget(endpoint, { ...request, path: credentialedPath });
      if (/%7b|%7d/i.test(target.pathname)) {
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "Data HTTP paths must not contain unresolved credential placeholders.",
        );
      }
      const body = encodeRequestBody(request, options.limits.maxRequestBytes);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const requestDigest = sha256CanonicalJson({
        capabilityId: options.capabilityId,
        endpointId: endpoint.endpointId,
        method: request.method,
        path: safeTarget.pathname,
        query: sortedQuery(safeTarget),
        bodyDigest: body === undefined ? null : sha256Bytes(Buffer.from(body, "utf8")),
      });
      const fetchResult = await performBoundedFetch({
        endpoint,
        initialTarget: target,
        method: request.method,
        body,
        headers,
        timeoutMs,
        limits: options.limits,
        fetchImpl,
        cookieJar:
          endpoint.sessionCookies === "same-origin-memory"
            ? sessionCookieJar(cookieJars, endpoint.endpointId)
            : null,
      });
      const { response, attempts } = fetchResult;
      const announcedLength = parseContentLength(response.headers.get("content-length"));
      if (announcedLength !== null && announcedLength > maxResponseBytes) {
        await response.body?.cancel();
        throw new DataRuntimeError(
          "response-too-large",
          "The provider response exceeds the declared byte limit.",
          {
            details: {
              ...httpAttemptDetails(fetchResult, "response"),
              maxResponseBytes,
            },
          },
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedResponse(response, maxResponseBytes);
      } catch (error) {
        throw withHttpAttemptDetails(error, fetchResult, "response");
      }
      if (containsConfiguredSecret(bytes, secrets)) {
        throw new DataRuntimeError(
          "provider-response-invalid",
          "The provider response reflected a configured credential and was blocked.",
        );
      }
      if (!response.ok) {
        throwHttpStatus(response, credential, options.limits.maxRetryDelayMs, bytes, fetchResult);
      }
      const contentType = normalizedContentType(response.headers.get("content-type"));
      if (!contentTypeAllowed(contentType, endpoint.allowedContentTypes)) {
        throw new DataRuntimeError(
          "provider-response-invalid",
          "The provider returned a content type outside the connector contract.",
          {
            details: {
              contentType,
              allowedContentTypes: endpoint.allowedContentTypes,
              ...httpAttemptDetails(fetchResult, "response"),
            },
          },
        );
      }
      const responseDigest = sha256Bytes(bytes);
      const observation: DataSourceObservation = {
        observationId: sha256CanonicalJson({
          requestDigest,
          responseDigest,
          status: response.status,
          attempts,
        }),
        sourceId: endpoint.endpointId,
        endpointId: endpoint.endpointId,
        requestDigest,
        responseDigest,
        responseBytes: bytes.byteLength,
        status: response.status,
        contentType,
        attempts,
      };
      return createHttpResponse(bytes, safeResponseHeaders(response.headers), observation);
    },
  };
}

function buildTarget(endpoint: DataEndpointScope, request: DataHttpRequest): URL {
  if (
    !request.path.startsWith("/") ||
    request.path.startsWith("//") ||
    request.path.includes("\\") ||
    request.path.includes("?") ||
    request.path.includes("#")
  ) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "Data HTTP paths must be absolute path-only values.",
    );
  }
  const target = new URL(request.path, endpoint.baseUrl);
  assertTargetAllowed(target, endpoint);
  for (const key of Object.keys(request.query ?? {}).sort(codePointOrder)) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new DataRuntimeError(
        "endpoint-policy-blocked",
        "Credential-like query parameters are not accepted by the data runtime.",
      );
    }
    const value = request.query?.[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) target.searchParams.append(key, String(item));
    }
  }
  target.searchParams.sort();
  return target;
}

function assertTargetAllowed(target: URL, endpoint: DataEndpointScope): void {
  const base = new URL(endpoint.baseUrl);
  if (
    target.protocol !== "https:" ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    isIP(target.hostname) !== 0 ||
    !endpoint.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))
  ) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "The data request is outside the connector endpoint scope.",
      { details: { endpointId: endpoint.endpointId } },
    );
  }
}

function encodeRequestBody(request: DataHttpRequest, maxRequestBytes: number): string | undefined {
  if (request.method === "GET") {
    if (request.body !== undefined) {
      throw new DataRuntimeError(
        "invalid-request",
        "GET data operations do not accept an HTTP request body.",
      );
    }
    return undefined;
  }
  if (request.body === undefined) return undefined;
  if (containsSensitiveField(request.body)) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "Credential-like fields are not accepted in data HTTP request bodies.",
    );
  }
  const encoded = canonicalJson(request.body);
  if (Buffer.byteLength(encoded, "utf8") > maxRequestBytes) {
    throw new DataRuntimeError(
      "invalid-request",
      "The data HTTP request body exceeds the connector byte limit.",
      { details: { maxRequestBytes } },
    );
  }
  return encoded;
}

async function performBoundedFetch(input: {
  endpoint: DataEndpointScope;
  initialTarget: URL;
  method: "GET" | "POST";
  body: string | undefined;
  headers: Headers;
  timeoutMs: number;
  limits: DataExecutionLimits;
  fetchImpl: typeof fetch;
  cookieJar: Map<string, string> | null;
}): Promise<{ response: Response; attempts: number; redirects: number; retries: number }> {
  let target = input.initialTarget;
  let redirects = 0;
  let retries = 0;
  let attempts = 0;
  while (true) {
    assertTargetAllowed(target, input.endpoint);
    attempts += 1;
    let response: Response;
    try {
      const requestHeaders = new Headers(input.headers);
      if (input.cookieJar && input.cookieJar.size > 0) {
        requestHeaders.set("Cookie", serializeCookieJar(input.cookieJar));
      }
      response = await input.fetchImpl(target.toString(), {
        method: input.method,
        headers: requestHeaders,
        ...(input.body === undefined ? {} : { body: input.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new DataRuntimeError("timeout", "The provider request exceeded its timeout.", {
          retryable: true,
          details: {
            attempts,
            phase: "request",
            redirects,
            retries,
            timeoutMs: input.timeoutMs,
          },
        });
      }
      throw new DataRuntimeError("network-failed", "The provider network request failed.", {
        retryable: true,
        details: { attempts, phase: "request", redirects, retries },
      });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (input.method !== "GET") {
        await response.body?.cancel();
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "Redirects are not authorized for POST data requests.",
          { details: { attempts, phase: "redirect", redirects, retries } },
        );
      }
      const location = response.headers.get("location");
      if (input.cookieJar) storeResponseCookies(input.cookieJar, response.headers);
      await response.body?.cancel();
      if (!location || redirects >= input.limits.maxRedirects) {
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "The provider redirect exceeded the connector policy.",
          { details: { attempts, phase: "redirect", redirects, retries } },
        );
      }
      const redirected = new URL(location, target);
      if (redirected.origin !== target.origin) {
        throw new DataRuntimeError(
          "endpoint-policy-blocked",
          "Cross-origin data redirects are blocked.",
          { details: { attempts, phase: "redirect", redirects, retries } },
        );
      }
      assertTargetAllowed(redirected, input.endpoint);
      target = redirected;
      redirects += 1;
      continue;
    }

    if (response.status === 429 && retries < input.limits.maxRetries) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const effectiveDelay = retryAfterMs ?? 0;
      if (effectiveDelay <= input.limits.maxRetryDelayMs) {
        await response.body?.cancel();
        retries += 1;
        if (effectiveDelay > 0) await delay(effectiveDelay);
        continue;
      }
    }
    if (input.cookieJar) storeResponseCookies(input.cookieJar, response.headers);
    return { response, attempts, redirects, retries };
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DataRuntimeError(
          "response-too-large",
          "The provider response exceeds the declared byte limit.",
          { details: { maxResponseBytes: maxBytes } },
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function throwHttpStatus(
  response: Response,
  credential: DataCredentialDeclaration | undefined,
  maxRetryDelayMs: number,
  bytes: Buffer,
  attempts: { attempts: number; redirects: number; retries: number },
): never {
  const providerReason = safeProviderErrorReason(bytes);
  if (response.status === 401 || response.status === 403) {
    throw new DataRuntimeError(
      credential ? "credential-invalid" : "provider-auth-blocked",
      credential
        ? "The provider rejected the configured logical credential."
        : "The provider requires authorization that is not available to this operation.",
      {
        userActionRequired: true,
        details: {
          status: response.status,
          ...httpAttemptDetails(attempts, "response"),
          ...(credential ? { credentialId: credential.credentialId } : {}),
          ...(providerReason ? { providerReason } : {}),
        },
      },
    );
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    throw new DataRuntimeError("rate-limited", "The provider rate limit blocked the operation.", {
      retryable: true,
      userActionRequired: (retryAfterMs ?? 0) > maxRetryDelayMs,
      details: {
        status: response.status,
        ...httpAttemptDetails(attempts, "response"),
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
        ...(providerReason ? { providerReason } : {}),
      },
    });
  }
  throw new DataRuntimeError(
    "provider-response-invalid",
    "The provider returned an unsuccessful HTTP response.",
    {
      retryable: response.status >= 500,
      details: {
        status: response.status,
        ...httpAttemptDetails(attempts, "response"),
        ...(providerReason ? { providerReason } : {}),
      },
    },
  );
}

function sessionCookieJar(
  jars: Map<string, Map<string, string>>,
  endpointId: string,
): Map<string, string> {
  const existing = jars.get(endpointId);
  if (existing) return existing;
  const created = new Map<string, string>();
  jars.set(endpointId, created);
  return created;
}

function storeResponseCookies(jar: Map<string, string>, headers: Headers): void {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const value of values) {
    const pair = value.split(";", 1)[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) continue;
    if (cookieValue.length > 2048 || /[\s;,\r\n]/.test(cookieValue)) continue;
    if (/max-age\s*=\s*0/i.test(value) || cookieValue === "") jar.delete(name);
    else jar.set(name, cookieValue);
  }
}

function serializeCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()]
    .sort(([left], [right]) => codePointOrder(left, right))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function httpAttemptDetails(
  value: { attempts: number; redirects: number; retries: number },
  phase: "request" | "redirect" | "response",
): Record<string, JsonValue> {
  return {
    attempts: value.attempts,
    phase,
    redirects: value.redirects,
    retries: value.retries,
  };
}

function withHttpAttemptDetails(
  error: unknown,
  value: { attempts: number; redirects: number; retries: number },
  phase: "request" | "redirect" | "response",
): unknown {
  if (!(error instanceof DataRuntimeError)) return error;
  return new DataRuntimeError(error.code, error.message, {
    ...error.options,
    details: {
      ...httpAttemptDetails(value, phase),
      ...(error.options.details ?? {}),
    },
  });
}

function safeProviderErrorReason(bytes: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
  const root = plainRecord(parsed);
  const error = plainRecord(root?.error);
  if (!error) return undefined;
  const candidates: unknown[] = [];
  if (Array.isArray(error.errors)) {
    for (const item of error.errors) candidates.push(plainRecord(item)?.reason);
  }
  candidates.push(error.reason, error.status);
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(candidate),
  );
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function createHttpResponse(
  bytes: Buffer,
  safeHeaders: Record<string, string>,
  observation: DataSourceObservation,
): DataHttpResponse {
  return {
    bytes,
    safeHeaders,
    observation,
    json: () => {
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new DataRuntimeError(
          "provider-response-invalid",
          "The provider response is not valid UTF-8 JSON.",
        );
      }
    },
    text: () => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new DataRuntimeError(
          "normalization-failed",
          "The provider response is not valid UTF-8 text.",
        );
      }
    },
  };
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const contentType = safeContentTypeMetadata(headers.get("content-type"));
  if (contentType) result["content-type"] = contentType;
  for (const name of [...SAFE_RESPONSE_HEADERS].sort(codePointOrder)) {
    const value = headers.get(name);
    if (value) result[name] = value.slice(0, 256);
  }
  return result;
}

function safeContentTypeMetadata(value: string | null): string | null {
  if (!value) return null;
  const mediaType = normalizedContentType(value);
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([A-Za-z0-9._-]{1,64})/i.exec(value)?.[1];
  return charset ? `${mediaType}; charset=${charset.toLowerCase()}` : mediaType;
}

function normalizedContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => candidate.toLowerCase() === contentType);
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function boundedOverride(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) return maximum;
  if (!Number.isInteger(requested) || requested < 1 || requested > maximum) {
    throw new DataRuntimeError(
      "invalid-request",
      `The requested ${name} must be a positive integer no greater than the connector limit.`,
      { details: { limit: maximum } },
    );
  }
  return requested;
}

function sortedQuery(url: URL): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of [...new Set(url.searchParams.keys())].sort(codePointOrder)) {
    result[key] = url.searchParams.getAll(key);
  }
  return result;
}

function containsSensitiveField(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => SENSITIVE_BODY_KEY.test(key) || containsSensitiveField(item),
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

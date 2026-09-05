import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBoundedHttpClient } from "../src/data/runtime/bounded-http.js";
import { DataRuntimeError, toDataMachineError } from "../src/data/runtime/errors.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

function httpClient(input: {
  fetchImpl: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  maxResponseBytes?: number;
  sameOriginSessionCookies?: boolean;
}) {
  const connector = syntheticConnector({ credential: true });
  if (input.sameOriginSessionCookies) {
    connector.endpoints[0] = {
      ...connector.endpoints[0]!,
      sessionCookies: "same-origin-memory",
    };
  }
  return createBoundedHttpClient({
    capabilityId: connector.capabilityId,
    endpoints: connector.endpoints,
    credentials: connector.credentials,
    environment: input.environment ?? { TIANGONG_DATA_TEST_TOKEN: "super-secret-token" },
    limits: {
      ...connector.limits,
      ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
    },
    fetchImpl: input.fetchImpl,
  });
}

describe("bounded data HTTP", () => {
  it("injects a logical credential only after endpoint validation", async () => {
    let authorization = "";
    const client = httpClient({
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), "https://example.test/v1/items?q=air");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response('{"items":[]}', {
          status: 200,
          headers: {
            "content-type": "application/json; charset=UTF-8; boundary=super-secret-token",
          },
        });
      }) as typeof fetch,
    });

    const response = await client.request({
      endpointId: "primary",
      method: "GET",
      path: "/v1/items",
      query: { q: "air" },
      credentialId: "api-token",
    });

    assert.equal(authorization, "Bearer super-secret-token");
    assert.deepEqual(response.json(), { items: [] });
    assert.equal(response.observation.attempts, 1);
    assert.equal(response.safeHeaders["content-type"], "application/json; charset=utf-8");
    assert.doesNotMatch(JSON.stringify(response.safeHeaders), /super-secret-token/);
  });

  it("injects a path-segment credential without exposing it to the request digest", async () => {
    const first = syntheticConnector({ credential: true });
    first.credentials[0]!.injection = {
      kind: "path-segment",
      placeholder: "{api-token}",
    };
    const requested: string[] = [];
    const run = async (secret: string) => {
      const client = createBoundedHttpClient({
        capabilityId: first.capabilityId,
        endpoints: first.endpoints,
        credentials: first.credentials,
        environment: { TIANGONG_DATA_TEST_TOKEN: secret },
        limits: first.limits,
        fetchImpl: (async (target) => {
          requested.push(String(target));
          return new Response('{"items":[]}', {
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      });
      return client.request({
        endpointId: "primary",
        method: "GET",
        path: "/v1/{api-token}/items",
        credentialId: "api-token",
      });
    };

    const left = await run("first-secret");
    const right = await run("second-secret");
    assert.deepEqual(requested, [
      "https://example.test/v1/first-secret/items",
      "https://example.test/v1/second-secret/items",
    ]);
    assert.equal(left.observation.requestDigest, right.observation.requestDigest);
    assert.doesNotMatch(JSON.stringify([left.observation, right.observation]), /first|second/);
  });

  it("rejects cross-origin redirects without forwarding credentials", async () => {
    const calls: string[] = [];
    const client = httpClient({
      fetchImpl: (async (input) => {
        calls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/v1/items" },
        });
      }) as typeof fetch,
    });

    await assert.rejects(
      () =>
        client.request({
          endpointId: "primary",
          method: "GET",
          path: "/v1/items",
          credentialId: "api-token",
        }),
      (error: unknown) =>
        error instanceof DataRuntimeError && error.code === "endpoint-policy-blocked",
    );
    assert.deepEqual(calls, ["https://example.test/v1/items"]);
  });

  it("keeps opt-in redirect cookies only in an ephemeral same-origin session", async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const client = httpClient({
      sameOriginSessionCookies: true,
      fetchImpl: (async (input, init) => {
        calls.push({
          url: String(input),
          cookie: new Headers(init?.headers).get("cookie"),
        });
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "/v1/session-ready",
              "set-cookie": "JSESSIONID=synthetic-session; Path=/; HttpOnly; Secure",
            },
          });
        }
        return Response.json({ items: [] });
      }) as typeof fetch,
    });

    const response = await client.request({
      endpointId: "primary",
      method: "GET",
      path: "/v1/items",
      credentialId: "api-token",
    });

    assert.equal(calls[0]?.cookie, null);
    assert.equal(calls[1]?.cookie, "JSESSIONID=synthetic-session");
    assert.equal(response.observation.attempts, 2);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-session/);
  });

  it("retries one bounded 429 and records the attempt count", async () => {
    let attempts = 0;
    const client = httpClient({
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('{"error":"slow"}', {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return new Response('{"items":[1]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const response = await client.request({
      endpointId: "primary",
      method: "GET",
      path: "/v1/items",
      credentialId: "api-token",
    });
    assert.equal(attempts, 2);
    assert.equal(response.observation.attempts, 2);
  });

  it("rejects announced and streamed oversized responses", async () => {
    const announced = httpClient({
      maxResponseBytes: 4,
      fetchImpl: (async () =>
        new Response("12345", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        })) as typeof fetch,
    });
    await assert.rejects(
      () => announced.request({ endpointId: "primary", method: "GET", path: "/v1/items" }),
      (error: unknown) => error instanceof DataRuntimeError && error.code === "response-too-large",
    );

    const streamed = httpClient({
      maxResponseBytes: 4,
      fetchImpl: (async () =>
        new Response("12345", { headers: { "content-type": "text/plain" } })) as typeof fetch,
    });
    await assert.rejects(
      () => streamed.request({ endpointId: "primary", method: "GET", path: "/v1/items" }),
      (error: unknown) => error instanceof DataRuntimeError && error.code === "response-too-large",
    );
  });

  it("classifies timeout and never leaks configured secrets", async () => {
    const secret = "super-secret-token";
    const timedOut = httpClient({
      fetchImpl: (async () => {
        throw new DOMException(`request with ${secret} timed out`, "TimeoutError");
      }) as typeof fetch,
    });
    let thrown: unknown;
    try {
      await timedOut.request({ endpointId: "primary", method: "GET", path: "/v1/items" });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof DataRuntimeError);
    const machine = toDataMachineError(thrown, [secret]);
    assert.equal(machine.code, "timeout");
    assert.deepEqual(machine.details, {
      attempts: 1,
      phase: "request",
      redirects: 0,
      retries: 0,
      timeoutMs: 1000,
    });
    assert.doesNotMatch(JSON.stringify(machine), new RegExp(secret));
  });

  it("retains only a bounded machine-readable provider error reason", async () => {
    const safe = httpClient({
      fetchImpl: (async () =>
        Response.json(
          { error: { errors: [{ reason: "commentsDisabled" }], message: "ignored prose" } },
          { status: 403 },
        )) as typeof fetch,
    });
    let safeError: unknown;
    try {
      await safe.request({
        endpointId: "primary",
        method: "GET",
        path: "/v1/items",
        credentialId: "api-token",
      });
    } catch (error) {
      safeError = error;
    }
    assert.ok(safeError instanceof DataRuntimeError);
    assert.equal(safeError.options.details?.providerReason, "commentsDisabled");

    const unsafe = httpClient({
      fetchImpl: (async () =>
        Response.json(
          { error: { errors: [{ reason: "comments disabled for jane@example.test" }] } },
          { status: 403 },
        )) as typeof fetch,
    });
    let unsafeError: unknown;
    try {
      await unsafe.request({
        endpointId: "primary",
        method: "GET",
        path: "/v1/items",
        credentialId: "api-token",
      });
    } catch (error) {
      unsafeError = error;
    }
    assert.ok(unsafeError instanceof DataRuntimeError);
    assert.equal(unsafeError.options.details?.providerReason, undefined);
  });

  it("blocks a provider response that reflects the injected credential", async () => {
    const client = httpClient({
      fetchImpl: (async () =>
        new Response('{"echo":"super-secret-token"}', {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    await assert.rejects(
      () =>
        client.request({
          endpointId: "primary",
          method: "GET",
          path: "/v1/items",
          credentialId: "api-token",
        }),
      (error: unknown) =>
        error instanceof DataRuntimeError && error.code === "provider-response-invalid",
    );
  });
});

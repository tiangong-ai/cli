import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";
import { Agent, getGlobalDispatcher } from "undici";
import { withBoundedTransport } from "../src/data/runtime/http-transport.js";
import { createDataRegistry } from "../src/data/catalog.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

it("reuses one dispatcher across operation pages and destroys it even on connector failure", async (context) => {
  const captured: Agent[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (_target: unknown, init: RequestInit & { dispatcher: Agent }) => {
      captured.push(init.dispatcher);
      assert.equal(init.dispatcher.destroyed, false);
      return Response.json({ items: [1] });
    },
  );
  for (const fail of [false, true]) {
    const base = syntheticConnector();
    const connector = syntheticConnector({
      execute: async (input) => {
        await input.http.request({ endpointId: "primary", method: "GET", path: "/v1/page1" });
        await input.http.request({ endpointId: "primary", method: "GET", path: "/v1/page2" });
        if (fail) throw new Error("synthetic connector failure");
        return base.operations[0]!.execute(input);
      },
    });
    const result = await executeDataRun(
      {
        schemaVersion: "tiangong.data.run-request.v1",
        capabilityId: "test.synthetic",
        capabilityVersion: "1.0.0",
        operationId: "echo",
        operationVersion: "1.0.0",
        input: { value: "hello" },
      },
      { registry: createDataRegistry([connector]), environment: {} },
    );
    assert.equal(result.status, fail ? "blocked" : "success");
    assert.equal(captured.at(-1), captured.at(-2));
    assert.equal(captured.at(-1)?.destroyed, true);
  }
  assert.notEqual(captured[0], captured[2]);
});

it("uses a Node-24-compatible dispatcher with real HTTP and consumes the body before cleanup", async () => {
  const server = createServer((_request, response) => response.end('{"items":[1]}'));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const globalDispatcher = getGlobalDispatcher();
  try {
    const result = await withBoundedTransport(15_000, undefined, async (fetchImpl) => {
      const response = await fetchImpl(`http://127.0.0.1:${address.port}/`, {
        signal: AbortSignal.timeout(15_000),
      });
      return response.json();
    });
    assert.deepEqual(result, { items: [1] });
    assert.equal(getGlobalDispatcher(), globalDispatcher);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

it("destroys its dispatcher on success and failure without replacing injected transports", async (context) => {
  const captured: Agent[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (_target: unknown, init: RequestInit & { dispatcher: Agent }) => {
      captured.push(init.dispatcher);
      assert.ok(init.dispatcher instanceof Agent);
      assert.equal(init.dispatcher.destroyed, false);
      return Response.json({ items: [1] });
    },
  );
  await withBoundedTransport(45_000, undefined, async (fetchImpl) => {
    await (await fetchImpl("https://example.test/")).json();
  });
  await assert.rejects(
    () =>
      withBoundedTransport(45_000, undefined, async (fetchImpl) => {
        await fetchImpl("https://example.test/");
        throw new Error("synthetic validation failure");
      }),
    /synthetic validation failure/,
  );
  assert.equal(captured.length, 2);
  assert.ok(captured.every((dispatcher) => dispatcher.destroyed));
  const override: typeof fetch = async () => Response.json({ overridden: true });
  await withBoundedTransport(1_000, override, async (fetchImpl) => {
    assert.equal(fetchImpl, override);
  });
  assert.equal(captured.length, 2);
});

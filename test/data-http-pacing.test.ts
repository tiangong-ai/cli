import assert from "node:assert/strict";
import { it } from "node:test";
import { createBoundedHttpClient } from "../src/data/runtime/bounded-http.js";
import { sharedRequestPacer } from "../src/data/runtime/http-timing.js";
import { DataRuntimeError } from "../src/data/runtime/errors.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

function fakeTiming() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
}

function setup(input: {
  statuses: number[];
  retryAfter?: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  interval?: number;
}) {
  const timing = fakeTiming();
  const connector = syntheticConnector();
  const starts: number[] = [];
  const createClient = () =>
    createBoundedHttpClient({
      capabilityId: connector.capabilityId,
      endpoints: connector.endpoints.map((endpoint) => ({
        ...endpoint,
        ...(input.interval === 0 ? {} : { minRequestIntervalMs: input.interval ?? 5_000 }),
      })),
      credentials: [],
      environment: {},
      timing,
      limits: {
        ...connector.limits,
        maxRetries: input.maxRetries ?? 2,
        maxRetryDelayMs: input.maxRetryDelayMs ?? 120_000,
      },
      fetchImpl: async () => {
        starts.push(timing.now());
        const status = input.statuses.shift() ?? 200;
        // The actual GDELT 429 has neither Retry-After nor Content-Type.
        return status === 429
          ? new Response("Please limit requests to one every 5 seconds", {
              status,
              headers: input.retryAfter === undefined ? {} : { "retry-after": input.retryAfter },
            })
          : Response.json({ items: [] });
      },
    });
  return { createClient, starts, timing };
}

const request = { endpointId: "primary", method: "GET" as const, path: "/v1/items" };

it("paces separate clients sharing one origin and retries missing-header 429 with exponential backoff", async () => {
  const scenario = setup({ statuses: [429, 429, 200, 200] });
  const response = await scenario.createClient().request(request);
  await scenario.createClient().request(request);
  assert.equal(response.observation.attempts, 3);
  assert.deepEqual(scenario.starts, [0, 5_000, 15_000, 20_000]);
});

it("honors Retry-After and the five-second minimum, including Retry-After zero", async () => {
  for (const [retryAfter, expected] of [
    ["0", 5_000],
    ["12", 12_000],
  ] as const) {
    const scenario = setup({ statuses: [429, 200], retryAfter });
    await scenario.createClient().request(request);
    assert.deepEqual(scenario.starts, [0, expected]);
  }
});

it("uses bounded fallback for unpaced providers and never retries beyond the caller delay ceiling", async () => {
  const unpaced = setup({ statuses: [429, 429, 200], interval: 0 });
  await unpaced.createClient().request(request);
  assert.deepEqual(unpaced.starts, [0, 1_000, 3_000]);
  const tooLong = setup({ statuses: [429], retryAfter: "121" });
  await assert.rejects(
    () => tooLong.createClient().request(request),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, "rate-limited");
      assert.equal(error.options.details?.attempts, 1);
      assert.equal(error.options.details?.retryAfterMs, 121_000);
      return true;
    },
  );
  assert.deepEqual(tooLong.starts, [0]);
  await assert.rejects(
    () => tooLong.createClient().request(request),
    (error: unknown) =>
      error instanceof DataRuntimeError &&
      error.code === "rate-limited" &&
      error.options.details?.phase === "throttle",
  );
  assert.deepEqual(tooLong.starts, [0]);
  const noWait = setup({ statuses: [429], maxRetryDelayMs: 0 });
  await assert.rejects(
    () => noWait.createClient().request(request),
    (error: unknown) => error instanceof DataRuntimeError && error.code === "rate-limited",
  );
  assert.deepEqual(noWait.starts, [0]);
});

it("reports exhausted 429 as blocked, not no-results, and preserves origin cooldown for the next run", async () => {
  const scenario = setup({ statuses: [429, 429, 429], maxRetries: 2 });
  await assert.rejects(
    () => scenario.createClient().request(request),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, "rate-limited");
      assert.equal(error.options.details?.status, 429);
      assert.equal(error.options.details?.attempts, 3);
      assert.equal(error.options.details?.recommendedRetryDelayMs, 20_000);
      return true;
    },
  );
  await scenario.createClient().request(request);
  assert.deepEqual(scenario.starts, [0, 5_000, 15_000, 35_000]);
});

it("serializes concurrent reservations without coupling other origins or a separate clock", async () => {
  const timing = fakeTiming();
  const pacer = sharedRequestPacer(timing);
  assert.equal(sharedRequestPacer(timing), pacer);
  assert.notEqual(sharedRequestPacer(fakeTiming()), pacer);
  await Promise.all([
    pacer.wait("https://one.test", 5_000, 120_000),
    pacer.wait("https://one.test", 5_000, 120_000),
    pacer.wait("https://one.test", 5_000, 120_000),
  ]);
  assert.deepEqual(timing.sleeps, [5_000, 5_000]);
  await pacer.wait("https://two.test", 5_000, 120_000);
  assert.deepEqual(timing.sleeps, [5_000, 5_000]);
});

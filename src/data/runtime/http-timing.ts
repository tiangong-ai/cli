import { setTimeout as delay } from "node:timers/promises";
import { DataRuntimeError } from "./errors.js";

export interface DataHttpTiming {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export const defaultHttpTiming: DataHttpTiming = {
  now: () => performance.now(),
  sleep: async (milliseconds) => {
    await delay(milliseconds);
  },
};

// Shared across clients/runs in this process, never persisted with credentials.
// Separate CLI processes sharing one egress must still be serialized by the caller.
const pacers = new WeakMap<DataHttpTiming, DataRequestPacer>();

export function sharedRequestPacer(timing: DataHttpTiming): DataRequestPacer {
  let pacer = pacers.get(timing);
  if (!pacer) {
    pacer = new DataRequestPacer(timing);
    pacers.set(timing, pacer);
  }
  return pacer;
}

class DataRequestPacer {
  private readonly origins = new Map<string, { nextStart: number; tail: Promise<void> }>();
  constructor(private readonly timing: DataHttpTiming) {}

  private state(origin: string) {
    let state = this.origins.get(origin);
    if (!state) {
      state = { nextStart: 0, tail: Promise.resolve() };
      this.origins.set(origin, state);
    }
    return state;
  }

  defer(origin: string, milliseconds: number): void {
    const state = this.state(origin);
    state.nextStart = Math.max(state.nextStart, this.timing.now() + milliseconds);
  }

  async wait(origin: string, intervalMs: number, maxWaitMs: number): Promise<void> {
    const state = this.state(origin);
    const entered = this.timing.now();
    const pending = state.tail.then(async () => {
      while (state.nextStart > this.timing.now()) {
        const remaining = state.nextStart - this.timing.now();
        if (state.nextStart - entered > maxWaitMs) {
          throw new DataRuntimeError(
            "rate-limited",
            "The provider cooldown exceeds the wait budget.",
            {
              retryable: true,
              userActionRequired: true,
              details: { phase: "throttle", retryAfterMs: Math.ceil(remaining) },
            },
          );
        }
        await this.timing.sleep(remaining);
      }
      state.nextStart = this.timing.now() + intervalMs;
    });
    state.tail = pending.catch(() => {});
    await pending;
  }
}

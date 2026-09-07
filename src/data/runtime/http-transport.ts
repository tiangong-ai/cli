import { Agent, type Dispatcher } from "undici";

// One dispatcher per bounded operation; reused by pages/retries/redirects and
// destroyed after its body is consumed or on any failure. No global dispatcher mutation.
export async function withBoundedTransport<T>(
  timeoutMs: number,
  override: typeof fetch | undefined,
  operation: (fetchImpl: typeof fetch) => Promise<T>,
): Promise<T> {
  if (override) return operation(override);
  const dispatcher = new Agent({
    connect: { timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    allowH2: false,
  });
  const fetchImpl: typeof fetch = (target, init) => {
    const boundedInit: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher };
    return globalThis.fetch(target, boundedInit);
  };
  try {
    return await operation(fetchImpl);
  } finally {
    await dispatcher.destroy();
  }
}

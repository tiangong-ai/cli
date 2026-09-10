import { realpath } from "node:fs/promises";
import { join } from "node:path";

// Serialize provider accounting and candidate registration from concurrent
// HTTP handlers inside one workspace lease. Never hold this queue over network
// calls; it does not replace the caller's cross-process workspace lease.
const ledgerWrites = new Map<string, Promise<unknown>>();

export async function serializeProviderStateWrite<T>(
  root: string,
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = join(await realpath(root), projectId);
  const previous = ledgerWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  ledgerWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (ledgerWrites.get(key) === current) ledgerWrites.delete(key);
  }
}

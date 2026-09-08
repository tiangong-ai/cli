import { spawnSync } from "node:child_process";

const CRASH_WORKER_TIMEOUT_MS = 60_000;

export function runResearchCrashWorker(options: {
  worker: string;
  root: string;
  point: string;
  cwd?: string;
  extraArgs?: string[];
}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", options.worker, options.root, options.point, ...(options.extraArgs ?? [])],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
      timeout: CRASH_WORKER_TIMEOUT_MS,
    },
  );

  if (result.error) {
    throw new Error(
      `Research crash worker did not reach checkpoint "${options.point}" within ${CRASH_WORKER_TIMEOUT_MS}ms: ${result.error.message}`,
    );
  }

  return result;
}

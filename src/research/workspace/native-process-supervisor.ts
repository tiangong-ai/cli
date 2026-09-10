/** Internal one-shot process guard. It has no project/state mutation authority
 * protocol and starts exactly one pre-authorized process. The solver inherits
 * neither this IPC channel nor the observer's environment. */
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

let child: ChildProcess | null = null;
let started = false,
  finished = false,
  timedOut = false;
let deadline: ReturnType<typeof setTimeout> | null = null;
const startup = setTimeout(() => process.exit(1), 5000);
function killGroup() {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
function finish(exitCode: number | null, signal: string | null) {
  if (finished) return;
  finished = true;
  clearTimeout(startup);
  if (deadline) clearTimeout(deadline);
  killGroup();
  const result = { kind: "result", exitCode, signal, timedOut };
  if (process.connected && process.send) process.send(result, () => process.exit(0));
  else process.exit(0);
}
function stop() {
  if (finished) return;
  killGroup();
  if (!child) finish(null, null);
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (value: unknown) => {
  if (finished) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (request.kind === "stop") {
    if (request.reason === "timeout") timedOut = true;
    stop();
    return;
  }
  if (
    started ||
    request.kind !== "start" ||
    typeof request.binary !== "string" ||
    !isAbsolute(request.binary) ||
    !Array.isArray(request.args) ||
    !request.args.every((a) => typeof a === "string") ||
    !request.env ||
    typeof request.env !== "object" ||
    Array.isArray(request.env) ||
    !Object.values(request.env).every((v) => typeof v === "string") ||
    typeof request.deadlineNs !== "string" ||
    !/^\d{1,24}$/.test(request.deadlineNs)
  ) {
    finish(null, null);
    return;
  }
  started = true;
  clearTimeout(startup);
  const remainingMs = Number((BigInt(request.deadlineNs) - process.hrtime.bigint()) / 1_000_000n);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 172800000) {
    timedOut = true;
    finish(null, null);
    return;
  }
  child = spawn(request.binary, request.args as string[], {
    cwd: process.cwd(),
    env: request.env as NodeJS.ProcessEnv,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
  deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, remainingMs);
  child.once("error", () => finish(null, null));
  child.once("exit", (code, signal) => finish(code, signal));
});

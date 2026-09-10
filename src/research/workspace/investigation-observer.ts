import { execFile } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { CliError } from "../../errors.js";
import { sha256Text, workspacePaths, writeJsonAtomic } from "./storage.js";

const exec = promisify(execFile),
  HASH = /^[a-f0-9]{64}$/;
type Phase = "runtime-probe" | "calculation";
interface Route {
  schemaVersion: 1;
  projectId: string;
  key: string;
  pid: number;
  title: string;
  phase: Phase;
  stagingDirectory: string;
  updatedAt: string;
}
function titleFor(key: string, phase: Phase) {
  return `tgr-${sha256Text(`${key}/${phase}`).slice(0, 32)}`;
}
async function location(root: string, projectId: string, key: string, create: boolean) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId) || !HASH.test(key))
    throw new CliError("Observer routing identity is invalid.", {
      code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
      exitCode: 3,
    });
  let path = workspacePaths(root).control;
  for (const part of ["projects", projectId, "native", "calculation-observers"]) {
    path = join(path, part);
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(path).catch(() => null);
    if (!info) {
      if (!create) return null;
      throw new Error("Missing observer route directory");
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CliError("Observer routing must use regular private directories.", {
        code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
        exitCode: 3,
      });
  }
  return join(path, `${key}.json`);
}
/** Local operational coordinates, deliberately excluded from portable records. */
export function investigationObserverRoute(
  root: string,
  projectId: string,
  key: string,
  phase: Phase,
  stagingDirectory: string,
) {
  const title = titleFor(key, phase);
  return {
    title,
    onSpawn: async (pid: number) => {
      const path = await location(root, projectId, key, true);
      const prior = await lstat(path!).catch(() => null);
      if (prior && (!prior.isFile() || prior.isSymbolicLink()))
        throw new CliError("Observer route cannot replace a linked entry.", {
          code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
          exitCode: 3,
        });
      const route: Route = {
        schemaVersion: 1,
        projectId,
        key,
        pid,
        title,
        phase,
        stagingDirectory,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(path!, route, 0o600);
    },
  };
}
export async function inspectInvestigationObserver(root: string, projectId: string, key: string) {
  const localRoute = `projects/${projectId}/native/calculation-observers/${key}.json`;
  const path = await location(root, projectId, key, false);
  if (!path) return { state: "unavailable", localRoute, automaticRetry: false };
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16384)
    return { state: "unavailable", localRoute, automaticRetry: false };
  let route: Route;
  try {
    route = JSON.parse(await readFile(path, "utf8")) as Route;
  } catch {
    return { state: "unavailable", localRoute, automaticRetry: false };
  }
  if (
    route.schemaVersion !== 1 ||
    route.projectId !== projectId ||
    route.key !== key ||
    !["runtime-probe", "calculation"].includes(route.phase) ||
    route.title !== titleFor(key, route.phase) ||
    !Number.isSafeInteger(route.pid) ||
    route.pid < 2 ||
    typeof route.stagingDirectory !== "string"
  )
    return { state: "unavailable", localRoute, automaticRetry: false };
  let state = "unavailable";
  try {
    if (process.platform === "linux") {
      const command = await readFile(`/proc/${route.pid}/cmdline`);
      state =
        command.toString("utf8").split("\0")[0] === route.title ? "observing" : "not-matching";
    } else if (process.platform === "darwin") {
      const result = await exec("/bin/ps", ["-p", String(route.pid), "-o", "command="], {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        timeout: 1000,
        maxBuffer: 8192,
      });
      state = result.stdout.trim() === route.title ? "observing" : "not-matching";
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    state =
      code === "ENOENT" || (process.platform === "darwin" && code === 1)
        ? "not-found"
        : "unavailable";
  }
  return {
    state,
    supervisorPid: route.pid,
    phase: route.phase,
    stagingDirectoryName: basename(route.stagingDirectory),
    localRoute,
    automaticRetry: false,
  };
}

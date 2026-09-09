import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";

import { CliError } from "../../errors.js";
import type { SetupCommandResult, SetupCommandRunner } from "./setup.js";

export type ResearchCliReleaseStatus = "newer" | "same" | "older" | "unavailable";

export type ResearchCliReleaseMetadata = {
  version: string;
  integrity: string;
  tarball: string;
  gitHead: string;
};

export type ResearchCliReleaseInspection = {
  status: ResearchCliReleaseStatus;
  packageName: string;
  requestedVersion: string;
  installedVersion: string;
  registry: string;
  metadata: ResearchCliReleaseMetadata | null;
  reason: string | null;
};

const REGISTRY_URL = "https://registry.npmjs.org";
// npm-registry-fetch prefers the scoped registry over opts.registry, so a
// HOME/.npmrc could silently retarget @tiangong-ai; both pins ride along as
// constant argv on every query.
const SCOPED_REGISTRY_PIN = "--@tiangong-ai:registry=https://registry.npmjs.org";
const STRICT_SSL_PIN = "--strict-ssl=true";
const RESEARCH_CLI_PACKAGE_NAME = "@tiangong-ai/cli";
const RELEASE_QUERY_TIMEOUT_MS = 30_000;
const RELEASE_KILL_GRACE_MS = 5_000;
const EXIT_STREAM_GRACE_MS = 1_000;
const MAX_RELEASE_QUERY_OUTPUT_BYTES = 1024 * 1024;
const EXACT_STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GIT_HEAD_PATTERN = /^[0-9a-f]{40}$/;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const CANDIDATE_INVALID_CODE = "RESEARCH_SETUP_CANDIDATE_INVALID";
const QUERY_FAILED_REASON = "RESEARCH_SETUP_RELEASE_QUERY_FAILED";
const METADATA_INVALID_REASON = "RESEARCH_SETUP_RELEASE_METADATA_INVALID";
const INSTALLED_INCOMPARABLE_REASON = "RESEARCH_SETUP_RELEASE_INSTALLED_INCOMPARABLE";

// Only variables the pinned npm view query actually needs are forwarded;
// ambient npm_config_* and unrelated ambient variables never reach the child.
const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_cafile",
] as const;

function buildChildEnvironment(environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const child: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      child[key] = value;
    }
  }
  return child;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStableSemver(value: string): [number, number, number] | null {
  const match = EXACT_STABLE_SEMVER_PATTERN.exec(value);
  if (!match) return null;
  const parsed: [number, number, number] = [0, 0, 0];
  for (let index = 1; index <= 3; index += 1) {
    const part = match[index]!;
    // Longer parts would round during Number conversion and silently corrupt
    // the newer/same/older comparison.
    if (part.length > 10) return null;
    const numeric = Number(part);
    if (!Number.isSafeInteger(numeric)) return null;
    parsed[index - 1] = numeric;
  }
  return parsed;
}

function compareStableSemver(
  candidate: [number, number, number],
  installed: [number, number, number],
): Exclude<ResearchCliReleaseStatus, "unavailable"> {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index]! > installed[index]!) return "newer";
    if (candidate[index]! < installed[index]!) return "older";
  }
  return "same";
}

function isVerifiedSha512Integrity(integrity: string): boolean {
  if (!SHA512_INTEGRITY_PATTERN.test(integrity)) return false;
  return Buffer.from(integrity.slice("sha512-".length), "base64").length === 64;
}

function isPinnedRegistryTarball(tarball: unknown, version: string): tarball is string {
  if (typeof tarball !== "string") return false;
  let url: URL;
  try {
    url = new URL(tarball);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.host !== "registry.npmjs.org") return false;
  // Query/fragment components could smuggle signed URLs or tokens past the
  // identity check, so only the bare pinned path is accepted.
  if (url.search !== "" || url.hash !== "") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  return pathname === `/${RESEARCH_CLI_PACKAGE_NAME}/-/cli-${version}.tgz`;
}

function verifiedReleaseMetadata(
  stdout: string,
  requestedVersion: string,
): ResearchCliReleaseMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  // `npm view ... --json` emits the dist fields as flat dot-path keys; the
  // nested-dist spelling never appears on the real interface.
  const gitHead = value.gitHead;
  const integrity = value["dist.integrity"];
  const name = value.name;
  const tarball = value["dist.tarball"];
  const version = value.version;
  if (name !== RESEARCH_CLI_PACKAGE_NAME) return null;
  if (typeof version !== "string" || version !== requestedVersion) return null;
  if (typeof gitHead !== "string" || !GIT_HEAD_PATTERN.test(gitHead)) return null;
  if (typeof integrity !== "string" || !isVerifiedSha512Integrity(integrity)) return null;
  if (!isPinnedRegistryTarball(tarball, requestedVersion)) return null;
  return { version, integrity, tarball, gitHead };
}

const defaultSetupReleaseRunner: SetupCommandRunner = (input) =>
  new Promise<SetupCommandResult>((resolvePromise) => {
    // Windows npm is npm.cmd, which shell:false spawn cannot execute; the
    // fixed cmd.exe branch forwards only constant argv plus the
    // regex-validated exact version and accepts no additional parameters.
    const windowsShell = process.platform === "win32";
    const file = windowsShell ? "cmd.exe" : input.command;
    const args = windowsShell ? ["/d", "/s", "/c", input.command, ...input.args] : input.args;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let streamAbandoned = false;
    const activeTimers = new Set<NodeJS.Timeout>();
    // On POSIX the child leads its own process group, so a descendant that
    // inherited the stdio pipes can be reached without ever signalling a pid
    // we do not own.
    const child = spawn(file, args, {
      cwd: input.cwd,
      env: input.environment,
      detached: !windowsShell,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const later = (callback: () => void, delayMs: number): void => {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        callback();
      }, delayMs);
      activeTimers.add(timer);
      timer.unref();
    };
    // Both streams share one byte budget; chunks are concatenated once at
    // settle instead of per-chunk, avoiding quadratic copies.
    const capture = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (truncated) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_RELEASE_QUERY_OUTPUT_BYTES - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const take = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
      if (take.length > 0) {
        chunks.push(take);
        capturedBytes += take.length;
      }
      if (take.length < bytes.length) truncated = true;
    };
    const killOwnedGroup = (signal: NodeJS.Signals): void => {
      if (windowsShell || typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The process group is already gone.
      }
    };
    // Windows has no process groups; the fixed taskkill targets only our own
    // child pid's tree. One taskkill per query at most; the reference is kept
    // so finish can guarantee the helper never outlives the bounded query.
    let treeKill: ChildProcess | undefined;
    const killOwnedTreeOnWindows = (): void => {
      if (!windowsShell || typeof child.pid !== "number" || treeKill) return;
      treeKill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        cwd: input.cwd,
        env: input.environment,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      const fallbackKillChild = (): void => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The child already exited.
        }
      };
      treeKill.on("error", fallbackKillChild);
      treeKill.on("close", fallbackKillChild);
    };
    // One finite force/settle watchdog: whatever happens to the child events,
    // the query settles at most one grace period after termination began.
    const forceSettle = (): void => {
      if (settled) return;
      killOwnedGroup("SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
      streamAbandoned = true;
      finish(124);
    };
    const terminateChild = (): void => {
      if (terminating || settled) return;
      terminating = true;
      if (windowsShell) {
        // Start the tree kill while the root pid still exists: on real
        // Windows a preceding root kill terminates cmd.exe immediately and
        // taskkill /T would lose the still-running npm descendants. The root
        // kill only happens as the bounded fallback in the watchdog and the
        // taskkill completion/error handlers.
        killOwnedTreeOnWindows();
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          // The child already exited.
        }
        killOwnedGroup("SIGTERM");
        later(() => {
          killOwnedGroup("SIGKILL");
          if (!settled) {
            try {
              child.kill("SIGKILL");
            } catch {
              // The child already exited.
            }
          }
        }, RELEASE_KILL_GRACE_MS);
      }
      later(forceSettle, RELEASE_KILL_GRACE_MS + EXIT_STREAM_GRACE_MS);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      capture(stdoutChunks, chunk);
      if (truncated) terminateChild();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      capture(stderrChunks, chunk);
      if (truncated) terminateChild();
    });
    later(() => {
      timedOut = true;
      terminateChild();
    }, input.timeoutMs);
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      for (const timer of activeTimers) clearTimeout(timer);
      activeTimers.clear();
      if (windowsShell) {
        // Only a terminating/abandoned query can still own live tree members;
        // a clean close means every pipe-holding process is already gone.
        if (terminating || streamAbandoned) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child already exited.
          }
        }
        // The helper was spawned by this query and must never outlive it.
        if (
          treeKill &&
          typeof treeKill.pid === "number" &&
          treeKill.pid > 0 &&
          treeKill.exitCode === null &&
          !treeKill.killed
        ) {
          try {
            treeKill.kill("SIGKILL");
          } catch {
            // The helper already exited.
          }
        }
      } else {
        // Harmless ESRCH on a clean close; on an abandoned stream this is
        // what reaps a descendant that inherited the pipes.
        killOwnedGroup("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({
        exitCode: timedOut || truncated || streamAbandoned ? 124 : exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };
    child.on("error", (error) => {
      capture(stderrChunks, error.message);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    // Node emits "close" only once every stdio stream has ended. A descendant
    // that inherited the pipes can hold them open long after the root exited,
    // so the root's exit starts one bounded grace; if close has not arrived by
    // then the buffered output is abandoned as untrusted and the query settles.
    child.on("exit", () => {
      later(() => {
        if (settled) return;
        streamAbandoned = true;
        finish(124);
      }, EXIT_STREAM_GRACE_MS);
    });
  });

export async function inspectExactResearchCliRelease(
  candidateVersion: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    runner?: SetupCommandRunner;
    installedVersion: string;
  },
): Promise<ResearchCliReleaseInspection> {
  const candidate = parseStableSemver(candidateVersion);
  if (!candidate) {
    throw new CliError(
      "The requested exact CLI candidate version is not a supported bounded stable semver release identifier.",
      { code: CANDIDATE_INVALID_CODE, exitCode: 2 },
    );
  }
  const base = {
    packageName: RESEARCH_CLI_PACKAGE_NAME,
    requestedVersion: candidateVersion,
    installedVersion: options.installedVersion,
    registry: REGISTRY_URL,
  };
  const installed = parseStableSemver(options.installedVersion);
  if (!installed) {
    return {
      ...base,
      status: "unavailable",
      metadata: null,
      reason: INSTALLED_INCOMPARABLE_REASON,
    };
  }
  const runner = options.runner ?? defaultSetupReleaseRunner;
  let queryResult: SetupCommandResult;
  try {
    queryResult = await runner({
      command: "npm",
      args: [
        "view",
        `${RESEARCH_CLI_PACKAGE_NAME}@${candidateVersion}`,
        "name",
        "version",
        "dist.integrity",
        "dist.tarball",
        "gitHead",
        "--json",
        "--registry",
        REGISTRY_URL,
        SCOPED_REGISTRY_PIN,
        STRICT_SSL_PIN,
      ],
      cwd: tmpdir(),
      environment: buildChildEnvironment(options.environment),
      timeoutMs: RELEASE_QUERY_TIMEOUT_MS,
    });
  } catch {
    return { ...base, status: "unavailable", metadata: null, reason: QUERY_FAILED_REASON };
  }
  if (queryResult.exitCode !== 0) {
    return { ...base, status: "unavailable", metadata: null, reason: QUERY_FAILED_REASON };
  }
  // Runner-provided output is subject to the same combined budget as process
  // output; oversized results are untrusted and never parsed or echoed.
  if (
    Buffer.byteLength(queryResult.stdout, "utf8") + Buffer.byteLength(queryResult.stderr, "utf8") >
    MAX_RELEASE_QUERY_OUTPUT_BYTES
  ) {
    return { ...base, status: "unavailable", metadata: null, reason: QUERY_FAILED_REASON };
  }
  const metadata = verifiedReleaseMetadata(queryResult.stdout, candidateVersion);
  if (!metadata) {
    return { ...base, status: "unavailable", metadata: null, reason: METADATA_INVALID_REASON };
  }
  return {
    ...base,
    status: compareStableSemver(candidate, installed),
    metadata,
    reason: null,
  };
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { inspectExactResearchCliRelease } from "../src/research/workspace/setup-release.js";
import type { SetupCommandRunner } from "../src/research/workspace/setup.js";

const REGISTRY = "https://registry.npmjs.org";
const PACKAGE_NAME = "@tiangong-ai/cli";
const VALID_GIT_HEAD = "a".repeat(40);
const VALID_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

// The query must go to the pinned registry only, so ambient npm_config_*
// overrides and unrelated ambient variables are never forwarded. Proxy/CA
// variables are the explicitly allowed exceptions.
const ENV_ALLOWLIST = new Set([
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
  "DO_NOT_TRACK",
]);

const SECRET_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/operator",
  TMPDIR: "/tmp",
  HTTPS_PROXY: "http://proxy.internal:3128",
  NO_PROXY: "localhost,.internal",
  SSL_CERT_FILE: "/etc/internal-ca.pem",
  NODE_EXTRA_CA_CERTS: "/etc/internal-ca.pem",
  NODE_OPTIONS: "--require SECRET-NODE-OPTIONS-MARKER",
  TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON: '{"key":"SECRET-CRED-VALUE"}',
  AWS_SECRET_ACCESS_KEY: "SECRET-AWS-VALUE",
  ANTHROPIC_API_KEY: "SECRET-ANTHROPIC-VALUE",
  npm_config_registry: "https://evil.example/root",
  npm_config_userconfig: "/tmp/evil/.npmrc",
};

type RecordedQuery = {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
};

type FixtureResponse = { exitCode: number; stdout: string; stderr: string } | Error;

function fixtureRunner(response: FixtureResponse) {
  const queries: RecordedQuery[] = [];
  const runner: SetupCommandRunner = async (input) => {
    queries.push({ ...input });
    if (response instanceof Error) throw response;
    return { ...response };
  };
  return { queries, runner };
}

function firstQuery(queries: RecordedQuery[]): RecordedQuery {
  const query = queries[0];
  assert.ok(query, "expected exactly one recorded query");
  return query;
}

function payload(overrides: Record<string, unknown> = {}, version = "0.0.61") {
  // Real `npm view ... --json` emits dot-path keys for the dist fields; the
  // fixture must mirror that shape or the module would never verify metadata.
  return JSON.stringify({
    _note: "SECRET-STDOUT-MARKER",
    name: PACKAGE_NAME,
    version,
    "dist.integrity": VALID_INTEGRITY,
    "dist.tarball": `${REGISTRY}/${PACKAGE_NAME}/-/cli-${version}.tgz`,
    gitHead: VALID_GIT_HEAD,
    ...overrides,
  });
}

function assertNoLeak(value: unknown) {
  const text = JSON.stringify(value) ?? "";
  for (const marker of [
    "SECRET-STDOUT-MARKER",
    "SECRET-STDERR-MARKER",
    "SECRET-CRED-VALUE",
    "SECRET-AWS-VALUE",
    "SECRET-ANTHROPIC-VALUE",
    "SECRET-QUERY-TOKEN",
    "SECRET-FRAGMENT-MARKER",
    "SECRET-BIG-OUTPUT-MARKER",
    "SECRET-NODE-OPTIONS-MARKER",
    "evil.example",
  ]) {
    assert.ok(!text.includes(marker), `result leaked ${marker}`);
  }
}

function assertUnreachableStatus(result: {
  status: string;
  metadata: unknown;
  reason: string | null;
}) {
  assert.equal(result.status, "unavailable");
  assert.equal(result.metadata, null);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  assertNoLeak(result);
}

describe("inspectExactResearchCliRelease", () => {
  it("reports a newer exact release with verified metadata after one pinned bounded query", async () => {
    const { queries, runner } = fixtureRunner({ exitCode: 0, stdout: payload(), stderr: "" });
    const result = await inspectExactResearchCliRelease("0.0.61", {
      environment: SECRET_ENV,
      runner,
      installedVersion: "0.0.60",
    });
    assert.equal(queries.length, 1);
    const query = firstQuery(queries);
    assert.equal(query.command, "npm");
    assert.deepEqual(query.args, [
      "view",
      "@tiangong-ai/cli@0.0.61",
      "name",
      "version",
      "dist.integrity",
      "dist.tarball",
      "gitHead",
      "--json",
      "--registry",
      REGISTRY,
      // npm-registry-fetch prefers the scoped registry over opts.registry, so
      // the scope pin must ride along as a constant argv or a HOME/.npmrc
      // could silently retarget @tiangong-ai.
      "--@tiangong-ai:registry=https://registry.npmjs.org",
      "--strict-ssl=true",
    ]);
    assert.ok(query.timeoutMs > 0 && query.timeoutMs <= 30_000);
    assert.ok(isAbsolute(query.cwd));
    assert.deepEqual(Object.keys(result).sort(), [
      "installedVersion",
      "metadata",
      "packageName",
      "reason",
      "registry",
      "requestedVersion",
      "status",
    ]);
    assert.equal(result.status, "newer");
    assert.equal(result.packageName, PACKAGE_NAME);
    assert.equal(result.requestedVersion, "0.0.61");
    assert.equal(result.installedVersion, "0.0.60");
    assert.equal(result.registry, REGISTRY);
    assert.equal(result.reason, null);
    assert.deepEqual(result.metadata, {
      version: "0.0.61",
      integrity: VALID_INTEGRITY,
      tarball: `${REGISTRY}/${PACKAGE_NAME}/-/cli-0.0.61.tgz`,
      gitHead: VALID_GIT_HEAD,
    });
    assertNoLeak(result);
  });

  it("compares bounded stable semver numerically", async () => {
    const comparisons: Array<{
      installed: string;
      candidate: string;
      status: "newer" | "same" | "older";
    }> = [
      { installed: "0.0.60", candidate: "0.0.61", status: "newer" },
      { installed: "0.0.61", candidate: "0.0.61", status: "same" },
      { installed: "0.0.62", candidate: "0.0.61", status: "older" },
      { installed: "0.0.9", candidate: "0.0.61", status: "newer" },
      { installed: "0.9.0", candidate: "0.10.0", status: "newer" },
      { installed: "1.0.0", candidate: "0.99.99", status: "older" },
      { installed: "999999999.0.0", candidate: "1000000000.0.0", status: "newer" },
    ];
    for (const { installed, candidate, status } of comparisons) {
      const { queries, runner } = fixtureRunner({
        exitCode: 0,
        stdout: payload({}, candidate),
        stderr: "",
      });
      const result = await inspectExactResearchCliRelease(candidate, {
        runner,
        installedVersion: installed,
      });
      assert.equal(result.status, status, `${candidate} vs ${installed}`);
      assert.equal(result.reason, null);
      assert.equal(queries.length, 1);
      assertNoLeak(result);
    }
  });

  it("refuses same when registry metadata does not verify", async () => {
    const { queries, runner } = fixtureRunner({
      exitCode: 0,
      stdout: payload({ version: "0.0.60" }),
      stderr: "",
    });
    const result = await inspectExactResearchCliRelease("0.0.61", {
      runner,
      installedVersion: "0.0.61",
    });
    assert.notEqual(result.status, "same");
    assertUnreachableStatus(result);
    assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_METADATA_INVALID");
    assert.equal(queries.length, 1);
  });

  it("rejects malformed candidates before issuing any query", async () => {
    const malformedCandidates = [
      "latest",
      "",
      "^0.0.61",
      "~0.0.60",
      ">=0.0.60",
      "0.0.61-beta.1",
      "0.0.61-local",
      "v0.0.61",
      "0.0.061",
      "0.0.61.1",
      "0.0",
      "0.0.61 ",
      " 0.0.61",
      "file:../escape",
      "github:tiangong-ai/cli#main",
      "0.0.61; rm -rf /workspace",
      "0.0.61 --unsafe-perm",
      "0.0.61\n",
      // Version parts beyond Number.isSafeInteger would silently round during
      // comparison, so they are rejected before any query.
      "12345678901.0.0",
      "9007199254740993.0.0",
    ];
    for (const candidate of malformedCandidates) {
      const { queries, runner } = fixtureRunner({ exitCode: 0, stdout: payload(), stderr: "" });
      await assert.rejects(
        inspectExactResearchCliRelease(candidate, { runner, installedVersion: "0.0.60" }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_SETUP_CANDIDATE_INVALID");
          assert.equal(error.exitCode, 2);
          assert.ok(!error.message.includes("rm -rf"));
          assert.ok(!error.message.includes("github:"));
          return true;
        },
      );
      assert.equal(queries.length, 0, `candidate ${JSON.stringify(candidate)} must not query`);
    }
  });

  it("reports unavailable when installedVersion is not comparable stable semver", async () => {
    const incomparable = [
      "0.0.61-local.4",
      "not-a-version",
      "",
      "0.0.61.0",
      "0.0",
      "v0.0.61",
      "0.0.61-beta.1",
      "9007199254740992.0.0",
    ];
    for (const installedVersion of incomparable) {
      const { queries, runner } = fixtureRunner({ exitCode: 0, stdout: payload(), stderr: "" });
      const result = await inspectExactResearchCliRelease("0.0.61", { runner, installedVersion });
      assert.equal(result.status, "unavailable", installedVersion);
      assert.notEqual(result.status, "newer");
      assert.equal(result.metadata, null);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_INSTALLED_INCOMPARABLE");
      assert.equal(queries.length, 0, `installed ${installedVersion} must not query`);
      assertNoLeak(result);
    }
  });

  it("maps transport failures to unavailable without echoing transport output", async () => {
    const failures: FixtureResponse[] = [
      { exitCode: 1, stdout: "", stderr: "SECRET-STDERR-MARKER npm ERR! network timeout" },
      new Error("spawn npm ENETUNREACH SECRET-STDERR-MARKER"),
    ];
    for (const failure of failures) {
      const { queries, runner } = fixtureRunner(failure);
      const result = await inspectExactResearchCliRelease("0.0.61", {
        runner,
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
      assert.equal(queries.length, 1);
    }
  });

  it("maps unparseable registry payloads to unavailable metadata", async () => {
    const bodies = ["<html>502 Bad Gateway</html>", "", "   "];
    for (const stdout of bodies) {
      const { queries, runner } = fixtureRunner({ exitCode: 0, stdout, stderr: "" });
      const result = await inspectExactResearchCliRelease("0.0.61", {
        runner,
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_METADATA_INVALID");
      assert.equal(queries.length, 1);
    }
  });

  it("rejects payloads that do not match the requested package identity", async () => {
    const validTarball = `${REGISTRY}/${PACKAGE_NAME}/-/cli-0.0.61.tgz`;
    const invalidPayloads: Array<[string, string]> = [
      ["wrong package name", payload({ name: "@evil/cli" })],
      ["wrong package version", payload({ version: "0.0.60" })],
      [
        "sha1 integrity",
        payload({
          "dist.integrity": `sha1-${Buffer.alloc(20, 7).toString("base64")}`,
          "dist.tarball": validTarball,
        }),
      ],
      [
        "truncated sha512 integrity",
        payload({
          "dist.integrity": `sha512-${Buffer.alloc(63, 7).toString("base64")}`,
          "dist.tarball": validTarball,
        }),
      ],
      [
        "non-base64 integrity",
        payload({ "dist.integrity": "sha512-%%%not-base64%%%", "dist.tarball": validTarball }),
      ],
      ["missing integrity", payload({ "dist.integrity": undefined })],
      ["missing gitHead", payload({ gitHead: "" })],
      ["short gitHead", payload({ gitHead: "a".repeat(39) })],
      ["long gitHead", payload({ gitHead: "a".repeat(41) })],
      ["uppercase gitHead", payload({ gitHead: "A".repeat(40) })],
    ];
    for (const [label, stdout] of invalidPayloads) {
      const { queries, runner } = fixtureRunner({ exitCode: 0, stdout, stderr: "" });
      const result = await inspectExactResearchCliRelease("0.0.61", {
        runner,
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_METADATA_INVALID", label);
      assert.equal(queries.length, 1);
    }
  });

  it("rejects tarball locations outside the pinned registry identity", async () => {
    const tarballs = [
      "http://registry.npmjs.org/@tiangong-ai/cli/-/cli-0.0.61.tgz",
      "https://evil.example/@tiangong-ai/cli/-/cli-0.0.61.tgz",
      "https://registry.npmjs.org.evil.com/@tiangong-ai/cli/-/cli-0.0.61.tgz",
      "https://user:pass@registry.npmjs.org/@tiangong-ai/cli/-/cli-0.0.61.tgz",
      "https://registry.npmjs.org/@tiangong-ai/cli/-/cli-0.0.60.tgz",
      "https://registry.npmjs.org/other-package/-/other-0.0.61.tgz",
      "file:///tmp/cli-0.0.61.tgz",
      "https://registry.npmjs.org/@tiangong-ai/cli/-/cli-0.0.61.tgz?token=SECRET-QUERY-TOKEN",
      "https://registry.npmjs.org/@tiangong-ai/cli/-/cli-0.0.61.tgz#SECRET-FRAGMENT-MARKER",
    ];
    for (const tarball of tarballs) {
      const { queries, runner } = fixtureRunner({
        exitCode: 0,
        stdout: payload({ "dist.tarball": tarball }),
        stderr: "",
      });
      const result = await inspectExactResearchCliRelease("0.0.61", {
        runner,
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_METADATA_INVALID");
      assert.ok(!JSON.stringify(result)?.includes("user:pass"));
      assert.equal(queries.length, 1);
    }
  });

  it("passes only an allowlisted environment to the runner and never echoes ambient secrets", async () => {
    const { queries, runner } = fixtureRunner({ exitCode: 0, stdout: payload(), stderr: "" });
    const result = await inspectExactResearchCliRelease("0.0.61", {
      environment: SECRET_ENV,
      runner,
      installedVersion: "0.0.60",
    });
    assert.equal(result.status, "newer");
    const env = firstQuery(queries).environment;
    for (const key of Object.keys(env)) {
      assert.ok(ENV_ALLOWLIST.has(key), `unexpected env key passed to runner: ${key}`);
    }
    assert.ok(env.PATH);
    assert.equal(env.HTTPS_PROXY, "http://proxy.internal:3128");
    assert.equal(env.NO_PROXY, "localhost,.internal");
    assert.equal(env.SSL_CERT_FILE, "/etc/internal-ca.pem");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/internal-ca.pem");
    assert.ok(!("NODE_OPTIONS" in env));
    assert.ok(!JSON.stringify(env)?.includes("SECRET-"));
    assert.ok(!JSON.stringify(env)?.includes("evil.example"));
    assertNoLeak(result);
  });

  it("caps combined injected runner output without echoing it", async () => {
    let calls = 0;
    const runner: SetupCommandRunner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: `${"A".repeat(1_200_000)}SECRET-BIG-OUTPUT-MARKER`,
        stderr: "",
      };
    };
    const result = await inspectExactResearchCliRelease("0.0.61", {
      runner,
      installedVersion: "0.0.60",
    });
    assert.equal(calls, 1);
    assertUnreachableStatus(result);
    assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
  });
});

// Escalation fixtures can outlive a failing assertion: when the implementation
// under test never settles, the test framework timeout fires while the fixture
// child keeps burning CPU. Cleanup must therefore not depend on the awaited
// promise or on timers owned by the implementation. The abort listener and the
// afterEach hook SIGKILL only processes whose command line contains our own
// uniquely named fixture bin directory, never any other process.
const activeFixtureBins = new Set<string>();

function killOwnedFixtureProcesses(): void {
  for (const binDirectory of activeFixtureBins) {
    const listed = spawnSync("pgrep", ["-f", `${binDirectory}/`]);
    if (listed.status !== 0 && listed.stdout.length === 0) continue;
    for (const line of listed.stdout.toString().split("\n")) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The pid may have exited between pgrep and the kill.
        }
      }
    }
  }
}

afterEach(() => {
  killOwnedFixtureProcesses();
});

// Every fixture process (root, descendant, fake taskkill) carries the unique
// mkdtemp bin directory in its command line, so pgrep can enumerate exactly
// the processes we own and nothing else.
function assertNoSurvivors(binDirectory: string): void {
  const listed = spawnSync("pgrep", ["-f", `${binDirectory}/`]);
  const survivors = listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert.deepEqual(survivors, [], "owned fixture processes survived the settle");
}

type MockNpmFixture = {
  binDirectory: string;
  lines: () => Promise<string[]>;
  dispose: () => Promise<void>;
};

async function createMockNpmExecutable(
  scriptBodyOrFactory: string | ((binDirectory: string) => string),
  options: {
    file?: string;
    recordArgv?: boolean;
    extraExecutables?: Array<{ file: string; body: string }>;
  } = {},
): Promise<MockNpmFixture> {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-release-mock-"));
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory);
  const logPath = join(directory, "invocations.log");
  const record = options.recordArgv
    ? `for arg in "$@"; do echo "$arg" >> ${JSON.stringify(logPath)}; done`
    : `echo "$@" >> ${JSON.stringify(logPath)}`;
  const scriptBody =
    typeof scriptBodyOrFactory === "function"
      ? scriptBodyOrFactory(binDirectory)
      : scriptBodyOrFactory;
  const executablePath = join(binDirectory, options.file ?? "npm");
  await writeFile(executablePath, `#!/bin/sh\n${record}\n${scriptBody}\n`, { mode: 0o755 });
  for (const extra of options.extraExecutables ?? []) {
    await writeFile(join(binDirectory, extra.file), `${extra.body}\n`, { mode: 0o755 });
  }
  activeFixtureBins.add(binDirectory);
  return {
    binDirectory,
    lines: async () =>
      (await readFile(logPath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.length > 0),
    dispose: async () => {
      killOwnedFixtureProcesses();
      activeFixtureBins.delete(binDirectory);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// First exec of a freshly written fixture can lag behind SIGTERM on
// security-scanning hosts, so escalation fixtures write a readiness file only
// after arming their TERM ignore; tests tick past the timeout from that point.
function waitForReadiness(path: string): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      readFileSync(path, "utf8");
      return;
    } catch {
      spawnSync("/bin/sleep", ["0.02"]);
    }
  }
  assert.fail("fixture child never signalled readiness");
}

// Mock timers advance instantly while real fixture processes need real time;
// asynchronous process events must be allowed to happen before the next tick.
function waitForLogLines(path: string, minLines: number): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let lines: string[] = [];
    try {
      lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      // The log file appears when the fixture process first runs.
    }
    if (lines.length >= minLines) return;
    spawnSync("/bin/sleep", ["0.02"]);
  }
  assert.fail(`fixture log never reached ${minLines} lines`);
}

describe("inspectExactResearchCliRelease default runner", () => {
  // The child PATH holds only the fixture directory, so mock scripts use shell
  // builtins exclusively: the real npm stays unreachable even if wiring breaks.
  // The fixture refuses to answer unless the scope pin and strict-ssl argv
  // actually arrived, keeping the registry override observable end to end.
  function registryJsonScript(version = "0.0.61"): string {
    return [
      "found_scope=0",
      "found_strict_ssl=0",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    --@tiangong-ai:registry=https://registry.npmjs.org) found_scope=1 ;;",
      "    --strict-ssl=true) found_strict_ssl=1 ;;",
      "  esac",
      "done",
      '[ "$found_scope" -eq 1 ] || { echo "missing scope registry pin" >&2; exit 99; }',
      '[ "$found_strict_ssl" -eq 1 ] || { echo "missing strict-ssl pin" >&2; exit 99; }',
      `printf '%s\\n' '${payload({}, version)}'`,
    ].join("\n");
  }

  it("runs the real npm query through PATH and reports a newer verified release", async () => {
    const fixture = await createMockNpmExecutable(registryJsonScript());
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: fixture.binDirectory },
        installedVersion: "0.0.60",
      });
      assert.equal(result.status, "newer");
      assert.equal(result.reason, null);
      assert.deepEqual(result.metadata, {
        version: "0.0.61",
        integrity: VALID_INTEGRITY,
        tarball: `${REGISTRY}/${PACKAGE_NAME}/-/cli-0.0.61.tgz`,
        gitHead: VALID_GIT_HEAD,
      });
      assert.equal((await fixture.lines()).length, 1);
      assertNoLeak(result);
    } finally {
      await fixture.dispose();
    }
  });

  it("routes Windows execution through the fixed cmd.exe branch with constant argv", async () => {
    const fixture = await createMockNpmExecutable(registryJsonScript(), {
      file: "cmd.exe",
      recordArgv: true,
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: fixture.binDirectory },
        installedVersion: "0.0.60",
      });
      assert.equal(result.status, "newer");
      assert.deepEqual(await fixture.lines(), [
        "/d",
        "/s",
        "/c",
        "npm",
        "view",
        "@tiangong-ai/cli@0.0.61",
        "name",
        "version",
        "dist.integrity",
        "dist.tarball",
        "gitHead",
        "--json",
        "--registry",
        REGISTRY,
        "--@tiangong-ai:registry=https://registry.npmjs.org",
        "--strict-ssl=true",
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      await fixture.dispose();
    }
  });

  it("reports unavailable when npm cannot be resolved without crashing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tiangong-release-mock-"));
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: binDirectory },
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds oversized registry output without echoing it", async () => {
    const fixture = await createMockNpmExecutable(
      [
        'echo "SECRET-BIG-OUTPUT-MARKER"',
        "i=0",
        'while [ "$i" -lt 2200 ]; do',
        `  printf '%s' '${"A".repeat(500)}'`,
        "  i=$((i + 1))",
        "done",
      ].join("\n"),
    );
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: fixture.binDirectory },
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
      assert.equal((await fixture.lines()).length, 1);
    } finally {
      await fixture.dispose();
    }
  });

  it("maps nonzero npm exits and non-JSON output to unavailable", async () => {
    const failure = await createMockNpmExecutable('echo "npm ERR! mock failure" >&2\nexit 1');
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: failure.binDirectory },
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
      assert.equal((await failure.lines()).length, 1);
    } finally {
      await failure.dispose();
    }
    const garbage = await createMockNpmExecutable('echo "<html>mock registry</html>"');
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: garbage.binDirectory },
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_METADATA_INVALID");
      assert.equal((await garbage.lines()).length, 1);
    } finally {
      await garbage.dispose();
    }
  });

  it("applies the output cap to stdout and stderr combined", async () => {
    const flood = "A".repeat(500);
    const fixture = await createMockNpmExecutable(
      [
        "i=0",
        'while [ "$i" -lt 1573 ]; do',
        `  printf '%s\\n' '${flood}'`,
        "  i=$((i + 1))",
        "done",
        "i=0",
        'while [ "$i" -lt 1573 ]; do',
        `  echo '${flood}' >&2`,
        "  i=$((i + 1))",
        "done",
      ].join("\n"),
    );
    try {
      const result = await inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: fixture.binDirectory },
        installedVersion: "0.0.60",
      });
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
      assert.equal((await fixture.lines()).length, 1);
    } finally {
      await fixture.dispose();
    }
  });

  it("escalates past a TERM-ignoring child and always settles", { timeout: 8000 }, async (t) => {
    const readyPath = join(tmpdir(), `tiangong-release-ready-${randomUUID()}`);
    const fixture = await createMockNpmExecutable(
      `trap '' TERM\necho ready > ${JSON.stringify(readyPath)}\nwhile :; do :; done`,
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const killOnAbort = () => killOwnedFixtureProcesses();
    t.signal.addEventListener("abort", killOnAbort);
    try {
      const pending = inspectExactResearchCliRelease("0.0.61", {
        environment: { PATH: fixture.binDirectory },
        installedVersion: "0.0.60",
      });
      waitForReadiness(readyPath);
      t.mock.timers.tick(30_000);
      t.mock.timers.tick(120_000);
      const result = await pending;
      assertUnreachableStatus(result);
      assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
    } finally {
      await fixture.dispose();
      rmSync(readyPath, { force: true });
    }
  });

  it(
    "forces the Windows process tree with taskkill /T /F when the query window times out",
    { timeout: 8000 },
    async (t) => {
      const readyPath = join(tmpdir(), `tiangong-release-ready-${randomUUID()}`);
      const taskkillLog = join(tmpdir(), `tiangong-release-taskkill-${randomUUID()}.log`);
      const fixture = await createMockNpmExecutable(
        `trap '' TERM\necho ready > ${JSON.stringify(readyPath)}\nwhile :; do :; done`,
        {
          file: "cmd.exe",
          extraExecutables: [
            {
              file: "taskkill",
              body: [
                "#!/bin/sh",
                `for arg in "$@"; do echo "$arg" >> ${JSON.stringify(taskkillLog)}; done`,
                'kill -9 "$2"',
              ].join("\n"),
            },
          ],
        },
      );
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const killOnAbort = () => killOwnedFixtureProcesses();
      t.signal.addEventListener("abort", killOnAbort);
      try {
        const pending = inspectExactResearchCliRelease("0.0.61", {
          environment: { PATH: fixture.binDirectory },
          installedVersion: "0.0.60",
        });
        waitForReadiness(readyPath);
        t.mock.timers.tick(30_000);
        // Let the real taskkill helper record its argv and act before any
        // further mock-clock advance can race it.
        waitForLogLines(taskkillLog, 4);
        t.mock.timers.tick(120_000);
        const result = await pending;
        assertUnreachableStatus(result);
        assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
        const argv = (await readFile(taskkillLog, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line.length > 0);
        assert.equal(argv[0], "/pid");
        assert.match(argv[1] ?? "", /^\d+$/);
        assert.equal(argv[2], "/T");
        assert.equal(argv[3], "/F");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        rmSync(taskkillLog, { force: true });
        rmSync(readyPath, { force: true });
        await fixture.dispose();
      }
    },
  );

  it(
    "settles by timeout plus finite grace when a descendant keeps the inherited pipes open",
    { timeout: 8000 },
    async (t) => {
      // The root npm process exits on its own, but its descendant inherits the
      // root's stdout/stderr pipes and keeps them open while ignoring TERM.
      // Node only emits child "close" once every stdio stream ends, so an
      // implementation that waits for close/error can stay pending forever
      // after root exit. The query must still settle inside the
      // timeout+grace budget and every owned process must be gone afterwards.
      const readyPath = join(tmpdir(), `tiangong-release-ready-${randomUUID()}`);
      const fixture = await createMockNpmExecutable(
        (binDirectory) =>
          [`${JSON.stringify(join(binDirectory, "descendant"))} &`, "echo root-exited"].join("\n"),
        {
          extraExecutables: [
            {
              file: "descendant",
              body: `#!/bin/sh\necho ready > ${JSON.stringify(readyPath)}\ntrap '' TERM\nwhile :; do :; done`,
            },
          ],
        },
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const killOnAbort = () => killOwnedFixtureProcesses();
      t.signal.addEventListener("abort", killOnAbort);
      try {
        const pending = inspectExactResearchCliRelease("0.0.61", {
          environment: { PATH: fixture.binDirectory },
          installedVersion: "0.0.60",
        });
        waitForReadiness(readyPath);
        t.mock.timers.tick(30_000);
        t.mock.timers.tick(120_000);
        const result = await pending;
        assertUnreachableStatus(result);
        assert.equal(result.reason, "RESEARCH_SETUP_RELEASE_QUERY_FAILED");
        assertNoSurvivors(fixture.binDirectory);
      } finally {
        await fixture.dispose();
        rmSync(readyPath, { force: true });
      }
    },
  );
});

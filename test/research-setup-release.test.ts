import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { describe, it } from "node:test";

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
  return JSON.stringify({
    _note: "SECRET-STDOUT-MARKER",
    name: PACKAGE_NAME,
    version,
    dist: {
      integrity: VALID_INTEGRITY,
      tarball: `${REGISTRY}/${PACKAGE_NAME}/-/cli-${version}.tgz`,
    },
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
          dist: {
            integrity: `sha1-${Buffer.alloc(20, 7).toString("base64")}`,
            tarball: validTarball,
          },
        }),
      ],
      [
        "truncated sha512 integrity",
        payload({
          dist: {
            integrity: `sha512-${Buffer.alloc(63, 7).toString("base64")}`,
            tarball: validTarball,
          },
        }),
      ],
      [
        "non-base64 integrity",
        payload({ dist: { integrity: "sha512-%%%not-base64%%%", tarball: validTarball } }),
      ],
      ["missing dist", payload({ dist: undefined })],
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
    ];
    for (const tarball of tarballs) {
      const { queries, runner } = fixtureRunner({
        exitCode: 0,
        stdout: payload({ dist: { integrity: VALID_INTEGRITY, tarball } }),
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
    assert.ok(!JSON.stringify(env)?.includes("SECRET-"));
    assert.ok(!JSON.stringify(env)?.includes("evil.example"));
    assertNoLeak(result);
  });
});

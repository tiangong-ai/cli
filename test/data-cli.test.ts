import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { builtInDataRegistry } from "../src/data/builtins.js";
import { runDataCommand } from "../src/data/commands.js";
import { runCli } from "../src/cli.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

function captureIo(environment: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: environment,
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("data CLI", () => {
  it("routes the offline built-in catalog through the top-level CLI", async () => {
    const capture = captureIo();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("catalog must remain offline");
    }) as typeof fetch;
    try {
      const exitCode = await runCli(["data", "catalog", "--json"], capture.io);
      assert.equal(exitCode, 0);
      const payload = JSON.parse(capture.output().stdout) as {
        schemaVersion: string;
        capabilities: unknown[];
        catalogDigest: string;
      };
      assert.equal(payload.schemaVersion, "tiangong.data.catalog.v1");
      assert.deepEqual(
        (payload.capabilities as Array<{ capabilityId: string }>).map(
          (capability) => capability.capabilityId,
        ),
        [
          "airnow.hourly-observations",
          "bluesky.public-posts",
          "epa.eis-records",
          "federal-register.documents",
          "gdelt.doc-search",
          "gdelt.events",
          "gdelt.gkg",
          "gdelt.mentions",
          "nasa-firms.active-fire",
          "open-meteo.air-quality",
          "open-meteo.flood",
          "open-meteo.historical-weather",
          "openaq.air-quality",
          "regulations-gov.attachments",
          "regulations-gov.comments",
          "usbr.project-records",
          "usbr.rise",
          "usgs.water-instantaneous-values",
          "youtube.public-content",
        ],
      );
      assert.match(payload.catalogDigest, /^[a-f0-9]{64}$/);
      assert.equal(capture.output().stderr, "");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("prints data commands in top-level help", async () => {
    const capture = captureIo();
    const exitCode = await runCli(["--help"], capture.io);
    assert.equal(exitCode, 0);
    assert.match(capture.output().stdout, /tiangong-ai data catalog/);
  });

  it("does not load cwd dotenv credentials for data commands", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "tiangong-data-dotenv-"));
    const previousCwd = process.cwd();
    try {
      await writeFile(join(temporaryDirectory, ".env"), "TIANGONG_DATA_TEST_TOKEN=must-not-load\n");
      process.chdir(temporaryDirectory);
      const environment: NodeJS.ProcessEnv = {};
      const capture = captureIo(environment);
      const exitCode = await runCli(["data", "catalog", "--json"], capture.io);
      assert.equal(exitCode, 0);
      assert.equal(environment.TIANGONG_DATA_TEST_TOKEN, undefined);
    } finally {
      process.chdir(previousCwd);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("describes a connector offline with its public schemas", async () => {
    const capture = captureIo();
    const exitCode = await runDataCommand(["describe", "test.synthetic", "--json"], capture.io, {
      registry: createDataRegistry([syntheticConnector()]),
    });
    const payload = JSON.parse(capture.output().stdout) as Record<string, unknown>;
    assert.equal(exitCode, 0);
    assert.equal(payload.schemaVersion, "tiangong.data.describe.v1");
    assert.ok(payload.manifest);
    assert.ok(payload.discovery);
    assert.ok(payload.schemas);
    assert.equal(capture.output().stderr, "");
  });

  it("runs static doctor offline and live doctor only when explicitly selected", async () => {
    let fetchCalls = 0;
    const capture = captureIo();
    const registry = createDataRegistry([syntheticConnector({ liveDoctor: true })]);
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected fetch");
    }) as typeof fetch;

    const staticCode = await runDataCommand(["doctor", "test.synthetic", "--json"], capture.io, {
      registry,
      fetchImpl,
    });
    assert.equal(staticCode, 0);
    assert.equal(fetchCalls, 0);
    assert.equal((JSON.parse(capture.output().stdout) as { mode: string }).mode, "static");

    const liveCapture = captureIo();
    const liveCode = await runDataCommand(
      ["doctor", "test.synthetic", "--live", "--json"],
      liveCapture.io,
      { registry, fetchImpl },
    );
    assert.equal(liveCode, 0);
    assert.equal((JSON.parse(liveCapture.output().stdout) as { mode: string }).mode, "live");
  });

  it("describes suspended capabilities but blocks doctor and run without network access", async () => {
    const capabilityId = "regulations-gov.comments";
    const manifest = builtInDataRegistry.describe(capabilityId)!;
    const operation = manifest.operations.find((item) => item.operationId === "search")!;
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("suspended capabilities must not fetch");
    }) as typeof fetch;

    const describeCapture = captureIo();
    assert.equal(
      await runDataCommand(["describe", capabilityId, "--json"], describeCapture.io, {
        registry: builtInDataRegistry,
        fetchImpl,
      }),
      0,
    );
    assert.equal(
      (
        JSON.parse(describeCapture.output().stdout) as {
          manifest: { availability: { status: string } };
        }
      ).manifest.availability.status,
      "suspended",
    );

    const doctorCapture = captureIo({ REGGOV_API_KEY: "fixture-key-never-sent" });
    assert.equal(
      await runDataCommand(["doctor", capabilityId, "--live", "--json"], doctorCapture.io, {
        registry: builtInDataRegistry,
        fetchImpl,
      }),
      3,
    );
    assert.equal(fetchCalls, 0);

    const runCapture = captureIo({ REGGOV_API_KEY: "fixture-key-never-sent" });
    const runRequest = {
      schemaVersion: "tiangong.data.run-request.v1",
      capabilityId,
      capabilityVersion: manifest.capabilityVersion,
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      input: {},
    };
    assert.equal(
      await runDataCommand(
        ["run", capabilityId, operation.operationId, "--input", "-", "--json"],
        { ...runCapture.io, stdin: Readable.from([JSON.stringify(runRequest)]) },
        { registry: builtInDataRegistry, fetchImpl },
      ),
      3,
    );
    assert.equal(fetchCalls, 0);
    assert.equal(
      (JSON.parse(runCapture.output().stdout) as { errors: Array<{ code: string }> }).errors[0]
        ?.code,
      "capability-unavailable",
    );
  });

  it("reads one run request from stdin and returns a machine result", async () => {
    const capture = captureIo();
    const request = {
      schemaVersion: "tiangong.data.run-request.v1",
      capabilityId: "test.synthetic",
      capabilityVersion: "1.0.0",
      operationId: "echo",
      operationVersion: "1.0.0",
      input: { value: "stdin" },
    };
    const exitCode = await runDataCommand(
      ["run", "test.synthetic", "echo", "--input", "-", "--json"],
      { ...capture.io, stdin: Readable.from([JSON.stringify(request)]) },
      { registry: createDataRegistry([syntheticConnector()]) },
    );
    const payload = JSON.parse(capture.output().stdout) as {
      status: string;
      data: unknown;
    };
    assert.equal(exitCode, 0);
    assert.equal(payload.status, "success");
    assert.deepEqual(payload.data, { echoed: "stdin" });
  });

  it("passes an explicit artifact directory to declared artifact operations", async () => {
    const artifactOutputDirectory = await mkdtemp(join(tmpdir(), "tiangong-data-cli-artifacts-"));
    try {
      const capture = captureIo();
      const request = {
        schemaVersion: "tiangong.data.run-request.v1",
        capabilityId: "test.synthetic",
        capabilityVersion: "1.0.0",
        operationId: "echo",
        operationVersion: "1.0.0",
        input: { value: "artifact-cli" },
      };
      const exitCode = await runDataCommand(
        [
          "run",
          "test.synthetic",
          "echo",
          "--input",
          "-",
          "--artifact-dir",
          artifactOutputDirectory,
          "--json",
        ],
        { ...capture.io, stdin: Readable.from([JSON.stringify(request)]) },
        {
          registry: createDataRegistry([
            syntheticConnector({
              artifactOutput: true,
              execute: async (context) => {
                assert.ok(context.artifacts);
                await context.artifacts.stage("cli.txt", Buffer.from("artifact-cli", "utf8"));
                return {
                  status: "success",
                  data: { echoed: "artifact-cli" },
                  summary: {
                    recordCount: 1,
                    pageCount: 0,
                    chunkCount: 1,
                    truncated: false,
                    completeness: "complete",
                  },
                  warnings: [],
                  errors: [],
                  observations: [],
                };
              },
            }),
          ]),
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(
        await readFile(join(artifactOutputDirectory, "cli.txt"), "utf8"),
        "artifact-cli",
      );
      assert.doesNotMatch(capture.output().stdout, new RegExp(artifactOutputDirectory));
    } finally {
      await rm(artifactOutputDirectory, { force: true, recursive: true });
    }
  });

  it("uses non-zero exits for partial and blocked machine results", async () => {
    const blocked = captureIo();
    const request = JSON.stringify({
      schemaVersion: "tiangong.data.run-request.v1",
      capabilityId: "missing.capability",
      capabilityVersion: "1.0.0",
      operationId: "fetch",
      operationVersion: "1.0.0",
      input: {},
    });
    const exitCode = await runDataCommand(
      ["run", "missing.capability", "fetch", "--input", "-", "--json"],
      { ...blocked.io, stdin: Readable.from([request]) },
      { registry: createDataRegistry([]) },
    );
    assert.equal(exitCode, 2);
    assert.equal(
      (JSON.parse(blocked.output().stdout) as { errors: Array<{ code: string }> }).errors[0]?.code,
      "invalid-request",
    );
  });
});

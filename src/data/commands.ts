import { readFile } from "node:fs/promises";

import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { builtInDataRegistry } from "./builtins.js";
import type { DataRegistry } from "./catalog.js";
import type {
  DataDescribeResult,
  DataDoctorCheck,
  DataDoctorResult,
  DataErrorEnvelope,
  DataRunRequest,
  DataRunResult,
} from "./contracts.js";
import {
  DATA_DESCRIBE_SCHEMA_VERSION,
  DATA_DOCTOR_SCHEMA_VERSION,
  DATA_ERROR_SCHEMA_VERSION,
} from "./contracts.js";
import { createBoundedHttpClient } from "./runtime/bounded-http.js";
import { resolveDataCredentials } from "./runtime/credentials.js";
import { dataErrorExitCode, DataRuntimeError, toDataMachineError } from "./runtime/errors.js";
import { executeDataRun } from "./runtime/execute.js";
import { validateDataPublicContract } from "./schemas.js";

const MAX_DATA_INPUT_BYTES = 1024 * 1024;

export interface RunDataCommandOptions {
  registry?: DataRegistry | undefined;
  fetchImpl?: typeof fetch | undefined;
  clock?: (() => Date) | undefined;
}

export async function runDataCommand(
  argv: string[],
  io: CliIO,
  options: RunDataCommandOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  const registry = options.registry ?? builtInDataRegistry;
  try {
    const [subcommand, ...rest] = argv;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      write(io.stdout, dataHelp());
      return 0;
    }
    if (subcommand === "catalog") return runCatalog(rest, io, registry);
    if (subcommand === "describe") return runDescribe(rest, io, registry);
    if (subcommand === "doctor") return runDoctor(rest, io, registry, options);
    if (subcommand === "run") return runOperation(rest, io, registry, options);
    throw new DataRuntimeError(
      "unsupported-operation",
      "Unknown data command. Use tiangong-ai data --help.",
      { details: { subcommand } },
    );
  } catch (error) {
    const normalized =
      error instanceof CliError
        ? new DataRuntimeError("invalid-request", error.message, { exitCode: 2 })
        : error;
    const machine = toDataMachineError(normalized);
    if (json) {
      const envelope: DataErrorEnvelope = {
        schemaVersion: DATA_ERROR_SCHEMA_VERSION,
        status: "blocked",
        errors: [machine],
      };
      validateDataPublicContract("error", envelope);
      write(io.stdout, stringifyJson(envelope, true));
    } else {
      write(io.stderr, `${machine.message}\n`);
    }
    return normalized instanceof DataRuntimeError
      ? normalized.exitCode
      : dataErrorExitCode(machine.code);
  }
}

export function dataHelp(): string {
  return `Tiangong atomic data commands

Usage:
  tiangong-ai data catalog [--json]
  tiangong-ai data describe <capability-id> [--json]
  tiangong-ai data doctor <capability-id> [--live] [--json]
  tiangong-ai data run <capability-id> <operation-id> --input <path|-> [--artifact-dir <absolute-existing-directory>] [--json]

Data commands use closed, versioned machine contracts. catalog, describe, and
static doctor are offline. Only an explicit doctor --live or data run may use
the network. Credentials are resolved from manifest-declared environment
variables and must never be placed in argv or input JSON.
`;
}

function runCatalog(argv: string[], io: CliIO, registry: DataRegistry): number {
  const args = parseStrictArgs(argv, { help: "boolean", json: "boolean" }, "data catalog");
  if (strictBoolean(args, "help")) {
    write(io.stdout, dataHelp());
    return 0;
  }
  assertPositionals(args.positionals, 0, "data catalog");
  const result = registry.catalog();
  if (strictBoolean(args, "json")) {
    write(io.stdout, stringifyJson(result, true));
  } else if (result.capabilities.length === 0) {
    write(io.stdout, "No built-in data capabilities are registered.\n");
  } else {
    for (const capability of result.capabilities) {
      write(
        io.stdout,
        `${capability.capabilityId}\t${capability.capabilityVersion}\t${capability.providerId}\t${capability.summary}\n`,
      );
    }
  }
  return 0;
}

function runDescribe(argv: string[], io: CliIO, registry: DataRegistry): number {
  const args = parseStrictArgs(argv, { help: "boolean", json: "boolean" }, "data describe");
  if (strictBoolean(args, "help")) {
    write(io.stdout, dataHelp());
    return 0;
  }
  assertPositionals(args.positionals, 1, "data describe");
  const capabilityId = args.positionals[0]!;
  const manifest = registry.describe(capabilityId);
  const discovery = registry.discovery(capabilityId);
  const schemas = registry.schemas(capabilityId);
  if (!manifest || !discovery || !schemas) {
    throw new DataRuntimeError(
      "invalid-request",
      "The requested data capability is not registered.",
      {
        details: { capabilityId },
      },
    );
  }
  const result: DataDescribeResult = {
    schemaVersion: DATA_DESCRIBE_SCHEMA_VERSION,
    manifest,
    discovery,
    schemas,
  };
  validateDataPublicContract("describe", result);
  if (strictBoolean(args, "json")) {
    write(io.stdout, stringifyJson(result, true));
  } else {
    write(io.stdout, `${manifest.capabilityId} ${manifest.capabilityVersion}\n`);
    write(io.stdout, `${discovery.summary}\n`);
    write(io.stdout, `source ${discovery.source.name}\n`);
    write(io.stdout, `manifest ${manifest.manifestDigest}\n`);
    write(io.stdout, `discovery ${discovery.discoveryDigest}\n`);
    for (const item of discovery.provides) write(io.stdout, `provides ${item}\n`);
    for (const item of discovery.doesNotProvide) {
      write(io.stdout, `does-not-provide ${item}\n`);
    }
    for (const operation of manifest.operations) {
      const operationDiscovery = discovery.operations.find(
        (item) => item.operationId === operation.operationId,
      );
      write(
        io.stdout,
        `${operation.operationId} ${operation.operationVersion}\t${operationDiscovery?.summary ?? ""}\n`,
      );
    }
  }
  return 0;
}

async function runDoctor(
  argv: string[],
  io: CliIO,
  registry: DataRegistry,
  options: RunDataCommandOptions,
): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { help: "boolean", json: "boolean", live: "boolean" },
    "data doctor",
  );
  if (strictBoolean(args, "help")) {
    write(io.stdout, dataHelp());
    return 0;
  }
  assertPositionals(args.positionals, 1, "data doctor");
  const capabilityId = args.positionals[0]!;
  const connector = registry.registered(capabilityId);
  if (!connector) {
    throw new DataRuntimeError(
      "invalid-request",
      "The requested data capability is not registered.",
      {
        details: { capabilityId },
      },
    );
  }
  const live = strictBoolean(args, "live");
  const resolved = resolveDataCredentials(connector.definition.credentials, io.env);
  let checks: DataDoctorCheck[] = [
    {
      checkId: "manifest",
      status: "pass",
      message: "The built-in manifest and operation schemas are valid.",
    },
    ...(connector.definition.availability?.status === "suspended"
      ? [
          {
            checkId: "availability",
            status: "fail" as const,
            message: "The data capability is temporarily suspended.",
            details: {
              reasonCode: connector.definition.availability.reasonCode,
              resumeCriteria: connector.definition.availability.resumeCriteria,
            },
          },
        ]
      : []),
    ...resolved.checks,
  ];
  let networkAttempted = false;
  if (
    live &&
    !checks.some((check) => check.checkId === "availability" && check.status === "fail")
  ) {
    if (!connector.definition.diagnostics.live || !connector.definition.liveDoctor) {
      throw new DataRuntimeError(
        "unsupported-operation",
        "This data capability does not provide a live doctor probe.",
      );
    }
    if (!checks.some((check) => check.status === "fail")) {
      const http = createBoundedHttpClient({
        capabilityId: connector.manifest.capabilityId,
        endpoints: connector.definition.endpoints,
        credentials: connector.definition.credentials,
        environment: io.env,
        limits: connector.definition.limits,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const liveResult = await connector.definition.liveDoctor({ http });
      checks = [...checks, ...liveResult.checks];
      networkAttempted = liveResult.networkAttempted ?? true;
    }
  }
  const status = checks.some((check) => check.status === "fail")
    ? "blocked"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "ready";
  const result: DataDoctorResult = {
    schemaVersion: DATA_DOCTOR_SCHEMA_VERSION,
    capabilityId: connector.manifest.capabilityId,
    capabilityVersion: connector.manifest.capabilityVersion,
    manifestDigest: connector.manifest.manifestDigest,
    mode: live ? "live" : "static",
    status,
    networkAttempted,
    checks,
  };
  validateDataPublicContract("doctor", result);
  if (strictBoolean(args, "json")) {
    write(io.stdout, stringifyJson(result, true));
  } else {
    write(io.stdout, `${result.capabilityId}\t${result.mode}\t${result.status}\n`);
    for (const check of checks) write(io.stdout, `${check.status}\t${check.message}\n`);
  }
  return status === "blocked" ? 3 : 0;
}

async function runOperation(
  argv: string[],
  io: CliIO,
  registry: DataRegistry,
  options: RunDataCommandOptions,
): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { "artifact-dir": "string", help: "boolean", input: "string", json: "boolean" },
    "data run",
  );
  if (strictBoolean(args, "help")) {
    write(io.stdout, dataHelp());
    return 0;
  }
  assertPositionals(args.positionals, 2, "data run");
  const inputSource = strictString(args, "input");
  if (!inputSource) {
    throw new DataRuntimeError("invalid-request", "data run requires --input <path|->.", {
      exitCode: 2,
    });
  }
  const rawRequest = await readDataInput(inputSource, io);
  assertCommandBinding(rawRequest, args.positionals[0]!, args.positionals[1]!);
  const artifactOutputDirectory = strictString(args, "artifact-dir");
  const result = await executeDataRun(rawRequest, {
    registry,
    environment: io.env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(artifactOutputDirectory === undefined ? {} : { artifactOutputDirectory }),
  });
  if (strictBoolean(args, "json")) {
    write(io.stdout, stringifyJson(result, true));
  } else {
    writeHumanRunResult(io, result);
  }
  if (result.status === "success") return 0;
  if (result.status === "partial") return 4;
  return dataErrorExitCode(result.errors[0]?.code ?? "internal-error");
}

async function readDataInput(source: string, io: CliIO): Promise<unknown> {
  let bytes: Buffer;
  if (source === "-") {
    if (!io.stdin) {
      throw new DataRuntimeError("invalid-request", "Standard input is unavailable.", {
        exitCode: 2,
      });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of io.stdin as AsyncIterable<Buffer | string | Uint8Array>) {
      const bytesChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytesChunk.byteLength;
      if (total > MAX_DATA_INPUT_BYTES) {
        throw new DataRuntimeError("invalid-request", "The data run input exceeds 1 MiB.", {
          exitCode: 2,
        });
      }
      chunks.push(bytesChunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    try {
      bytes = await readFile(source);
    } catch {
      throw new DataRuntimeError("invalid-request", "The data run input file could not be read.", {
        exitCode: 2,
      });
    }
    if (bytes.byteLength > MAX_DATA_INPUT_BYTES) {
      throw new DataRuntimeError("invalid-request", "The data run input exceeds 1 MiB.", {
        exitCode: 2,
      });
    }
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new DataRuntimeError("invalid-request", "The data run input is not valid UTF-8 JSON.", {
      exitCode: 2,
    });
  }
}

function assertCommandBinding(
  value: unknown,
  capabilityId: string,
  operationId: string,
): asserts value is DataRunRequest {
  const request = value as Partial<DataRunRequest> | null;
  if (
    !request ||
    typeof request !== "object" ||
    request.capabilityId !== capabilityId ||
    request.operationId !== operationId
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "The command capability and operation must match the input request contract.",
      { exitCode: 2 },
    );
  }
}

function assertPositionals(positionals: string[], count: number, command: string): void {
  if (positionals.length !== count) {
    throw new DataRuntimeError(
      "invalid-request",
      `${command} expects exactly ${count} positional argument${count === 1 ? "" : "s"}.`,
      { exitCode: 2 },
    );
  }
}

function writeHumanRunResult(io: CliIO, result: DataRunResult): void {
  write(
    io.stdout,
    `${result.status}\t${result.contract.capabilityId}/${result.contract.operationId}\n`,
  );
  write(io.stdout, `records\t${result.summary.recordCount}\n`);
  write(io.stdout, `receipt\t${result.receipt.receiptDigest}\n`);
  for (const warning of result.warnings) write(io.stdout, `warning\t${warning}\n`);
  for (const error of result.errors) write(io.stdout, `error\t${error.code}\t${error.message}\n`);
}

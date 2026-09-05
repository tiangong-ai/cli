import packageMetadata from "../../../package.json" with { type: "json" };

import type {
  DataCapabilityManifest,
  DataExecutionLimits,
  DataExecutionSummary,
  DataOperationManifest,
  DataRunRequest,
  DataRunResult,
} from "../contracts.js";
import { DATA_RUN_REQUEST_SCHEMA_VERSION, DATA_RUN_RESULT_SCHEMA_VERSION } from "../contracts.js";
import type { DataRegistry, RegisteredDataConnector } from "../catalog.js";
import { createBoundedHttpClient } from "./bounded-http.js";
import { createDataArtifactSession, type DataArtifactSession } from "./artifacts.js";
import { canonicalJson } from "./canonical-json.js";
import { requiredCredentialsPresent, resolveDataCredentials } from "./credentials.js";
import {
  containsConfiguredSecret,
  DataRuntimeError,
  sanitizeDataText,
  sanitizeDataValue,
  toDataMachineError,
} from "./errors.js";
import { buildCoreDataReceipt } from "./receipts.js";
import {
  DataContractValidationError,
  formatValidationErrors,
  validateDataPublicContract,
} from "../schemas.js";

export interface ExecuteDataRunOptions {
  registry: DataRegistry;
  environment: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch | undefined;
  clock?: (() => Date) | undefined;
  cliVersion?: string | undefined;
  artifactOutputDirectory?: string | undefined;
}

export async function executeDataRun(
  rawRequest: unknown,
  options: ExecuteDataRunOptions,
): Promise<DataRunResult> {
  const cliVersion = options.cliVersion ?? packageMetadata.version;
  const clock = options.clock ?? (() => new Date());
  let request: DataRunRequest;
  try {
    validateDataPublicContract("runRequest", rawRequest);
    canonicalJson(rawRequest);
    request = rawRequest as DataRunRequest;
  } catch (error) {
    request = fallbackRequest(rawRequest);
    return blockedResult({
      cliVersion,
      request,
      manifest: null,
      operation: null,
      error: new DataRuntimeError("invalid-request", "The data run request is invalid.", {
        details: validationDetails(error),
      }),
      generatedAt: clock().toISOString(),
    });
  }

  const connector = options.registry.registered(request.capabilityId);
  if (!connector) {
    return blockedResult({
      cliVersion,
      request,
      manifest: null,
      operation: null,
      error: new DataRuntimeError(
        "invalid-request",
        "The requested data capability is not registered.",
        { details: { capabilityId: request.capabilityId } },
      ),
      generatedAt: clock().toISOString(),
    });
  }
  const operation = connector.operations.get(request.operationId);
  if (!operation) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: null,
      error: new DataRuntimeError(
        "unsupported-operation",
        "The requested operation is not provided by this data capability.",
        {
          details: {
            capabilityId: request.capabilityId,
            operationId: request.operationId,
          },
        },
      ),
      generatedAt: clock().toISOString(),
    });
  }
  if (connector.definition.availability?.status === "suspended") {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: new DataRuntimeError(
        "capability-unavailable",
        "The requested data capability is temporarily suspended.",
        {
          userActionRequired: true,
          details: {
            capabilityId: request.capabilityId,
            reasonCode: connector.definition.availability.reasonCode,
          },
        },
      ),
      generatedAt: clock().toISOString(),
    });
  }
  const contractError = checkCompatibility(request, connector, operation.manifest, cliVersion);
  if (contractError) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: contractError,
      generatedAt: clock().toISOString(),
    });
  }
  if (!operation.validateInput(request.input)) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: new DataRuntimeError(
        "invalid-request",
        "The operation input does not satisfy its published schema.",
        { details: { issues: formatValidationErrors(operation.validateInput.errors) } },
      ),
      generatedAt: clock().toISOString(),
    });
  }

  const artifactOutput = operation.definition.artifactOutput;
  if (artifactOutput?.required && options.artifactOutputDirectory === undefined) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: new DataRuntimeError(
        "invalid-request",
        "This data operation requires an explicit artifact output directory.",
        { userActionRequired: true },
      ),
      generatedAt: clock().toISOString(),
    });
  }
  if (artifactOutput === undefined && options.artifactOutputDirectory !== undefined) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: new DataRuntimeError(
        "invalid-request",
        "This data operation does not declare artifact output.",
      ),
      generatedAt: clock().toISOString(),
    });
  }

  let effectiveLimits: DataExecutionLimits;
  try {
    effectiveLimits = applyLimitOverrides(operation.manifest.limits, request.limits);
  } catch (error) {
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error,
      generatedAt: clock().toISOString(),
    });
  }
  const resolvedCredentials = resolveDataCredentials(
    connector.definition.credentials,
    options.environment,
  );
  if (!requiredCredentialsPresent(connector.definition.credentials, resolvedCredentials.values)) {
    const missing = connector.definition.credentials
      .filter(
        (credential) =>
          credential.required && !resolvedCredentials.values.has(credential.credentialId),
      )
      .map((credential) => credential.credentialId);
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error: new DataRuntimeError(
        "credential-missing",
        "One or more required logical credentials are not configured.",
        { userActionRequired: true, details: { credentialIds: missing } },
      ),
      generatedAt: clock().toISOString(),
    });
  }

  let artifactSession: DataArtifactSession | null = null;
  if (artifactOutput !== undefined) {
    try {
      artifactSession = await createDataArtifactSession(options.artifactOutputDirectory!);
    } catch (error) {
      return blockedResult({
        cliVersion,
        request,
        manifest: connector.manifest,
        operation: operation.manifest,
        error,
        generatedAt: clock().toISOString(),
      });
    }
  }

  const http = createBoundedHttpClient({
    capabilityId: connector.manifest.capabilityId,
    endpoints: connector.definition.endpoints,
    credentials: connector.definition.credentials,
    environment: options.environment,
    limits: effectiveLimits,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  try {
    const execution = await operation.definition.execute({
      input: request.input,
      request,
      limits: effectiveLimits,
      http,
      artifacts: artifactSession,
    });
    assertExecutionInvariants(execution, effectiveLimits);
    if (!operation.validateOutput(execution.data)) {
      throw new DataRuntimeError(
        "provider-response-invalid",
        "The normalized operation result does not satisfy its published output schema.",
        { details: { issues: formatValidationErrors(operation.validateOutput.errors) } },
      );
    }
    const secrets = http.configuredSecrets();
    if (containsConfiguredSecret(canonicalJson(execution), secrets)) {
      throw new DataRuntimeError(
        "provider-response-invalid",
        "The normalized operation result contained configured credential material and was blocked.",
      );
    }
    const errors = execution.errors.map((error) => ({
      ...error,
      message: sanitizeDataText(error.message, secrets),
      ...(error.details === undefined
        ? {}
        : { details: sanitizeDataValue(error.details, secrets) as typeof error.details }),
    }));
    const result: DataRunResult = {
      schemaVersion: DATA_RUN_RESULT_SCHEMA_VERSION,
      status: execution.status,
      requestId: request.requestId ?? null,
      contract: contractProjection(cliVersion, request, connector.manifest, operation.manifest),
      data: execution.data,
      summary: execution.summary,
      warnings: execution.warnings.map((warning) => sanitizeDataText(warning, secrets)),
      errors,
      receipt: buildCoreDataReceipt({
        cliVersion,
        request,
        manifest: connector.manifest,
        operation: operation.manifest,
        observations: execution.observations,
        data: execution.data,
        completionStatus: execution.status,
        summary: execution.summary,
        generatedAt: clock().toISOString(),
      }),
    };
    validateDataPublicContract("runResult", result);
    await artifactSession?.commit();
    return result;
  } catch (error) {
    await artifactSession?.rollback();
    return blockedResult({
      cliVersion,
      request,
      manifest: connector.manifest,
      operation: operation.manifest,
      error,
      secrets: http.configuredSecrets(),
      generatedAt: clock().toISOString(),
    });
  }
}

function checkCompatibility(
  request: DataRunRequest,
  connector: RegisteredDataConnector,
  operation: DataOperationManifest,
  cliVersion: string,
): DataRuntimeError | null {
  if (
    request.capabilityVersion !== connector.manifest.capabilityVersion ||
    request.operationVersion !== operation.operationVersion
  ) {
    return new DataRuntimeError(
      "incompatible-contract",
      "The requested connector or operation version does not match the installed contract.",
      {
        details: {
          requestedCapabilityVersion: request.capabilityVersion,
          installedCapabilityVersion: connector.manifest.capabilityVersion,
          requestedOperationVersion: request.operationVersion,
          installedOperationVersion: operation.operationVersion,
        },
      },
    );
  }
  if (compareSemver(cliVersion, connector.manifest.minimumCliVersion) < 0) {
    return new DataRuntimeError(
      "incompatible-contract",
      "The installed CLI version is below the connector minimum.",
      {
        details: {
          cliVersion,
          minimumCliVersion: connector.manifest.minimumCliVersion,
        },
      },
    );
  }
  return null;
}

function assertExecutionInvariants(
  execution: Awaited<
    ReturnType<RegisteredDataConnector["definition"]["operations"][number]["execute"]>
  >,
  limits: DataExecutionLimits,
): void {
  if (execution.status === "success") {
    if (execution.summary.completeness !== "complete" || execution.errors.length > 0) {
      throw new DataRuntimeError(
        "normalization-failed",
        "A successful connector result must be complete and error-free.",
      );
    }
  } else if (
    execution.summary.completeness !== "partial" ||
    !execution.errors.some((error) => error.code === "partial-result") ||
    !execution.summary.missing?.length
  ) {
    throw new DataRuntimeError(
      "normalization-failed",
      "A partial connector result must identify its missing coverage.",
    );
  }
  if (
    execution.summary.recordCount > limits.maxRecords ||
    execution.summary.pageCount > limits.maxPages
  ) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "The connector result exceeds its declared record or page limit.",
    );
  }
}

function blockedResult(input: {
  cliVersion: string;
  request: DataRunRequest;
  manifest: DataCapabilityManifest | null;
  operation: DataOperationManifest | null;
  error: unknown;
  secrets?: readonly string[] | undefined;
  generatedAt: string;
}): DataRunResult {
  const summary: DataExecutionSummary = {
    recordCount: 0,
    pageCount: 0,
    chunkCount: 0,
    truncated: false,
    completeness: "blocked",
  };
  const result: DataRunResult = {
    schemaVersion: DATA_RUN_RESULT_SCHEMA_VERSION,
    status: "blocked",
    requestId: input.request.requestId ?? null,
    contract: contractProjection(input.cliVersion, input.request, input.manifest, input.operation),
    data: null,
    summary,
    warnings: [],
    errors: [toDataMachineError(input.error, input.secrets)],
    receipt: buildCoreDataReceipt({
      cliVersion: input.cliVersion,
      request: input.request,
      manifest: input.manifest,
      operation: input.operation,
      observations: [],
      data: null,
      completionStatus: "blocked",
      summary,
      generatedAt: input.generatedAt,
    }),
  };
  validateDataPublicContract("runResult", result);
  return result;
}

function contractProjection(
  cliVersion: string,
  request: DataRunRequest,
  manifest: DataCapabilityManifest | null,
  operation: DataOperationManifest | null,
): DataRunResult["contract"] {
  return {
    cliVersion,
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    operationId: request.operationId,
    operationVersion: request.operationVersion,
    manifestDigest: manifest?.manifestDigest ?? null,
    inputSchema: operation?.inputSchema ?? null,
    outputSchema: operation?.outputSchema ?? null,
  };
}

function applyLimitOverrides(
  base: DataExecutionLimits,
  overrides: DataRunRequest["limits"],
): DataExecutionLimits {
  const result = { ...base };
  if (!overrides) return result;
  for (const key of Object.keys(overrides) as Array<keyof NonNullable<DataRunRequest["limits"]>>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > base[key]) {
      throw new DataRuntimeError(
        "invalid-request",
        `The requested ${key} cannot exceed the operation limit.`,
        { details: { limit: base[key] } },
      );
    }
    result[key] = value;
  }
  return result;
}

function fallbackRequest(value: unknown): DataRunRequest {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    schemaVersion: DATA_RUN_REQUEST_SCHEMA_VERSION,
    capabilityId: safeId(record.capabilityId, "invalid"),
    capabilityVersion: safeVersion(record.capabilityVersion),
    operationId: safeId(record.operationId, "invalid"),
    operationVersion: safeVersion(record.operationVersion),
    input: jsonSafe(record.input),
    ...(typeof record.requestId === "string" && record.requestId
      ? { requestId: record.requestId.slice(0, 128) }
      : {}),
  };
}

function safeId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
    ? value
    : fallback;
}

function safeVersion(value: unknown): string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : "0.0.0";
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return null;
  }
}

function validationDetails(error: unknown): Record<string, string[]> {
  if (error instanceof DataContractValidationError) return { issues: error.issues };
  return { issues: ["The request is not valid JSON contract data."] };
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(/[+-]/, 1)[0]!.split(".").map(Number);
  const rightParts = right.split(/[+-]/, 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

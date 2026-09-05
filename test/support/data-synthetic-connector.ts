import type {
  DataConnectorDefinition,
  DataExecutionLimits,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  JsonSchema,
} from "../../src/data/contracts.js";

export const SYNTHETIC_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/test/synthetic-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: { type: "string", minLength: 1 },
  },
} as const satisfies JsonSchema;

export const SYNTHETIC_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/test/synthetic-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["echoed"],
  properties: {
    echoed: { type: "string" },
  },
} as const satisfies JsonSchema;

export interface SyntheticConnectorOptions {
  credential?: boolean;
  liveDoctor?: boolean;
  artifactOutput?: boolean;
  limits?: Partial<DataExecutionLimits>;
  outputSchema?: JsonSchema;
  execute?: (
    context: DataOperationExecutionContext,
  ) => DataOperationExecution | Promise<DataOperationExecution>;
}

export function syntheticConnector(
  options: SyntheticConnectorOptions = {},
): DataConnectorDefinition {
  return {
    schemaVersion: "tiangong.data.manifest.v1",
    capabilityId: "test.synthetic",
    capabilityVersion: "1.0.0",
    minimumCliVersion: "0.0.51",
    provider: {
      providerId: "synthetic",
      name: "Synthetic provider",
    },
    sourceCategory: "test-fixture",
    endpoints: [
      {
        endpointId: "primary",
        baseUrl: "https://example.test",
        pathPrefixes: ["/v1/"],
        allowedMethods: ["GET"],
        allowedContentTypes: ["application/json"],
      },
    ],
    license: {
      name: "Synthetic test fixture",
      url: "https://example.test/license",
      restrictions: ["test-only"],
    },
    credentials: options.credential
      ? [
          {
            credentialId: "api-token",
            environmentVariable: "TIANGONG_DATA_TEST_TOKEN",
            required: true,
            endpointIds: ["primary"],
            injection: {
              kind: "header",
              name: "Authorization",
              prefix: "Bearer ",
            },
          },
        ]
      : [],
    limits: {
      timeoutMs: 1_000,
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
      maxPages: 2,
      maxRecords: 10,
      maxRetries: 1,
      maxRetryDelayMs: 10,
      maxRedirects: 2,
      ...options.limits,
    },
    diagnostics: {
      static: true,
      live: options.liveDoctor ?? false,
    },
    freshness: {
      kind: "provider-defined",
      description: "Synthetic fixture data has no freshness guarantee.",
    },
    limitations: ["Not a real provider."],
    discovery: {
      source: {
        maintainedBy: "Tiangong CLI tests",
        summary: "Synthetic records used only by deterministic runtime tests.",
        description:
          "A local test definition that exercises the public data runtime without representing an external source.",
        coverage: {
          geographic: "Not applicable.",
          temporal: "Not applicable.",
          granularity: "One synthetic echo record.",
        },
      },
      summary: "Exercise one deterministic synthetic data operation.",
      description:
        "This test-only capability validates registry, schema, credential, HTTP, and receipt behavior.",
      provides: ["A deterministic echo result for runtime contract tests."],
      doesNotProvide: ["Real provider data."],
      selectionHints: ["Use only in automated tests."],
      typicalUseCases: ["Verify the atomic data runtime contract."],
      sourceDocumentation: [
        { title: "Synthetic provider fixture", url: "https://example.test/docs" },
      ],
    },
    operations: [
      {
        operationId: "echo",
        operationVersion: "1.0.0",
        summary: "Echo one validated string.",
        description:
          "Validates one non-empty string and returns it unchanged in a closed envelope.",
        inputSchema: SYNTHETIC_INPUT_SCHEMA,
        outputSchema: options.outputSchema ?? SYNTHETIC_OUTPUT_SCHEMA,
        ...(options.artifactOutput
          ? { artifactOutput: { kind: "directory" as const, required: true as const } }
          : {}),
        execute:
          options.execute ??
          ((context) => ({
            status: "success",
            data: { echoed: (context.input as { value: string }).value },
            summary: {
              recordCount: 1,
              pageCount: 0,
              chunkCount: 0,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [],
          })),
      },
    ],
    ...(options.liveDoctor
      ? {
          liveDoctor: async () => ({
            status: "ready" as const,
            checks: [
              {
                checkId: "synthetic-live",
                status: "pass" as const,
                message: "Synthetic live check passed.",
              },
            ],
          }),
        }
      : {}),
  };
}

export function partialResult(
  message = "One synthetic page was unavailable.",
): DataOperationExecution | Promise<DataOperationExecution> {
  const error: DataMachineError = {
    code: "partial-result",
    message,
    retryable: true,
    userActionRequired: false,
    details: { missingPages: [2] },
  };
  return {
    status: "partial",
    data: { echoed: "available" },
    summary: {
      recordCount: 1,
      pageCount: 1,
      chunkCount: 0,
      truncated: false,
      completeness: "partial",
      missing: [{ kind: "page", identifiers: ["2"] }],
    },
    warnings: [],
    errors: [error],
    observations: [],
  };
}

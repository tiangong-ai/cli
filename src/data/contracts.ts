export const DATA_MANIFEST_SCHEMA_VERSION = "tiangong.data.manifest.v1" as const;
export const DATA_DISCOVERY_SCHEMA_VERSION = "tiangong.data.discovery.v1" as const;
export const DATA_CATALOG_SCHEMA_VERSION = "tiangong.data.catalog.v1" as const;
export const DATA_DESCRIBE_SCHEMA_VERSION = "tiangong.data.describe.v1" as const;
export const DATA_DOCTOR_SCHEMA_VERSION = "tiangong.data.doctor.v1" as const;
export const DATA_RUN_REQUEST_SCHEMA_VERSION = "tiangong.data.run-request.v1" as const;
export const DATA_RUN_RESULT_SCHEMA_VERSION = "tiangong.data.run-result.v1" as const;
export const DATA_ERROR_SCHEMA_VERSION = "tiangong.data.error.v1" as const;
export const DATA_RECEIPT_SCHEMA_VERSION = "tiangong.data.core-receipt.v1" as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type DataErrorCode =
  | "invalid-request"
  | "unsupported-operation"
  | "incompatible-contract"
  | "capability-unavailable"
  | "credential-missing"
  | "credential-invalid"
  | "provider-auth-blocked"
  | "endpoint-policy-blocked"
  | "rate-limited"
  | "timeout"
  | "network-failed"
  | "response-too-large"
  | "provider-response-invalid"
  | "normalization-failed"
  | "partial-result"
  | "internal-error";

export interface DataMachineError {
  code: DataErrorCode;
  message: string;
  retryable: boolean;
  userActionRequired: boolean;
  details?: Record<string, JsonValue> | undefined;
}

export interface DataErrorEnvelope {
  schemaVersion: typeof DATA_ERROR_SCHEMA_VERSION;
  status: "blocked";
  errors: DataMachineError[];
}

export interface DataExecutionLimits {
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxPages: number;
  maxRecords: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  maxRedirects: number;
}

export interface DataLimitOverrides {
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  maxPages?: number | undefined;
  maxRecords?: number | undefined;
}

export interface DataEndpointScope {
  endpointId: string;
  baseUrl: string;
  pathPrefixes: string[];
  allowedMethods: Array<"GET" | "POST">;
  allowedContentTypes: string[];
  sessionCookies?: "same-origin-memory" | undefined;
}

export interface DataCredentialDeclaration {
  credentialId: string;
  environmentVariable: string;
  required: boolean;
  endpointIds: string[];
  injection:
    | {
        kind: "header";
        name: string;
        prefix: string;
      }
    | {
        kind: "path-segment";
        placeholder: `{${string}}`;
      };
}

export interface DataSchemaReference {
  schemaId: string;
  digest: string;
}

export interface DataOperationManifest {
  operationId: string;
  operationVersion: string;
  inputSchema: DataSchemaReference;
  outputSchema: DataSchemaReference;
  limits: DataExecutionLimits;
  features?: string[] | undefined;
  artifactOutput?: DataArtifactOutputDeclaration | undefined;
}

export interface DataCapabilityAvailability {
  status: "available" | "suspended";
  reasonCode: string | null;
  description: string | null;
  resumeCriteria: string[];
}

export interface SuspendedDataCapabilityAvailability {
  status: "suspended";
  reasonCode: string;
  description: string;
  resumeCriteria: string[];
}

export interface DataArtifactOutputDeclaration {
  kind: "directory";
  required: true;
}

export interface DataArtifactRecord {
  relativePath: string;
  sha256: string;
  byteSize: number;
}

export interface DataArtifactSink {
  assertAvailable(relativePath: string): Promise<void>;
  stage(relativePath: string, bytes: Uint8Array): Promise<DataArtifactRecord>;
}

/** The capability's execution contract. Discovery prose is intentionally excluded. */
export interface DataCapabilityManifest {
  schemaVersion: typeof DATA_MANIFEST_SCHEMA_VERSION;
  capabilityId: string;
  capabilityVersion: string;
  minimumCliVersion: string;
  providerId: string;
  endpoints: DataEndpointScope[];
  credentials: DataCredentialDeclaration[];
  limits: DataExecutionLimits;
  diagnostics: {
    static: true;
    live: boolean;
  };
  availability?: Pick<SuspendedDataCapabilityAvailability, "status" | "reasonCode"> | undefined;
  operations: DataOperationManifest[];
  manifestDigest: string;
}

export interface DataSourceDocumentation {
  title: string;
  url: string;
}

export interface DataCapabilityDiscovery {
  schemaVersion: typeof DATA_DISCOVERY_SCHEMA_VERSION;
  capabilityId: string;
  capabilityVersion: string;
  source: {
    providerId: string;
    name: string;
    maintainedBy: string;
    sourceCategory: string;
    summary: string;
    description: string;
    coverage: {
      geographic: string;
      temporal: string;
      granularity: string;
    };
  };
  summary: string;
  description: string;
  provides: string[];
  doesNotProvide: string[];
  selectionHints: string[];
  typicalUseCases: string[];
  sourceDocumentation: DataSourceDocumentation[];
  license: {
    name: string;
    url: string;
    restrictions: string[];
  };
  freshness: {
    kind: string;
    description: string;
  };
  limitations: string[];
  availability?: SuspendedDataCapabilityAvailability | undefined;
  operations: Array<{
    operationId: string;
    summary: string;
    description: string;
  }>;
  discoveryDigest: string;
}

export interface DataCatalogCapability {
  capabilityId: string;
  capabilityVersion: string;
  minimumCliVersion: string;
  providerId: string;
  sourceCategory: string;
  summary: string;
  provides: string[];
  doesNotProvide: string[];
  availability: DataCapabilityAvailability;
  manifestDigest: string;
  discoveryDigest: string;
  operations: Array<{
    operationId: string;
    operationVersion: string;
    summary: string;
    features?: string[] | undefined;
    inputSchemaDigest: string;
    outputSchemaDigest: string;
  }>;
}

export interface DataCatalogResult {
  schemaVersion: typeof DATA_CATALOG_SCHEMA_VERSION;
  capabilities: DataCatalogCapability[];
  catalogDigest: string;
}

export interface DataDescribeResult {
  schemaVersion: typeof DATA_DESCRIBE_SCHEMA_VERSION;
  manifest: DataCapabilityManifest;
  discovery: DataCapabilityDiscovery;
  schemas: Record<string, JsonSchema>;
}

export interface DataDoctorCheck {
  checkId: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: Record<string, JsonValue> | undefined;
}

export interface DataDoctorResult {
  schemaVersion: typeof DATA_DOCTOR_SCHEMA_VERSION;
  capabilityId: string;
  capabilityVersion: string;
  manifestDigest: string;
  mode: "static" | "live";
  status: "ready" | "degraded" | "blocked";
  networkAttempted: boolean;
  checks: DataDoctorCheck[];
}

export interface DataRunRequest {
  schemaVersion: typeof DATA_RUN_REQUEST_SCHEMA_VERSION;
  capabilityId: string;
  capabilityVersion: string;
  operationId: string;
  operationVersion: string;
  input: unknown;
  limits?: DataLimitOverrides | undefined;
  requestId?: string | undefined;
}

export interface DataMissingRange {
  kind: "chunk" | "field" | "file" | "page" | "range";
  identifiers: string[];
}

export interface DataExecutionSummary {
  recordCount: number;
  pageCount: number;
  chunkCount: number;
  truncated: boolean;
  completeness: "complete" | "partial" | "blocked";
  missing?: DataMissingRange[] | undefined;
}

export interface DataSourceObservation {
  observationId: string;
  sourceId: string;
  endpointId: string;
  requestDigest: string;
  responseDigest: string;
  responseBytes: number;
  status: number;
  contentType: string;
  attempts: number;
}

export interface CoreDataReceipt {
  schemaVersion: typeof DATA_RECEIPT_SCHEMA_VERSION;
  cliVersion: string;
  capabilityId: string;
  capabilityVersion: string;
  operationId: string;
  operationVersion: string;
  requestDigest: string;
  manifestDigest: string | null;
  inputSchemaDigest: string | null;
  outputSchemaDigest: string | null;
  inputDigest: string;
  aggregateResponseDigest: string | null;
  normalizedDataDigest: string | null;
  observations: DataSourceObservation[];
  completionStatus: "success" | "partial" | "blocked";
  summary: DataExecutionSummary;
  generatedAt: string;
  receiptDigest: string;
}

export interface DataRunResult {
  schemaVersion: typeof DATA_RUN_RESULT_SCHEMA_VERSION;
  status: "success" | "partial" | "blocked";
  requestId: string | null;
  contract: {
    cliVersion: string;
    capabilityId: string;
    capabilityVersion: string;
    operationId: string;
    operationVersion: string;
    manifestDigest: string | null;
    inputSchema: DataSchemaReference | null;
    outputSchema: DataSchemaReference | null;
  };
  data: unknown | null;
  summary: DataExecutionSummary;
  warnings: string[];
  errors: DataMachineError[];
  receipt: CoreDataReceipt;
}

export interface DataHttpRequest {
  endpointId: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, boolean | number | string | Array<boolean | number | string>> | undefined;
  body?: JsonValue | undefined;
  credentialId?: string | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

export interface DataHttpResponse {
  bytes: Uint8Array;
  safeHeaders: Record<string, string>;
  observation: DataSourceObservation;
  json(): unknown;
  text(): string;
}

export interface DataHttpClient {
  request(request: DataHttpRequest): Promise<DataHttpResponse>;
  configuredSecrets(): string[];
}

export interface DataOperationExecutionContext {
  input: unknown;
  request: DataRunRequest;
  limits: DataExecutionLimits;
  http: DataHttpClient;
  artifacts: DataArtifactSink | null;
}

export interface DataOperationExecution {
  status: "success" | "partial";
  data: unknown;
  summary: DataExecutionSummary;
  warnings: string[];
  errors: DataMachineError[];
  observations: DataSourceObservation[];
}

export interface DataOperationDefinition {
  operationId: string;
  operationVersion: string;
  summary: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  features?: string[] | undefined;
  limits?: Partial<DataExecutionLimits> | undefined;
  artifactOutput?: DataArtifactOutputDeclaration | undefined;
  execute(
    context: DataOperationExecutionContext,
  ): DataOperationExecution | Promise<DataOperationExecution>;
}

export interface DataLiveDoctorContext {
  http: DataHttpClient;
}

export interface DataLiveDoctorExecution {
  status: "ready" | "degraded" | "blocked";
  checks: DataDoctorCheck[];
  networkAttempted?: boolean | undefined;
}

export interface DataConnectorDefinition {
  schemaVersion: typeof DATA_MANIFEST_SCHEMA_VERSION;
  capabilityId: string;
  capabilityVersion: string;
  minimumCliVersion: string;
  provider: {
    providerId: string;
    name: string;
  };
  sourceCategory: string;
  endpoints: DataEndpointScope[];
  license: {
    name: string;
    url: string;
    restrictions: string[];
  };
  credentials: DataCredentialDeclaration[];
  limits: DataExecutionLimits;
  diagnostics: {
    static: true;
    live: boolean;
  };
  availability?: SuspendedDataCapabilityAvailability | undefined;
  freshness: {
    kind: string;
    description: string;
  };
  limitations: string[];
  discovery: {
    source: {
      maintainedBy: string;
      summary: string;
      description: string;
      coverage: {
        geographic: string;
        temporal: string;
        granularity: string;
      };
    };
    summary: string;
    description: string;
    provides: string[];
    doesNotProvide: string[];
    selectionHints: string[];
    typicalUseCases: string[];
    sourceDocumentation: DataSourceDocumentation[];
  };
  operations: DataOperationDefinition[];
  liveDoctor?:
    | ((
        context: DataLiveDoctorContext,
      ) => DataLiveDoctorExecution | Promise<DataLiveDoctorExecution>)
    | undefined;
}

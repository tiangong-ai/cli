import { isIP } from "node:net";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type {
  DataCapabilityDiscovery,
  DataCapabilityManifest,
  DataCatalogCapability,
  DataCatalogResult,
  DataConnectorDefinition,
  DataExecutionLimits,
  DataOperationDefinition,
  DataOperationManifest,
  JsonSchema,
} from "./contracts.js";
import {
  DATA_CATALOG_SCHEMA_VERSION,
  DATA_DISCOVERY_SCHEMA_VERSION,
  DATA_MANIFEST_SCHEMA_VERSION,
} from "./contracts.js";
import { sha256CanonicalJson } from "./runtime/canonical-json.js";
import { DataRuntimeError } from "./runtime/errors.js";
import { validateDataPublicContract } from "./schemas.js";

export interface RegisteredDataOperation {
  definition: DataOperationDefinition;
  manifest: DataOperationManifest;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

export interface RegisteredDataConnector {
  definition: DataConnectorDefinition;
  manifest: DataCapabilityManifest;
  discovery: DataCapabilityDiscovery;
  operations: Map<string, RegisteredDataOperation>;
  schemas: Record<string, JsonSchema>;
}

export class DataRegistry {
  readonly #connectors: Map<string, RegisteredDataConnector>;

  constructor(definitions: readonly DataConnectorDefinition[]) {
    this.#connectors = new Map();
    for (const definition of [...definitions].sort((left, right) =>
      codePointOrder(left.capabilityId, right.capabilityId),
    )) {
      if (this.#connectors.has(definition.capabilityId)) {
        throw new DataRuntimeError(
          "internal-error",
          `Duplicate data capability ID: ${definition.capabilityId}.`,
        );
      }
      const connector = registerConnector(definition);
      this.#connectors.set(definition.capabilityId, connector);
    }
  }

  catalog(): DataCatalogResult {
    const capabilities = [...this.#connectors.values()].map(toCatalogCapability);
    const stable = { schemaVersion: DATA_CATALOG_SCHEMA_VERSION, capabilities };
    const result: DataCatalogResult = {
      ...stable,
      catalogDigest: sha256CanonicalJson(stable),
    };
    validateDataPublicContract("catalog", result);
    return structuredClone(result);
  }

  describe(capabilityId: string): DataCapabilityManifest | undefined {
    const manifest = this.#connectors.get(capabilityId)?.manifest;
    return manifest ? structuredClone(manifest) : undefined;
  }

  discovery(capabilityId: string): DataCapabilityDiscovery | undefined {
    const discovery = this.#connectors.get(capabilityId)?.discovery;
    return discovery ? structuredClone(discovery) : undefined;
  }

  schemas(capabilityId: string): Record<string, JsonSchema> | undefined {
    const schemas = this.#connectors.get(capabilityId)?.schemas;
    return schemas ? structuredClone(schemas) : undefined;
  }

  registered(capabilityId: string): RegisteredDataConnector | undefined {
    return this.#connectors.get(capabilityId);
  }
}

export function createDataRegistry(
  definitions: readonly DataConnectorDefinition[] = [],
): DataRegistry {
  return new DataRegistry(definitions);
}

function registerConnector(source: DataConnectorDefinition): RegisteredDataConnector {
  const definition = cloneAndFreezeConnector(source);
  assertConnectorDefinition(definition);
  const operations = new Map<string, RegisteredDataOperation>();
  const schemaDocuments: Record<string, JsonSchema> = {};
  const operationManifests: DataOperationManifest[] = [];
  const operationDiscoveries: DataCapabilityDiscovery["operations"] = [];
  for (const operation of [...definition.operations].sort((left, right) =>
    codePointOrder(left.operationId, right.operationId),
  )) {
    if (operations.has(operation.operationId)) {
      throw new DataRuntimeError(
        "internal-error",
        `Duplicate operation ID in ${definition.capabilityId}: ${operation.operationId}.`,
      );
    }
    const inputSchemaId = schemaId(operation.inputSchema, "input", operation.operationId);
    const outputSchemaId = schemaId(operation.outputSchema, "output", operation.operationId);
    if (schemaDocuments[inputSchemaId] || schemaDocuments[outputSchemaId]) {
      throw new DataRuntimeError(
        "internal-error",
        `Duplicate operation schema ID in ${definition.capabilityId}.`,
      );
    }
    const limits = mergeLimits(definition.limits, operation.limits);
    const manifest: DataOperationManifest = {
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      inputSchema: {
        schemaId: inputSchemaId,
        digest: sha256CanonicalJson(operation.inputSchema),
      },
      outputSchema: {
        schemaId: outputSchemaId,
        digest: sha256CanonicalJson(operation.outputSchema),
      },
      limits,
      ...(operation.features === undefined
        ? {}
        : { features: [...operation.features].sort(codePointOrder) }),
      ...(operation.artifactOutput === undefined
        ? {}
        : { artifactOutput: structuredClone(operation.artifactOutput) }),
    };
    const inputAjv = operationAjv();
    const outputAjv = operationAjv();
    const validateInput = inputAjv.compile(operation.inputSchema);
    const validateOutput = outputAjv.compile(operation.outputSchema);
    operations.set(operation.operationId, {
      definition: operation,
      manifest,
      validateInput,
      validateOutput,
    });
    schemaDocuments[inputSchemaId] = structuredClone(operation.inputSchema);
    schemaDocuments[outputSchemaId] = structuredClone(operation.outputSchema);
    operationManifests.push(manifest);
    operationDiscoveries.push({
      operationId: operation.operationId,
      summary: operation.summary,
      description: operation.description,
    });
  }

  const stableManifest = {
    schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
    capabilityId: definition.capabilityId,
    capabilityVersion: definition.capabilityVersion,
    minimumCliVersion: definition.minimumCliVersion,
    providerId: definition.provider.providerId,
    endpoints: [...definition.endpoints]
      .sort((left, right) => codePointOrder(left.endpointId, right.endpointId))
      .map((endpoint) => ({
        ...structuredClone(endpoint),
        pathPrefixes: [...endpoint.pathPrefixes].sort(codePointOrder),
        allowedMethods: [...endpoint.allowedMethods].sort(codePointOrder),
        allowedContentTypes: [...endpoint.allowedContentTypes].sort(codePointOrder),
      })),
    credentials: [...definition.credentials]
      .sort((left, right) => codePointOrder(left.credentialId, right.credentialId))
      .map((credential) => ({
        ...structuredClone(credential),
        endpointIds: [...credential.endpointIds].sort(codePointOrder),
      })),
    limits: structuredClone(definition.limits),
    diagnostics: structuredClone(definition.diagnostics),
    ...(definition.availability === undefined
      ? {}
      : {
          availability: {
            status: definition.availability.status,
            reasonCode: definition.availability.reasonCode,
          },
        }),
    operations: operationManifests,
  };
  const published: DataCapabilityManifest = {
    ...stableManifest,
    manifestDigest: sha256CanonicalJson(stableManifest),
  };
  validateDataPublicContract("manifest", published);
  const stableDiscovery = {
    schemaVersion: DATA_DISCOVERY_SCHEMA_VERSION,
    capabilityId: definition.capabilityId,
    capabilityVersion: definition.capabilityVersion,
    source: {
      providerId: definition.provider.providerId,
      name: definition.provider.name,
      maintainedBy: definition.discovery.source.maintainedBy,
      sourceCategory: definition.sourceCategory,
      summary: definition.discovery.source.summary,
      description: definition.discovery.source.description,
      coverage: structuredClone(definition.discovery.source.coverage),
    },
    summary: definition.discovery.summary,
    description: definition.discovery.description,
    provides: [...definition.discovery.provides].sort(codePointOrder),
    doesNotProvide: [...definition.discovery.doesNotProvide].sort(codePointOrder),
    selectionHints: [...definition.discovery.selectionHints].sort(codePointOrder),
    typicalUseCases: [...definition.discovery.typicalUseCases].sort(codePointOrder),
    sourceDocumentation: [...definition.discovery.sourceDocumentation]
      .sort(
        (left, right) =>
          codePointOrder(left.url, right.url) || codePointOrder(left.title, right.title),
      )
      .map((document) => structuredClone(document)),
    license: {
      ...structuredClone(definition.license),
      restrictions: [...definition.license.restrictions].sort(codePointOrder),
    },
    freshness: structuredClone(definition.freshness),
    limitations: [...definition.limitations].sort(codePointOrder),
    ...(definition.availability === undefined
      ? {}
      : { availability: structuredClone(definition.availability) }),
    operations: operationDiscoveries,
  };
  const discovery: DataCapabilityDiscovery = {
    ...stableDiscovery,
    discoveryDigest: sha256CanonicalJson(stableDiscovery),
  };
  validateDataPublicContract("discovery", discovery);
  return {
    definition,
    manifest: published,
    discovery,
    operations,
    schemas: schemaDocuments,
  };
}

function cloneAndFreezeConnector(source: DataConnectorDefinition): DataConnectorDefinition {
  const clone: DataConnectorDefinition = {
    ...source,
    provider: structuredClone(source.provider),
    endpoints: source.endpoints.map((endpoint) => structuredClone(endpoint)),
    license: structuredClone(source.license),
    credentials: source.credentials.map((credential) => structuredClone(credential)),
    limits: structuredClone(source.limits),
    diagnostics: structuredClone(source.diagnostics),
    ...(source.availability === undefined
      ? {}
      : { availability: structuredClone(source.availability) }),
    freshness: structuredClone(source.freshness),
    limitations: [...source.limitations],
    discovery: structuredClone(source.discovery),
    operations: source.operations.map((operation) => ({
      ...operation,
      inputSchema: structuredClone(operation.inputSchema),
      outputSchema: structuredClone(operation.outputSchema),
      ...(operation.features === undefined ? {} : { features: [...operation.features] }),
      ...(operation.limits === undefined ? {} : { limits: structuredClone(operation.limits) }),
      ...(operation.artifactOutput === undefined
        ? {}
        : { artifactOutput: structuredClone(operation.artifactOutput) }),
    })),
  };
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function assertConnectorDefinition(definition: DataConnectorDefinition): void {
  if (definition.schemaVersion !== DATA_MANIFEST_SCHEMA_VERSION) {
    throw new DataRuntimeError("incompatible-contract", "Unsupported data manifest version.");
  }
  if (definition.operations.length === 0) {
    throw new DataRuntimeError("internal-error", "A data connector must define an operation.");
  }
  assertLimits(definition.limits);
  const endpointIds = new Set<string>();
  for (const endpoint of definition.endpoints) {
    if (endpointIds.has(endpoint.endpointId)) {
      throw new DataRuntimeError("internal-error", "Data endpoint IDs must be unique.");
    }
    endpointIds.add(endpoint.endpointId);
    const base = new URL(endpoint.baseUrl);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.pathname !== "/" && base.pathname !== "") ||
      isIP(base.hostname) !== 0
    ) {
      throw new DataRuntimeError(
        "endpoint-policy-blocked",
        "Data endpoint base URLs must be credential-free HTTPS origins with DNS hostnames.",
      );
    }
    if (
      endpoint.pathPrefixes.length === 0 ||
      endpoint.pathPrefixes.some(
        (prefix) => !prefix.startsWith("/") || !prefix.endsWith("/") || prefix.includes("\\"),
      )
    ) {
      throw new DataRuntimeError(
        "endpoint-policy-blocked",
        "Data endpoint path prefixes must be absolute slash-delimited directory prefixes.",
      );
    }
  }
  for (const credential of definition.credentials) {
    if (credential.endpointIds.some((endpointId) => !endpointIds.has(endpointId))) {
      throw new DataRuntimeError(
        "endpoint-policy-blocked",
        "A logical credential references an undeclared endpoint.",
      );
    }
  }
  if (definition.diagnostics.live !== Boolean(definition.liveDoctor)) {
    throw new DataRuntimeError(
      "internal-error",
      "Live doctor support must match the connector diagnostics declaration.",
    );
  }
  if (
    definition.availability &&
    (definition.availability.status !== "suspended" ||
      !definition.availability.reasonCode ||
      !definition.availability.description ||
      definition.availability.resumeCriteria.length === 0)
  ) {
    throw new DataRuntimeError("internal-error", "Suspended capability metadata is invalid.");
  }
  for (const operation of definition.operations) {
    if (
      operation.features &&
      (operation.features.length === 0 ||
        new Set(operation.features).size !== operation.features.length ||
        operation.features.some((feature) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(feature)))
    ) {
      throw new DataRuntimeError("internal-error", "Data operation features are invalid.");
    }
  }
}

function assertLimits(limits: DataExecutionLimits): void {
  const positive = [
    limits.timeoutMs,
    limits.maxRequestBytes,
    limits.maxResponseBytes,
    limits.maxPages,
    limits.maxRecords,
  ];
  const nonNegative = [limits.maxRetries, limits.maxRetryDelayMs, limits.maxRedirects];
  if (
    positive.some((value) => !Number.isInteger(value) || value < 1) ||
    nonNegative.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    throw new DataRuntimeError("internal-error", "Data connector limits are invalid.");
  }
}

function mergeLimits(
  base: DataExecutionLimits,
  override: Partial<DataExecutionLimits> | undefined,
): DataExecutionLimits {
  const merged = { ...base, ...override };
  assertLimits(merged);
  for (const key of Object.keys(base) as Array<keyof DataExecutionLimits>) {
    if (merged[key] > base[key]) {
      throw new DataRuntimeError(
        "internal-error",
        `Operation limit ${key} cannot exceed its capability limit.`,
      );
    }
  }
  return merged;
}

function schemaId(schema: JsonSchema, direction: string, operationId: string): string {
  const id = schema.$id;
  if (typeof id !== "string" || !id.trim()) {
    throw new DataRuntimeError(
      "internal-error",
      `The ${operationId} ${direction} schema must declare a stable $id.`,
    );
  }
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new DataRuntimeError(
      "incompatible-contract",
      `The ${operationId} ${direction} schema must use JSON Schema 2020-12.`,
    );
  }
  return id;
}

function operationAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
}

function toCatalogCapability(connector: RegisteredDataConnector): DataCatalogCapability {
  const manifest = connector.manifest;
  const discovery = connector.discovery;
  return {
    capabilityId: manifest.capabilityId,
    capabilityVersion: manifest.capabilityVersion,
    minimumCliVersion: manifest.minimumCliVersion,
    providerId: manifest.providerId,
    sourceCategory: discovery.source.sourceCategory,
    summary: discovery.summary,
    provides: [...discovery.provides],
    doesNotProvide: [...discovery.doesNotProvide],
    availability: definitionAvailability(connector),
    manifestDigest: manifest.manifestDigest,
    discoveryDigest: discovery.discoveryDigest,
    operations: manifest.operations.map((operation) => ({
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      summary:
        discovery.operations.find((item) => item.operationId === operation.operationId)?.summary ??
        operation.operationId,
      ...(operation.features === undefined ? {} : { features: [...operation.features] }),
      inputSchemaDigest: operation.inputSchema.digest,
      outputSchemaDigest: operation.outputSchema.digest,
    })),
  };
}

function definitionAvailability(connector: RegisteredDataConnector) {
  const suspended = connector.definition.availability;
  return suspended
    ? structuredClone(suspended)
    : {
        status: "available" as const,
        reasonCode: null,
        description: null,
        resumeCriteria: [],
      };
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

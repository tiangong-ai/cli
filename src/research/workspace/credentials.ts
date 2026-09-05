import { lstat, readFile } from "node:fs/promises";

import { builtInDataRegistry } from "../../data/builtins.js";
import type { DataRegistry } from "../../data/catalog.js";
import { CliError } from "../../errors.js";
import { isObject, pathExists, workspacePaths, writeTextAtomic } from "./storage.js";
import type { CapabilityDeclaration } from "./types.js";

const CREDENTIAL_ENV_KEY = "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON";
const MAX_CREDENTIAL_ENV_BYTES = 64 * 1024;

export function researchDataCredentialId(capabilityId: string, credentialId: string): string {
  return `data:${capabilityId}:${credentialId}`;
}

export function researchDataCredentialIds(registry: DataRegistry = builtInDataRegistry): string[] {
  return [
    ...new Set(
      registry
        .catalog()
        .capabilities.filter((capability) => capability.availability.status === "available")
        .flatMap((capability) =>
          (registry.describe(capability.capabilityId)?.credentials ?? []).map((credential) =>
            researchDataCredentialId(capability.capabilityId, credential.credentialId),
          ),
        ),
    ),
  ].sort();
}

export async function loadCapabilityCredentialMap(
  root: string,
  capabilities: CapabilityDeclaration[],
  options: { ignoreUndeclared?: boolean } = {},
): Promise<Map<string, string>> {
  return loadCapabilityCredentialMapForIds(
    root,
    [
      ...capabilities.flatMap((capability) =>
        capability.credentials.map((credential) => credential.id),
      ),
      ...researchDataCredentialIds(),
    ],
    options,
  );
}

export async function loadCapabilityCredentialMapForIds(
  root: string,
  declaredCredentialIds: readonly string[],
  options: { ignoreUndeclared?: boolean } = {},
): Promise<Map<string, string>> {
  const path = workspacePaths(root).env;
  if (!(await pathExists(path))) return new Map();
  const info = await lstat(path).catch(() => {
    throw credentialEnvironmentError("credential environment cannot be inspected");
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw credentialEnvironmentError("credential environment must be a regular non-symlink file");
  }
  if (info.size > MAX_CREDENTIAL_ENV_BYTES) {
    throw credentialEnvironmentError("credential environment exceeds the maximum supported size");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw credentialEnvironmentError("credential environment must have owner-only permissions");
  }
  const declared = new Set(declaredCredentialIds);
  const configured = new Map<string, string>();
  let foundConfiguration = false;
  const content = await readFile(path, "utf8").catch(() => {
    throw credentialEnvironmentError("credential environment cannot be read");
  });
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals).trim() : "";
    if (key !== CREDENTIAL_ENV_KEY) {
      throw credentialEnvironmentError(`unsupported research environment key: ${key || "missing"}`);
    }
    if (foundConfiguration) {
      throw credentialEnvironmentError("research credential configuration is duplicated");
    }
    foundConfiguration = true;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(equals + 1).trim() || "{}") as unknown;
    } catch {
      throw credentialEnvironmentError("capability credential JSON is invalid");
    }
    if (!isObject(value)) {
      throw credentialEnvironmentError("capability credentials must be a JSON object");
    }
    for (const [credentialId, credentialValue] of Object.entries(value)) {
      if (!declared.has(credentialId) && !options.ignoreUndeclared) {
        throw credentialEnvironmentError(`credential is not declared: ${credentialId}`);
      }
      if (typeof credentialValue !== "string" || Buffer.byteLength(credentialValue, "utf8") < 8) {
        throw credentialEnvironmentError(`credential value is invalid: ${credentialId}`);
      }
      if (!declared.has(credentialId)) continue;
      configured.set(credentialId, credentialValue);
    }
  }
  return configured;
}

export async function reconcileCapabilityCredentialEnvironment(
  root: string,
  capabilities: CapabilityDeclaration[],
): Promise<{ configuredCredentialIds: string[] }> {
  const path = workspacePaths(root).env;
  if (!(await pathExists(path))) return { configuredCredentialIds: [] };
  const configured = await loadCapabilityCredentialMap(root, capabilities, {
    ignoreUndeclared: true,
  });
  const serialized = Object.fromEntries(
    [...configured.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeTextAtomic(path, `${CREDENTIAL_ENV_KEY}=${JSON.stringify(serialized)}\n`, 0o600);
  return { configuredCredentialIds: [...configured.keys()].sort() };
}

export async function inspectCapabilityCredentialEnvironment(
  root: string,
  capabilities: CapabilityDeclaration[],
): Promise<{
  detail: string;
  configuredIds: string[];
  missingIds: string[];
}> {
  const declaredIds = [
    ...new Set(
      capabilities.flatMap((capability) =>
        capability.credentials.map((credential) => credential.id),
      ),
    ),
  ].sort();
  const configured = await loadCapabilityCredentialMap(root, capabilities);
  const configuredIds = [...configured.keys()].filter((id) => declaredIds.includes(id)).sort();
  const missingIds = declaredIds.filter((credentialId) => !configured.has(credentialId));
  const detail =
    declaredIds.length === 0
      ? "not configured; no credentials declared"
      : missingIds.length === 0
        ? `${configuredIds.length} declared credential value(s) configured with owner-only permissions`
        : `${missingIds.length}/${declaredIds.length} declared credential value(s) missing`;
  return { detail, configuredIds, missingIds };
}

export async function setCapabilityCredentialFromEnvironment(input: {
  root: string;
  capabilities: CapabilityDeclaration[];
  credentialId: string;
  environmentName: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{
  credentialId: string;
  sourceEnvironmentName: string;
  configured: true;
  configuredCredentialIds: string[];
}> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.environmentName)) {
    throw credentialConfigurationError("credential source environment name is invalid");
  }
  const value = input.environment[input.environmentName];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 8) {
    throw credentialConfigurationError(
      `credential source environment variable is missing or too short: ${input.environmentName}`,
    );
  }
  const result = await setCapabilityCredentialValue({
    root: input.root,
    declaredCredentialIds: [
      ...input.capabilities.flatMap((capability) =>
        capability.credentials.map((credential) => credential.id),
      ),
      ...researchDataCredentialIds(),
    ],
    credentialId: input.credentialId,
    value,
    minimumUtf8Bytes: 8,
  });
  return {
    credentialId: input.credentialId,
    sourceEnvironmentName: input.environmentName,
    configured: true,
    configuredCredentialIds: result.configuredCredentialIds,
  };
}

export async function setCapabilityCredentialValue(input: {
  root: string;
  declaredCredentialIds: readonly string[];
  credentialId: string;
  value: string;
  minimumUtf8Bytes: number;
  ignoreUndeclaredExisting?: boolean;
}): Promise<{
  credentialId: string;
  configured: true;
  configuredCredentialIds: string[];
}> {
  const declared = new Set(input.declaredCredentialIds);
  if (!declared.has(input.credentialId)) {
    throw credentialConfigurationError(`credential is not declared: ${input.credentialId}`);
  }
  if (
    typeof input.value !== "string" ||
    Buffer.byteLength(input.value, "utf8") < input.minimumUtf8Bytes
  ) {
    throw credentialConfigurationError("credential value is missing or too short");
  }
  const configured = await loadCapabilityCredentialMapForIds(
    input.root,
    input.declaredCredentialIds,
    { ignoreUndeclared: input.ignoreUndeclaredExisting === true },
  );
  configured.set(input.credentialId, input.value);
  const serialized = Object.fromEntries(
    [...configured.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeTextAtomic(
    workspacePaths(input.root).env,
    `${CREDENTIAL_ENV_KEY}=${JSON.stringify(serialized)}\n`,
    0o600,
  );
  return {
    credentialId: input.credentialId,
    configured: true,
    configuredCredentialIds: [...configured.keys()].sort(),
  };
}

function credentialConfigurationError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID",
    exitCode: 3,
  });
}

function credentialEnvironmentError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_CAPABILITY_CREDENTIAL_ENV_INVALID",
    exitCode: 3,
  });
}

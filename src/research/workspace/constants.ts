import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESEARCH_CONTROL_DIRECTORY = ".tiangong-research";
export const RESEARCH_PROTOCOL_VERSION = 1 as const;
export const RESEARCH_PACKAGE_NAME = "@tiangong-ai/cli" as const;
export const SETUP_UPGRADING_MARKER = "tiangong-research-workspace-upgrading";

export const ALLOWED_CAPABILITY_PERMISSIONS = new Set([
  "project-read",
  "candidate-write",
  "brokered-network",
  "controlled-command",
]);

export const WORKSPACE_OPERATIONS = [
  "research.context.inspect",
  "research.workspace.doctor",
  "research.capability.catalog",
  "research.capability.configure",
  "research.capability.import",
  "research.capability.doctor",
  "research.capability.credential.set",
  "research.capability.lock",
  "research.capability.verify",
  "research.project.init",
  "research.project.preflight",
  "research.project.input.add",
  "research.project.retry",
  "research.project.fork",
  "research.schema.show",
  "research.status",
  "research.run",
  "research.setup.catalog",
  "research.setup.plan",
  "research.setup.apply",
  "research.setup.status",
  "research.setup.doctor",
  "research.setup.credential.set",
  "research.setup.retry",
  "research.setup.update",
  "research.setup.upgrade",
] as const;

export const SETUP_OPERATIONS = [
  "research.context.inspect",
  "research.setup.catalog",
  "research.setup.plan",
  "research.setup.apply",
  "research.setup.status",
  "research.setup.retry",
] as const;

export const UNMANAGED_OPERATIONS = [
  "research.context.inspect",
  "research.capability.catalog",
  "research.workspace.init",
  "research.setup.catalog",
  "research.setup.plan",
] as const;

export const INVALID_OPERATIONS = ["research.context.inspect"] as const;

export function packageVersion(): string {
  const packagePath = resolve(packageRoot(), "package.json");
  const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Package version is unavailable.");
  }
  return value.version;
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

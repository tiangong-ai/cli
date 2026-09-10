import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../../errors.js";
import { sha256File, workspacePaths } from "./storage.js";
import { readTaskObject, taskDirectory } from "./task-contract.js";
import type { OutputRecord } from "./types.js";

/** Operation-scoped immutable-object access, shared with indexed portable audit. */
export interface InvestigationReadStore {
  readTask<T>(projectId: string, group: string, hash: string, field: string): Promise<T>;
  verifyBlob(projectId: string, object: OutputRecord): Promise<void>;
  readBlob(projectId: string, object: OutputRecord, maxBytes: number): Promise<Buffer>;
}
export function assertInvestigationBlob(object: OutputRecord): void {
  if (
    !object ||
    typeof object.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.sha256) ||
    object.path !== `task/run-objects/${object.sha256}` ||
    !Number.isSafeInteger(object.bytes) ||
    object.bytes < 0
  )
    throw new CliError("Investigation blob address is invalid.", {
      code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
      exitCode: 3,
    });
}
export function localInvestigationReadStore(root: string): InvestigationReadStore {
  const verified = new Set<string>();
  const directories = new Set<string>();
  const store: InvestigationReadStore = {
    readTask: <T>(projectId: string, group: string, hash: string, field: string) =>
      readTaskObject<T>(root, projectId, group, hash, field),
    verifyBlob: async (projectId, object) => {
      assertInvestigationBlob(object);
      const key = `${projectId}/${object.sha256}/${object.bytes}`;
      if (verified.has(key)) return;
      if (!directories.has(projectId)) {
        await taskDirectory(root, projectId, "run-objects", false);
        directories.add(projectId);
      }
      const path = join(workspacePaths(root).projects, projectId, object.path),
        info = await lstat(path).catch(() => null);
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.size !== object.bytes ||
        (await sha256File(path)) !== object.sha256
      )
        throw new CliError("Investigation blob bytes changed.", {
          code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
          exitCode: 3,
        });
      verified.add(key);
    },
    readBlob: async (projectId, object, maxBytes) => {
      await store.verifyBlob(projectId, object);
      if (object.bytes > maxBytes)
        throw new CliError("Investigation object exceeds this read's explicit byte limit.", {
          code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
          exitCode: 3,
        });
      return readFile(join(workspacePaths(root).projects, projectId, object.path));
    },
  };
  return store;
}

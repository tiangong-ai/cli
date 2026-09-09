import type { SetupCommandRunner } from "./setup.js";

export type ResearchCliReleaseStatus = "newer" | "same" | "older" | "unavailable";

export type ResearchCliReleaseMetadata = {
  version: string;
  integrity: string;
  tarball: string;
  gitHead: string;
};

export type ResearchCliReleaseInspection = {
  status: ResearchCliReleaseStatus;
  packageName: string;
  requestedVersion: string;
  installedVersion: string;
  registry: string;
  metadata: ResearchCliReleaseMetadata | null;
  reason: string | null;
};

export async function inspectExactResearchCliRelease(
  candidateVersion: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    runner?: SetupCommandRunner;
    installedVersion: string;
  },
): Promise<ResearchCliReleaseInspection> {
  void candidateVersion;
  void options;
  throw new Error(
    "setup-release inspection is not implemented yet: tests-first stub awaiting RED observation.",
  );
}

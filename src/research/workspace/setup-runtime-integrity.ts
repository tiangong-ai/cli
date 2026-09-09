import { join } from "node:path";
import { CliError } from "../../errors.js";
import { packageRoot } from "./constants.js";
import { canonicalJson, hashRegularTree, sha256File, sha256Text } from "./storage.js";

// Upgrade-only binding of the CLI's declared package identity and executable
// distribution. Excludes node_modules, source checkout, caches, and owner data.
// This is content integrity, not a publisher signature or dependency attestation.
export async function researchSetupRuntimeSha256(): Promise<string> {
  const root = packageRoot();
  const [manifest, bin, dist] = await Promise.all([
    sha256File(join(root, "package.json")),
    hashRegularTree(join(root, "bin")),
    hashRegularTree(join(root, "dist")),
  ]);
  return sha256Text(
    canonicalJson({ algorithm: "cli-package-bin-dist-sha256-v1", manifest, bin, dist }),
  );
}

export async function assertResearchSetupRuntimeIntegrity(expected: string): Promise<void> {
  const observed = await researchSetupRuntimeSha256();
  if (observed !== expected) {
    throw new CliError("The running CLI bytes differ from the reviewed upgrade candidate.", {
      code: "RESEARCH_SETUP_CLI_INTEGRITY_MISMATCH",
      exitCode: 3,
      details: {
        expectedSha256: expected,
        observedSha256: observed,
        minimumAction:
          "Use the exact reviewed CLI distribution, or generate and review a fresh candidate with the selected distribution. Do not rewrite the existing candidate.",
      },
    });
  }
}

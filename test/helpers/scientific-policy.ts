import { join } from "node:path";
import { writeTextAtomic } from "../../src/research/workspace/storage.js";
import {
  initializeResearchPolicy,
  approveResearchPolicy,
  loadApprovedResearchPolicy,
} from "../../src/research/workspace/research-policy.js";
import type { ResearchPolicyBinding } from "../../src/research/workspace/types.js";

export async function syntheticScientificPolicy(
  root: string,
  projectId: string,
  rules = ["uncertainty-propagated", "robustness-and-uncertainty-reviewed"],
): Promise<ResearchPolicyBinding> {
  const sourceRoot = join(root, "synthetic-policy");
  const reviewerRoles = ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"];
  const documents = [
    ["baseline/top-journal.md", "baseline", "bundled-default"],
    ["article-types/computational-modeling.md", "article-type", "bundled-default"],
    ["fields/pavement-engineering.md", "field", "bundled-default"],
    ["journal-classes/discipline-flagship.md", "journal-class", "bundled-default"],
    ...reviewerRoles.map((role) => [
      `reviewer-rubrics/${role}.md`,
      "reviewer-rubric",
      "bundled-default",
    ]),
    ["project/publication-brief.md", "publication-brief", "project-template"],
    ["journals/exact-journal-template.md", "exact-journal", "exact-journal-template"],
  ];
  for (const [path, kind, templateClass] of documents) {
    const metadata = {
      schemaVersion: 1,
      id: `fixture.${path!.replaceAll("/", ".").replace(/\.md$/, "")}`,
      kind,
      templateClass,
      policyVersion: 1,
      targetTier: "top",
      articleType: "computational-modeling",
      field: "pavement-engineering",
      journalClass: "discipline-flagship",
      targetJournal: "none",
      centralQuestion:
        "Can a frozen source parameter be filled without changing its scientific identity?",
      centralClaim: "Protocol behavior is validated using explicitly synthetic sources.",
      centralOutcome: "Correct hash and parameter bindings, not a scientific estimate.",
      contributionType: "protocol-fixture",
      rules,
      constraints: {
        requireScientificDesignContract: true,
        requireEarlyScientificReviews: true,
        requireRealRecordConstructCanary: true,
      },
      requiredReviewers: reviewerRoles,
      reviewAfterDays: 365,
    };
    await writeTextAtomic(
      join(sourceRoot, "assets/research-policy/defaults", path!),
      `---\n${JSON.stringify(metadata)}\n---\n\n# Synthetic policy\n\nZero-cost deterministic protocol fixture, not journal approval.\n`,
    );
  }
  await initializeResearchPolicy({
    root,
    projectId,
    sourceRoot,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
  });
  await approveResearchPolicy(root, projectId, { confirm: true, acknowledgeDefaults: true });
  return loadApprovedResearchPolicy(root, projectId);
}

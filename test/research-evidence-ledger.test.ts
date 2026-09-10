import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
  registerBrokerCandidates,
  verifyEvidenceLedger,
} from "../src/research/workspace/evidence-ledger.js";
import { parseStructuredStageOutput, schemaForStage } from "../src/research/workspace/schemas.js";
import type { BrokerEvidenceReceipt } from "../src/research/workspace/evidence.js";
import { deriveDiscoveryPlan } from "../src/research/workspace/discovery-planning.js";
import type {
  ProjectEvidenceRequirements,
  WorkspaceConfig,
} from "../src/research/workspace/types.js";

describe("research evidence ledger", () => {
  it("deduplicates concurrent broker receipts without losing their occurrences", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-concurrent-candidates-"));
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, id) =>
          registerBrokerCandidates({
            root,
            projectId: "ledger-project",
            receipt: receipt(`parallel-${id}`, "2026-08-11T00:00:00.000Z"),
            contextBytes: Buffer.from(
              JSON.stringify([{ title: "Shared paper", url: "https://example.test/paper" }]),
            ),
          }),
        ),
      );
      const candidates = await listEvidenceCandidates(root, "ledger-project");
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!.occurrences.length, 8);
      assert.equal((await verifyEvidenceLedger(root, "ledger-project")).events, 8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records stable broker candidates and deduplicates equivalent URLs across receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-evidence-ledger-"));
    try {
      const first = await registerBrokerCandidates({
        root,
        projectId: "ledger-project",
        receipt: receipt("attempt-one", "2026-08-11T00:00:00.000Z"),
        selectedJsonPointer: "/results",
        itemOffset: 0,
        contextBytes: Buffer.from(
          JSON.stringify([
            {
              title: "Measured result",
              url: "https://example.test/paper?utm_source=search&token=must-not-persist",
              description: "A bounded result.",
              page_age: "2026-07-01T00:00:00Z",
            },
          ]),
        ),
      });
      const second = await registerBrokerCandidates({
        root,
        projectId: "ledger-project",
        receipt: receipt("attempt-two", "2026-08-11T00:01:00.000Z"),
        selectedJsonPointer: "/results",
        itemOffset: 4,
        contextBytes: Buffer.from(
          JSON.stringify([
            {
              title: "Measured result duplicate",
              url: "https://EXAMPLE.test/paper?utm_medium=news",
              description: "A duplicate discovery path.",
            },
          ]),
        ),
      });

      assert.equal(first.length, 1);
      assert.equal(second.length, 1);
      assert.equal(second[0]?.id, first[0]?.id);
      assert.equal(first[0]?.url, "https://example.test/paper");
      assert.equal(first[0]?.origin.jsonPointer, "/results/0");
      assert.equal(second[0]?.origin.jsonPointer, "/results/4");
      const candidates = await listEvidenceCandidates(root, "ledger-project");
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.occurrences.length, 2);
      const ledger = await readFile(evidenceLedgerPath(root, "ledger-project"), "utf8");
      assert.match(ledger, /candidate\.discovered/);
      assert.match(ledger, /candidate\.duplicate/);
      assert.doesNotMatch(ledger, /must-not-persist|token=/);
      assert.deepEqual(await verifyEvidenceLedger(root, "ledger-project"), {
        events: 2,
        candidates: 1,
        head: JSON.parse(ledger.trim().split("\n").at(-1)!).hash,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts distinct SCI candidates from content plus Markdown source citations", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-evidence-ledger-sci-"));
    try {
      const candidates = await registerBrokerCandidates({
        root,
        projectId: "ledger-project",
        receipt: receipt("attempt-sci", "2026-08-11T00:00:00.000Z"),
        contextBytes: Buffer.from(
          JSON.stringify([
            {
              content: "First bounded full-text excerpt.",
              source:
                "[AI-assisted code review effectiveness, SOFTWARE QUALITY JOURNAL. Ada Author. 2025-04.](https://doi.org/10.1000/first-paper)",
            },
            {
              content: "Second bounded full-text excerpt.",
              source:
                "[Human oversight in automated review, EMPIRICAL SOFTWARE ENGINEERING. Ben Author. 2024.](https://doi.org/10.1000/second-paper)",
            },
          ]),
        ),
      });

      assert.equal(candidates.length, 2);
      assert.notEqual(candidates[0]?.id, candidates[1]?.id);
      assert.deepEqual(
        candidates.map((candidate) => candidate.doi),
        ["10.1000/first-paper", "10.1000/second-paper"],
      );
      assert.deepEqual(
        candidates.map((candidate) => candidate.publicationDate),
        ["2025-04", "2024"],
      );
      assert.deepEqual(
        candidates.map((candidate) => candidate.excerpt),
        ["First bounded full-text excerpt.", "Second bounded full-text excerpt."],
      );
      assert.ok(candidates.every((candidate) => candidate.title !== "Untitled candidate"));
      assert.equal((await listEvidenceCandidates(root, "ledger-project")).length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects append-only ledger tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-evidence-ledger-tamper-"));
    try {
      await appendEvidenceLedgerEvent(root, "ledger-project", "candidate.rejected", {
        candidateId: "candidate-1",
        reasonCode: "out-of-scope",
        rationale: "Not relevant.",
      });
      await appendFile(evidenceLedgerPath(root, "ledger-project"), "{}\n");
      await assert.rejects(
        verifyEvidenceLedger(root, "ledger-project"),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_EVIDENCE_LEDGER_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an incremental discovery closeout instead of one source-sized final container", () => {
    const schema = schemaForStage("discover");
    assert.equal(schema.$id, "https://schemas.tiangong.ai/research/discovery-closeout-v2.json");
    const parsed = parseStructuredStageOutput(
      "discover",
      JSON.stringify({
        schemaVersion: 2,
        limitations: ["Full texts require acquisition."],
        dimensionJudgments: [{ id: "empirical-evidence", status: "covered" }],
        gaps: ["No counterevidence acquired yet."],
      }),
    );
    assert.equal(parsed.value.schemaVersion, 2);
    assert.equal("admissions" in parsed.value, false);
    assert.equal("rejections" in parsed.value, false);
  });

  it("derives call, batch, and output budgets from reviewed coverage requirements", () => {
    const requirements: ProjectEvidenceRequirements = {
      dimensions: ["effects", "mechanisms", "conditions", "limitations", "counterevidence"],
      sourceTypes: ["academic", "official", "industry", "news"],
      requiredCapabilityIds: ["method.web", "method.news", "method.database"],
      requiredCompanionIds: [],
      requiredDiscoveryScopes: ["public-internet", "database:research"],
      minSources: 30,
      minFullTextSources: 8,
      minDatedSources: 20,
      publicationDateFrom: "2024-01-01",
      publicationDateTo: "2026-08-11",
    };
    const config = {
      budget: {
        maxBrokerCalls: 24,
        maxBrokerItems: 100,
        maxOutputTokens: 6_000,
        maxRepairTokens: 1_000,
        maxBrokerContextTokens: 24_000,
        maxInputContextTokens: 24_000,
        packageMaxTokens: { discover: 300_000 },
      },
    } as unknown as WorkspaceConfig;
    const plan = deriveDiscoveryPlan(requirements, config, [
      "method.web",
      "method.news",
      "method.database",
      "method.supplemental",
    ]);
    assert.equal(plan.targetUniqueSources, 30);
    assert.ok(plan.maxCalls >= 8, JSON.stringify(plan));
    assert.ok(plan.maxCalls < config.budget.maxBrokerCalls);
    assert.ok(plan.recommendedOutputTokens <= config.budget.maxOutputTokens);
    assert.equal(plan.outputTokenLimit, plan.recommendedOutputTokens);
    assert.deepEqual(plan.requiredFirstPassCapabilityIds, [
      "method.database",
      "method.news",
      "method.web",
    ]);
    assert.ok(plan.plannedBatches.length >= 2);
    assert.ok(plan.reservedDiscoverTokens <= config.budget.packageMaxTokens.discover);
  });

  it("reserves enough focused search and gap-fill views for heterogeneous production work", () => {
    const requirements: ProjectEvidenceRequirements = {
      dimensions: [
        "academic-evidence",
        "official-data",
        "government-policy",
        "competitive-landscape",
        "counterevidence",
      ],
      sourceTypes: ["academic", "news", "government", "official-data", "competitive-research"],
      requiredCapabilityIds: ["method.web", "method.news", "method.database"],
      requiredCompanionIds: ["tiangong.academic-paper-download"],
      requiredDiscoveryScopes: ["public-internet", "database:research"],
      minSources: 15,
      minFullTextSources: 5,
      minDatedSources: 10,
      publicationDateFrom: "2024-01-01",
      publicationDateTo: "2026-08-11",
    };
    const config = {
      budget: {
        maxBrokerCalls: 24,
        maxBrokerItems: 100,
        maxOutputTokens: 6_000,
        maxRepairTokens: 1_000,
        maxBrokerContextTokens: 12_000,
        maxInputContextTokens: 12_000,
        packageMaxTokens: { discover: 300_000 },
      },
    } as unknown as WorkspaceConfig;
    const plan = deriveDiscoveryPlan(requirements, config, [
      "method.web",
      "method.news",
      "method.database",
    ]);

    assert.ok(plan.maxCalls >= 12, JSON.stringify(plan));
    assert.ok(plan.maxCalls <= plan.hardCallLimit);
    assert.ok(
      plan.plannedBatches.some(
        (batch) => batch.kind === "gap-fill" && batch.maxCalls >= requirements.sourceTypes.length,
      ),
      JSON.stringify(plan),
    );
  });
});

function receipt(attemptId: string, retrievedAt: string): BrokerEvidenceReceipt {
  const sha256 = "a".repeat(64);
  const contextSha256 = "b".repeat(64);
  return {
    schemaVersion: 1,
    attemptId,
    projectId: "ledger-project",
    capabilityId: "method.test-search",
    credentialId: null,
    status: 200,
    contentType: "application/json",
    bytes: 1,
    sha256,
    sourceSha256: "c".repeat(64),
    locator: `evidence/objects/aa/${sha256}`,
    contextLocator: `evidence/objects/bb/${contextSha256}`,
    contextSha256,
    contextBytes: 1,
    contextEstimatedTokens: 1,
    contextItems: 1,
    contextOffset: 0,
    contextTotalItems: 1,
    contextNextOffset: null,
    contextTruncated: false,
    redactions: 0,
    retrievedAt,
    servedAt: retrievedAt,
    cacheHit: false,
  };
}

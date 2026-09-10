import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import {
  closePublication,
  freezePublicationManuscript,
  inspectPublicationStatus,
  preparePublicationReview,
  submitPublicationReview,
  type PublicationReviewRole,
  type PublicationSubmissionRole,
} from "../src/research/workspace/publication-workflow.js";
import type { PublicationAssessment } from "../src/research/workspace/publication.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import {
  approveResearchPolicy,
  completeResearchExactJournalPolicy,
  completeResearchPublicationBrief,
  initializeResearchPolicy,
  loadApprovedResearchPolicy,
} from "../src/research/workspace/research-policy.js";
import {
  canonicalJson,
  fileRecord,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { defineProjectTask } from "../src/research/workspace/task-contract.js";
import {
  passEvidenceConstructGate,
  passPilotMethodsGate,
  passResearchDesignGate,
  scientificEvidenceSnapshotSources,
  scientificDesignInput,
} from "./helpers/scientific-design.js";

const REVIEW_ROLES: PublicationReviewRole[] = [
  "evidence",
  "methods-reproducibility",
  "domain-novelty",
  "journal-editor",
];

describe("top-journal publication workflow", () => {
  it("rejects a report changed after the mechanical base closure", async () => {
    const fixture = await publicationFixture("stale-closed-report");
    try {
      const outputs = join(workspacePaths(fixture.root).projects, fixture.projectId, "outputs");
      const closurePath = join(outputs, "closure.json");
      const closure = JSON.parse(await readFile(closurePath, "utf8"));
      closure.artifacts = await Promise.all(
        ["analysis.json", "report.md"].map((name) =>
          fileRecord(join(outputs, name), `outputs/${name}`),
        ),
      );
      await writeJsonAtomic(closurePath, closure);
      await writeFile(join(outputs, "report.md"), "# Unreviewed corrected report B\n");
      await assert.rejects(
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles,
          resultLineage: await fixtureResultLineage(fixture),
          producerAgent: "codex",
          producerSessionId: "stale-report-producer",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      );
      closure.artifacts = await Promise.all(
        ["analysis.json", "report.md"].map((name) =>
          fileRecord(join(outputs, name), `outputs/${name}`),
        ),
      );
      await writeJsonAtomic(closurePath, closure);
      await assert.rejects(
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles,
          resultLineage: await fixtureResultLineage(fixture),
          producerAgent: "codex",
          producerSessionId: "stale-reviewed-report",
        }),
        (error: unknown) => {
          assert.equal(errorCode(error), "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE");
          assert.equal(
            (error as { details: { binding: string } }).details.binding,
            "review-packet",
          );
          return true;
        },
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects prepared generation B materials against individually valid generation A analysis", async () => {
    const fixture = await publicationFixture("mixed-result-generations");
    try {
      const outputs = join(workspacePaths(fixture.root).projects, fixture.projectId, "outputs");
      const names = ["analysis.json", "claim-evidence-graph.json", "report.md", "closure.json"];
      const original = new Map(
        await Promise.all(
          names.map(async (name) => [name, await readFile(join(outputs, name), "utf8")] as const),
        ),
      );
      const analysis = JSON.parse(original.get("analysis.json")!);
      analysis.analysisRun.id = "publication-fixture-run-b";
      analysis.findings[0].statement = "The corrected central outcome was two units.";
      await writeJsonAtomic(join(outputs, "analysis.json"), analysis);
      const graph = JSON.parse(original.get("claim-evidence-graph.json")!);
      graph.analysisRunId = analysis.analysisRun.id;
      graph.analysisSha256 = sha256Text(await readFile(join(outputs, "analysis.json"), "utf8"));
      for (const node of graph.nodes) {
        if (node.type === "analysis-run") {
          node.id = `analysis-run:${analysis.analysisRun.id}`;
          node.label = analysis.analysisRun.id;
        }
        if (node.id === "finding:finding-central") {
          node.label = analysis.findings[0].statement;
          node.sha256 = sha256Text(canonicalJson(analysis.findings[0]));
        }
      }
      for (const edge of graph.edges) {
        if (edge.type === "finding-produced-by-analysis-run")
          edge.to = `analysis-run:${analysis.analysisRun.id}`;
      }
      delete graph.graphSha256;
      await writeJsonAtomic(join(outputs, "claim-evidence-graph.json"), {
        ...graph,
        graphSha256: sha256Text(canonicalJson(graph)),
      });
      await writeFile(
        join(outputs, "report.md"),
        "# Corrected generation B report\n\nThe outcome was two units.\n",
      );
      await writeFile(fixture.supplement, "measure,value\noutcome,2\n");
      await writeFile(
        fixture.manuscript,
        `${await readFile(fixture.manuscript, "utf8")}\nCorrected result generation B: two units.\n`,
      );
      const assessment = JSON.parse(await readFile(fixture.assessment, "utf8"));
      assessment.results[0].statement = analysis.findings[0].statement;
      await writeJsonAtomic(fixture.assessment, assessment);
      await recordFixtureClosureLineage(fixture.root, fixture.projectId);
      const resultLineage = {
        schemaVersion: 1,
        projectId: fixture.projectId,
        analysisRunId: analysis.analysisRun.id,
        analysisSha256: graph.analysisSha256,
        claimEvidenceGraphSha256: sha256Text(
          await readFile(join(outputs, "claim-evidence-graph.json"), "utf8"),
        ),
        reportSha256: sha256Text(await readFile(join(outputs, "report.md"), "utf8")),
        files: await Promise.all(
          [
            { role: "manuscript", path: fixture.manuscript },
            { role: "assessment", path: fixture.assessment },
            ...fixture.submissionFiles,
          ].map(async (file) => ({
            role: file.role,
            analysisSha256: graph.analysisSha256,
            sha256: sha256Text(await readFile(file.path, "utf8")),
          })),
        ),
      };
      await writeJsonAtomic(fixture.submissionManifest, {
        schemaVersion: 1,
        files: fixture.submissionFiles,
        resultLineage,
      });
      const freeze = async () =>
        invokeCli([
          "research",
          "publication",
          "freeze",
          fixture.projectId,
          "--manuscript",
          fixture.manuscript,
          "--assessment",
          fixture.assessment,
          "--submission",
          fixture.submissionManifest,
          "--producer-agent",
          "codex",
          "--producer-session",
          "synthetic-generation-producer",
          "--workspace",
          fixture.root,
          "--json",
        ]);
      const validB = await freeze();
      assert.equal(validB.exitCode, 0, validB.stderr);
      for (const [name, content] of original) await writeFile(join(outputs, name), content);
      const mixed = await freeze();
      assert.equal(
        mixed.exitCode,
        3,
        "B material lineage must not silently bind to restored A analysis",
      );
      assert.equal(
        JSON.parse(mixed.stderr).error.code,
        "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      );
      await assert.rejects(
        inspectPublicationStatus(fixture.root, fixture.projectId),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      );
      const status = await invokeCli([
        "research",
        "status",
        "--project",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      const invalid = JSON.parse(status.stdout).projects[0].publication;
      assert.equal(invalid.generationStatus, "invalid");
      assert.equal(invalid.details.object, "analysisRunId");
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence",
          reviewerAgent: "claude",
          reviewerSessionId: "stale-generation-reviewer",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires prepared material lineage and rejects stale bytes or a per-file foreign generation", async () => {
    const fixture = await publicationFixture("material-lineage-bytes");
    try {
      const request = {
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        producerAgent: "codex" as const,
        producerSessionId: "material-producer",
      };
      await assert.rejects(
        freezePublicationManuscript(request),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_RESULT_LINEAGE_REQUIRED",
      );
      const resultLineage = await fixtureResultLineage(fixture);
      const foreign = structuredClone(resultLineage);
      foreign.files.find((file) => file.role === "source-data")!.analysisSha256 = "b".repeat(64);
      await assert.rejects(
        freezePublicationManuscript({ ...request, resultLineage: foreign }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      );
      await writeFile(fixture.supplement, "measure,value\noutcome,999\n");
      await assert.rejects(
        freezePublicationManuscript({ ...request, resultLineage }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("carries the original task and current check matrix into the existing publication review", async () => {
    const fixture = await publicationFixture("task-bound-publication", {}, {}, true);
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "task-manuscript-producer",
      });
      const packet = JSON.parse(
        JSON.stringify(
          await preparePublicationReview({
            root: fixture.root,
            projectId: fixture.projectId,
            role: "evidence",
            reviewerAgent: "claude",
            reviewerSessionId: "task-final-evidence-reviewer",
          }),
        ),
      );
      assert.equal(
        packet.taskAcceptance.originalRequest,
        "Evaluate the declared central outcome without presupposing a positive result.",
      );
      assert.equal(packet.taskAcceptance.requirements[0].id, "central-outcome");
      assert.equal(packet.taskAcceptance.requirements[0].status, "unanswered");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a legacy generation's objects but does not invent missing material lineage", async () => {
    const fixture = await publicationFixture("legacy-material-lineage");
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "legacy-fixture-producer",
      });
      const directory = join(workspacePaths(fixture.root).projects, fixture.projectId);
      const pointerPath = join(directory, "publication", "current.json");
      const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
      const original = await readFile(join(directory, pointer.manifestLocator), "utf8");
      const legacy = JSON.parse(original);
      delete legacy.analysisGenerationId;
      delete legacy.materialResultsManifest;
      delete legacy.generationSha256;
      const generationSha256 = sha256Text(canonicalJson(legacy));
      const manifestLocator = `publication/generations/${generationSha256}/manifest.json`;
      await mkdir(join(directory, "publication", "generations", generationSha256), {
        recursive: true,
      });
      await writeJsonAtomic(join(directory, manifestLocator), { ...legacy, generationSha256 });
      await writeJsonAtomic(pointerPath, { ...pointer, generationSha256, manifestLocator });
      await assert.rejects(
        inspectPublicationStatus(fixture.root, fixture.projectId),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_RESULT_LINEAGE_REQUIRED",
      );
      assert.equal(await readFile(join(directory, pointer.manifestLocator), "utf8"), original);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds binary figure bytes and ordered table supplements without decoding them as text", async () => {
    const fixture = await publicationFixture("binary-material-lineage");
    try {
      const figure = join(fixture.root, "figure.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6u0AAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(figure, bytes);
      const supplements = [figure, fixture.supplement];
      const resultLineage = await fixtureResultLineage(fixture, supplements);
      const request = {
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        submissionFiles: fixture.submissionFiles,
        supplementPaths: supplements,
        resultLineage,
        producerAgent: "codex" as const,
        producerSessionId: "binary-material-producer",
      };
      const frozen = await freezePublicationManuscript(request);
      assert.equal(frozen.supplements[0]!.sha256, await sha256File(figure));
      assert.notEqual(frozen.supplements[0]!.sha256, sha256Text(bytes.toString("utf8")));
      const manifest = JSON.parse(
        await readFile(
          join(
            workspacePaths(fixture.root).projects,
            fixture.projectId,
            frozen.materialResultsManifest!.objectLocator,
          ),
          "utf8",
        ),
      );
      assert.equal(
        manifest.files.find((file: { role: string }) => file.role === "supplement-2").sha256,
        await sha256File(fixture.supplement),
      );
      await writeFile(figure, Buffer.concat([bytes, Buffer.from([0xff])]));
      await assert.rejects(
        freezePublicationManuscript(request),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("freezes a qualitative analysis without inventing a computational reproduction", async () => {
    const fixture = await publicationFixture(
      "qualitative-publication",
      {},
      {
        mode: "qualitative",
        status: "not-applicable",
        implementationSha256s: [],
        environmentSha256s: [],
        command: null,
        randomSeed: null,
      },
    );
    try {
      const frozen = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "qualitative-producer",
      });
      assert.equal(frozen.status, "manuscript-frozen");
      assert.equal(
        (await inspectPublicationStatus(fixture.root, fixture.projectId)).reviewState,
        "not-started",
      );
      await assert.rejects(
        closePublication(fixture.root, fixture.projectId),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_INCOMPLETE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects inconsistent computational and qualitative metadata at publication freeze", async () => {
    for (const run of [
      { mode: "computational", status: "not-applicable" },
      { mode: "mixed", status: "not-applicable" },
      { mode: "qualitative", status: "reproduced" },
      { mode: "qualitative", status: "not-applicable", command: "invented command" },
      {
        mode: "computational",
        status: "reproduced",
        command: null,
        randomSeed: null,
        implementationSha256s: [],
        environmentSha256s: [],
      },
    ]) {
      const fixture = await publicationFixture("inconsistent-analysis-run", {}, run);
      try {
        await assert.rejects(
          freezePublicationManuscript({
            root: fixture.root,
            projectId: fixture.projectId,
            manuscriptPath: fixture.manuscript,
            assessmentPath: fixture.assessment,
            supplementPaths: [],
            submissionFiles: fixture.submissionFiles,
            resultLineage: await fixtureResultLineage(fixture),
            producerAgent: "codex",
            producerSessionId: "inconsistent-run-producer",
          }),
          (error: unknown) =>
            errorCode(error) === "RESEARCH_PUBLICATION_SUBMISSION_BINDING_INVALID",
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("reports active base research as pending publication rather than invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-publication-pending-"));
    const projectId = "pending-publication";
    try {
      await initializeResearchWorkspace(root, "Pending publication workflow");
      const policy = await createApprovedPublicationPolicy(root, projectId);
      await initializeProject(
        root,
        projectId,
        "Does the active study produce its declared central outcome?",
        undefined,
        false,
        undefined,
        policy,
        await scientificDesignInput(root, projectId, {
          targetJournal: policy.targetJournal,
          policyRules: policy.resolvedRules,
        }),
      );
      const status = await invokeCli([
        "research",
        "status",
        "--project",
        projectId,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0);
      const projectStatus = JSON.parse(status.stdout).projects[0];
      assert.equal(projectStatus.publication.generationStatus, "waiting-for-base-research");
      assert.equal("code" in projectStatus.publication, false);
      assert.doesNotMatch(projectStatus.recommendedAction, /publication state is invalid/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes publication freeze/status and authoritative assessment/review schemas", async () => {
    const fixture = await publicationFixture("publication-cli");
    try {
      const lineage = await invokeCli([
        "research",
        "publication",
        "lineage",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(lineage.exitCode, 0, lineage.stderr);
      const preparation = JSON.parse(lineage.stdout);
      assert.match(preparation.analysisGenerationId, /^[a-f0-9]{64}$/);
      assert.deepEqual(preparation.resultLineage.files, []);
      const frozen = await invokeCli([
        "research",
        "publication",
        "freeze",
        fixture.projectId,
        "--manuscript",
        fixture.manuscript,
        "--assessment",
        fixture.assessment,
        "--submission",
        fixture.submissionManifest,
        "--producer-agent",
        "codex",
        "--producer-session",
        "native-cli-session",
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(frozen.exitCode, 0);
      assert.equal(JSON.parse(frozen.stdout).status, "manuscript-frozen");

      const status = await invokeCli([
        "research",
        "publication",
        "status",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0);
      const publicationStatus = JSON.parse(status.stdout);
      assert.equal(publicationStatus.reviewState, "not-started");
      assert.match(publicationStatus.submissionPackageSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(publicationStatus.submissionRoles.sort(), [
        "code-availability",
        "cover-letter",
        "data-availability",
        "reporting-checklist",
        "source-data",
        "title-page",
      ]);
      assert.match(publicationStatus.contentSnapshotSha256, /^[a-f0-9]{64}$/);
      assert.match(publicationStatus.inferenceSnapshotSha256, /^[a-f0-9]{64}$/);
      assert.match(publicationStatus.claimEvidenceGraphSha256, /^[a-f0-9]{64}$/);
      assert.equal(publicationStatus.analysisGenerationId, preparation.analysisGenerationId);
      assert.match(publicationStatus.materialResultsManifestSha256, /^[a-f0-9]{64}$/);

      const workspaceStatus = await invokeCli([
        "research",
        "status",
        "--project",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(workspaceStatus.exitCode, 0);
      assert.match(
        JSON.parse(workspaceStatus.stdout).projects[0].recommendedAction,
        /publication status|final manuscript/i,
      );

      for (const schemaName of [
        "publication-result-lineage",
        "publication-assessment",
        "publication-review-evidence",
        "publication-review-journal-editor",
      ]) {
        const schema = await invokeCli(["research", "schema", "show", schemaName, "--json"]);
        assert.equal(schema.exitCode, 0);
        assert.equal(JSON.parse(schema.stdout).additionalProperties, false);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("freezes the final manuscript and requires four fresh hash-bound reviews", async () => {
    const fixture = await publicationFixture("review-complete");
    try {
      const frozen = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [fixture.supplement],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture, [fixture.supplement]),
        producerAgent: "codex",
        producerSessionId: "native-codex-session-1",
      });
      assert.match(frozen.generationSha256, /^[a-f0-9]{64}$/);
      assert.equal(frozen.status, "manuscript-frozen");
      assert.deepEqual(frozen.submissionPackage.files.map((file) => file.role).sort(), [
        "code-availability",
        "cover-letter",
        "data-availability",
        "reporting-checklist",
        "source-data",
        "title-page",
      ]);
      assert.match(frozen.submissionPackage.packageSha256, /^[a-f0-9]{64}$/);

      for (const role of REVIEW_ROLES) {
        const reviewerSessionId = `independent-${role}-session`;
        const packet = await preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewerAgent: "claude",
          reviewerSessionId,
        });
        assert.equal(packet.manuscript.sha256, frozen.manuscript.sha256);
        assert.equal(packet.policy.resolvedPolicySha256, fixture.policy.resolvedPolicySha256);
        assert.equal(packet.evidenceSnapshot.sha256, fixture.snapshotSha256);
        assert.match(packet.packetSha256, /^[a-f0-9]{64}$/);
        const reviewPath = join(fixture.root, `${role}-review.json`);
        await writeJsonAtomic(
          reviewPath,
          reviewRecord(role, packet.packetSha256, reviewerSessionId),
        );
        await submitPublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewPath,
        });
      }

      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.reviewState, "complete");
      assert.equal(status.readinessVerdict, "target-journal-submission-ready");
      const closure = await closePublication(fixture.root, fixture.projectId);
      assert.equal(closure.readinessVerdict, "target-journal-submission-ready");
      assert.equal(closure.manuscript.sha256, frozen.manuscript.sha256);
      assert.equal(closure.reviews.length, 4);
      assert.match(closure.closureSha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("persists only hashes of producer and reviewer session identifiers", async () => {
    const fixture = await publicationFixture("session-hash-binding");
    const producerSessionId = "native-sensitive-producer-session";
    const reviewerSessionId = "sensitive-reviewer-session";
    try {
      const frozen = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId,
      });
      assert.doesNotMatch(JSON.stringify(frozen), new RegExp(producerSessionId));
      assert.equal(
        (frozen.producer as unknown as { sessionSha256?: string }).sessionSha256,
        sha256Text(producerSessionId),
      );

      const packet = await preparePublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewerAgent: "claude",
        reviewerSessionId,
      });
      assert.doesNotMatch(JSON.stringify(packet), new RegExp(reviewerSessionId));
      assert.equal(
        (packet.reviewer as unknown as { sessionSha256?: string }).sessionSha256,
        sha256Text(reviewerSessionId),
      );
      const reviewPath = join(fixture.root, "session-hash-review.json");
      await writeJsonAtomic(
        reviewPath,
        reviewRecord("evidence", packet.packetSha256, reviewerSessionId),
      );
      await submitPublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewPath,
      });
      const persistedReview = await readFile(
        join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "publication",
          "generations",
          frozen.generationSha256,
          "reviews",
          "evidence.json",
        ),
        "utf8",
      );
      assert.doesNotMatch(persistedReview, new RegExp(reviewerSessionId));
      assert.match(persistedReview, new RegExp(sha256Text(reviewerSessionId)));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete submission package and manuscript before paid review", async () => {
    const fixture = await publicationFixture("submission-completeness");
    try {
      await assert.rejects(
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles.filter(
            (file) => file.role !== "reporting-checklist",
          ),
          producerAgent: "codex",
          producerSessionId: "missing-package-role-session",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_PUBLICATION_SUBMISSION_PACKAGE_INVALID",
      );
      await writeFile(
        fixture.manuscript,
        "# Final manuscript\n\nA result without required sections.\n",
      );
      await assert.rejects(
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles,
          resultLineage: await fixtureResultLineage(fixture),
          producerAgent: "codex",
          producerSessionId: "incomplete-manuscript-session",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_PUBLICATION_MANUSCRIPT_INCOMPLETE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts conservative numbered section headings at publication freeze", async () => {
    const fixture = await publicationFixture("numbered-sections");
    try {
      await writeFile(fixture.manuscript, sectionManuscript(NUMBERED_SECTIONS));
      const frozen = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "numbered-sections-producer",
      });
      assert.equal(frozen.status, "manuscript-frozen");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("still rejects missing, unrelated, unseparated, and body-text section matches", async () => {
    const fixture = await publicationFixture("section-rejections");
    try {
      const freeze = async () =>
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles,
          resultLineage: await fixtureResultLineage(fixture),
          producerAgent: "codex",
          producerSessionId: "section-rejection-producer",
        });
      const expectMissing = async (manuscript: string, missing: string[]) => {
        await writeFile(fixture.manuscript, manuscript);
        await assert.rejects(freeze(), (error: unknown) => {
          assert.equal(errorCode(error), "RESEARCH_PUBLICATION_MANUSCRIPT_INCOMPLETE");
          const details = (error as { details?: { missingSections?: string[] } }).details;
          assert.deepEqual([...(details?.missingSections ?? [])].sort(), missing);
          return true;
        });
      };
      const withHeading = (from: string, to: string): Array<[string, string]> =>
        STANDARD_SECTIONS.map(([heading, body]): [string, string] => [
          heading === from ? to : heading,
          body,
        ]);
      await expectMissing(
        sectionManuscript(STANDARD_SECTIONS.filter(([heading]) => heading !== "Discussion")),
        ["discussion"],
      );
      await expectMissing(sectionManuscript(withHeading("Methods", "2 Methodology")), ["methods"]);
      await expectMissing(
        sectionManuscript(
          STANDARD_SECTIONS.map(([heading, body]): [string, string] =>
            heading === "Introduction"
              ? ["1Introduction", body]
              : heading === "Methods"
                ? ["2Methods", body]
                : [heading, body],
          ),
        ),
        ["introduction", "methods"],
      );
      await expectMissing(
        sectionManuscript([
          [
            "Abstract",
            "1. Introduction appears in chapter one. 2 Methods were compared across sites.",
          ],
          ...STANDARD_SECTIONS.filter(
            ([heading]) => heading !== "Abstract" && heading !== "Introduction",
          ),
        ]),
        ["introduction"],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an internally hash-valid but semantically disconnected Claim-Evidence Graph", async () => {
    const fixture = await publicationFixture("submission-graph-binding");
    try {
      const graphPath = join(
        workspacePaths(fixture.root).projects,
        fixture.projectId,
        "outputs",
        "claim-evidence-graph.json",
      );
      const graph = JSON.parse(await readFile(graphPath, "utf8")) as Record<string, unknown> & {
        edges: Array<Record<string, unknown>>;
      };
      const { graphSha256: _discarded, ...graphCore } = graph;
      graphCore.edges = graph.edges.map((edge) =>
        edge.type === "finding-supported-by-atom"
          ? { ...edge, from: "finding:unrelated-finding" }
          : edge,
      );
      await writeJsonAtomic(graphPath, {
        ...graphCore,
        graphSha256: sha256Text(canonicalJson(graphCore)),
      });
      await assert.rejects(
        freezePublicationManuscript({
          root: fixture.root,
          projectId: fixture.projectId,
          manuscriptPath: fixture.manuscript,
          assessmentPath: fixture.assessment,
          supplementPaths: [],
          submissionFiles: fixture.submissionFiles,
          resultLineage: await fixtureResultLineage(fixture),
          producerAgent: "codex",
          producerSessionId: "disconnected-graph-session",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_PUBLICATION_SUBMISSION_BINDING_INVALID",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects producer/reviewer identity reuse and reviewer session reuse", async () => {
    const fixture = await publicationFixture("review-independence");
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "native-producer-session",
      });
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence",
          reviewerAgent: "codex",
          reviewerSessionId: "different-session-same-agent-family",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
      );
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence",
          reviewerAgent: "claude",
          reviewerSessionId: "native-producer-session",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
      );
      await preparePublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewerAgent: "claude",
        reviewerSessionId: "fresh-reviewer-session",
      });
      await rm(
        join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "publication",
          "reviewer-sessions.json",
        ),
        { force: true },
      );
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "methods-reproducibility",
          reviewerAgent: "claude",
          reviewerSessionId: "fresh-reviewer-session",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("invalidates publication work when the approved Research Policy changes", async () => {
    const fixture = await publicationFixture("policy-drift");
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "native-policy-bound-producer",
      });
      const briefPath = join(
        fixture.root,
        "research-policy",
        fixture.projectId,
        "publication-brief.md",
      );
      await writeFile(briefPath, `${await readFile(briefPath, "utf8")}\nChanged scope.\n`);
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence",
          reviewerAgent: "claude",
          reviewerSessionId: "fresh-after-policy-drift",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_CHANGED",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("starts a new generation and invalidates every review after the manuscript changes", async () => {
    const fixture = await publicationFixture("review-invalidation");
    try {
      const first = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "native-generation-one",
      });
      const packet = await preparePublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewerAgent: "claude",
        reviewerSessionId: "generation-one-reviewer",
      });
      const reviewPath = join(fixture.root, "first-review.json");
      await writeJsonAtomic(
        reviewPath,
        reviewRecord("evidence", packet.packetSha256, "generation-one-reviewer"),
      );
      await submitPublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewPath,
      });

      await writeFile(
        fixture.manuscript,
        `${await readFile(fixture.manuscript, "utf8")}\nMaterial revision.\n`,
      );
      const second = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "native-generation-two",
      });
      assert.notEqual(second.generationSha256, first.generationSha256);
      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.completedReviewRoles.length, 0);
      assert.equal(status.reviewState, "not-started");
      await assert.rejects(
        closePublication(fixture.root, fixture.projectId),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_INCOMPLETE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let an editor upgrade a mechanically blocked assessment", async () => {
    const fixture = await publicationFixture("bounded-editor", {
      outcomes: [
        {
          id: "outcome-central",
          role: "central",
          label: "Unobserved promised outcome",
          supportStatus: "unobserved",
          claimIds: ["claim-central"],
          resultIds: ["result-central"],
        },
      ],
    });
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        submissionFiles: fixture.submissionFiles,
        resultLineage: await fixtureResultLineage(fixture),
        producerAgent: "codex",
        producerSessionId: "native-blocked-assessment",
      });
      for (const role of REVIEW_ROLES) {
        const reviewerSessionId = `blocked-${role}`;
        const packet = await preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewerAgent: "claude",
          reviewerSessionId,
        });
        const reviewPath = join(fixture.root, `blocked-${role}.json`);
        await writeJsonAtomic(
          reviewPath,
          reviewRecord(role, packet.packetSha256, reviewerSessionId),
        );
        await submitPublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewPath,
        });
      }
      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.mechanicalIssues.includes("CENTRAL_OUTCOME_UNOBSERVED"), true);
      assert.notEqual(status.readinessVerdict, "target-journal-submission-ready");
      const closure = await closePublication(fixture.root, fixture.projectId);
      assert.equal(closure.readinessVerdict, "revision-required");
      assert.match(closure.boundedStatement, /not submission-ready/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

const STANDARD_SECTIONS: Array<[string, string]> = [
  ["Abstract", "The independently reproduced central outcome was one unit."],
  ["Introduction", "This study tests the declared central claim."],
  ["Methods", "We executed the frozen computational analysis with seed 42."],
  ["Results", "The central outcome was one unit."],
  ["Discussion", "The result applies only to this synthetic fixture."],
  ["Data availability", "The frozen source-data file accompanies this submission."],
  [
    "Code availability",
    "The command and environment hashes are recorded in the reproducibility manifest.",
  ],
  ["References", "1. Peer-reviewed fixture source."],
];

const NUMBERED_SECTIONS: Array<[string, string]> = [
  ["Abstract", "The independently reproduced central outcome was one unit."],
  ["1. Introduction", "This study tests the declared central claim."],
  ["2 Methods", "We executed the frozen computational analysis with seed 42."],
  ["3.1 Results", "The central outcome was one unit."],
  ["4) Discussion", "The result applies only to this synthetic fixture."],
  ["Data availability", "The frozen source-data file accompanies this submission."],
  [
    "Code availability",
    "The command and environment hashes are recorded in the reproducibility manifest.",
  ],
  ["References", "1. Peer-reviewed fixture source."],
];

function sectionManuscript(sections: Array<[string, string]>): string {
  return [
    "# Observed central outcome in a validated study",
    ...sections.flatMap(([heading, body]) => [`## ${heading}`, body]),
    "",
  ].join("\n\n");
}

async function publicationFixture(
  projectId: string,
  assessmentOverride: Partial<PublicationAssessment> = {},
  analysisRunOverride: Partial<{
    mode: string;
    status: string;
    implementationSha256s: string[];
    environmentSha256s: string[];
    command: string | null;
    randomSeed: string | null;
  }> = {},
  withTask = false,
) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-publication-workflow-"));
  await initializeResearchWorkspace(root, "Publication workflow");
  const policy = await createApprovedPublicationPolicy(root, projectId);
  const designInput = await scientificDesignInput(root, projectId, {
    targetJournal: policy.targetJournal,
    policyRules: policy.resolvedRules,
  });
  await initializeProject(
    root,
    projectId,
    "Does the studied intervention produce the observed central outcome?",
    undefined,
    false,
    undefined,
    policy,
    designInput,
  );
  if (withTask) {
    await defineProjectTask(root, projectId, {
      schemaVersion: 1,
      originalRequest:
        "Evaluate the declared central outcome without presupposing a positive result.",
      requirements: [
        {
          id: "central-outcome",
          text: "Evaluate the actual observed central outcome.",
          acceptance: "Report traceable evidence, alternatives and uncertainty.",
          checkKind: "evidence",
          designClaimIds: [],
          coverageDimensionIds: ["research-question"],
        },
      ],
    });
  }
  await passResearchDesignGate(root, projectId);
  let project = await loadProject(root, projectId);
  const outputRoot = join(workspacePaths(root).projects, projectId, "outputs");
  await writeJsonAtomic(join(outputRoot, "evidence.json"), {
    schemaVersion: 1,
    sources: [],
  });
  const discover = project.packages.find((workPackage) => workPackage.id === "discover")!;
  discover.status = "complete";
  discover.completedAt = "2026-08-12T00:00:00.000Z";
  await saveProject(root, project);
  project = await loadProject(root, projectId);
  await writeJsonAtomic(join(outputRoot, "acquisition.json"), {
    schemaVersion: 1,
    artifacts: [],
  });
  const snapshotSources = [
    ...scientificEvidenceSnapshotSources(designInput.design.contract),
    {
      id: "peer-1",
      sourceType: "journal-article",
      publicationDate: "2025-01-01",
      fullTextAvailable: true,
      coverageDimensions: ["central-outcome"],
    },
  ];
  const snapshotCore = {
    schemaVersion: 1,
    kind: "tiangong-evidence-snapshot",
    snapshotId: "snapshot-final",
    parentSnapshotId: null,
    parentSnapshotSha256: null,
    projectId,
    questionSha256: sha256Text(project.question),
    createdAt: "2026-08-12T00:00:00.000Z",
    ledgerHead: "1".repeat(64),
    evidenceRecord: { path: "outputs/evidence.json", sha256: "2".repeat(64) },
    acquisitionRecord: { path: "outputs/acquisition.json", sha256: "3".repeat(64) },
    receipts: [],
    artifacts: [],
    sources: snapshotSources,
    activitySummary: {
      total: 1,
      byKind: { web: 1 },
      blockedChallenges: 0,
      linkedCandidateIds: snapshotSources.map((source) => source.id),
    },
    coverage: {
      dimensions: [
        {
          id: "central-outcome",
          status: "covered",
          sourceIds: snapshotSources.map((source) => source.id),
        },
      ],
    },
    limitations: [],
    delta: {
      addedSourceIds: snapshotSources.map((source) => source.id),
      changedSourceIds: [],
      removedSourceIds: [],
      unchangedSourceIds: [],
      addedArtifactIds: [],
      removedArtifactIds: [],
    },
  };
  const snapshotSha256 = sha256Text(canonicalJson(snapshotCore));
  const snapshot = { ...snapshotCore, snapshotSha256 };
  await writeJsonAtomic(join(outputRoot, "evidence-snapshot.json"), snapshot);
  const immutableSnapshotRoot = join(
    workspacePaths(root).projects,
    projectId,
    "evidence",
    "snapshots",
  );
  await mkdir(immutableSnapshotRoot, { recursive: true });
  await writeJsonAtomic(join(immutableSnapshotRoot, `${snapshotSha256}.json`), snapshot);
  const acquire = project.packages.find((workPackage) => workPackage.id === "acquire")!;
  acquire.status = "complete";
  acquire.completedAt = "2026-08-12T00:00:00.000Z";
  project.evidenceState.currentSnapshotId = snapshot.snapshotId;
  project.evidenceState.currentSnapshotSha256 = snapshotSha256;
  await saveProject(root, project);
  await passEvidenceConstructGate(root, projectId);
  await passPilotMethodsGate(root, projectId);
  project = await loadProject(root, projectId);
  const designClaim = designInput.design.contract.claims.find(
    (claim) => claim.id === "claim-discrepancy",
  )!;
  const evidenceAtomCore = {
    schemaVersion: 1 as const,
    projectId,
    sourceId: "peer-1",
    candidateId: "peer-1",
    artifactId: "artifact-peer-1-text",
    artifactSha256: "8".repeat(64),
    locator: { kind: "line-range" as const, startLine: 10, endLine: 12 },
    excerpt: "The independently reproduced central outcome was one unit.",
    excerptSha256: sha256Text("The independently reproduced central outcome was one unit."),
    statement: "The independently reproduced central outcome was one unit.",
    evidenceRoleIds: ["role-central-model"],
    coverageDimensionIds: ["central-model-definitions"],
    evidenceFunction: "support",
    scope: "Synthetic publication workflow fixture.",
    limitations: [],
  };
  const evidenceAtom = {
    ...evidenceAtomCore,
    atomId: `atom-${sha256Text(canonicalJson(evidenceAtomCore)).slice(0, 24)}`,
    atomSha256: sha256Text(canonicalJson(evidenceAtomCore)),
    registeredAt: "2026-08-12T00:00:01.000Z",
  };
  const contentCore = {
    schemaVersion: 1,
    kind: "tiangong-evidence-content-snapshot",
    snapshotId: "content-snapshot-final",
    projectId,
    acquisitionSnapshotId: snapshot.snapshotId,
    acquisitionSnapshotSha256: snapshotSha256,
    createdAt: "2026-08-12T00:00:01.000Z",
    ledgerHead: "6".repeat(64),
    decompositions: [],
    atoms: [evidenceAtom],
    sourceCoverage: [
      {
        sourceId: "peer-1",
        atomIds: [evidenceAtom.atomId],
        evidenceRoleIds: evidenceAtom.evidenceRoleIds,
        coverageDimensionIds: evidenceAtom.coverageDimensionIds,
        evidenceFunctions: [evidenceAtom.evidenceFunction],
      },
    ],
    roleCoverage: [
      {
        roleId: "role-central-model",
        sourceIds: ["peer-1"],
        fullTextSourceIds: ["peer-1"],
        datedSourceIds: ["peer-1"],
        coverageDimensionIds: ["central-model-definitions"],
        sourceTypes: ["journal-article"],
        decision: "pass",
        gaps: [],
      },
    ],
    gate: {
      decision: "pass",
      reasons: [],
      requiredDecompositionArtifactIds: [],
      missingDecompositionArtifactIds: [],
      acceptedFullTextSourceIds: [],
      sourcesWithoutAtoms: snapshotSources
        .map((source) => source.id)
        .filter((sourceId) => sourceId !== "peer-1"),
    },
  };
  const contentSnapshot = {
    ...contentCore,
    snapshotSha256: sha256Text(canonicalJson(contentCore)),
  };
  await writeJsonAtomic(join(outputRoot, "content-snapshot.json"), contentSnapshot);
  const evidenceGate = project.scientificDesign!.gates["evidence-construct"];
  const inferenceCore = {
    schemaVersion: 1,
    kind: "tiangong-inference-snapshot",
    snapshotId: "inference-snapshot-final",
    projectId,
    createdAt: "2026-08-12T00:00:02.000Z",
    ledgerHead: "7".repeat(64),
    acquisitionSnapshot: { snapshotId: snapshot.snapshotId, snapshotSha256 },
    contentSnapshot: {
      snapshotId: contentSnapshot.snapshotId,
      snapshotSha256: contentSnapshot.snapshotSha256,
    },
    scientificReview: {
      designSha256: project.scientificDesign!.designSha256,
      packetSha256: evidenceGate.packetSha256,
      assessmentSha256: evidenceGate.assessmentSha256,
      reviewSha256: evidenceGate.reviewSha256,
    },
    policySha256: policy.resolvedPolicySha256,
    sources: snapshotSources.map((source) => ({ ...source, title: source.id })),
    atoms: [evidenceAtom],
    claims: designInput.design.contract.claims,
    designEdges: designInput.design.contract.edges,
    artifactSha256s: [],
    implementationArtifactSha256s: designInput.design.contract.identity.modelStructures.map(
      (model) => model.implementationArtifactSha256,
    ),
    environmentLockSha256s: designInput.design.contract.identity.modelStructures.map(
      (model) => model.environmentLockSha256,
    ),
    gate: { decision: "pass", reasons: [] },
  };
  const inferenceSnapshot = {
    ...inferenceCore,
    snapshotSha256: sha256Text(canonicalJson(inferenceCore)),
  };
  await writeJsonAtomic(join(outputRoot, "inference-snapshot.json"), inferenceSnapshot);
  const analysis = {
    schemaVersion: 2,
    inferenceSnapshotSha256: inferenceSnapshot.snapshotSha256,
    analysisRun: {
      id: "publication-fixture-run",
      mode: "computational",
      status: "reproduced",
      implementationSha256s: inferenceCore.implementationArtifactSha256s,
      environmentSha256s: inferenceCore.environmentLockSha256s,
      inputArtifactSha256s: [],
      command: "python analysis.py --seed 42",
      randomSeed: "42",
      limitations: [],
      ...analysisRunOverride,
    },
    findings: [
      {
        id: "finding-central",
        statement: "The independently reproduced central outcome was one unit.",
        evidence: ["peer-1"],
        evidenceAtomIds: [evidenceAtom.atomId],
        claimIds: [designClaim.id],
        analysisArtifactSha256s: [],
        uncertainty: "The synthetic fixture does not estimate sampling uncertainty.",
        applicability: "Applies only to the synthetic publication workflow fixture.",
      },
    ],
    limitations: [],
  };
  await writeJsonAtomic(join(outputRoot, "analysis.json"), analysis);
  const graphCore = {
    schemaVersion: 1,
    kind: "tiangong-claim-evidence-graph",
    graphId: "claim-graph-final",
    projectId,
    createdAt: "2026-08-12T00:00:03.000Z",
    inferenceSnapshotSha256: inferenceSnapshot.snapshotSha256,
    analysisSha256: sha256Text(`${JSON.stringify(analysis, null, 2)}\n`),
    analysisRunId: analysis.analysisRun.id,
    nodes: [
      {
        id: "analysis-run:publication-fixture-run",
        type: "analysis-run",
        label: "publication-fixture-run",
        sha256: null,
      },
      {
        id: "finding:finding-central",
        type: "finding",
        label: analysis.findings[0]!.statement,
        sha256: sha256Text(canonicalJson(analysis.findings[0])),
      },
      {
        id: `atom:${evidenceAtom.atomId}`,
        type: "atom",
        label: evidenceAtom.statement,
        sha256: evidenceAtom.atomSha256,
      },
      {
        id: "source:peer-1",
        type: "source",
        label: "peer-1",
        sha256: sha256Text(
          canonicalJson(inferenceCore.sources.find((source) => source.id === "peer-1")),
        ),
      },
      {
        id: `design-claim:${designClaim.id}`,
        type: "design-claim",
        label: designClaim.statement,
        sha256: sha256Text(canonicalJson(designClaim)),
      },
    ],
    edges: [
      {
        id: "edge-finding-atom",
        type: "finding-supported-by-atom",
        from: "finding:finding-central",
        to: `atom:${evidenceAtom.atomId}`,
      },
      {
        id: "edge-atom-source",
        type: "atom-derived-from-source",
        from: `atom:${evidenceAtom.atomId}`,
        to: "source:peer-1",
      },
      {
        id: "edge-finding-claim",
        type: "finding-addresses-design-claim",
        from: "finding:finding-central",
        to: `design-claim:${designClaim.id}`,
      },
      {
        id: "edge-finding-run",
        type: "finding-produced-by-analysis-run",
        from: "finding:finding-central",
        to: "analysis-run:publication-fixture-run",
      },
    ],
  };
  await writeJsonAtomic(join(outputRoot, "claim-evidence-graph.json"), {
    ...graphCore,
    graphSha256: sha256Text(canonicalJson(graphCore)),
  });
  await writeFile(join(outputRoot, "report.md"), "# Frozen research report\n");
  await writeJsonAtomic(join(outputRoot, "closure.json"), {
    schemaVersion: 1,
    projectId,
    status: "complete",
    publicationPolicy: {
      resolvedPolicySha256: policy.resolvedPolicySha256,
      approvalSha256: policy.approvalSha256,
    },
    evidenceSnapshot: { snapshotId: snapshot.snapshotId, snapshotSha256 },
  });
  await recordFixtureClosureLineage(root, projectId);
  for (const workPackage of project.packages) {
    workPackage.status = "complete";
    workPackage.completedAt = "2026-08-12T00:00:00.000Z";
  }
  project.status = "complete";
  project.evidenceState.currentSnapshotId = snapshot.snapshotId;
  project.evidenceState.currentSnapshotSha256 = snapshotSha256;
  project.evidenceState.closureSnapshotId = snapshot.snapshotId;
  await saveProject(root, project);

  const manuscript = join(root, "final-manuscript.md");
  const supplement = join(root, "supplement.csv");
  const assessment = join(root, "publication-assessment.json");
  const submissionFiles: Array<{ role: PublicationSubmissionRole; path: string }> = [
    { role: "cover-letter", path: join(root, "cover-letter.md") },
    { role: "title-page", path: join(root, "title-page.md") },
    { role: "reporting-checklist", path: join(root, "reporting-checklist.md") },
    { role: "data-availability", path: join(root, "data-availability.md") },
    { role: "code-availability", path: join(root, "code-availability.md") },
    { role: "source-data", path: supplement },
  ];
  const submissionManifest = join(root, "submission-package.json");
  await writeFile(
    manuscript,
    [
      "# Observed central outcome in a validated study",
      "## Abstract",
      "The independently reproduced central outcome was one unit.",
      "## Introduction",
      "This study tests the declared central claim.",
      "## Methods",
      "We executed the frozen computational analysis with seed 42.",
      "## Results",
      "The central outcome was one unit.",
      "## Discussion",
      "The result applies only to this synthetic fixture.",
      "## Data availability",
      "The frozen source-data file accompanies this submission.",
      "## Code availability",
      "The command and environment hashes are recorded in the reproducibility manifest.",
      "## References",
      "1. Peer-reviewed fixture source.",
      "",
    ].join("\n\n"),
  );
  await writeFile(supplement, "measure,value\noutcome,1\n");
  for (const file of submissionFiles.filter((file) => file.path !== supplement)) {
    await writeFile(file.path, `# ${file.role}\n\nComplete submission material for review.\n`);
  }
  await writeJsonAtomic(assessment, publicationAssessment(assessmentOverride));
  await writeJsonAtomic(submissionManifest, {
    schemaVersion: 1,
    files: submissionFiles,
    resultLineage: await fixtureResultLineage({
      root,
      projectId,
      manuscript,
      assessment,
      submissionFiles,
    }),
  });
  return {
    root,
    projectId,
    policy,
    manuscript,
    supplement,
    assessment,
    submissionFiles,
    submissionManifest,
    snapshotSha256,
  };
}

async function recordFixtureClosureLineage(root: string, projectId: string) {
  const directory = join(workspacePaths(root).projects, projectId);
  const outputs = join(directory, "outputs");
  const closurePath = join(outputs, "closure.json");
  const closure = JSON.parse(await readFile(closurePath, "utf8"));
  const artifacts = await Promise.all(
    [
      "analysis.json",
      "report.md",
      "claim-evidence-graph.json",
      "content-snapshot.json",
      "inference-snapshot.json",
      "evidence-snapshot.json",
    ].map((name) => fileRecord(join(outputs, name), `outputs/${name}`)),
  );
  const context = "Synthetic closed review context.\n";
  const contextSha = sha256Text(context);
  const contextPath = `review/contexts/${contextSha}.txt`;
  await mkdir(join(directory, "review", "contexts"), { recursive: true });
  await writeFile(join(directory, contextPath), context);
  const core = {
    schemaVersion: 1,
    projectId,
    artifacts,
    snapshotChain: [],
    reviewEvidenceContext: {
      path: contextPath,
      sha256: contextSha,
      bytes: Buffer.byteLength(context),
    },
  };
  const packetSha256 = sha256Text(canonicalJson(core));
  const path = `review/packets/${packetSha256}.json`;
  await mkdir(join(directory, "review", "packets"), { recursive: true });
  await writeJsonAtomic(join(directory, path), { ...core, packetSha256 });
  closure.artifacts = artifacts.filter((file) =>
    ["outputs/analysis.json", "outputs/report.md"].includes(file.path),
  );
  closure.reviewPacket = { ...(await fileRecord(join(directory, path), path)), packetSha256 };
  await writeJsonAtomic(closurePath, closure);
}

async function fixtureResultLineage(
  fixture: {
    root: string;
    projectId: string;
    manuscript: string;
    assessment: string;
    submissionFiles: Array<{ role: PublicationSubmissionRole; path: string }>;
  },
  supplements: string[] = [],
) {
  const outputs = join(workspacePaths(fixture.root).projects, fixture.projectId, "outputs");
  const analysisBytes = await readFile(join(outputs, "analysis.json"), "utf8");
  const analysisSha256 = sha256Text(analysisBytes);
  return {
    schemaVersion: 1,
    projectId: fixture.projectId,
    analysisRunId: JSON.parse(analysisBytes).analysisRun.id,
    analysisSha256,
    claimEvidenceGraphSha256: sha256Text(
      await readFile(join(outputs, "claim-evidence-graph.json"), "utf8"),
    ),
    reportSha256: sha256Text(await readFile(join(outputs, "report.md"), "utf8")),
    files: await Promise.all(
      [
        { role: "manuscript", path: fixture.manuscript },
        { role: "assessment", path: fixture.assessment },
        ...fixture.submissionFiles,
        ...supplements.map((path, i) => ({ role: `supplement-${i + 1}`, path })),
      ].map(async (file) => ({
        role: file.role,
        sha256: await sha256File(file.path),
        analysisSha256,
      })),
    ),
  };
}

async function createApprovedPublicationPolicy(
  root: string,
  projectId: string,
): Promise<ResearchPolicyBinding> {
  const source = join(root, "policy-source");
  await writePublicationPolicyPack(source);
  await initializeResearchPolicy({
    root,
    projectId,
    sourceRoot: source,
    articleType: "original-empirical",
    field: "engineering-computing",
    journalClass: "discipline-flagship",
    includeExactJournalTemplate: true,
  });
  await completeResearchPublicationBrief(root, projectId, {
    centralQuestion: "Does the studied intervention produce the observed central outcome?",
    centralClaim: "The studied intervention changes the observed central outcome.",
    centralOutcome: "Observed central outcome",
    contributionType: "new-empirical-estimate",
    targetJournal: "Example Journal",
  });
  await completeResearchExactJournalPolicy(root, projectId, {
    journalName: "Example Journal",
    officialGuidelinesUrl: "https://example.org/journal/guidelines",
    officialGuidelinesRetrievedAt: "2026-08-12",
    scope: "Original empirical studies with broad engineering significance.",
    editorialSignificance: "Results must change understanding or a material engineering decision.",
    evidenceExpectations: "Direct full-text empirical evidence must support each central claim.",
    methodsAndValidation: "Methods require uncertainty, robustness, and independent validation.",
    reproducibility: "All material results must be independently reproduced from frozen inputs.",
    deskRejectTriggers:
      "Unobserved outcomes, unsupported novelty, or unreproduced results block review.",
    requiredReviewerQuestions:
      "Do evidence, methods, novelty, and journal fit support the exact claim?",
    permittedPivots:
      "Narrow the claim, collect evidence, redesign the study, or change journal class.",
  });
  for (const file of ["article-type.md", "field.md", "journal-class.md"]) {
    const path = join(root, "research-policy", projectId, file);
    await writeFile(path, `${await readFile(path, "utf8")}\nHuman-reviewed requirement.\n`);
  }
  await approveResearchPolicy(root, projectId, {
    confirm: true,
    acknowledgeDefaults: true,
  });
  return loadApprovedResearchPolicy(root, projectId);
}

async function writePublicationPolicyPack(root: string): Promise<void> {
  const policyRoot = join(root, "assets", "research-policy", "defaults");
  const documents: Array<[string, string, string, string]> = [
    ["baseline/top-journal.md", "baseline.top-journal", "baseline", "bundled-default"],
    ["article-types/original-empirical.md", "article.original", "article-type", "bundled-default"],
    ["fields/engineering-computing.md", "field.engineering", "field", "bundled-default"],
    [
      "journal-classes/discipline-flagship.md",
      "journal.flagship",
      "journal-class",
      "bundled-default",
    ],
    ["reviewer-rubrics/evidence.md", "reviewer.evidence", "reviewer-rubric", "bundled-default"],
    [
      "reviewer-rubrics/methods-reproducibility.md",
      "reviewer.methods",
      "reviewer-rubric",
      "bundled-default",
    ],
    ["reviewer-rubrics/domain-novelty.md", "reviewer.domain", "reviewer-rubric", "bundled-default"],
    ["reviewer-rubrics/journal-editor.md", "reviewer.editor", "reviewer-rubric", "bundled-default"],
    ["project/publication-brief.md", "project.brief", "publication-brief", "project-template"],
    [
      "journals/exact-journal-template.md",
      "journal.exact",
      "exact-journal",
      "exact-journal-template",
    ],
  ];
  for (const [relative, id, kind, templateClass] of documents) {
    const path = join(policyRoot, relative);
    await mkdir(join(path, ".."), { recursive: true });
    const isBrief = kind === "publication-brief";
    const isJournal = kind === "exact-journal";
    const requiredTopJournalConstraints =
      kind === "baseline"
        ? "\n  requireScientificDesignContract: true\n  requireEarlyScientificReviews: true\n  requireRealRecordConstructCanary: true"
        : "";
    await writeFile(
      path,
      `---\nschemaVersion: 1\nid: ${id}\nkind: ${kind}\ntemplateClass: ${templateClass}\npolicyVersion: 1\ntargetTier: top\narticleType: original-empirical\nfield: engineering-computing\njournalClass: discipline-flagship\ntargetJournal: ${isBrief ? "__SELECT_EXACT_JOURNAL_OR_NONE__" : "none"}\njournalName: ${isJournal ? "__REPLACE_JOURNAL_NAME__" : "none"}\nofficialGuidelinesUrl: ${isJournal ? "__REPLACE_OFFICIAL_HTTPS_URL__" : "https://example.org"}\nofficialGuidelinesRetrievedAt: ${isJournal ? "__REPLACE_YYYY-MM-DD__" : "2026-08-12"}\ncentralQuestion: ${isBrief ? "__DEFINE_CENTRAL_QUESTION__" : "defined"}\ncentralClaim: ${isBrief ? "__DEFINE_CENTRAL_CLAIM__" : "defined"}\ncentralOutcome: ${isBrief ? "__DEFINE_CENTRAL_OUTCOME__" : "defined"}\ncontributionType: ${isBrief ? "__DEFINE_CONTRIBUTION_TYPE__" : "defined"}\nrules:\n  - central-claim-directly-supported\nconstraints:\n  minDirectPeerReviewedFullText: 1${requiredTopJournalConstraints}\nrequiredReviewers:\n  - evidence\n  - methods-reproducibility\n  - domain-novelty\n  - journal-editor\nreviewAfterDays: 365\n---\n\n# ${id}\n\nGeneric policy content requiring substantive human review.\n`,
    );
  }
}

function publicationAssessment(override: Partial<PublicationAssessment>): PublicationAssessment {
  return {
    schemaVersion: 1,
    title: "Observed central outcome in a validated study",
    claims: [
      {
        id: "claim-central",
        role: "central",
        statement: "The studied intervention changes the central outcome.",
        evidenceSourceIds: ["peer-1"],
        dimensionIds: ["central-outcome"],
        resultIds: ["result-central"],
      },
    ],
    outcomes: [
      {
        id: "outcome-central",
        role: "central",
        label: "Observed central outcome",
        supportStatus: "field-observation",
        claimIds: ["claim-central"],
        resultIds: ["result-central"],
      },
    ],
    titleOutcomeIds: ["outcome-central"],
    results: [
      {
        id: "result-central",
        role: "central",
        resultClass: "field-observation",
        statement: "The central outcome was observed.",
        evidenceSourceIds: ["peer-1"],
        independentlyReproduced: true,
      },
    ],
    sourceClassifications: [
      {
        sourceId: "peer-1",
        relationship: "direct",
        evidenceKind: "peer-reviewed-empirical",
      },
    ],
    recallAudit: {
      status: "pass",
      candidateDispositionComplete: true,
      databaseCoverageComplete: true,
      backwardCitationChasing: true,
      forwardCitationChasing: true,
      adversarialSearch: true,
      closestPriorWorkCompared: true,
      missingCoreWorkIds: [],
    },
    ...override,
  };
}

function reviewRecord(
  role: PublicationReviewRole,
  packetSha256: string,
  reviewerSessionId: string,
) {
  return {
    schemaVersion: 1,
    role,
    packetSha256,
    reviewerSessionSha256: sha256Text(reviewerSessionId),
    decision: role === "journal-editor" ? "submission-ready" : "pass",
    findings: [],
    boundedRecommendation: "The exact frozen manuscript satisfies this review role.",
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function invokeCli(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (value: string) => void stdout.push(value) },
    stderr: { write: (value: string) => void stderr.push(value) },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

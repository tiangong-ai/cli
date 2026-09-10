import {
  cli,
  contractInput,
  fixture,
  acquiredFixture,
  submitFixtureStage,
} from "./helpers/task-fixture.js";
import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { runResearchCrashWorker } from "./helpers/research-crash-worker.js";

import { runCli } from "../src/cli.js";
import { openArtifactViews } from "../src/research/workspace/artifact-views.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { readVerifiedJournal } from "../src/research/workspace/journal.js";
import {
  addProjectInput,
  initializeProject,
  loadProject,
} from "../src/research/workspace/projects.js";
import {
  canonicalJson,
  sha256File,
  sha256Text,
  workspacePaths,
} from "../src/research/workspace/storage.js";
import {
  initializeResearchWorkspace,
  withWorkspaceLock,
} from "../src/research/workspace/workspace.js";
import { setTimeout as delay } from "node:timers/promises";
import { loadCurrentEvidenceSnapshot } from "../src/research/workspace/acquisition.js";
import {
  freezeEvidenceContentSnapshot,
  registerEvidenceAtom,
} from "../src/research/workspace/content-evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import {
  prepareNativeResearchStage,
  runResearchWorkspace,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import { passResearchDesignGate, scientificDesignInput } from "./helpers/scientific-design.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { inspectScientificReviewStatus } from "../src/research/workspace/scientific-review.js";

describe("lightweight original task and authorized scope", () => {
  for (const example of [
    { label: "a promotion hash", value: { promotionSha256: "a".repeat(64) } },
    { label: "no promotion hash", value: { status: "passed" } },
  ]) {
    it(`rejects grafted certification with ${example.label} in an ordinary portable run`, async () => {
      const fx = await acquiredFixture("computation");
      try {
        const request = await nativeRunTestRequest(
          fx,
          "ghost-certification",
          `import {writeFile} from 'node:fs/promises'; await writeFile(process.argv[3],JSON.stringify({value:1}));`,
        );
        const observed = await cli(request.argv);
        assert.equal(observed.exitCode, 0, observed.stderr);
        const run = JSON.parse(observed.stdout).record;
        const bundle = join(fx.files, "ghost-certification-audit");
        const exported = await cli([
          "research",
          "project",
          "audit",
          "export",
          "task-project",
          "--output",
          bundle,
          "--workspace",
          fx.root,
          "--json",
        ]);
        assert.equal(exported.exitCode, 0, exported.stderr);
        const manifestPath = join(bundle, "manifest.json"),
          proofPath = join(bundle, "state/journal-event-proofs.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")),
          proof = JSON.parse(await readFile(proofPath, "utf8"));
        const { recordSha256: oldHash, ...core } = run;
        core.investigationCertification = example.value;
        const newHash = sha256Text(canonicalJson(core)),
          changedRun = { ...core, recordSha256: newHash };
        const oldPath = `project/task/runs/${oldHash}.json`,
          newPath = `project/task/runs/${newHash}.json`;
        const runText = JSON.stringify(changedRun, null, 2) + "\n";
        await rm(join(bundle, oldPath));
        await writeFile(join(bundle, newPath), runText);
        const entry = manifest.files.find((f: { path: string }) => f.path === oldPath);
        Object.assign(entry, {
          path: newPath,
          sha256: sha256Text(runText),
          bytes: Buffer.byteLength(runText),
        });
        const completed = proof.events.find(
          (e: { type: string; payload: { recordSha256?: string } }) =>
            e.type === "project.task.run.completed" && e.payload.recordSha256 === oldHash,
        );
        completed.payload.recordSha256 = newHash;
        completed.sourcePayloadSha256 = sha256Text(canonicalJson(completed.payload));
        completed.sourceEventHash = sha256Text(
          canonicalJson({
            schemaVersion: 1,
            sequence: completed.sequence,
            timestamp: completed.timestamp,
            type: completed.type,
            scope: completed.scope,
            payload: completed.payload,
            previousHash: completed.sourcePreviousHash,
          }),
        );
        proof.workspaceJournalHead = completed.sourceEventHash;
        manifest.sourceBindings.workspaceJournalHead = completed.sourceEventHash;
        const proofText = JSON.stringify(proof, null, 2) + "\n";
        await chmod(proofPath, 0o600);
        await writeFile(proofPath, proofText);
        const proofEntry = manifest.files.find(
          (f: { path: string }) => f.path === "state/journal-event-proofs.json",
        );
        proofEntry.sha256 = sha256Text(proofText);
        proofEntry.bytes = Buffer.byteLength(proofText);
        manifest.files.sort((a: { path: string }, b: { path: string }) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        const { manifestSha256: _old, ...manifestCore } = manifest;
        await chmod(manifestPath, 0o600);
        await writeFile(
          manifestPath,
          JSON.stringify(
            { ...manifestCore, manifestSha256: sha256Text(canonicalJson(manifestCore)) },
            null,
            2,
          ) + "\n",
        );
        const checked = await cli([
          "research",
          "project",
          "audit",
          "verify",
          "--bundle",
          bundle,
          "--json",
        ]);
        assert.notEqual(
          checked.exitCode,
          0,
          "Certification claims cannot be added without a matching authorized start",
        );
        assert.match(checked.stderr, /Native run.*committed start/);
      } finally {
        await fx.cleanup();
      }
    });
  }
  it("binds acceptance to one observed native calculation and replays without running it again", async () => {
    const fx = await acquiredFixture("computation");
    try {
      const scriptPath = join(fx.files, "calculate.mjs");
      const lockPath = join(fx.files, "environment.json");
      await writeFile(
        scriptPath,
        "import {readFile,writeFile} from 'node:fs/promises';\nimport {randomUUID} from 'node:crypto';\nconst source=await readFile(process.argv[2],'utf8');\nawait writeFile(process.argv[3],JSON.stringify({nonce:randomUUID(),lines:source.trim().split('\\n').length})+'\\n');\n",
      );
      await writeFile(lockPath, JSON.stringify({ node: process.version, dependencies: [] }));
      const inputPath = join(fx.files, "native-run.json");
      const input = {
        schemaVersion: 1,
        runId: "observed-check-001",
        requirementId: fx.rows[0]!.id,
        requirementSha256: fx.rows[0]!.requirementSha256,
        nativeSessionId: null,
        workingDirectory: fx.files,
        runtime: { kind: "node", path: process.execPath },
        scriptPath,
        environmentLockPath: lockPath,
        inputs: [{ id: "source", artifactId: fx.artifact.artifactId, sha256: fx.artifact.sha256 }],
        outputs: [{ id: "result", fileName: "result.json", mediaType: "application/json" }],
        arguments: ["{input:source}", "{output:result}"],
        timeoutSeconds: 30,
      };
      await writeFile(inputPath, JSON.stringify(input));
      const argv = [
        "research",
        "project",
        "task",
        "run",
        "observe",
        "task-project",
        "--input",
        inputPath,
        "--confirm-execution",
        "--workspace",
        fx.root,
        "--json",
      ];
      const observed = await cli(argv);
      assert.equal(observed.exitCode, 0, observed.stderr);
      const first = JSON.parse(observed.stdout);
      assert.equal(first.record.status, "succeeded");
      assert.equal(first.record.observation, "cli-observed-native-process");
      assert.equal(first.record.executionCertified, false);
      assert.equal(first.record.process.exitCode, 0);
      assert.equal(first.record.runtime.kind, "node");
      assert.match(first.record.runtime.binarySha256, /^[a-f0-9]{64}$/);
      assert.equal(first.record.inputs[0].sha256, fx.artifact.sha256);
      assert.equal(first.record.outputs.length, 1);
      assert.equal(observed.stdout.includes(fx.files), false);
      assert.equal(observed.stdout.includes(fx.root), false);
      const replay = await cli(argv);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.deepEqual(JSON.parse(replay.stdout).record, first.record);
      assert.equal(JSON.parse(replay.stdout).replayed, true);
      const accepted = await recordAcceptance(fx, {
        ...acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "negative-result"),
        checkKind: "computation",
        reportedCommand: null,
        nativeRunSha256: first.record.recordSha256,
      });
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      const record = JSON.parse(accepted.stdout);
      assert.equal(record.nativeRunSha256, first.record.recordSha256);
      assert.equal(record.results[0].sha256, first.record.outputs[0].sha256);
      const auditPath = join(fx.files, "native-run-audit");
      const exported = await cli([
        "research",
        "project",
        "audit",
        "export",
        "task-project",
        "--output",
        auditPath,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(exported.exitCode, 0, exported.stderr);
      const manifestPath = join(auditPath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const missingScript = `project/${first.record.script.path}`;
      await rm(join(auditPath, missingScript));
      manifest.files = manifest.files.filter(
        (file: { path: string }) => file.path !== missingScript,
      );
      const { manifestSha256: _previousManifest, ...core } = manifest;
      await chmod(manifestPath, 0o600);
      await writeFile(
        manifestPath,
        JSON.stringify({ ...core, manifestSha256: sha256Text(canonicalJson(core)) }, null, 2) +
          "\n",
      );
      const invalidAudit = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        auditPath,
        "--json",
      ]);
      assert.equal(
        invalidAudit.exitCode,
        3,
        "rehashed inventories must not hide a missing observed program",
      );
      assert.equal(
        (await readVerifiedJournal(workspacePaths(fx.root).journal)).filter(
          (event) => event.type === "project.task.run.started",
        ).length,
        1,
      );
      const changed = {
        ...input,
        arguments: ["{input:source}", "{output:result}", "changed-intent"],
      };
      await writeFile(inputPath, JSON.stringify(changed));
      assert.equal((await cli(argv)).exitCode, 3);
      const analyze = await prepareNativeResearchStage({
        root: fx.root,
        projectId: "task-project",
        stage: "analyze",
        hostAgent: "codex",
      });
      const directory = await cli([
        "research",
        "project",
        "stage",
        "artifacts",
        "task-project",
        "--session",
        analyze.sessionId,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(directory.exitCode, 0, directory.stderr);
      const listed = JSON.parse(directory.stdout).items as Array<{ path: string; sha256: string }>;
      for (const object of [
        first.record.script,
        first.record.environmentLock,
        ...first.record.inputs,
        ...first.record.outputs,
      ]) {
        assert.ok(
          listed.some((item) => item.path === object.path && item.sha256 === object.sha256),
          `missing packet-readable run object ${object.path}`,
        );
      }
      const scriptObject = listed.find((item) => item.path === first.record.script.path) as {
        path: string;
        sha256: string;
        objectId: string;
      };
      const read = await cli([
        "research",
        "project",
        "stage",
        "read",
        "task-project",
        "--session",
        analyze.sessionId,
        "--artifact",
        scriptObject.objectId,
        "--length",
        "all",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(read.exitCode, 0, read.stderr);
      const receipt = JSON.parse(read.stdout).receipt;
      const readAudit = join(fx.files, "read-receipt-audit");
      const exportedRead = await cli([
        "research",
        "project",
        "audit",
        "export",
        "task-project",
        "--output",
        readAudit,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(exportedRead.exitCode, 0, exportedRead.stderr);
      const readManifestPath = join(readAudit, "manifest.json");
      const readManifest = JSON.parse(await readFile(readManifestPath, "utf8"));
      const receiptPath = `project/reads/receipts/${receipt.receiptSha256}.json`;
      const receiptFile = join(readAudit, receiptPath);
      await chmod(receiptFile, 0o600);
      await writeFile(
        receiptFile,
        JSON.stringify({ ...receipt, offset: receipt.offset + 1 }, null, 2) + "\n",
      );
      const changedReceipt = readManifest.files.find(
        (file: { path: string }) => file.path === receiptPath,
      );
      changedReceipt.sha256 = await sha256File(receiptFile);
      changedReceipt.bytes = (await readFile(receiptFile)).length;
      const { manifestSha256: _readManifestHash, ...readCore } = readManifest;
      await chmod(readManifestPath, 0o600);
      await writeFile(
        readManifestPath,
        JSON.stringify(
          { ...readCore, manifestSha256: sha256Text(canonicalJson(readCore)) },
          null,
          2,
        ) + "\n",
      );
      const alteredRead = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        readAudit,
        "--json",
      ]);
      assert.equal(
        alteredRead.exitCode,
        3,
        "a rehashed outer inventory cannot certify a changed read receipt",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("releases the workspace lease while an explicitly staged CommonJS calculation waits", async () => {
    const fx = await acquiredFixture("computation");
    let pending: ReturnType<typeof cli> | undefined;
    let barrier: string | undefined;
    try {
      const scriptPath = join(fx.files, "lease-check.cjs");
      const lockPath = join(fx.files, "lease-environment.json");
      await writeFile(
        scriptPath,
        "const fs=require('node:fs');\nconst output=process.argv[3];\nfs.writeFileSync(output,JSON.stringify({waiting:true}));\nconst timer=setInterval(()=>{if(fs.existsSync(output+'.continue')){clearInterval(timer);fs.writeFileSync(output,JSON.stringify({completed:true}));}},20);\n",
      );
      await writeFile(lockPath, JSON.stringify({ node: process.version, dependencies: [] }));
      const inputPath = join(fx.files, "lease-run.json");
      await writeFile(
        inputPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "lease-check-001",
          requirementId: fx.rows[0]!.id,
          requirementSha256: fx.rows[0]!.requirementSha256,
          nativeSessionId: null,
          workingDirectory: fx.files,
          runtime: { kind: "node", path: process.execPath },
          scriptPath,
          environmentLockPath: lockPath,
          inputs: [
            { id: "source", artifactId: fx.artifact.artifactId, sha256: fx.artifact.sha256 },
          ],
          outputs: [{ id: "result", fileName: "lease-result.json", mediaType: "application/json" }],
          arguments: ["{input:source}", "{output:result}"],
          timeoutSeconds: 30,
        }),
      );
      pending = cli([
        "research",
        "project",
        "task",
        "run",
        "observe",
        "task-project",
        "--input",
        inputPath,
        "--confirm-execution",
        "--workspace",
        fx.root,
        "--json",
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const event = (await readVerifiedJournal(workspacePaths(fx.root).journal)).find(
          (item) =>
            item.type === "project.task.run.started" && item.payload.runId === "lease-check-001",
        );
        if (event) {
          const path = join(
            fx.files,
            String(event.payload.stagingDirectoryName),
            "lease-result.json",
          );
          barrier = path + ".continue";
          const content = await readFile(path, "utf8").catch(() => "");
          if (content && JSON.parse(content).waiting) {
            waiting = true;
            break;
          }
        }
        await delay(25);
      }
      assert.equal(waiting, true, "the actual child reached the file-based wait barrier");
      await withWorkspaceLock(fx.root, "test.native-run.concurrent-reader", async () => {
        await writeFile(barrier!, "continue");
      });
      const result = await pending;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).record.status, "succeeded");
    } finally {
      if (barrier) await writeFile(barrier, "continue").catch(() => undefined);
      await pending;
      await fx.cleanup();
    }
  });

  it("records failed, timed-out and missing-output calculations without granting positive acceptance", async () => {
    const fx = await acquiredFixture("computation");
    try {
      for (const [name, source, expected] of [
        ["failed", "process.exit(7);", "failed"],
        ["missing", "console.log('no output file was produced');", "invalid-output"],
        ["timeout", "setInterval(()=>{},100);", "timed-out"],
      ]) {
        const request = await nativeRunTestRequest(fx, name!, source!);
        if (name === "timeout") request.input.timeoutSeconds = 1;
        await writeFile(request.path, JSON.stringify(request.input));
        const attempted = await cli(request.argv);
        assert.equal(attempted.exitCode, 3, attempted.stderr);
        const observed = JSON.parse(attempted.stdout).record;
        assert.equal(observed.status, expected);
        const forged = await recordAcceptance(fx, {
          ...acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "satisfied"),
          checkKind: "computation",
          reportedCommand: null,
          nativeRunSha256: observed.recordSha256,
        });
        assert.equal(forged.exitCode, 3);
        const replay = await cli(request.argv);
        assert.equal(JSON.parse(replay.stdout).replayed, true);
      }
      const events = await readVerifiedJournal(workspacePaths(fx.root).journal);
      assert.equal(events.filter((event) => event.type === "project.task.run.started").length, 3);
      assert.equal(
        events.filter((event) => event.type === "project.task.acceptance.recorded").length,
        0,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps native calculation credentials out of its environment, diagnostics and journal", async () => {
    const fx = await acquiredFixture("computation");
    const previous = process.env.TIANGONG_TEST_NATIVE_SECRET;
    const secret = "native-run-secret-marker";
    process.env.TIANGONG_TEST_NATIVE_SECRET = secret;
    try {
      const source =
        "import {writeFile} from 'node:fs/promises';\nconst value=['native','run','secret','marker'].join('-');\nif(process.env.TIANGONG_TEST_NATIVE_SECRET)process.exit(9);\nconsole.error(['Author','ization'].join('')+': '+'Bearer'+' '+value);\nconsole.error('https://example.invalid/report'+'?'+['to','ken'].join('')+'='+value);\nconsole.error(process.cwd());\nawait writeFile(process.argv[3],JSON.stringify({credentialInherited:false}));\n";
      const request = await nativeRunTestRequest(fx, "secrets", source);
      const result = await cli(request.argv);
      assert.equal(result.exitCode, 0, result.stderr);
      const journal = await readFile(workspacePaths(fx.root).journal, "utf8");
      assert.equal((result.stdout + result.stderr + journal).includes(secret), false);
      assert.equal(result.stdout.includes(fx.files), false);
      assert.match(JSON.parse(result.stdout).record.process.diagnostic, /REDACTED/);
    } finally {
      if (previous === undefined) delete process.env.TIANGONG_TEST_NATIVE_SECRET;
      else process.env.TIANGONG_TEST_NATIVE_SECRET = previous;
      await fx.cleanup();
    }
  });

  it("rejects malformed provenance before committing an unreadable original task", async () => {
    const fx = await fixture();
    try {
      await writeFile(
        fx.inputPath,
        JSON.stringify({
          ...contractInput(),
          requestProvenance: {
            mode: "verbatim",
            source: { kind: "user-message", text: contractInput().originalRequest, locator: null },
            explanation: "        ",
          },
        }),
      );
      const result = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(result.exitCode, 3, result.stdout);
      assert.equal(
        (await readVerifiedJournal(workspacePaths(fx.root).journal)).some(
          (event) => event.type === "project.task.defined",
        ),
        false,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves original request provenance separately from interpreted requirements", async () => {
    const fx = await fixture();
    try {
      const original =
        "\uFEFFCompare electricity and water evidence, retaining uncertainty and counterevidence.\r\n";
      const input = {
        ...contractInput(),
        requestProvenance: {
          mode: "interpreted",
          source: { kind: "user-message", text: original, locator: "conversation:request-17" },
          explanation:
            "The requirement list operationalizes the quoted user message without assuming an outcome.",
        },
      };
      await writeFile(fx.inputPath, JSON.stringify(input));
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const inspected = await fx.task(["status"]);
      assert.equal(inspected.exitCode, 0, inspected.stderr);
      const context = JSON.parse(inspected.stdout);
      assert.equal(context.requestProvenance.mode, "interpreted");
      assert.equal(context.requestProvenance.source.textSha256, sha256Text(original));
      assert.equal(
        context.requestProvenance.source.locatorSha256,
        sha256Text("conversation:request-17"),
      );
      assert.equal(context.requestProvenance.authorshipVerified, false);
      const object = JSON.parse(
        await readFile(
          join(
            workspacePaths(fx.root).projects,
            "task-project",
            "task/request-sources",
            `${context.requestProvenance.source.objectSha256}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(object.text, original);
      assert.equal(inspected.stdout.includes("conversation:request-17"), false);
    } finally {
      await fx.cleanup();
    }
  });

  it("cannot call a rewritten request verbatim or add provenance retrospectively", async () => {
    const fx = await fixture();
    try {
      await writeFile(
        fx.inputPath,
        JSON.stringify({
          ...contractInput(),
          requestProvenance: {
            mode: "verbatim",
            source: {
              kind: "user-file",
              text: "A different original task must not be hidden.",
              locator: null,
            },
            explanation: "The user supplied this complete request.",
          },
        }),
      );
      const rejected = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(rejected.exitCode, 3);
      await writeFile(fx.inputPath, JSON.stringify(contractInput()));
      assert.equal((await fx.task(["define", "--input", fx.inputPath])).exitCode, 0);
      const inspected = await fx.task(["status"]);
      assert.equal(JSON.parse(inspected.stdout).requestProvenance.mode, "unrecorded");
      await writeFile(
        fx.inputPath,
        JSON.stringify({
          ...contractInput(),
          requestProvenance: {
            mode: "verbatim",
            source: { kind: "user-file", text: contractInput().originalRequest, locator: null },
            explanation: "An original file was supplied after the first definition.",
          },
        }),
      );
      assert.equal((await fx.task(["define", "--input", fx.inputPath])).exitCode, 3);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not charge a non-embedded raw input bundle against a later task context", async () => {
    const fx = await acquiredFixture("evidence", 33_000);
    try {
      const prepared = await prepareNativeResearchStage({
        root: fx.root,
        projectId: "task-project",
        stage: "analyze",
        hostAgent: "codex",
      });
      assert.match(prepared.prompt, /Original task and current authorized scope/);
      assert.match(prepared.prompt, /outputs\/inference-snapshot.json/);
      assert.doesNotMatch(prepared.prompt, /non-embedded-input-padding/);
    } finally {
      await fx.cleanup();
    }
  });

  it("prepares a detailed original task without an arbitrary input length rejection", async () => {
    const fx = await fixture();
    try {
      const input = contractInput();
      input.originalRequest = "Preserve this detailed original requirement. ".repeat(1_000);
      await writeFile(fx.inputPath, JSON.stringify(input));
      assert.equal((await fx.task(["define", "--input", fx.inputPath])).exitCode, 0);
      const prepared = await prepareNativeResearchStage({
        root: fx.root,
        projectId: "task-project",
        stage: "discover",
        hostAgent: "codex",
      });
      assert.match(prepared.prompt, /Original task and current authorized scope/);
      const project = await loadProject(fx.root, "task-project");
      assert.equal(project.packages.find((item) => item.id === "discover")?.attempts, 1);
      assert.equal(project.usage.tokens, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses to define original requirements retrospectively after a scientific review", async () => {
    const fx = await fixture();
    const projectId = "already-reviewed";
    try {
      await initializeProject(
        fx.root,
        projectId,
        "Preserve the original scope present when the scientific design was reviewed.",
        undefined,
        false,
        undefined,
        scientificPolicy(projectId),
        await scientificDesignInput(fx.root, projectId),
      );
      await passResearchDesignGate(fx.root, projectId);
      const before = await loadProject(fx.root, projectId);
      const result = await fx.task(["define", "--input", fx.inputPath], projectId);
      assert.equal(result.exitCode, 3, result.stdout);
      assert.equal(JSON.parse(result.stderr).error.code, "RESEARCH_TASK_WINDOW_REQUIRED");
      assert.deepEqual(
        (await loadProject(fx.root, projectId)).scientificDesign,
        before.scientificDesign,
      );
      assert.equal(
        (await readVerifiedJournal(workspacePaths(fx.root).journal)).some(
          (event) => event.scope === projectId && event.type === "project.task.defined",
        ),
        false,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("shows committed scope invalidation read-only after a crash before the state projection", async () => {
    const fx = await fixture();
    try {
      await initializeProject(
        fx.root,
        "source",
        "Retain precise task and scientific approval authority after interruption.",
        undefined,
        false,
        undefined,
        scientificPolicy("source"),
        await scientificDesignInput(fx.root, "source"),
      );
      const defined = await fx.task(["define", "--input", fx.inputPath], "source");
      assert.equal(defined.exitCode, 0, defined.stderr);
      await passResearchDesignGate(fx.root, "source");
      const scopePath = join(fx.files, "crash-scope.json");
      await writeFile(
        scopePath,
        JSON.stringify({
          schemaVersion: 1,
          reason: "Explicit operator scope change for a process-crash regression.",
          requirements: [contractInput().requirements[0]],
        }),
      );
      const proposed = await cli([
        "research",
        "project",
        "task",
        "scope",
        "propose",
        "source",
        "--input",
        scopePath,
        "--expected-contract",
        JSON.parse(defined.stdout).contractSha256,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(proposed.exitCode, 0, proposed.stderr);
      const proposalSha = JSON.parse(proposed.stdout).proposalSha256;
      const worker = fileURLToPath(
        new URL("./fixtures/research-recovery/crash-worker.mjs", import.meta.url),
      );
      const crashed = runResearchCrashWorker({
        worker,
        root: fx.root,
        point: "scope-committed",
        extraArgs: [proposalSha],
      });
      assert.equal(crashed.stderr, "");
      assert.ok(crashed.signal || crashed.status !== 0);
      assert.equal(await readFile(join(fx.root, "fault-point.txt"), "utf8"), "scope-committed");
      const projectPath = join(workspacePaths(fx.root).projects, "source", "project.json");
      const before = await readFile(projectPath);
      const status = await inspectScientificReviewStatus(fx.root, "source");
      assert.equal(status.gates?.["research-design"].status, "pending");
      assert.deepEqual(await readFile(projectPath), before);
      const replay = await cli([
        "research",
        "project",
        "task",
        "scope",
        "approve",
        "source",
        "--proposal",
        proposalSha,
        "--confirm-change",
        proposalSha,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).replayed, true);
      assert.equal(
        (await loadProject(fx.root, "source")).scientificDesign!.gates["research-design"].status,
        "pending",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("reports workflow completion separately when the reviewed task remains inconclusive", async () => {
    const fx = await acquiredFixture();
    try {
      for (const row of fx.rows)
        assert.equal(
          (await recordAcceptance(fx, acceptanceInput(row, fx.atom.atomId, [], "inconclusive")))
            .exitCode,
          0,
        );
      await finishProducer(fx);
      let calls = 0;
      const run = await runResearchWorkspace(
        fx.root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        async (request) => {
          calls += 1;
          const packet = JSON.parse(
            await readFile(join(request.projectRoot, "inputs/review-packet.json"), "utf8"),
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              packetSha256: packet.packetSha256,
              decision: "pass",
              issues: [],
              rationale: "The report accurately states that evidence is inconclusive.",
              taskAssessment: {
                contextSha256: packet.taskAcceptance.contextSha256,
                requirements: packet.taskAcceptance.requirements.map(
                  (row: { requirementSha256: string }) => ({
                    requirementSha256: row.requirementSha256,
                    decision: "not-answered",
                    reason: "The required evidence is still inconclusive.",
                  }),
                ),
              },
            }),
            stderr: "",
            tokens: 10,
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 5,
            costUsd: 0,
            wallSeconds: 0,
            model: null,
            runtime: null,
          };
        },
      );
      const value = JSON.parse(JSON.stringify(run));
      assert.equal(value.status, "complete");
      assert.equal(value.projects[0].task.currentScope.status, "incomplete");
      assert.equal(value.projects[0].task.originalScope.status, "incomplete");
      assert.equal(calls, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("exports task relationships and verifies a moved audit without the source workspace", async () => {
    const fx = await acquiredFixture();
    try {
      const recorded = await recordAcceptance(
        fx,
        acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "negative-result"),
      );
      assert.equal(recorded.exitCode, 0, recorded.stderr);
      const destination = join(fx.files, "audit");
      const exported = await cli([
        "research",
        "project",
        "audit",
        "export",
        "task-project",
        "--output",
        destination,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(exported.exitCode, 0, exported.stderr);
      const manifest = JSON.parse(exported.stdout);
      assert.match(manifest.researchChain.task.contextSha256, /^[a-f0-9]{64}$/);
      const moved = join(fx.files, "moved-audit");
      await cp(destination, moved, { recursive: true });
      await rm(fx.root, { recursive: true });
      const verified = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        moved,
        "--json",
      ]);
      assert.equal(verified.exitCode, 0, verified.stderr);
      assert.equal(
        JSON.parse(verified.stdout).task.contractSha256,
        manifest.researchChain.task.contractSha256,
      );
      assert.equal(JSON.parse(verified.stdout).task.executionCertified, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects audit task-binding changes even when the manifest hash is recomputed", async () => {
    const fx = await acquiredFixture();
    try {
      const destination = join(fx.files, "task-binding-audit");
      const exported = await cli([
        "research",
        "project",
        "audit",
        "export",
        "task-project",
        "--output",
        destination,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(exported.exitCode, 0, exported.stderr);
      const manifestPath = join(destination, "manifest.json");
      const original = JSON.parse(await readFile(manifestPath, "utf8"));
      const altered = structuredClone(original);
      altered.researchChain.task = {
        contractSha256: "a".repeat(64),
        originalContractSha256: "b".repeat(64),
        contextSha256: "c".repeat(64),
      };
      const { manifestSha256: _old, ...core } = altered;
      altered.manifestSha256 = sha256Text(canonicalJson(core));
      await chmod(manifestPath, 0o600);
      await writeFile(manifestPath, JSON.stringify(altered, null, 2) + "\n");
      const invalid = await cli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        destination,
        "--json",
      ]);
      assert.equal(invalid.exitCode, 3);
      assert.match(invalid.stderr, /RESEARCH_AUDIT_BUNDLE_INVALID/);
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves the exact BOM and CRLF bytes of native result files", async () => {
    const fx = await acquiredFixture();
    try {
      const path = join(fx.files, "result.csv");
      await writeFile(path, "\uFEFFname,value\r\nnull-result,0\r\n");
      const result = await recordAcceptance(
        fx,
        acceptanceInput(fx.rows[0]!, fx.atom.atomId, [path], "negative-result"),
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.results[0].sha256, await sha256File(path));
      assert.deepEqual(
        await readFile(
          join(workspacePaths(fx.root).projects, "task-project", receipt.results[0].path),
        ),
        await readFile(path),
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("retains a failed computation honestly when no result file was produced", async () => {
    const fx = await acquiredFixture("computation");
    try {
      const result = await recordAcceptance(fx, {
        ...acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "failed"),
        checkKind: "computation",
        reportedCommand: "node missing-check.mjs",
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).executionCertified, false);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.requirements[0].status, "failed");
      assert.equal(status.currentScope.status, "incomplete");
    } finally {
      await fx.cleanup();
    }
  });

  it("retains an unobserved computational report but does not promote it to verified execution", async () => {
    const fx = await acquiredFixture("computation");
    try {
      const path = join(fx.files, "reported-only.json");
      await writeFile(path, JSON.stringify({ reportedDifference: 0 }));
      const accepted = await recordAcceptance(fx, {
        ...acceptanceInput(fx.rows[0]!, fx.atom.atomId, [path], "negative-result"),
        checkKind: "computation",
        reportedCommand: "node claimed-calculation.mjs",
      });
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.requirements[0].status, "unverified-execution");
      assert.equal(status.currentScope.status, "incomplete");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects control-store result paths through a parent-directory alias", async () => {
    const fx = await acquiredFixture();
    try {
      await writeFile(
        join(workspacePaths(fx.root).control, "not-a-native-result.txt"),
        "Synthetic control bytes are not native execution results.\n",
      );
      const alias = join(fx.files, "control-alias");
      await symlink(
        workspacePaths(fx.root).control,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const result = await recordAcceptance(
        fx,
        acceptanceInput(
          fx.rows[0]!,
          fx.atom.atomId,
          [join(alias, "not-a-native-result.txt")],
          "satisfied",
        ),
      );
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /RESEARCH_TASK_/);
    } finally {
      await fx.cleanup();
    }
  });

  it("binds early scientific review to the task and invalidates its approval after an authorized scope change", async () => {
    const fx = await fixture();
    const id = "scientific-task";
    try {
      await initializeProject(
        fx.root,
        id,
        "Assess a declared scientific design without changing the original task silently.",
        undefined,
        false,
        undefined,
        scientificPolicy(id),
        await scientificDesignInput(fx.root, id),
      );
      const sourceText =
        "Exact owner-provided scientific request, including counterevidence and unsuccessful outcomes.\r\n";
      await writeFile(
        fx.inputPath,
        JSON.stringify({
          ...contractInput(),
          requestProvenance: {
            mode: "interpreted",
            source: {
              kind: "user-message",
              text: sourceText,
              locator: "conversation:scientific-original",
            },
            explanation:
              "The operational checklist interprets the supplied original request without authenticating authorship.",
          },
        }),
      );
      const defined = await fx.task(["define", "--input", fx.inputPath], id);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const originalContract = JSON.parse(defined.stdout).contractSha256;
      await passResearchDesignGate(fx.root, id);
      const original = await loadProject(fx.root, id);
      const packetPath = join(
        workspacePaths(fx.root).projects,
        id,
        "scientific/review-packets/research-design",
        `${original.scientificDesign!.gates["research-design"].packetSha256}.json`,
      );
      const packetBytes = await readFile(packetPath, "utf8");
      assert.equal(JSON.parse(packetBytes).taskContract.contractSha256, originalContract);
      const sourceRecord = JSON.parse(packetBytes).stageInputs.find(
        (item: { purpose: string }) => item.purpose === "original-request-source",
      );
      assert.ok(
        sourceRecord,
        "the real canary exposed a request hash with no reviewer-readable original source",
      );
      const sourceObjectBytes = await readFile(
        join(workspacePaths(fx.root).control, sourceRecord.path),
        "utf8",
      );
      assert.equal(JSON.parse(sourceObjectBytes).text, sourceText);
      assert.equal(sourceRecord.sha256, sha256Text(sourceObjectBytes));
      const proposalPath = join(fx.files, "science-scope.json");
      await writeFile(
        proposalPath,
        JSON.stringify({
          schemaVersion: 1,
          reason:
            "Owner explicitly withdraws one requirement; scientific design remains unchanged.",
          requirements: [contractInput().requirements[0]],
        }),
      );
      const proposal = await cli([
        "research",
        "project",
        "task",
        "scope",
        "propose",
        id,
        "--expected-contract",
        originalContract,
        "--input",
        proposalPath,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(proposal.exitCode, 0, proposal.stderr);
      const sha = JSON.parse(proposal.stdout).proposalSha256;
      const approved = await cli([
        "research",
        "project",
        "task",
        "scope",
        "approve",
        id,
        "--proposal",
        sha,
        "--confirm-change",
        sha,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(approved.exitCode, 0, approved.stderr);
      const current = await loadProject(fx.root, id);
      assert.equal(current.scientificDesign!.designSha256, original.scientificDesign!.designSha256);
      assert.deepEqual(current.publicationPolicy, original.publicationPolicy);
      assert.ok(
        Object.values(current.scientificDesign!.gates).every(
          (gate) => gate.status === "pending" && gate.packetSha256 === null,
        ),
      );
      assert.equal(await readFile(packetPath, "utf8"), packetBytes);
    } finally {
      await fx.cleanup();
    }
  });

  it("records exact native check results without certifying execution or completing the task", async () => {
    const fx = await acquiredFixture();
    try {
      const resultFile = join(fx.files, "observed-result.json");
      await writeFile(
        resultFile,
        JSON.stringify({
          difference: 0,
          interpretation: "A bounded synthetic null-result fixture.",
        }),
      );
      const input = acceptanceInput(fx.rows[0]!, fx.atom.atomId, [resultFile], "negative-result");
      const recorded = await recordAcceptance(fx, input);
      assert.equal(recorded.exitCode, 0, recorded.stderr);
      const receipt = JSON.parse(recorded.stdout);
      assert.equal(receipt.executionCertified, false);
      assert.equal(receipt.trust, "native-observation");
      assert.equal(receipt.results[0].sha256, await sha256File(resultFile));
      assert.doesNotMatch(recorded.stdout, new RegExp(fx.files));
      const before = await readFile(workspacePaths(fx.root).journal);
      const replay = await recordAcceptance(fx, input);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).recordSha256, receipt.recordSha256);
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "incomplete");
      assert.equal(status.currentScope.requirements[0].status, "recorded");
      assert.equal(status.currentScope.requirements[0].outcome, "negative-result");
      const stored = join(
        workspacePaths(fx.root).projects,
        "task-project",
        receipt.results[0].path,
      );
      await chmod(stored, 0o600);
      await writeFile(stored, "modified result\n");
      const tampered = await fx.task(["status"]);
      assert.equal(tampered.exitCode, 3);
      assert.equal(JSON.parse(tampered.stderr).error.code, "RESEARCH_TASK_ARTIFACT_DRIFT");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects invented execution certification and evidence IDs before recording acceptance", async () => {
    const fx = await acquiredFixture();
    try {
      const before = await readFile(workspacePaths(fx.root).journal);
      const input = acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "satisfied");
      for (const invalidInput of [
        { ...input, executionCertified: true },
        { ...input, evidenceAtomIds: ["invented-atom"] },
        { ...input, requirementSha256: "b".repeat(64) },
      ]) {
        const result = await recordAcceptance(fx, invalidInput);
        assert.equal(result.exitCode, 3);
        assert.match(result.stderr, /RESEARCH_TASK_/);
      }
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
    } finally {
      await fx.cleanup();
    }
  });

  it("uses the existing single independent review to accept valid negative findings and close task coverage", async () => {
    const fx = await acquiredFixture();
    try {
      const sharedResult = join(fx.files, "shared-result.json");
      await writeFile(sharedResult, JSON.stringify({ fixtureDifference: 0 }));
      for (const row of fx.rows) {
        const recorded = await recordAcceptance(
          fx,
          acceptanceInput(row, fx.atom.atomId, [sharedResult], "negative-result"),
        );
        assert.equal(recorded.exitCode, 0, recorded.stderr);
      }
      await finishProducer(fx);
      assert.equal(
        (await readdir(join(workspacePaths(fx.root).projects, "task-project", "task/results")))
          .length,
        1,
      );
      let reviewCalls = 0;
      const run = await runResearchWorkspace(
        fx.root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        async (request) => {
          reviewCalls += 1;
          const packet = JSON.parse(
            await readFile(join(request.projectRoot, "inputs/review-packet.json"), "utf8"),
          );
          assert.equal(packet.taskAcceptance.requirements.length, 2);
          assert.equal(packet.taskAcceptance.originalRequest, contractInput().originalRequest);
          assert.equal(packet.taskAcceptance.results.length, 1);
          const views = await openArtifactViews(
            request.projectRoot,
            request.artifactViews!.index,
            packet.packetSha256,
          );
          const results = views.index.objects.filter(
            (item) => item.sha256 === packet.taskAcceptance.results[0].sha256,
          );
          assert.equal(results.length, 1);
          assert.deepEqual(
            JSON.parse((await views.read({ objectId: results[0]!.objectId })).content),
            { fixtureDifference: 0 },
          );
          assert.ok(
            Array.isArray(request.outputSchema?.required) &&
              request.outputSchema.required.includes("taskAssessment"),
          );
          const review = {
            schemaVersion: 1,
            packetSha256: packet.packetSha256,
            decision: "pass",
            issues: [],
            rationale: "Bounded independent fixture review.",
            taskAssessment: {
              contextSha256: packet.taskAcceptance.contextSha256,
              requirements: packet.taskAcceptance.requirements.map(
                (row: { requirementSha256: string }) => ({
                  requirementSha256: row.requirementSha256,
                  decision: "answered",
                  reason: "The declared null-result criterion is met within the exact fixture.",
                }),
              ),
            },
          };
          return {
            exitCode: 0,
            stdout: JSON.stringify(review),
            artifactReads: views.receipts(),
            stderr: "",
            tokens: 10,
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 5,
            costUsd: 0,
            wallSeconds: 0,
            model: null,
            runtime: null,
          };
        },
      );
      assert.equal(run.status, "complete", JSON.stringify(run));
      assert.equal(reviewCalls, 1);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "complete");
      assert.equal(status.originalScope.status, "complete");
      assert.ok(
        status.currentScope.requirements.every(
          (row: { status: string }) => row.status === "reviewed",
        ),
      );
      assert.equal(status.executionCertified, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not promote an inconclusive check just because the workflow reviewer returns pass", async () => {
    const fx = await acquiredFixture();
    try {
      for (const row of fx.rows) {
        const recorded = await recordAcceptance(
          fx,
          acceptanceInput(row, fx.atom.atomId, [], "inconclusive"),
        );
        assert.equal(recorded.exitCode, 0, recorded.stderr);
      }
      await finishProducer(fx);
      const run = await runResearchWorkspace(
        fx.root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          const packet = JSON.parse(
            await readFile(join(request.projectRoot, "inputs/review-packet.json"), "utf8"),
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              packetSha256: packet.packetSha256,
              decision: "pass",
              issues: [],
              rationale: "An invalid overclaim fixture.",
              taskAssessment: {
                contextSha256: packet.taskAcceptance.contextSha256,
                requirements: packet.taskAcceptance.requirements.map(
                  (row: { requirementSha256: string }) => ({
                    requirementSha256: row.requirementSha256,
                    decision: "answered",
                    reason: "Improperly promotes an inconclusive result.",
                  }),
                ),
              },
            }),
            stderr: "",
            tokens: 10,
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 5,
            costUsd: 0,
            wallSeconds: 0,
            model: null,
            runtime: null,
          };
        },
      );
      assert.notEqual(run.status, "complete");
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "incomplete");
    } finally {
      await fx.cleanup();
    }
  });
  it("defines immutable requirements and derives separate original/current completion without a model", async () => {
    const fx = await fixture();
    try {
      const unassessed = await fx.task(["status"]);
      assert.equal(unassessed.exitCode, 0, unassessed.stderr);
      assert.equal(JSON.parse(unassessed.stdout).status, "not-configured");
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const binding = JSON.parse(defined.stdout);
      assert.match(binding.contractSha256, /^[a-f0-9]{64}$/);
      const before = await readFile(workspacePaths(fx.root).journal);
      const repeated = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).contractSha256, binding.contractSha256);
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.originalScope.status, "incomplete");
      assert.equal(status.currentScope.status, "incomplete");
      assert.deepEqual(
        status.currentScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      assert.ok(
        status.currentScope.requirements.every(
          (entry: { status: string }) => entry.status === "unanswered",
        ),
      );
      assert.equal(status.executionCertified, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("requires exact separate scope authorization and keeps withdrawn original requirements visible", async () => {
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const original = JSON.parse(defined.stdout).contractSha256;
      const input = join(fx.files, "scope.json");
      await writeFile(
        input,
        JSON.stringify({
          schemaVersion: 1,
          reason: "Owner proposes postponing the unavailable water dataset.",
          requirements: [contractInput().requirements[0]],
        }),
      );
      const proposed = await cli([
        "research",
        "project",
        "task",
        "scope",
        "propose",
        "task-project",
        "--input",
        input,
        "--expected-contract",
        original,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(proposed.exitCode, 0, proposed.stderr);
      const proposal = JSON.parse(proposed.stdout);
      assert.deepEqual(proposal.changes.withdrawnRequirementIds, ["water"]);
      assert.deepEqual(
        proposal.changes.details.find((item: { id: string }) => item.id === "water").before,
        contractInput().requirements[1],
      );
      assert.equal(JSON.parse((await fx.task(["status"])).stdout).contractSha256, original);
      const approve = (confirmation?: string) =>
        cli([
          "research",
          "project",
          "task",
          "scope",
          "approve",
          "task-project",
          "--proposal",
          proposal.proposalSha256,
          ...(confirmation ? ["--confirm-change", confirmation] : []),
          "--workspace",
          fx.root,
          "--json",
        ]);
      const missing = await approve();
      assert.equal(missing.exitCode, 3);
      assert.equal(JSON.parse(missing.stderr).error.code, "RESEARCH_TASK_SCOPE_APPROVAL_REQUIRED");
      const mismatched = await approve("a".repeat(64));
      assert.equal(mismatched.exitCode, 3);
      const accepted = await approve(proposal.proposalSha256);
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.notEqual(status.contractSha256, original);
      assert.equal(status.originalContractSha256, original);
      assert.deepEqual(
        status.currentScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity"],
      );
      assert.equal(
        status.originalScope.requirements.find((entry: { id: string }) => entry.id === "water")
          .status,
        "withdrawn",
      );
      assert.equal(status.originalScope.status, "incomplete");
      assert.equal(status.scopeAuthorization.kind, "operator-confirmation");
      const events = await readVerifiedJournal(workspacePaths(fx.root).journal);
      assert.equal(
        events.filter((event) => event.type === "project.task.scope.approved").length,
        1,
      );
      const replay = await approve(proposal.proposalSha256);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.deepEqual(await readVerifiedJournal(workspacePaths(fx.root).journal), events);
      assert.equal(
        (await loadProject(fx.root, "task-project")).question,
        "Compare electricity and water evidence without presupposing a result.",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects producer approval flags, duplicate IDs and sensitive content before committing a task", async () => {
    const fx = await fixture();
    try {
      const before = await readFile(workspacePaths(fx.root).journal);
      for (const value of [
        { ...contractInput(), approved: true },
        {
          ...contractInput(),
          requirements: [contractInput().requirements[0], contractInput().requirements[0]],
        },
        {
          ...contractInput(),
          originalRequest: "Authorization: Bearer private-test-token-123456789",
        },
      ]) {
        await writeFile(fx.inputPath, JSON.stringify(value));
        const result = await fx.task(["define", "--input", fx.inputPath]);
        assert.equal(result.exitCode, 3);
        assert.equal(JSON.parse(result.stderr).error.code, "RESEARCH_TASK_INVALID");
        assert.doesNotMatch(result.stdout + result.stderr, /private-test-token/);
      }
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves original requirements through a fork without inheriting completion", async () => {
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const forked = await cli([
        "research",
        "project",
        "fork",
        "task-project",
        "--to",
        "task-successor",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(forked.exitCode, 0, forked.stderr);
      const status = await fx.task(["status"], "task-successor");
      assert.equal(status.exitCode, 0, status.stderr);
      const result = JSON.parse(status.stdout);
      assert.equal(result.originalContractSha256, JSON.parse(defined.stdout).contractSha256);
      assert.deepEqual(
        result.originalScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      assert.equal(result.currentScope.status, "incomplete");
      assert.equal(result.origin.projectId, "task-project");
    } finally {
      await fx.cleanup();
    }
  });

  it("exposes task schemas offline and puts the bound task in the native stage packet", async () => {
    const schema = await cli(["research", "schema", "show", "task-contract", "--json"]);
    assert.equal(schema.exitCode, 0, schema.stderr);
    assert.equal(JSON.parse(schema.stdout).additionalProperties, false);
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const prepared = await cli([
        "research",
        "project",
        "stage",
        "prepare",
        "task-project",
        "--stage",
        "discover",
        "--host-agent",
        "codex",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(prepared.exitCode, 0, prepared.stderr);
      const packet = JSON.parse(prepared.stdout);
      assert.equal(packet.taskContract.contractSha256, JSON.parse(defined.stdout).contractSha256);
      assert.deepEqual(
        packet.taskContract.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      const late = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(late.exitCode, 0, late.stderr); // An exact read-only acknowledgement is harmless.
    } finally {
      await fx.cleanup();
    }
  });
});

async function nativeRunTestRequest(
  fx: Awaited<ReturnType<typeof acquiredFixture>>,
  name: string,
  source: string,
) {
  const scriptPath = join(fx.files, `${name}.mjs`);
  const environmentLockPath = join(fx.files, `${name}-environment.json`);
  await writeFile(scriptPath, source);
  await writeFile(environmentLockPath, JSON.stringify({ node: process.version, dependencies: [] }));
  const input = {
    schemaVersion: 1,
    runId: `observed-${name}`,
    requirementId: fx.rows[0]!.id,
    requirementSha256: fx.rows[0]!.requirementSha256,
    nativeSessionId: null,
    workingDirectory: fx.files,
    runtime: { kind: "node", path: process.execPath },
    scriptPath,
    environmentLockPath,
    inputs: [{ id: "source", artifactId: fx.artifact.artifactId, sha256: fx.artifact.sha256 }],
    outputs: [{ id: "result", fileName: "result.json", mediaType: "application/json" }],
    arguments: ["{input:source}", "{output:result}"],
    timeoutSeconds: 30,
  };
  const path = join(fx.files, `${name}-run.json`);
  await writeFile(path, JSON.stringify(input));
  return {
    input,
    path,
    argv: [
      "research",
      "project",
      "task",
      "run",
      "observe",
      "task-project",
      "--input",
      path,
      "--confirm-execution",
      "--workspace",
      fx.root,
      "--json",
    ],
  };
}

function acceptanceInput(
  row: { id: string; requirementSha256: string },
  atomId: string,
  resultFiles: string[],
  outcome: string,
) {
  return {
    schemaVersion: 1,
    requirementId: row.id,
    requirementSha256: row.requirementSha256,
    previousRecordSha256: null,
    outcome,
    summary: "Observed fixture result with explicit limitations, not a CLI-certified execution.",
    checkKind: "evidence",
    reportedCommand: null,
    sourceIds: ["source-1"],
    evidenceAtomIds: [atomId],
    analysisFindingIds: [],
    resultFiles,
    limitations: ["Synthetic protocol fixture; not a scientific conclusion."],
  };
}

async function recordAcceptance(fx: Awaited<ReturnType<typeof fixture>>, value: object) {
  const path = join(fx.files, "acceptance.json");
  await writeFile(path, JSON.stringify(value));
  return cli([
    "research",
    "project",
    "task",
    "acceptance",
    "record",
    "task-project",
    "--input",
    path,
    "--workspace",
    fx.root,
    "--json",
  ]);
}

async function finishProducer(fx: Awaited<ReturnType<typeof acquiredFixture>>) {
  const analyze = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "analyze",
    hostAgent: "codex",
  });
  const inference = JSON.parse(
    await readFile(
      join(workspacePaths(fx.root).projects, "task-project", "outputs/inference-snapshot.json"),
      "utf8",
    ),
  );
  await submitFixtureStage(fx, analyze, {
    schemaVersion: 2,
    inferenceSnapshotSha256: inference.snapshotSha256,
    analysisRun: {
      id: "native-fixture-observation",
      mode: "qualitative",
      status: "not-applicable",
      implementationSha256s: [],
      environmentSha256s: [],
      inputArtifactSha256s: [fx.artifact.sha256],
      command: null,
      randomSeed: null,
      limitations: [],
    },
    findings: [
      {
        id: "finding-1",
        statement: "This fixture supplies bounded null-result evidence.",
        evidence: ["source-1"],
        evidenceAtomIds: [fx.atom.atomId],
        claimIds: [],
        analysisArtifactSha256s: [],
        uncertainty: "Synthetic fixture only.",
        applicability: "Protocol verification, not real-world inference.",
      },
    ],
    limitations: [],
  });
  const synthesize = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "synthesize",
    hostAgent: "codex",
  });
  await submitFixtureStage(fx, synthesize, {
    schemaVersion: 1,
    reportMarkdown:
      "# Bounded null result\n\nThe synthetic fixture supplies a null comparison with explicit limitations. This is protocol validation, not a real scientific study.\n",
  });
}

function scientificPolicy(projectId: string): ResearchPolicyBinding {
  return {
    goal: "top-journal",
    projectId,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
    targetJournal: "International Journal of Pavement Engineering",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
  };
}

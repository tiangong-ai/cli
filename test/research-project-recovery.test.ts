import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { runResearchCrashWorker } from "./helpers/research-crash-worker.js";

import { runCli } from "../src/cli.js";
import { CliError } from "../src/errors.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { evidenceLedgerPath } from "../src/research/workspace/evidence-ledger.js";
import { readJournal } from "../src/research/workspace/journal.js";
import {
  forkProject,
  initializeProject,
  loadProject,
  retryProjectPackage,
  saveProject,
} from "../src/research/workspace/projects.js";
import { prepareNativeResearchStage } from "../src/research/workspace/runtime.js";
import { pathExists, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = join(repo, "test", "fixtures", "research-recovery", "crash-worker.mjs");

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
  });
  return { exitCode, stdout, stderr };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tiangong-project-recovery-"));
  await initializeResearchWorkspace(root, "Synthetic process-crash regression");
  await lockCapabilities(root);
  await initializeProject(root, "source", "Recover a research fork without external execution.");
  return root;
}

function killFork(root: string, point: string) {
  return runResearchCrashWorker({
    worker,
    root,
    point,
    cwd: repo,
  });
}

describe("committed research project authority and crash recovery", () => {
  it("refuses a linked source directory even when its external state has the expected hash", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "tiangong-recovery-source-owner-"));
    try {
      killFork(root, "committed");
      const sourceDirectory = join(workspacePaths(root).projects, "source");
      const before = await readFile(join(sourceDirectory, "project.json"));
      await rename(sourceDirectory, join(root, "saved-source"));
      await writeFile(join(outside, "project.json"), before);
      await symlink(outside, sourceDirectory, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(forkProject(root, "source", "target"), {
        code: "RESEARCH_PROJECT_RECOVERY_REQUIRED",
      });
      assert.deepEqual(await readFile(join(outside, "project.json")), before);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not overwrite a concurrently changed source after a committed response is lost", async () => {
    const root = await fixture();
    try {
      killFork(root, "committed");
      const source = await loadProject(root, "source");
      source.question = "Preserve an external owner change instead of overwriting it.";
      await saveProject(root, source);
      await assert.rejects(forkProject(root, "source", "target"), {
        code: "RESEARCH_PROJECT_RECOVERY_REQUIRED",
      });
      assert.equal((await loadProject(root, "source")).question, source.question);
      assert.equal(await pathExists(join(workspacePaths(root).projects, "target")), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unknown targets and refuses linked replacements during recovery", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "tiangong-recovery-owner-"));
    try {
      await writeFile(join(outside, "owner.txt"), "Owner bytes must survive.\n");
      const targetPath = join(workspacePaths(root).projects, "target");
      killFork(root, "target-state");
      await rename(targetPath, join(root, "saved-interrupted-target"));
      await symlink(outside, targetPath, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(forkProject(root, "source", "target"), {
        code: "RESEARCH_PROJECT_RECOVERY_REQUIRED",
      });
      assert.equal(
        await readFile(join(outside, "owner.txt"), "utf8"),
        "Owner bytes must survive.\n",
      );
      assert.equal((await loadProject(root, "source")).lineage.supersededBy, null);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not leak malformed recovery-record contents through errors", async () => {
    const root = await fixture();
    try {
      killFork(root, "target-state");
      const pending = join(
        workspacePaths(root).control,
        "lineage",
        "pending-project-mutations",
        "fork-target.json",
      );
      await writeFile(pending, "Cookie: private-value Authorization: secret-value");
      const result = await invoke([
        "research",
        "project",
        "fork",
        "source",
        "--to",
        "target",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /RESEARCH_PROJECT_RECOVERY_REQUIRED/);
      assert.doesNotMatch(result.stderr, /private-value|secret-value|Cookie:/);
      assert.equal(
        await readFile(pending, "utf8"),
        "Cookie: private-value Authorization: secret-value",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const point of ["retry-state", "retry-committed"]) {
    it("recovers a report revision and acknowledges its lost response at " + point, async () => {
      const root = await fixture();
      try {
        const source = await loadProject(root, "source");
        for (const item of source.packages) {
          if (["discover", "acquire", "analyze", "synthesize"].includes(item.stage)) {
            item.status = "complete";
            item.completedAt = "2026-09-02T00:00:00.000Z";
          }
          if (item.stage === "review") {
            item.status = "failed";
            item.lastError = "Independent review requested revision.";
            item.lastFailureKind = "configuration";
          }
        }
        await saveProject(root, source);
        const report = join(workspacePaths(root).projects, "source", "outputs", "report.md");
        await writeFile(report, "# Preserved report\n");
        const child = killFork(root, point);
        assert.equal(child.stderr, "");
        assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), point);
        const recovered = await retryProjectPackage(root, "source", "synthesize");
        assert.equal(
          recovered.packages.find((item) => item.stage === "synthesize")?.status,
          "ready",
        );
        assert.deepEqual(await retryProjectPackage(root, "source", "synthesize"), recovered);
        assert.equal(
          (await readJournal(workspacePaths(root).journal)).filter(
            (event) => event.type === "project.retry.requested",
          ).length,
          1,
        );
        assert.equal(await readFile(report, "utf8"), "# Preserved report\n");
        const archives = await readdir(
          join(workspacePaths(root).projects, "source", "outputs", "revisions", "synthesize"),
        );
        assert.equal(archives.length, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const point of ["target-directory", "target-state", "source-state"]) {
    it(`keeps one consistent authority after a fork crash at ${point}`, async () => {
      const root = await fixture();
      try {
        const child = killFork(root, point);
        assert.equal(child.stderr, "");
        assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), point);
        assert.ok(child.signal || child.status !== 0);
        const events = await readJournal(workspacePaths(root).journal);
        const committed = events.some(
          (event) => event.type === "project.forked" && event.scope === "target",
        );
        const status = await invoke(["research", "status", "--workspace", root, "--json"]);
        assert.equal(status.exitCode, 0, status.stderr);
        const projects = JSON.parse(status.stdout).projects as Array<{
          id: string;
          authority: { state: string };
        }>;
        const authoritative = projects.filter(
          (project) => project.authority.state === "authoritative",
        );
        assert.deepEqual(
          authoritative.map((project) => project.id),
          [committed ? "target" : "source"],
        );
        if (!committed) {
          const prepared = await invoke([
            "research",
            "project",
            "stage",
            "prepare",
            "target",
            "--stage",
            "discover",
            "--host-agent",
            "codex",
            "--workspace",
            root,
            "--json",
          ]);
          assert.notEqual(
            prepared.exitCode,
            0,
            "An uncommitted target must not receive a native packet",
          );
          assert.equal(
            (await readJournal(workspacePaths(root).journal)).some(
              (event) => event.type === "native.stage.prepared" && event.scope === "target",
            ),
            false,
          );
        }
        const recovered = await forkProject(root, "source", "target");
        assert.equal(recovered.id, "target");
        assert.equal((await loadProject(root, "source")).lineage.supersededBy, "target");
        const replay = await forkProject(root, "source", "target");
        assert.deepEqual(replay, recovered);
        assert.equal(
          (await readJournal(workspacePaths(root).journal)).filter(
            (event) => event.type === "project.forked" && event.scope === "target",
          ).length,
          1,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("acknowledges a committed fork after its response is lost without repeating work", async () => {
    const root = await fixture();
    try {
      const child = killFork(root, "committed");
      assert.equal(child.stderr, "");
      assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), "committed");
      const targetBefore = await loadProject(root, "target");
      const replay = await forkProject(root, "source", "target");
      assert.deepEqual(replay, targetBefore);
      assert.equal(
        (await readJournal(workspacePaths(root).journal)).filter(
          (event) => event.type === "project.forked" && event.scope === "target",
        ).length,
        1,
      );
      await assert.rejects(
        forkProject(root, "source", "target", "discover"),
        (error: unknown) => error instanceof CliError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leave a false supersession ledger entry when the fork commit fails", async () => {
    const root = await fixture();
    try {
      const child = killFork(root, "before-commit");
      assert.equal(child.status, 0, child.stderr);
      assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), "before-commit");
      assert.equal((await loadProject(root, "source")).lineage.supersededBy, null);
      assert.equal(await pathExists(join(workspacePaths(root).projects, "target")), false);
      const ledger = await readJournal(evidenceLedgerPath(root, "source"));
      assert.equal(
        ledger.some((event) => event.type === "project.superseded"),
        false,
      );
      assert.equal((await forkProject(root, "source", "target")).id, "target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the same historical authority guard to public native prepare", async () => {
    const root = await fixture();
    try {
      await forkProject(root, "source", "target");
      const before = await loadProject(root, "source");
      await assert.rejects(
        prepareNativeResearchStage({
          root,
          projectId: "source",
          stage: "discover",
          hostAgent: "codex",
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      );
      assert.deepEqual(await loadProject(root, "source"), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

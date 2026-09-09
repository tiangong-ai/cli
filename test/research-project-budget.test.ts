import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";
import { sha256File, workspacePaths, writeJsonAtomic } from "../src/research/workspace/storage.js";

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "research-project-budget-")));
  await initializeResearchWorkspace(root, "Synthetic project budgets", "smoke-test");
  const config = await loadWorkspaceConfig(root);
  config.budget.maxCostUsd = 5000;
  config.budget.confirmationCostUsd = 100;
  for (const route of [config.producer, config.reviewer]) {
    route.pricing = {
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 2,
    };
  }
  await writeJsonAtomic(workspacePaths(root).config, config);
  return root;
}

async function cli(root: string, args: string[]) {
  let stdout = "",
    stderr = "";
  const code = await runCli(["research", ...args, "--workspace", root, "--json"], {
    env: {},
    stdout: {
      write: (value: string) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr += value;
      },
    },
  });
  return { code, body: JSON.parse(stdout || stderr), stderr };
}

// These values are synthetic accounting inputs, not provider invoices.
describe("numeric project budget authorization", () => {
  it("binds a project 50 ceiling beneath workspace 5000 without rewriting shared configuration", async () => {
    const root = await workspace();
    try {
      const configSha = await sha256File(workspacePaths(root).config);
      const preflight = await cli(root, [
        "project",
        "preflight",
        "--question",
        "How should this synthetic evidence be evaluated?",
        "--max-cost-usd",
        "50",
      ]);
      assert.notEqual(preflight.code, 2, preflight.stderr);
      assert.equal(preflight.body.budget.maxCostUsd, 50);
      assert.equal(preflight.body.budget.workspaceMaxCostUsd, 5000);
      assert.equal(preflight.body.budget.projectMaxCostUsd, 50);
      assert.equal(
        preflight.body.budget.confirmationRequired,
        false,
        "confirmation uses the selected 50, not the workspace default 5000",
      );
      const created = await cli(root, [
        "project",
        "init",
        "budget-project",
        "--question",
        "How should this synthetic evidence be evaluated?",
        "--max-cost-usd",
        "50",
      ]);
      assert.equal(created.code, 0, created.stderr);
      assert.equal(created.body.budget.authorization.maxCostUsd, 50);
      assert.equal(created.body.budget.authorization.revision, 1);
      const status = await cli(root, ["status", "--project", "budget-project"]);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(status.body.projects[0].budget.effectiveMaxCostUsd, 50);
      assert.equal(status.body.projects[0].budget.workspaceMaxCostUsd, 5000);
      assert.equal(status.body.projects[0].budget.authorization.maxCostUsd, 50);
      assert.equal(
        await sha256File(workspacePaths(root).config),
        configSha,
        "one project's budget must not invalidate shared workspace configuration/Doctor evidence",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tightens explicitly, reuses an unchanged authorization, and requires confirmation for an increase", async () => {
    const root = await workspace();
    try {
      const initialized = await cli(root, [
        "project",
        "init",
        "budget-project",
        "--question",
        "How should this synthetic evidence be evaluated?",
        "--max-cost-usd",
        "50",
        "--confirm-budget",
      ]);
      assert.equal(initialized.code, 0, initialized.stderr);
      const tightened = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        "40",
      ]);
      assert.equal(tightened.code, 0, tightened.stderr);
      assert.equal(tightened.body.budget.authorization.maxCostUsd, 40);
      assert.equal(tightened.body.budget.authorization.revision, 2);
      const unchanged = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        "40",
      ]);
      assert.equal(unchanged.code, 0, unchanged.stderr);
      assert.deepEqual(unchanged.body.budget.authorization, tightened.body.budget.authorization);
      const refused = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        "60",
      ]);
      assert.equal(refused.body.error?.code, "RESEARCH_BUDGET_CONFIRMATION_REQUIRED");
      const approved = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        "60",
        "--confirm-budget",
      ]);
      assert.equal(approved.code, 0, approved.stderr);
      assert.equal(approved.body.budget.authorization.maxCostUsd, 60);
      assert.equal(approved.body.budget.authorization.revision, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

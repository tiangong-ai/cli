import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import { reserveProjectCost, settleProjectCost } from "../src/research/workspace/project-budget.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import {
  prepareNativeResearchStage,
  abortNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
  withWorkspaceLock,
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
  it("records an owner-estimated overrun without silently increasing the authorization", async () => {
    const root = await workspace();
    try {
      await fundedProject(root);
      await withWorkspaceLock(root, "test.pending-overrun", async () => {
        const project = await loadProject(root, "budget-project");
        reserveProjectCost(project, await loadWorkspaceConfig(root), {
          id: "uncertain",
          kind: "provider-operation",
          reference: "synthetic",
          maxCostUsd: 15,
        });
        await saveProject(root, project);
      });
      const resolved = await cli(root, [
        "project",
        "budget",
        "resolve",
        "budget-project",
        "--reservation",
        "uncertain",
        "--accounted-cost-usd",
        "100",
        "--reason",
        "Owner supplied a conservative estimate after the operation.",
        "--confirm-budget",
      ]);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.equal(resolved.body.budget.authorization.maxCostUsd, 50);
      assert.equal(resolved.body.budget.accountedEstimateUsd, 100);
      assert.equal(resolved.body.budget.overrunEstimateUsd, 50);
      assert.equal(resolved.body.budget.admissionState, "overrun");
      await assert.rejects(
        withWorkspaceLock(root, "test.overrun-blocks-next", async () => {
          const project = await loadProject(root, "budget-project");
          reserveProjectCost(project, await loadWorkspaceConfig(root), {
            id: "next",
            kind: "provider-operation",
            reference: "synthetic",
            maxCostUsd: 1,
          });
        }),
        { code: "RESEARCH_BUDGET_RESERVATION_FAILED" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps inherited native funding pending until its old session is explicitly stopped", async () => {
    const root = await workspace();
    try {
      await fundedProject(root);
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "budget-project",
        stage: "discover",
        hostAgent: "codex",
      });
      const id = `native:${packet.sessionId}`;
      const args = [
        "project",
        "budget",
        "resolve",
        "budget-project",
        "--reservation",
        id,
        "--accounted-cost-usd",
        "0",
        "--reason",
        "Synthetic caller has verified no provider expense.",
        "--confirm-budget",
      ];
      assert.equal((await cli(root, args)).body.error?.code, "RESEARCH_BUDGET_OPERATION_ACTIVE");
      assert.equal(
        (await cli(root, ["project", "fork", "budget-project", "--to", "budget-next"])).code,
        0,
      );
      args[3] = "budget-next";
      assert.equal((await cli(root, args)).body.error?.code, "RESEARCH_BUDGET_OPERATION_ACTIVE");
      await abortNativeResearchStage({
        root,
        projectId: "budget-project",
        sessionId: packet.sessionId,
      });
      const pending = (await loadProject(root, "budget-next")).budget!.entries.find(
        (e) => e.id === id,
      )!;
      assert.equal(pending.status, "reserved");
      assert.equal(pending.sourceProjectId, "budget-project");
      const resolved = await cli(root, args);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.equal(resolved.body.budget.remainingUsd, 50);
      assert.equal(resolved.body.budget.providerInvoiceUsd, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses 10 before execution when 30 is accounted and 15 is still reserved under 50", async () => {
    const root = await workspace();
    try {
      await fundedProject(root);
      await withWorkspaceLock(root, "test.account-and-reserve", async () => {
        const project = await loadProject(root, "budget-project"),
          config = await loadWorkspaceConfig(root);
        reserveProjectCost(project, config, {
          id: "spent",
          kind: "review",
          reference: "synthetic",
          maxCostUsd: 30,
        });
        settleProjectCost(project, "spent", 30, "reported-usage");
        reserveProjectCost(project, config, {
          id: "pending",
          kind: "provider-operation",
          reference: "synthetic",
          maxCostUsd: 15,
        });
        await saveProject(root, project);
      });
      let calls = 0;
      await assert.rejects(
        withWorkspaceLock(root, "test.next-operation", async () => {
          const project = await loadProject(root, "budget-project");
          reserveProjectCost(project, await loadWorkspaceConfig(root), {
            id: "next",
            kind: "provider-operation",
            reference: "synthetic",
            maxCostUsd: 10,
          });
          await saveProject(root, project);
          calls++;
        }),
        { code: "RESEARCH_BUDGET_RESERVATION_FAILED" },
      );
      assert.equal(calls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not allocate two in-flight operations of 4 from a remaining allowance of 5", async () => {
    const root = await workspace();
    try {
      await fundedProject(root);
      await withWorkspaceLock(root, "test.spent", async () => {
        const project = await loadProject(root, "budget-project"),
          config = await loadWorkspaceConfig(root);
        reserveProjectCost(project, config, {
          id: "spent",
          kind: "review",
          reference: "synthetic",
          maxCostUsd: 45,
        });
        settleProjectCost(project, "spent", 45, "reported-usage");
        await saveProject(root, project);
      });
      let signalReserved!: () => void,
        finishFirst!: () => void,
        calls = 0;
      const reserved = new Promise<void>((resolve) => {
        signalReserved = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const first = (async () => {
        await withWorkspaceLock(root, "test.first-reservation", async () => {
          const project = await loadProject(root, "budget-project");
          reserveProjectCost(project, await loadWorkspaceConfig(root), {
            id: "first",
            kind: "provider-operation",
            reference: "synthetic",
            maxCostUsd: 4,
          });
          await saveProject(root, project);
        });
        calls++;
        signalReserved();
        await pending;
      })();
      await reserved;
      try {
        await assert.rejects(
          withWorkspaceLock(root, "test.second-reservation", async () => {
            const project = await loadProject(root, "budget-project");
            reserveProjectCost(project, await loadWorkspaceConfig(root), {
              id: "second",
              kind: "provider-operation",
              reference: "synthetic",
              maxCostUsd: 4,
            });
            await saveProject(root, project);
            calls++;
          }),
          { code: "RESEARCH_BUDGET_RESERVATION_FAILED" },
        );
        assert.equal(calls, 1);
      } finally {
        finishFirst();
        await first;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("transfers unresolved reservation identity and requires explicit owner resolution without inventing an invoice", async () => {
    const root = await workspace();
    try {
      await fundedProject(root);
      await withWorkspaceLock(root, "test.pending-operation", async () => {
        const project = await loadProject(root, "budget-project");
        reserveProjectCost(project, await loadWorkspaceConfig(root), {
          id: "pending-provider",
          kind: "provider-operation",
          reference: "synthetic-provider",
          maxCostUsd: 15,
        });
        await saveProject(root, project);
      });
      const forked = await cli(root, ["project", "fork", "budget-project", "--to", "budget-next"]);
      assert.equal(forked.code, 0, forked.stderr);
      const next = await loadProject(root, "budget-next");
      const pending = next.budget!.entries.find((e) => e.id === "pending-provider");
      assert.equal(
        pending?.status,
        "reserved",
        "a fork must not turn an unresolved operation into a settled charge",
      );
      assert.equal(pending?.maxCostUsd, 15);
      const resolveArgs = [
        "project",
        "budget",
        "resolve",
        "budget-next",
        "--reservation",
        "pending-provider",
        "--accounted-cost-usd",
        "0",
        "--reason",
        "Synthetic owner confirmed this operation did not reach a provider.",
      ];
      const refused = await cli(root, resolveArgs);
      assert.equal(refused.body.error?.code, "RESEARCH_BUDGET_CONFIRMATION_REQUIRED");
      const blank = [...resolveArgs];
      blank[blank.indexOf("--accounted-cost-usd") + 1] = "";
      const invalid = await cli(root, [...blank, "--confirm-budget"]);
      assert.equal(
        invalid.body.error?.code,
        "INVALID_ARGS",
        "an empty estimate must not become zero",
      );
      const resolved = await cli(root, [...resolveArgs, "--confirm-budget"]);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.equal(resolved.body.budget.outstandingReservationsUsd, 0);
      assert.equal(resolved.body.budget.accountedEstimateUsd, 0);
      assert.equal(resolved.body.budget.providerInvoiceUsd, null);
      const replay = await cli(root, [...resolveArgs, "--confirm-budget"]);
      assert.equal(replay.code, 0, replay.stderr);
      assert.equal(replay.body.replayed, true);
      const historical = await cli(root, [
        "project",
        "budget",
        "resolve",
        "budget-project",
        "--reservation",
        "pending-provider",
        "--accounted-cost-usd",
        "0",
        "--reason",
        "Do not mutate a superseded financial authority.",
        "--confirm-budget",
      ]);
      assert.equal(historical.body.error?.code, "RESEARCH_PROJECT_NOT_AUTHORITATIVE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a lifecycle estimate that fits the workspace guard but exceeds the selected project amount", async () => {
    const root = await workspace();
    try {
      const config = await loadWorkspaceConfig(root);
      for (const route of [config.producer, config.reviewer])
        route.pricing = {
          inputUsdPerMillionTokens: 1000,
          cachedInputUsdPerMillionTokens: 1000,
          outputUsdPerMillionTokens: 1000,
        };
      await writeJsonAtomic(workspacePaths(root).config, config);
      const result = await cli(root, [
        "project",
        "preflight",
        "--question",
        "How should this synthetic evidence be evaluated?",
        "--max-cost-usd",
        "50",
      ]);
      assert.equal(result.code, 3, result.stderr);
      assert.ok(
        result.body.budget.estimatedMaxCostUsd > 50 &&
          result.body.budget.estimatedMaxCostUsd < 5000,
      );
      assert.ok(
        result.body.gaps.some((gap: string) =>
          /^package-cost-reservations-exceed-total:.*\/50$/u.test(gap),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the authorization and already-accounted cost across the authoritative recovery chain", async () => {
    const root = await workspace();
    try {
      await initializeProject(
        root,
        "budget-source",
        "How should this synthetic evidence be evaluated?",
      );
      await withWorkspaceLock(root, "test.synthetic-accounted-usage", async () => {
        const project = await loadProject(root, "budget-source");
        project.usage.costUsd = 30;
        await saveProject(root, project);
      });
      const authorized = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-source",
        "--max-cost-usd",
        "50",
        "--confirm-budget",
      ]);
      assert.equal(authorized.code, 0, authorized.stderr);
      const forked = await cli(root, ["project", "fork", "budget-source", "--to", "budget-next"]);
      assert.equal(forked.code, 0, forked.stderr);
      const status = await cli(root, ["status", "--project", "budget-next"]);
      assert.equal(status.body.projects[0].budget.authorization.maxCostUsd, 50);
      assert.equal(status.body.projects[0].budget.accountedEstimateUsd, 30);
      assert.equal(status.body.projects[0].budget.remainingUsd, 20);
      const stale = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-source",
        "--max-cost-usd",
        "100",
        "--confirm-budget",
      ]);
      assert.equal(stale.body.error?.code, "RESEARCH_PROJECT_NOT_AUTHORITATIVE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adopts an existing native reservation and never refunds an unobserved abort to fund retries", async () => {
    const root = await workspace();
    try {
      await initializeProject(
        root,
        "budget-project",
        "How should this synthetic evidence be evaluated?",
      );
      await withWorkspaceLock(root, "test.synthetic-accounted-usage", async () => {
        const project = await loadProject(root, "budget-project");
        project.usage.costUsd = 30;
        await saveProject(root, project);
      });
      const first = await prepareNativeResearchStage({
        root,
        projectId: "budget-project",
        stage: "discover",
        hostAgent: "codex",
      });
      const reserved = first.limits.reservedMaxCostUsd;
      assert.ok(reserved > 0 && reserved < 20);
      const tooSmall = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        String(30 + reserved / 2),
        "--confirm-budget",
      ]);
      assert.equal(tooSmall.body.error?.code, "RESEARCH_BUDGET_RESERVATION_FAILED");
      const admitted = await cli(root, [
        "project",
        "budget",
        "set",
        "budget-project",
        "--max-cost-usd",
        "50",
        "--confirm-budget",
      ]);
      assert.equal(admitted.code, 0, admitted.stderr);
      const active = await cli(root, ["status", "--project", "budget-project"]);
      assert.equal(active.body.projects[0].nativeStage.sessionId, first.sessionId);
      assert.ok(active.body.projects[0].budget.outstandingReservationsUsd >= reserved);
      assert.equal(active.body.projects[0].budget.providerInvoiceUsd, null);
      await abortNativeResearchStage({
        root,
        projectId: "budget-project",
        sessionId: first.sessionId,
      });
      const second = await prepareNativeResearchStage({
        root,
        projectId: "budget-project",
        stage: "discover",
        hostAgent: "codex",
      });
      const after = await cli(root, ["status", "--project", "budget-project"]);
      const budget = after.body.projects[0].budget;
      assert.ok(
        budget.accountedEstimateUsd + budget.outstandingReservationsUsd >=
          30 + reserved + second.limits.reservedMaxCostUsd - 0.000001,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

async function fundedProject(root: string) {
  const result = await cli(root, [
    "project",
    "init",
    "budget-project",
    "--question",
    "How should this synthetic evidence be evaluated?",
    "--max-cost-usd",
    "50",
    "--confirm-budget",
  ]);
  assert.equal(result.code, 0, result.stderr);
}

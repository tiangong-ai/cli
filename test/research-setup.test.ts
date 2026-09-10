import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import {
  loadCapabilityDeclarations,
  lockCapabilities,
  verifyCapabilities,
} from "../src/research/workspace/capabilities.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import { packageVersion } from "../src/research/workspace/constants.js";
import { evaluateRequiredResearchCompanions } from "../src/research/workspace/companion-readiness.js";
import {
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
} from "../src/research/workspace/external-skills.js";
import {
  inspectResearchSetupCatalog,
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SKILLS,
  setupTargetRoot,
  verifyResearchSetupRuntimeContract,
} from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  checkResearchSetupUpdates,
  createResearchSetupPlan,
  doctorResearchSetup,
  inspectResearchSetupStatus,
  loadAndVerifyResearchSetupPlan,
  retryResearchSetup,
  runResearchSetupCompanion,
  setResearchSetupCredentialFromEnvironment,
} from "../src/research/workspace/setup.js";
import {
  researchSetupApplyCommand,
  researchSetupRetryCommand,
} from "../src/research/workspace/setup-invocation.js";
import {
  createResearchSetupWizardTheme,
  executeResearchSetupWizard,
  formatResearchSetupWizardNote,
  readResearchSetupCredentialStdin,
  shouldUseResearchSetupWizardColor,
  type ResearchSetupWizardNoteTone,
  type ResearchSetupWizardPrompt,
} from "../src/research/workspace/setup-wizard.js";
import {
  canonicalJson,
  hashRegularTree,
  sha256File,
  sha256Text,
  workspacePaths,
} from "../src/research/workspace/storage.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";

describe("research setup catalog and immutable plans", () => {
  it("reports a separately sourced, pinned, role-aware recommendation catalog", async () => {
    const root = await temporaryDirectory();
    try {
      const catalog = await inspectResearchSetupCatalog({ selectedPath: root });
      assert.equal(catalog.policy.bundledSkills, false);
      assert.equal(catalog.policy.userInitiatedOnly, true);
      assert.equal(catalog.policy.runtimeInstall, false);
      assert.equal(catalog.policy.defaultScope, "project");
      assert.equal(catalog.policy.defaultInstallMode, "copy");
      assert.equal(catalog.policy.floatingUpdates, false);
      assert.deepEqual(catalog.installer, RESEARCH_SETUP_INSTALLER);
      assert.equal(catalog.entries.length, 18);
      assert.ok(catalog.entries.every((entry) => entry.bundled === false));
      assert.ok(catalog.entries.every((entry) => entry.userInitiatedOnly === true));
      assert.ok(catalog.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.expectedTreeSha256)));
      assert.ok(catalog.sources.every((source) => /^[0-9a-f]{40}$/.test(source.immutableRef)));
      assert.equal(
        catalog.sources.find((source) => source.id === "tiangong-ai-skills")?.immutableRef,
        "812881fec1ad4141da240c1caa252e262779057f",
      );
      assert.equal(
        catalog.entries.find((entry) => entry.id === "tiangong.auto-research")?.expectedTreeSha256,
        "16d4adda6a82e855061976c2fd6f4e10c6690fb819c2d96e4725541c79193758",
      );
      assert.ok(catalog.roles.evidenceCapabilities.includes("tiangong.kb-sci-search"));
      assert.ok(catalog.roles.evidenceCapabilities.includes("tiangong.kb-report-search"));
      assert.ok(catalog.roles.evidenceCapabilities.includes("tiangong.kb-patent-search"));
      assert.deepEqual(
        catalog.entries.find((entry) => entry.id === "tiangong.auto-research")?.runtimeContract,
        {
          mode: "workspace-lock",
          resolverRelativePath: "scripts/research_cli.mjs",
          exactCliVersionLiterals: "forbidden",
        },
      );
      assert.equal(
        catalog.entries.find((entry) => entry.id === "tiangong.kb-report-search")
          ?.standaloneTestedCliVersion,
        "0.0.30",
      );
      assert.deepEqual(catalog.roles.orchestrators, [
        "tiangong.auto-research",
        "tiangong.auto-research-workbuddy",
      ]);
      assert.equal(
        catalog.entries.find((entry) => entry.id === "tiangong.auto-research-workbuddy")
          ?.expectedTreeSha256,
        "e5be05338b95e4729e45eec27ed9089c59b073f928d4e5e4f3befec809e29482",
      );
      assert.ok(catalog.roles.inputPreprocessors.includes("tiangong.document-granular-decompose"));
      assert.ok(catalog.roles.acquisitionAdapters.includes("tiangong.academic-paper-download"));
      assert.ok(catalog.roles.postClosureAuthoring.includes("anthropic.docx"));
      assert.equal(
        catalog.entries.find((entry) => entry.id === "tiangong.document-granular-decompose")
          ?.expectedTreeSha256,
        "e7ef2d0fe57582d3d0ce7e847a2165498f91aa13ba35a260f494fc2407d7d07e",
      );
      assert.deepEqual(
        catalog.entries
          .find((entry) => entry.id === "anthropic.docx")
          ?.dependencies.map((dependency) => dependency.id),
        [
          "python-3.10",
          "authoring:defusedxml",
          "authoring:lxml",
          "authoring:node-docx",
          "authoring:pandoc",
          "authoring:libreoffice",
          "authoring:poppler",
          "authoring:zip",
          "authoring:unzip",
        ],
      );
      assert.deepEqual(
        catalog.entries
          .find((entry) => entry.id === "anthropic.pdf")
          ?.dependencies.map((dependency) => dependency.id),
        [
          "python-3.10",
          "authoring:pypdf",
          "authoring:pdfplumber",
          "authoring:reportlab",
          "authoring:pillow",
          "authoring:pdf2image",
          "authoring:pandas",
          "authoring:poppler",
        ],
      );
      assert.deepEqual(
        catalog.entries
          .find((entry) => entry.id === "anthropic.pptx")
          ?.dependencies.map((dependency) => dependency.id),
        [
          "python-3.10",
          "authoring:defusedxml",
          "authoring:lxml",
          "authoring:pillow",
          "authoring:python-pptx",
          "authoring:markitdown",
          "authoring:node-pptxgenjs",
          "authoring:libreoffice",
          "authoring:poppler",
          "authoring:zip",
          "authoring:unzip",
        ],
      );
      assert.deepEqual(
        catalog.entries
          .find((entry) => entry.id === "anthropic.xlsx")
          ?.dependencies.map((dependency) => dependency.id),
        [
          "python-3.10",
          "authoring:openpyxl",
          "authoring:pandas",
          "authoring:markitdown",
          "authoring:libreoffice",
        ],
      );
      assert.deepEqual(
        Object.fromEntries(
          catalog.entries
            .filter((entry) => entry.sourceId === "brave-search-skills")
            .map((entry) => [entry.skillName, entry.sourceRelativePath]),
        ),
        {
          "web-search": "skills/web-search",
          "news-search": "skills/news-search",
          "llm-context": "skills/llm-context",
          "images-search": "skills/images-search",
          "videos-search": "skills/videos-search",
        },
      );
      assert.equal(
        catalog.entries.find((entry) => entry.id === "anthropic.doc-coauthoring")?.license.label,
        "NOASSERTION",
      );
      assert.match(
        catalog.entries.find((entry) => entry.id === "anthropic.docx")?.license.notice ?? "",
        /not open source/i,
      );
      assert.equal(
        catalog.entries.find((entry) => entry.id === "hugohe3.ppt-master")?.expectedTreeSha256,
        "229514a9ae52ff958ba80307a071c3235c72aa137fb8f9dedda61d103b8e3902",
      );
      assert.deepEqual(catalog.conflictGroups, []);
      assert.deepEqual(catalog.selectionGuidance.pptCreation, {
        preferredSkillId: "hugohe3.ppt-master",
        situationalSkillIds: ["anthropic.pptx"],
        maySelectTogether: true,
        automaticSelection: false,
        guidance:
          "Prefer PPT Master for creating PPT presentations; use Anthropic PPTX when its workflow better fits the task. Both remain explicit post-closure choices.",
      });
      assert.deepEqual(
        catalog.entries
          .filter((entry) => entry.sourceId === "tiangong-ai-skills" && entry.defaultSelected)
          .map((entry) => entry.id),
        ["tiangong.auto-research"],
      );
      assert.equal(
        setupTargetRoot({
          workspace: root,
          scope: "global",
          agent: "codex",
          environment: {
            HOME: join(root, "operator-home"),
            CODEX_HOME: join(root, "ignored-codex-home"),
          },
        }),
        join(root, "operator-home", ".agents", "skills"),
      );
      assert.equal(
        setupTargetRoot({
          workspace: root,
          scope: "global",
          agent: "claude-code",
          environment: { CLAUDE_CONFIG_DIR: join(root, "operator-claude") },
        }),
        join(root, "operator-claude", "skills"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mechanically enforces the workspace-lock resolver and forbids stale exact CLI literals", async () => {
    const root = await temporaryDirectory();
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.auto-research",
    )!;
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await mkdir(join(root, "references"), { recursive: true });
      await writeFile(
        join(root, "SKILL.md"),
        "Use scripts/research_cli.mjs for workspace commands.\n",
      );
      await writeFile(join(root, "references", "setup.md"), "Use the locked resolver.\n");
      await writeFile(join(root, "scripts", "research_cli.mjs"), "// fixture resolver\n");
      const verified = await verifyResearchSetupRuntimeContract(root, skill);
      assert.equal(verified.status, "verified");
      assert.deepEqual(verified.scannedInstructionFiles, ["SKILL.md", "references/setup.md"]);

      await writeFile(join(root, "SKILL.md"), "npx --yes @tiangong-ai/cli@0.0.26 research run\n");
      await assert.rejects(
        () => verifyResearchSetupRuntimeContract(root, skill),
        (error) =>
          error instanceof Error &&
          (error as Error & { code: string }).code === "RESEARCH_SETUP_RUNTIME_CONTRACT_INVALID" &&
          !JSON.stringify(error).includes(root),
      );

      await writeFile(join(root, "SKILL.md"), "Use scripts/research_cli.mjs.\n");
      await rm(join(root, "scripts", "research_cli.mjs"));
      await symlink(join(root, "SKILL.md"), join(root, "scripts", "research_cli.mjs"));
      await assert.rejects(
        () => verifyResearchSetupRuntimeContract(root, skill),
        (error) =>
          error instanceof Error &&
          (error as Error & { code: string }).code === "RESEARCH_SETUP_RUNTIME_CONTRACT_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds every Brave evidence profile to the pinned upstream skills directory", async () => {
    const profiles = [
      {
        profile: EXTERNAL_SKILL_PROFILE,
        expectedPaths: ["skills/web-search", "skills/news-search"],
      },
      {
        profile: EXTERNAL_SKILL_CONTEXT_PROFILE,
        expectedPaths: ["skills/web-search", "skills/news-search", "skills/llm-context"],
      },
      {
        profile: EXTERNAL_SKILL_MEDIA_PROFILE,
        expectedPaths: [
          "skills/web-search",
          "skills/news-search",
          "skills/llm-context",
          "skills/images-search",
          "skills/videos-search",
        ],
      },
    ] as const;
    for (const testCase of profiles) {
      const root = await temporaryDirectory();
      try {
        const plan = await createResearchSetupPlan({
          workspace: root,
          mode: "production-research",
          evidenceProfile: testCase.profile,
          skillIds: [],
          acceptedLicenseIds: ["brave-search-skills:MIT"],
          credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
          confirmNetworkDownloads: true,
        });
        assert.deepEqual(
          plan.skills
            .filter((skill) => skill.sourceId === "brave-search-skills")
            .map((skill) => skill.sourceRelativePath)
            .sort(),
          [...testCase.expectedPaths].sort(),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("creates a hash-bound plan before workspace initialization and exposes setup context", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createEmptyPlan(root);
      const canonicalRoot = await realpath(root);
      assert.equal(plan.workspace.path, canonicalRoot);
      assert.equal(plan.install.scope, "project");
      assert.deepEqual(plan.reviewerExecution, {
        transport: "native-direct",
        isolationProvider: "platform-capsule",
      });
      assert.deepEqual(plan.install.targets, [
        { agent: "codex", root: join(canonicalRoot, ".agents", "skills") },
      ]);
      assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
      assert.equal(
        plan.mutations.find((mutation) => mutation.step === "workspace")?.target,
        workspacePaths(canonicalRoot).control,
      );
      const context = await inspectResearchContext(root);
      assert.equal(context.role, "setup");
      assert.ok(context.allowedOperations.includes("research.setup.apply"));
      assert.deepEqual(context.setup, {
        status: "pending",
        currentStep: null,
        blocker: null,
        runtime: {
          packageName: "@tiangong-ai/cli",
          packageVersion: plan.cli.version,
          source: "setup-plan",
        },
        next: {
          action: "apply",
          retryCommand: researchSetupApplyCommand({
            version: plan.cli.version,
            planPath: workspacePaths(canonicalRoot).setupPlan,
          }),
        },
      });
      const status = await inspectResearchSetupStatus(root);
      assert.equal(status.state.status, "pending");
      assert.equal(status.next?.action, "apply");
      assert.equal(status.next?.retryCommand, context.setup?.next?.retryCommand);
      assert.deepEqual(status.credentialReadiness, {
        valuesEmitted: false,
        configuredIds: [],
        missingRequiredIds: [],
        scopes: [],
      });
      assert.equal(status.provenance.effectiveCli.packageName, "@tiangong-ai/cli");
      assert.equal(status.provenance.effectiveCli.packageVersion, plan.cli.version);
      assert.equal(status.provenance.effectiveCli.invocationMode, "exact-npx");
      assert.equal(status.provenance.selectedOrchestrator, null);
      const priorCwd = process.cwd();
      try {
        process.chdir(root);
        const blockedSearch = await invoke(
          [
            "research",
            "search",
            "--query",
            "must not reach ambient provider",
            "--dry-run",
            "--json",
          ],
          {},
        );
        assert.equal(blockedSearch.exitCode, 3);
        assert.match(blockedSearch.stderr, /AUTO_RESEARCH_SETUP_INCOMPLETE/);
        assert.match(blockedSearch.stderr, /"credentialScope":"broker"/);
        assert.doesNotMatch(blockedSearch.stderr, /STANDALONE_AMBIENT_CREDENTIAL_MISSING/);
        assert.match(blockedSearch.stderr, /research setup apply/);
      } finally {
        process.chdir(priorCwd);
      }
      const loaded = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
      assert.deepEqual(loaded, plan);
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).setupPlan)).mode & 0o222, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds an explicit sandbox-bridge choice into the plan and workspace config", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        reviewerExecution: {
          transport: "sandbox-bridge",
          isolationProvider: "platform-capsule",
        },
        confirmNetworkDownloads: false,
      });
      assert.equal(plan.reviewerExecution.transport, "sandbox-bridge");
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        environment: {},
        skipDoctor: true,
      });
      const config = await loadWorkspaceConfig(root);
      assert.deepEqual(config.reviewerExecution, plan.reviewerExecution);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records WorkBuddy as the native producer while keeping a CLI-only reviewer", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        agentRoutes: {
          producerAgent: "workbuddy",
          reviewerAgent: "claude",
          producerModel: "hy3",
          reviewerModel: "claude-reviewer",
        },
        reviewerExecution: {
          transport: "sandbox-bridge",
          isolationProvider: "platform-capsule",
        },
        confirmNetworkDownloads: false,
      });
      assert.equal(plan.agentRoutes.producerAgent, "workbuddy");
      assert.equal(plan.agentRoutes.reviewerAgent, "claude");
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        environment: {},
        skipDoctor: true,
      });
      const config = await loadWorkspaceConfig(root);
      assert.equal(config.producer.agent, "workbuddy");
      assert.equal(config.producer.executionMode, "native-host");
      assert.equal(config.producer.binary, "workbuddy-native-host");
      assert.equal(config.reviewer.agent, "claude");
      assert.equal(config.reviewer.executionMode, "headless-cli");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports ignored ambient CLI and Skill conflicts for project-scoped setup", async () => {
    const root = await temporaryDirectory();
    const operatorHome = await temporaryDirectory();
    const bin = join(operatorHome, "bin");
    const realCli = join(bin, "ambient-tiangong-ai");
    const linkedCli = join(bin, "tiangong-ai");
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.auto-research",
    )!;
    const ambientSkill = join(operatorHome, ".agents", "skills", skill.skillName);
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(realCli, "#!/bin/sh\nexit 0\n");
      await chmod(realCli, 0o755);
      await symlink(realCli, linkedCli);
      await mkdir(ambientSkill, { recursive: true });
      await writeFile(join(ambientSkill, "SKILL.md"), "# unrelated ambient copy\n");
      await mkdir(join(ambientSkill, "scripts"));
      await writeFile(
        join(ambientSkill, "scripts", "legacy.sh"),
        'CLI="${TIANGONG_AI_CLI:-tiangong-ai}"\n',
      );
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: [skill.license.id],
        confirmNetworkDownloads: true,
      });

      const status = await inspectResearchSetupStatus(root, {
        HOME: operatorHome,
        PATH: bin,
      });
      assert.deepEqual(status.provenance.ambientCli, {
        path: await realpath(realCli),
        ignoredByExactInvocation: true,
      });
      assert.deepEqual(status.provenance.ambientSkillConflicts, [
        {
          skillId: skill.id,
          skillName: skill.skillName,
          agent: "codex",
          path: ambientSkill,
          status: "drifted",
          observedTreeSha256: await hashRegularTree(ambientSkill),
          expectedTreeSha256: skill.expectedTreeSha256,
          unmanagedPathCliFallback: true,
          ignoredByProjectScope: true,
        },
      ]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(operatorHome, { recursive: true, force: true }),
      ]);
    }
  });

  it("canonicalizes a symlinked parent before review but rejects a symlinked workspace leaf", async () => {
    const fixture = await temporaryDirectory();
    const realParent = join(fixture, "real-parent");
    const linkedParent = join(fixture, "linked-parent");
    const realWorkspace = join(realParent, "workspace");
    const linkedWorkspace = join(linkedParent, "workspace");
    const linkedLeaf = join(fixture, "linked-leaf");
    try {
      await mkdir(realParent);
      await mkdir(realWorkspace);
      await symlink(realParent, linkedParent);
      await symlink(realWorkspace, linkedLeaf);

      const plan = await createEmptyPlan(linkedWorkspace);
      const canonicalWorkspace = await realpath(realWorkspace);
      assert.equal(plan.workspace.path, canonicalWorkspace);
      assert.deepEqual(plan.install.targets, [
        { agent: "codex", root: join(canonicalWorkspace, ".agents", "skills") },
      ]);
      assert.equal(await pathExistsSafe(workspacePaths(canonicalWorkspace).setupPlan), true);

      await assert.rejects(
        createEmptyPlan(linkedLeaf),
        errorCode("RESEARCH_SETUP_WORKSPACE_INVALID"),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("requires explicit licenses and rejects ambiguous or unsafe selections", async () => {
    const root = await temporaryDirectory();
    try {
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "production-research",
          evidenceProfile: "none",
          skillIds: [],
          acceptedLicenseIds: [],
          confirmNetworkDownloads: false,
        }),
        errorCode("RESEARCH_SETUP_SELECTION_INVALID"),
      );
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "smoke-test",
          evidenceProfile: "none",
          skillIds: ["tiangong.academic-paper-download"],
          acceptedLicenseIds: [],
          confirmNetworkDownloads: true,
        }),
        errorCode("RESEARCH_SETUP_LICENSE_NOT_ACCEPTED"),
      );
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "smoke-test",
          evidenceProfile: "none",
          skillIds: [],
          acceptedLicenseIds: [],
          liveChecks: false,
          allowSyntheticUnstructureUpload: true,
          confirmNetworkDownloads: false,
        }),
        errorCode("RESEARCH_SETUP_CONFIRMATION_REQUIRED"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows PPT Master and Anthropic PPTX in the same explicit setup plan", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["anthropic.pptx", "hugohe3.ppt-master"],
        acceptedLicenseIds: ["anthropic-skills:document-terms", "ppt-master:MIT"],
        confirmNetworkDownloads: true,
      });
      assert.deepEqual(plan.selection.skillIds, ["anthropic.pptx", "hugohe3.ppt-master"]);
      assert.deepEqual(
        plan.skills.map((skill) => skill.role),
        ["post-closure-authoring", "post-closure-authoring"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects both direct tampering and hash-valid catalog reinterpretation", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      const planPath = workspacePaths(root).setupPlan;
      await chmod(planPath, 0o600);
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
      const workspace = plan.workspace as Record<string, unknown>;
      workspace.name = "tampered";
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      await assert.rejects(
        loadAndVerifyResearchSetupPlan(planPath),
        errorCode("RESEARCH_SETUP_PLAN_TAMPERED"),
      );

      const mutations = plan.mutations as Array<Record<string, unknown>>;
      mutations[0]!.target = join(root, "wrong-control-target");
      const { planSha256: _oldHash, ...unsigned } = plan;
      plan.planSha256 = sha256Text(canonicalJson(unsigned));
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      await assert.rejects(
        loadAndVerifyResearchSetupPlan(planPath),
        errorCode("RESEARCH_SETUP_PLAN_CATALOG_DRIFT"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an immutable setup plan from an earlier CLI release", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      const planPath = workspacePaths(root).setupPlan;
      await chmod(planPath, 0o600);
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
      (plan.cli as Record<string, unknown>).version = "0.0.29";
      const { planSha256: _oldHash, ...unsigned } = plan;
      plan.planSha256 = sha256Text(canonicalJson(unsigned));
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      const update = await checkResearchSetupUpdates(root);
      assert.equal(update.updateAvailable, true);
      assert.deepEqual(update.cliVersionDrift, { planned: "0.0.29", active: packageVersion() });
      assert.match(update.policy.minimumAction, /replacement immutable plan/i);
      await assert.rejects(
        loadAndVerifyResearchSetupPlan(planPath),
        errorCode("RESEARCH_SETUP_CLI_DRIFT"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives an old immutable generation before explicit replacement", async () => {
    const root = await temporaryDirectory();
    try {
      const first = await createEmptyPlan(root);
      const firstBytes = await readFile(workspacePaths(root).setupPlan, "utf8");
      const second = await createResearchSetupPlan({
        workspace: root,
        name: "replacement",
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      assert.notEqual(first.planSha256, second.planSha256);
      assert.equal(
        await readFile(
          join(workspacePaths(root).control, "setup-history", first.planSha256, "setup-plan.json"),
          "utf8",
        ),
        firstBytes,
      );
      const applied = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
      });
      assert.equal(applied.state.status, "partially-ready");
      assert.equal((await inspectResearchContext(root)).role, "workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves owner custom capability credentials while staging a setup credential", async () => {
    const root = await temporaryDirectory();
    const customSecret = "owner-custom-capability-secret";
    const braveSecret = "owner-brave-setup-secret";
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: [],
        acceptedLicenseIds: ["brave-search-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
        confirmNetworkDownloads: true,
      });
      const skillPath = join(root, "owner-custom-skill");
      await mkdir(skillPath);
      await writeFile(join(skillPath, "SKILL.md"), "# owner custom capability\n");
      const expectedTreeSha256 = await hashRegularTree(skillPath);
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify({
          schemaVersion: 1,
          capabilities: [
            {
              id: "database.owner.custom",
              skillPath,
              source: {
                type: "local",
                locator: "owner-custom-fixture",
                immutableRef: `sha256:${expectedTreeSha256}`,
                expectedTreeSha256,
                license: "MIT",
                catalogId: null,
              },
              requiredForDiscovery: false,
              permissions: ["project-read", "candidate-write", "brokered-network"],
              allowedHosts: ["owner.example.test"],
              http: {
                endpoint: "https://owner.example.test/",
                accept: "application/json",
                allowedContentTypes: ["application/json"],
                maxResponseBytes: 4096,
                maxItems: 10,
              },
              coverage: {
                dimensions: ["*"],
                sourceTypes: ["*"],
                discoveryScopes: ["database:owner"],
                fullText: false,
                publicationDates: true,
              },
              credentials: [
                {
                  id: "database.owner.api-key",
                  allowedHosts: ["owner.example.test"],
                  headerName: "Authorization",
                  prefix: "Bearer ",
                },
              ],
              healthCheck: null,
            },
          ],
        })}\n`,
      );
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.owner.api-key":"${customSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);

      const result = await setResearchSetupCredentialFromEnvironment({
        workspace: root,
        credentialId: "brave.search.api-key",
        environmentName: "BRAVE_API_KEY",
        environment: { BRAVE_API_KEY: braveSecret },
      });
      assert.equal(JSON.stringify(result).includes(braveSecret), false);
      assert.equal(JSON.stringify(result).includes(customSecret), false);
      const stored = await readFile(workspacePaths(root).env, "utf8");
      assert.equal(stored.includes(customSecret), true);
      assert.equal(stored.includes(braveSecret), true);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(customSecret), false);
      assert.equal(journal.includes(braveSecret), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles all deselected setup-managed capabilities while preserving custom capabilities and Skill bytes", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const capabilities = [];
      for (const [id, skillName, catalogId] of [
        ["method.brave.llm-context", "llm-context", "external.brave.llm-context"],
        [
          "database.tiangong.sci-search",
          "tiangong-kb-sci-search",
          "first-party.tiangong.kb-sci-search",
        ],
        ["database.owner.custom", "owner-custom-search", null],
      ] as const) {
        const skillPath = join(root, ".agents", "skills", skillName);
        await mkdir(skillPath, { recursive: true });
        await writeFile(
          join(skillPath, "SKILL.md"),
          `---\nname: ${skillName}\ndescription: Fixture capability.\n---\n\n# Fixture\n`,
        );
        const expectedTreeSha256 = await hashRegularTree(skillPath);
        capabilities.push({
          id,
          skillPath,
          source: {
            type: "git",
            locator:
              catalogId === null
                ? "https://github.com/example/owner-custom-search.git"
                : catalogId.startsWith("external.brave")
                  ? "https://github.com/brave/brave-search-skills.git"
                  : "https://github.com/tiangong-ai/skills.git",
            immutableRef: "a".repeat(40),
            expectedTreeSha256,
            license: "MIT",
            catalogId,
          },
          requiredForDiscovery: false,
          permissions: ["project-read"],
          allowedHosts: [],
          http: null,
          coverage: null,
          credentials: [],
          healthCheck: null,
        });
      }
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify({ schemaVersion: 1, capabilities }, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await writeFile(
        workspacePaths(root).env,
        'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"obsolete.context.key":"obsolete-broker-secret"}\n',
        { mode: 0o600 },
      );
      await writeFile(
        workspacePaths(root).setupAdapterEnv,
        'TIANGONG_RESEARCH_ADAPTER_CREDENTIALS_JSON={"semantic-scholar.api-key":"obsolete-adapter-secret"}\n',
        { mode: 0o600 },
      );

      await createResearchSetupPlan({
        workspace: root,
        name: "reconciled",
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });

      const declarations = await loadCapabilityDeclarations(root);
      assert.deepEqual(
        declarations.capabilities.map((capability) => capability.id),
        ["database.owner.custom"],
      );
      assert.equal((await verifyCapabilities(root)).status, "verified");
      assert.equal(
        await pathExistsSafe(join(root, ".agents", "skills", "llm-context", "SKILL.md")),
        true,
      );
      assert.equal(
        await pathExistsSafe(join(root, ".agents", "skills", "tiangong-kb-sci-search", "SKILL.md")),
        true,
      );
      assert.equal((await readFile(workspacePaths(root).env, "utf8")).includes("secret"), false);
      assert.equal(
        (await readFile(workspacePaths(root).setupAdapterEnv, "utf8")).includes("secret"),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research setup execution and operator safety", () => {
  it("configures a reproducible source checkout before verifying and installing bytes", async () => {
    const root = await temporaryDirectory();
    const skill = RESEARCH_SETUP_SKILLS.find((candidate) => candidate.id === "hugohe3.ppt-master")!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    const calls: string[][] = [];
    let installerCachePath: string | null = null;
    try {
      const fixture = join(root, "fixture-ppt-master");
      await mkdir(fixture, { recursive: true });
      await writeFile(join(fixture, "SKILL.md"), "# deterministic checkout fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(fixture);
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["ppt-master:MIT"],
        confirmNetworkDownloads: true,
      });
      const source = plan.sources.find((candidate) => candidate.id === skill.sourceId)!;
      let hasHead = false;
      const result = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: async ({ command, args, environment }) => {
          calls.push([command, ...args]);
          if (command === "npm") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                version: RESEARCH_SETUP_INSTALLER.version,
                "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
                gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
              }),
              stderr: "",
            };
          }
          if (command === "git" && args[0] === "init") {
            await mkdir(args.at(-1)!, { recursive: true });
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[2] === "remote" && args[3] === "get-url") {
            return { exitCode: 0, stdout: `${source.locator}\n`, stderr: "" };
          }
          if (command === "git" && args[2] === "rev-parse") {
            return hasHead
              ? { exitCode: 0, stdout: `${source.immutableRef}\n`, stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing HEAD" };
          }
          if (command === "git" && args[2] === "checkout") {
            const sourcePath = join(args[1]!, skill.sourceRelativePath);
            await mkdir(sourcePath, { recursive: true });
            await writeFile(join(sourcePath, "SKILL.md"), "# deterministic checkout fixture\n");
            hasHead = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "npx") {
            installerCachePath = environment.npm_config_cache ?? null;
            assert.ok(installerCachePath && isAbsolute(installerCachePath));
            assert.equal(installerCachePath.startsWith(environment.HOME ?? ""), false);
            assert.equal((await lstat(installerCachePath)).isDirectory(), true);
            const destination = join(plan.install.targets[0]!.root, skill.skillName);
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, "SKILL.md"), "# deterministic checkout fixture\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`Unexpected setup command: ${command} ${args.join(" ")}`);
        },
      });
      assert.equal(result.state.status, "partially-ready");
      assert.ok(
        calls.some((call) => call.join(" ").endsWith("config --local core.autocrlf false")),
      );
      assert.ok(calls.some((call) => call.join(" ").endsWith("config --local core.eol lf")));
      const checkoutIndex = calls.findIndex((call) => call.includes("checkout"));
      const autocrlfIndex = calls.findIndex((call) => call.includes("core.autocrlf"));
      assert.ok(autocrlfIndex >= 0 && autocrlfIndex < checkoutIndex);
      const installerCall = calls.find((call) => call[0] === "npx");
      assert.deepEqual(installerCall?.slice(0, 7), [
        "npx",
        "--yes",
        "--package",
        `skills@${RESEARCH_SETUP_INSTALLER.version}`,
        "--",
        "skills",
        "add",
      ]);
      assert.ok(installerCachePath);
      assert.equal(await pathExistsSafe(installerCachePath), false);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the isolated setup npm cache after an installer verification failure", async () => {
    const root = await temporaryDirectory();
    let installerCachePath: string | null = null;
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["tiangong.auto-research"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        confirmNetworkDownloads: true,
      });
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: async ({ command, environment }) => {
            if (command !== "npm") throw new Error(`Unexpected command before npm: ${command}`);
            installerCachePath = environment.npm_config_cache ?? null;
            assert.ok(installerCachePath && isAbsolute(installerCachePath));
            assert.equal((await lstat(installerCachePath)).isDirectory(), true);
            return { exitCode: 1, stdout: "", stderr: "registry unavailable" };
          },
        }),
        errorCode("RESEARCH_SETUP_COMMAND_FAILED"),
      );
      assert.ok(installerCachePath);
      assert.equal(await pathExistsSafe(installerCachePath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed with safe diagnostics when pinned source bytes do not match", async () => {
    const root = await temporaryDirectory();
    const skill = RESEARCH_SETUP_SKILLS.find((candidate) => candidate.id === "hugohe3.ppt-master")!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    const calls: string[][] = [];
    try {
      skill.expectedTreeSha256 = "0".repeat(64);
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["ppt-master:MIT"],
        confirmNetworkDownloads: true,
      });
      const source = plan.sources.find((candidate) => candidate.id === skill.sourceId)!;
      const checkout = join(
        workspacePaths(root).setupSources,
        `${source.id}-${source.immutableRef.slice(0, 12)}`,
      );
      const sourcePath = join(checkout, skill.sourceRelativePath);
      let hasHead = false;
      let thrown: unknown;
      try {
        await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: async ({ command, args }) => {
            calls.push([command, ...args]);
            if (command === "npm") {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  version: RESEARCH_SETUP_INSTALLER.version,
                  "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
                  gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
                }),
                stderr: "",
              };
            }
            if (command === "git" && args[0] === "init") {
              await mkdir(args.at(-1)!, { recursive: true });
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (command === "git" && args[2] === "remote" && args[3] === "get-url") {
              return { exitCode: 0, stdout: `${source.locator}\n`, stderr: "" };
            }
            if (command === "git" && args[2] === "rev-parse") {
              return hasHead
                ? { exitCode: 0, stdout: `${source.immutableRef}\n`, stderr: "" }
                : { exitCode: 1, stdout: "", stderr: "missing HEAD" };
            }
            if (command === "git" && args[2] === "checkout") {
              await mkdir(sourcePath, { recursive: true });
              await writeFile(join(sourcePath, "SKILL.md"), "# mismatched immutable bytes\n");
              hasHead = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (command === "npx") throw new Error("installer must not run after hash mismatch");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Error);
      const observedTreeSha256 = await hashRegularTree(sourcePath);
      assert.equal(
        (thrown as Error & { code: string }).code,
        "RESEARCH_SETUP_SOURCE_HASH_MISMATCH",
      );
      const details = (thrown as Error & { details: Record<string, unknown> }).details;
      assert.deepEqual(details.diagnostics, {
        skillId: skill.id,
        sourceId: source.id,
        hashAlgorithm: "sha256-nfc-path-size-content-v2",
        expectedTreeSha256: "0".repeat(64),
        observedTreeSha256,
      });
      assert.equal(
        calls.some((call) => call[0] === "npx"),
        false,
      );
      const state = JSON.parse(await readFile(workspacePaths(root).setupState, "utf8")) as {
        status: string;
        completedSteps: string[];
      };
      assert.equal(state.status, "blocked");
      assert.equal(state.completedSteps.includes("source-checkout"), false);
      assert.equal(
        await pathExistsSafe(join(plan.install.targets[0]!.root, skill.skillName)),
        false,
      );
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies an empty smoke setup without invoking any installer or network command", async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    try {
      await createEmptyPlan(root);
      const result = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: async ({ command }) => {
          calls.push(command);
          return { exitCode: 0, stdout: "unexpected", stderr: "" };
        },
      });
      assert.equal(result.state.status, "partially-ready");
      assert.equal(calls.length, 0);
      assert.equal((await inspectResearchContext(root)).role, "workspace");
      const status = await inspectResearchSetupStatus(root);
      assert.equal(status.state.status, "partially-ready");
      assert.equal(status.installations.length, 0);
      assert.match(
        await readFile(workspacePaths(root).journal, "utf8"),
        /research\.setup\.applied/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a Claude native producer with a valid Codex reviewer route", async () => {
    const root = await temporaryDirectory();
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        agentRoutes: {
          producerAgent: "claude",
          reviewerAgent: "codex",
        },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const config = await loadWorkspaceConfig(root);
      assert.deepEqual(config.producer, {
        agent: "claude",
        executionMode: "native-host",
        binary: "claude",
        model: null,
        effort: "low",
      });
      assert.deepEqual(config.reviewer, {
        agent: "codex",
        executionMode: "headless-cli",
        binary: "codex",
        model: null,
        effort: "low",
        verbosity: "low",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks missing required credentials before downloads and sanitizes retry failures", async () => {
    const root = await temporaryDirectory();
    const secret = "opaque-fixture-owner-secret";
    const calls: string[] = [];
    try {
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: ["tiangong.auto-research"],
        acceptedLicenseIds: ["brave-search-skills:MIT", "tiangong-ai-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "OWNER_VALUE" },
        confirmNetworkDownloads: true,
      });
      const canonicalRoot = plan.workspace.path;
      const recoverySkill = join(
        canonicalRoot,
        ".agents",
        "skills",
        "tiangong-auto-research-recovery",
      );
      assert.ok(
        plan.mutations.some(
          (mutation) => mutation.step === "recovery-shim" && mutation.target === recoverySkill,
        ),
      );
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          environment: {},
          runner: async ({ command }) => {
            calls.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error: unknown) => {
          if (!errorCode("RESEARCH_SETUP_CREDENTIAL_PREFLIGHT_FAILED")(error)) return false;
          const details = (error as { details?: { diagnostics?: Record<string, unknown> } })
            .details;
          assert.equal(details?.diagnostics?.executionMode, "setup-preflight");
          assert.equal(details?.diagnostics?.credentialScope, "broker");
          assert.equal(details?.diagnostics?.networkAttempted, false);
          assert.deepEqual(details?.diagnostics?.missingCredentialIds, ["brave.search.api-key"]);
          return true;
        },
      );
      assert.equal(calls.length, 0);

      await assert.rejects(
        retryResearchSetup({
          workspace: root,
          step: "credential-preflight",
          options: {
            skipDoctor: true,
            environment: { OWNER_VALUE: secret },
            runner: async ({ command }) => {
              calls.push(command);
              if (command === "npm") {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    version: RESEARCH_SETUP_INSTALLER.version,
                    "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
                    gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
                  }),
                  stderr: "",
                };
              }
              return { exitCode: 9, stdout: "", stderr: `git failure ${secret}` };
            },
          },
        }),
        errorCode("RESEARCH_SETUP_COMMAND_FAILED"),
      );
      assert.deepEqual(calls, ["npm", "git"]);
      const persisted = `${await readFile(workspacePaths(root).setupState, "utf8")}\n${await readFile(
        workspacePaths(root).journal,
        "utf8",
      )}`;
      assert.equal(persisted.includes(secret), false);
      assert.match(persisted, /\[REDACTED\]/);
      const credentialStore = await readFile(workspacePaths(root).env, "utf8");
      assert.equal(credentialStore.includes(secret), true);
      const status = await inspectResearchSetupStatus(root, {});
      const braveSource = plan.sources.find((source) => source.id === "brave-search-skills")!;
      assert.equal(status.state.lastError?.step, "source-checkout");
      assert.deepEqual(status.state.lastError?.diagnostics, {
        sourceId: "brave-search-skills",
        repository: "brave/brave-search-skills",
        immutableRef: braveSource.immutableRef,
        cacheState: "absent",
        safeToRetry: true,
      });
      assert.equal(
        status.state.lastError?.retryCommand,
        researchSetupRetryCommand({
          version: status.plan.cliVersion,
          workspace: canonicalRoot,
          step: "source-checkout",
        }),
      );
      assert.equal(status.next?.action, "retry");
      assert.deepEqual(status.credentialReadiness, {
        valuesEmitted: false,
        configuredIds: ["brave.search.api-key"],
        missingRequiredIds: [],
        scopes: ["broker"],
      });
      assert.equal(status.provenance.selectedOrchestrator?.skillId, "tiangong.auto-research");
      assert.equal(status.provenance.selectedOrchestrator?.preferredPath, null);
      assert.equal(status.provenance.selectedOrchestrator?.installations[0]?.status, "missing");
      assert.equal(status.provenance.recoveryShims[0]?.status, "installed");
      assert.equal(status.provenance.recoveryShims[0]?.path, recoverySkill);
      const recoveryInstructions = await readFile(join(recoverySkill, "SKILL.md"), "utf8");
      assert.match(recoveryInstructions, /recovery-only/i);
      assert.match(recoveryInstructions, new RegExp(`@tiangong-ai/cli@${plan.cli.version}`));
      assert.match(recoveryInstructions, /research context inspect/);
      assert.match(recoveryInstructions, /never run research or standalone evidence/i);
      assert.equal(recoveryInstructions.includes(secret), false);

      const retryCalls: string[] = [];
      await assert.rejects(
        retryResearchSetup({
          workspace: root,
          step: "source-checkout",
          options: {
            skipDoctor: true,
            environment: {},
            runner: async ({ command }) => {
              retryCalls.push(command);
              if (command === "npm") {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    version: RESEARCH_SETUP_INSTALLER.version,
                    "dist.integrity": RESEARCH_SETUP_INSTALLER.npmIntegrity,
                    gitHead: RESEARCH_SETUP_INSTALLER.gitHead,
                  }),
                  stderr: "",
                };
              }
              return { exitCode: 9, stdout: "", stderr: "repeatable clean failure" };
            },
          },
        }),
        errorCode("RESEARCH_SETUP_COMMAND_FAILED"),
      );
      assert.deepEqual(retryCalls, ["npm", "git"]);
      const retriedStatus = await inspectResearchSetupStatus(root, {});
      assert.equal(retriedStatus.state.attempts, 3);
      assert.deepEqual(retriedStatus.credentialReadiness, status.credentialReadiness);
      const priorCwd = process.cwd();
      try {
        process.chdir(root);
        const blockedSearch = await invoke([
          "research",
          "search",
          "--query",
          "must remain managed",
          "--sources",
          "sci",
          "--dry-run",
          "--json",
        ]);
        assert.equal(blockedSearch.exitCode, 3);
        const blockedError = JSON.parse(blockedSearch.stderr) as {
          error: { code: string; details: Record<string, unknown> };
        };
        assert.equal(blockedError.error.code, "AUTO_RESEARCH_SETUP_BLOCKED");
        assert.equal(blockedError.error.details.requestedExecutionMode, "standalone");
        assert.equal(blockedError.error.details.recommendedExecutionMode, "managed-workspace");
        assert.equal(blockedError.error.details.brokerCredentialStore, "present");
        assert.equal(blockedError.error.details.standaloneCredential, "absent");
        assert.equal(blockedError.error.details.setupStatus, "blocked");
        assert.equal(blockedError.error.details.failedStep, "source-checkout");
        assert.equal(blockedError.error.details.networkAttempted, false);
        assert.deepEqual(blockedError.error.details.effectiveCli, status.provenance.effectiveCli);
        assert.deepEqual(blockedError.error.details.recoveryShims, status.provenance.recoveryShims);
        assert.equal(JSON.stringify(blockedError).includes(secret), false);
      } finally {
        process.chdir(priorCwd);
      }
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).env)).mode & 0o077, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only its verified recovery shim after the full orchestrator is available", async () => {
    const root = await temporaryDirectory();
    const canonicalRoot = await realpath(root);
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.auto-research",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    const installedSkill = join(canonicalRoot, ".agents", "skills", skill.skillName);
    const recoverySkill = join(
      canonicalRoot,
      ".agents",
      "skills",
      "tiangong-auto-research-recovery",
    );
    try {
      await mkdir(installedSkill, { recursive: true });
      await writeFile(join(installedSkill, "SKILL.md"), "# verified full orchestrator fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(installedSkill);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: [skill.license.id],
        confirmNetworkDownloads: true,
      });
      const result = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: async () => {
          throw new Error("a verified installation requires no downloader");
        },
      });
      assert.equal(result.state.status, "partially-ready");
      assert.equal(await pathExistsSafe(recoverySkill), false);
      const status = await inspectResearchSetupStatus(root, {});
      assert.equal(status.provenance.selectedOrchestrator?.preferredPath, installedSkill);
      assert.deepEqual(status.provenance.recoveryShims, []);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a recovery shim parent symlink before creating anything outside the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.auto-research",
    )!;
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: [skill.license.id],
        confirmNetworkDownloads: true,
      });
      await symlink(outside, join(root, ".agents"));
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: async () => {
            throw new Error("symlink rejection must precede every network command");
          },
        }),
        errorCode("RESEARCH_SETUP_SYMLINK_BLOCKED"),
      );
      assert.equal(await pathExistsSafe(join(outside, "skills")), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("binds global destinations into the plan and refuses a symlinked agent home", async () => {
    const root = await temporaryDirectory();
    const homes = await temporaryDirectory();
    const realHome = join(homes, "real-codex-home");
    const linkedHome = join(homes, "linked-codex-home");
    try {
      await mkdir(realHome);
      await symlink(realHome, linkedHome);
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        scope: "global",
        agents: ["codex"],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        confirmGlobalMutation: true,
        environment: { HOME: linkedHome },
      });
      assert.equal(plan.install.targets[0]?.root, join(linkedHome, ".agents", "skills"));
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          environment: { HOME: join(homes, "different-home") },
        }),
        errorCode("RESEARCH_SETUP_SYMLINK_BLOCKED"),
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(homes, { recursive: true, force: true }),
      ]);
    }
  });

  it("applies a Claude-only acquisition plan without assuming a Codex target", async () => {
    const root = await temporaryDirectory();
    const homes = await temporaryDirectory();
    const claudeConfig = join(homes, "claude-config");
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.academic-paper-download",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      const skillDirectory = join(claudeConfig, "skills", skill.skillName);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(join(skillDirectory, "SKILL.md"), "# pinned fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        scope: "global",
        agents: ["claude-code"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        confirmNetworkDownloads: true,
        confirmGlobalMutation: true,
        environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      });
      const applied = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      });
      assert.equal(applied.state.status, "partially-ready");
      const status = await inspectResearchSetupStatus(root, {
        CLAUDE_CONFIG_DIR: claudeConfig,
      });
      assert.equal(status.installations[0]?.agent, "claude-code");
      assert.equal(status.installations[0]?.status, "installed");
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(homes, { recursive: true, force: true }),
      ]);
    }
  });

  it("returns a report instead of throwing and removes mapped opaque secrets", async () => {
    const root = await temporaryDirectory();
    const secret = "opaque-value-not-named-like-a-token";
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["tiangong.academic-paper-download"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "semantic-scholar.api-key": "OWNER_VALUE" },
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");
      const report = await doctorResearchSetup(root, {
        environment: { OWNER_VALUE: secret },
        runner: async () => ({ exitCode: 0, stdout: `version ${secret}`, stderr: "" }),
      });
      assert.equal(report.researchReadiness, "READY");
      assert.equal(report.acquisitionReadiness, "DEGRADED");
      assert.equal(report.overallReadiness, "PARTIALLY_READY");
      assert.equal(JSON.stringify(report).includes(secret), false);
      const reportChecks = report.checks as Array<{
        id: string;
        status: string;
        minimumAction: string | null;
      }>;
      const optionalSetting = reportChecks.find(
        (check) => check.id === "setting.unpaywall.contact-email",
      );
      assert.equal(optionalSetting?.status, "pass");
      assert.equal(optionalSetting?.minimumAction, null);
      const optionalCredential = reportChecks.find(
        (check) => check.id === "credential.semantic-scholar.api-key",
      );
      assert.equal(optionalCredential?.status, "pass");
      assert.equal(optionalCredential?.minimumAction, null);
      const pypdfDependency = reportChecks.find(
        (check) => check.id === "dependency.academic-paper-download:pypdf",
      );
      assert.equal(pypdfDependency?.status, "fail");
      assert.match(pypdfDependency?.minimumAction ?? "", /runtime\.py bootstrap --locked/i);
      assert.equal(
        (await readFile(workspacePaths(root).setupReport, "utf8")).includes(secret),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks selected authoring components when any complete workflow prerequisite is absent", async () => {
    const root = await temporaryDirectory();
    const selected = RESEARCH_SETUP_SKILLS.filter((candidate) =>
      ["anthropic.docx", "anthropic.pdf", "anthropic.pptx", "anthropic.xlsx"].includes(
        candidate.id,
      ),
    );
    const originalHashes = new Map(
      selected.map((skill) => [skill.id, skill.expectedTreeSha256] as const),
    );
    try {
      for (const skill of selected) {
        const directory = join(root, ".agents", "skills", skill.skillName);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `# ${skill.skillName} fixture\n`);
        if (["docx", "pptx"].includes(skill.skillName)) {
          await mkdir(join(directory, "scripts", "office"), { recursive: true });
          await writeFile(join(directory, "scripts", "office", "validate.py"), "# validator\n");
          await writeFile(join(directory, "scripts", "office", "soffice.py"), "# office\n");
        }
        if (skill.skillName === "pptx") {
          await writeFile(join(directory, "scripts", "thumbnail.py"), "# thumbnail\n");
        }
        if (skill.skillName === "pdf") {
          await mkdir(join(directory, "scripts"), { recursive: true });
          await writeFile(join(directory, "scripts", "convert_pdf_to_images.py"), "# convert\n");
          await writeFile(
            join(directory, "scripts", "create_validation_image.py"),
            "# validate image\n",
          );
        }
        if (skill.skillName === "xlsx") {
          await mkdir(join(directory, "scripts", "office"), { recursive: true });
          await writeFile(join(directory, "scripts", "recalc.py"), "# recalc\n");
          await writeFile(join(directory, "scripts", "office", "soffice.py"), "# office\n");
        }
        skill.expectedTreeSha256 = await hashRegularTree(directory);
      }
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: selected.map((skill) => skill.id),
        acceptedLicenseIds: ["anthropic-skills:document-terms"],
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");

      const report = await doctorResearchSetup(root, {
        runner: async ({ command, args }) => {
          const commandName = basename(command).replace(/\.(?:cmd|exe)$/iu, "");
          const isPython = commandName.startsWith("python3");
          if (isPython && args.includes("--version")) {
            return { exitCode: 0, stdout: "Python 3.12.8\n", stderr: "" };
          }
          if (isPython && args.some((arg) => arg.includes("defusedxml"))) {
            return { exitCode: 0, stdout: "0.7.1\n", stderr: "" };
          }
          if (["pandoc", "pdftoppm", "soffice", "node", "zip", "unzip"].includes(commandName)) {
            return { exitCode: 127, stdout: "", stderr: "missing" };
          }
          if (
            isPython &&
            args.some((arg) =>
              [
                "lxml",
                "PIL",
                "pypdf",
                "pdfplumber",
                "reportlab",
                "pdf2image",
                "openpyxl",
                "pandas",
              ].some((name) => arg.includes(name)),
            )
          ) {
            return { exitCode: 1, stdout: "", stderr: "missing" };
          }
          return { exitCode: 0, stdout: `${command} fixture-version\n`, stderr: "" };
        },
      });

      assert.equal(report.researchReadiness, "READY");
      assert.equal(report.authoringReadiness, "BLOCKED");
      assert.equal(report.overallReadiness, "PARTIALLY_READY");
      const checks = report.checks as Array<{
        id: string;
        status: string;
        minimumAction: string | null;
      }>;
      for (const id of [
        "dependency.authoring:lxml",
        "dependency.authoring:node-docx",
        "dependency.authoring:pandoc",
        "dependency.authoring:pypdf",
        "dependency.authoring:pdf2image",
        "dependency.authoring:pillow",
        "dependency.authoring:node-pptxgenjs",
        "dependency.authoring:openpyxl",
        "dependency.authoring:pandas",
      ]) {
        assert.equal(checks.find((check) => check.id === id)?.status, "fail", id);
      }
      for (const skillId of [
        "anthropic.docx",
        "anthropic.pdf",
        "anthropic.pptx",
        "anthropic.xlsx",
      ]) {
        const canary = checks.find((check) => check.id === `authoring-canary.${skillId}`);
        assert.equal(canary?.status, "fail", skillId);
        assert.match(canary?.minimumAction ?? "", /prerequisite|runtime|dependency/i);
      }
    } finally {
      for (const skill of selected) {
        skill.expectedTreeSha256 = originalHashes.get(skill.id)!;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires all four exact-file authoring canaries before reporting READY", async () => {
    const root = await temporaryDirectory();
    const bin = join(root, "authoring-bin");
    const selected = RESEARCH_SETUP_SKILLS.filter((candidate) =>
      ["anthropic.docx", "anthropic.pdf", "anthropic.pptx", "anthropic.xlsx"].includes(
        candidate.id,
      ),
    );
    const originalHashes = new Map(
      selected.map((skill) => [skill.id, skill.expectedTreeSha256] as const),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    try {
      await mkdir(bin);
      for (const name of ["node", "pandoc", "soffice", "pdftoppm", "zip", "unzip"]) {
        const path = join(bin, name);
        await writeFile(path, "#!/bin/sh\nexit 0\n");
        await chmod(path, 0o755);
      }
      const virtualEnvironmentPython = join(root, "authoring-python-real");
      await writeFile(virtualEnvironmentPython, "#!/bin/sh\nexit 0\n");
      await chmod(virtualEnvironmentPython, 0o755);
      await symlink(virtualEnvironmentPython, join(bin, "python3"));
      for (const skill of selected) {
        const directory = join(root, ".agents", "skills", skill.skillName);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `# ${skill.skillName} fixture\n`);
        if (["docx", "pptx"].includes(skill.skillName)) {
          await mkdir(join(directory, "scripts", "office"), { recursive: true });
          await writeFile(join(directory, "scripts", "office", "validate.py"), "# validator\n");
          await writeFile(join(directory, "scripts", "office", "soffice.py"), "# office\n");
        }
        if (skill.skillName === "pptx") {
          await writeFile(join(directory, "scripts", "thumbnail.py"), "# thumbnail\n");
        }
        if (skill.skillName === "pdf") {
          await mkdir(join(directory, "scripts"), { recursive: true });
          await writeFile(join(directory, "scripts", "convert_pdf_to_images.py"), "# convert\n");
          await writeFile(
            join(directory, "scripts", "create_validation_image.py"),
            "# validate image\n",
          );
        }
        if (skill.skillName === "xlsx") {
          await mkdir(join(directory, "scripts", "office"), { recursive: true });
          await writeFile(join(directory, "scripts", "recalc.py"), "# recalc\n");
          await writeFile(join(directory, "scripts", "office", "soffice.py"), "# office\n");
        }
        skill.expectedTreeSha256 = await hashRegularTree(directory);
      }
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: selected.map((skill) => skill.id),
        acceptedLicenseIds: ["anthropic-skills:document-terms"],
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");
      const environment = { PATH: bin, NODE_PATH: join(root, "node_modules") };
      const report = await doctorResearchSetup(root, {
        environment,
        runner: async ({ command, args }) => {
          calls.push({ command, args });
          const name = basename(command);
          if (name === "python3" && args.includes("--version")) {
            return { exitCode: 0, stdout: "Python 3.12.8\n", stderr: "" };
          }
          if (name === "python3" && args[0] === "-c" && args[1]?.includes("importlib.metadata")) {
            const version = args[1].includes("markitdown")
              ? "0.1.7"
              : args[1].includes("defusedxml")
                ? "0.7.1"
                : "1.0.0";
            return { exitCode: 0, stdout: `${version}\n`, stderr: "" };
          }
          if (name === "node" && args[1]?.includes("require.resolve")) {
            return { exitCode: 0, stdout: "/virtual/node-module.js", stderr: "" };
          }
          if (
            ["pandoc", "soffice", "pdftoppm", "zip", "unzip"].includes(name) &&
            args.some((arg) => arg.startsWith("-v") || arg === "--version")
          ) {
            return { exitCode: 0, stdout: `${name} 1.0\n`, stderr: "" };
          }
          if (name === "node" && args[0] === "-e") {
            await writeFile(args.at(-1)!, Buffer.alloc(256, 1));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0] === "-c" && args[1]?.includes("reportlab")) {
            await writeFile(args[2]!, Buffer.alloc(256, 2));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0] === "-c" && args[1]?.includes("Workbook")) {
            await writeFile(args[2]!, Buffer.alloc(256, 3));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0] === "-c" && args[1]?.includes("pdfplumber")) {
            return { exitCode: 0, stdout: "TIANGONG_PDF_CANARY\n", stderr: "" };
          }
          if (name === "python3" && args[0] === "-c" && args[1]?.includes("data_only=True")) {
            return { exitCode: 0, stdout: "5\n", stderr: "" };
          }
          if (name === "python3" && args[0] === "-m" && args[1] === "markitdown") {
            return {
              exitCode: 0,
              stdout: args.at(-1)?.endsWith(".xlsx")
                ? "Sheet1 TIANGONG\\_XLSX\\_CANARY 5\n"
                : "TIANGONG_PPTX_CANARY\n",
              stderr: "",
            };
          }
          if (name === "pandoc") {
            return { exitCode: 0, stdout: "TIANGONG_DOCX_CANARY\n", stderr: "" };
          }
          if (name === "python3" && args[0]?.endsWith("soffice.py")) {
            const source = args.at(-1)!;
            await writeFile(source.replace(/\.docx$/u, ".pdf"), Buffer.alloc(256, 4));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "pdftoppm") {
            await writeFile(`${args.at(-1)!}.png`, Buffer.alloc(128, 5));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0]?.endsWith("thumbnail.py")) {
            await writeFile(`${args[2]}.jpg`, Buffer.alloc(128, 6));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0]?.endsWith("convert_pdf_to_images.py")) {
            await writeFile(join(args[2]!, "page_1.png"), Buffer.alloc(128, 7));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0]?.endsWith("create_validation_image.py")) {
            await writeFile(args.at(-1)!, Buffer.alloc(128, 8));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (name === "python3" && args[0]?.endsWith("recalc.py")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ status: "success", total_errors: 0, total_formulas: 1 }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: `${name} fixture-version\n`, stderr: "" };
        },
      });
      assert.equal(report.researchReadiness, "READY");
      assert.equal(report.authoringReadiness, "READY");
      const checks = report.checks as Array<{ id: string; status: string }>;
      for (const skill of selected) {
        assert.equal(
          checks.find((check) => check.id === `authoring-canary.${skill.id}`)?.status,
          "pass",
          skill.id,
        );
      }
      assert.equal(
        calls.some((call) =>
          ["pip", "npm", "brew", "apt", "apt-get"].includes(basename(call.command)),
        ),
        false,
      );
      assert.ok(calls.some((call) => call.args[0]?.endsWith("convert_pdf_to_images.py")));
      assert.ok(
        calls.some(
          (call) =>
            call.args[0] === "-m" &&
            call.args[1] === "markitdown" &&
            call.args.at(-1)?.endsWith(".xlsx"),
        ),
      );
    } finally {
      for (const skill of selected) {
        skill.expectedTreeSha256 = originalHashes.get(skill.id)!;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries Semantic Scholar 429 once and scopes the degradation to acquisition", async () => {
    const root = await temporaryDirectory();
    const secret = "semantic-scholar-rate-limit-secret";
    let providerCalls = 0;
    const sleeps: number[] = [];
    const providerUrls: string[] = [];
    const providerKeys: Array<string | null> = [];
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.academic-paper-download",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      const skillDirectory = join(root, ".agents", "skills", skill.skillName);
      await mkdir(join(skillDirectory, "scripts"), { recursive: true });
      await writeFile(join(skillDirectory, "SKILL.md"), "# Academic paper fixture\n");
      await writeFile(join(skillDirectory, "scripts", "runtime.py"), "# runtime fixture\n");
      const runtimePath = await realpath(join(skillDirectory, "scripts", "runtime.py"));
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["tiangong.academic-paper-download"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "semantic-scholar.api-key": "OWNER_S2_VALUE" },
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");
      await setResearchSetupCredentialFromEnvironment({
        workspace: root,
        credentialId: "semantic-scholar.api-key",
        environmentName: "OWNER_S2_VALUE",
        environment: { OWNER_S2_VALUE: secret },
      });
      const runtimeDoctorCalls: string[][] = [];
      const report = await doctorResearchSetup(root, {
        live: true,
        environment: { OWNER_S2_VALUE: secret },
        runner: async ({ command, args }) => {
          if (command === "python3" && args[0] === runtimePath) {
            runtimeDoctorCalls.push(args);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                data: { message: "Locked runtime preflight passed", pypdf: "6.14.2" },
              }),
              stderr: "",
            };
          }
          if (command === "python3" && args.includes("--version")) {
            return { exitCode: 0, stdout: "Python 3.12.8\n", stderr: "" };
          }
          return { exitCode: 0, stdout: `${command} fixture-version\n`, stderr: "" };
        },
        fetcher: async (input, init) => {
          providerCalls += 1;
          providerUrls.push(String(input));
          providerKeys.push(new Headers(init?.headers).get("x-api-key"));
          return new Response(`{"token":"${secret}"}`, {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "7" },
          });
        },
        sleeper: async (milliseconds) => void sleeps.push(milliseconds),
      });
      assert.deepEqual(runtimeDoctorCalls, [[runtimePath, "doctor", "--json"]]);
      assert.equal(providerCalls, 2);
      assert.deepEqual(providerUrls, [
        "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/s41586-020-2649-2?fields=paperId",
        "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/s41586-020-2649-2?fields=paperId",
      ]);
      assert.deepEqual(providerKeys, [secret, secret]);
      assert.deepEqual(sleeps, [5_000]);
      assert.equal(report.researchReadiness, "READY");
      assert.equal(report.acquisitionReadiness, "DEGRADED");
      assert.equal(report.overallReadiness, "PARTIALLY_READY");
      const check = (
        report.checks as Array<{
          id: string;
          status: string;
          minimumAction: string | null;
          diagnostics?: Record<string, unknown>;
          blocking?: boolean;
        }>
      ).find((candidate) => candidate.id === "live.semantic-scholar");
      assert.equal(check?.status, "fail");
      assert.equal(check?.blocking, false);
      assert.equal(check?.diagnostics?.code, "PROVIDER_RATE_LIMITED");
      assert.equal(check?.diagnostics?.networkAttempted, true);
      assert.equal(check?.diagnostics?.retryAfterSeconds, 7);
      assert.match(check?.minimumAction ?? "", /must not downgrade to standalone/i);
      assert.equal(JSON.stringify(report).includes(secret), false);
      const required = await evaluateRequiredResearchCompanions(root, [skill.id]);
      assert.equal(required.ready, true, JSON.stringify(required));
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks setup readiness when an explicitly requested agent smoke fails", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const report = await doctorResearchSetup(root, {
        agentSmoke: true,
        environment: {},
        runner: async ({ command }) => ({
          exitCode: 0,
          stdout: `${command} fixture-version`,
          stderr: "",
        }),
        executor: async (request) => ({
          exitCode: 9,
          stdout: "",
          stderr: `${request.route.agent} smoke failed`,
          tokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallSeconds: 0,
          model: request.route.model,
          runtime: null,
        }),
      });
      assert.equal(report.readiness, "BLOCKED");
      const checks = report.checks as Array<{ id: string; status: string }>;
      assert.equal(checks.find((check) => check.id === "production-runtime")?.status, "fail");
      assert.equal((report.workspaceDoctor as { status: string } | null)?.status, "blocked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks an incompatible installed Policy pack before paid reviewer smoke", async () => {
    const root = await temporaryDirectory();
    const orchestrator = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.auto-research",
    )!;
    const originalTreeSha256 = orchestrator.expectedTreeSha256;
    let executorCalls = 0;
    try {
      const skillDirectory = join(root, ".agents", "skills", orchestrator.skillName);
      await writeDoctorPolicyPack(skillDirectory, true);
      orchestrator.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [orchestrator.id],
        acceptedLicenseIds: [orchestrator.license.id],
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");
      const report = await doctorResearchSetup(root, {
        agentSmoke: true,
        environment: {},
        runner: async ({ command }) => ({
          exitCode: 0,
          stdout: `${command} fixture-version`,
          stderr: "",
        }),
        executor: async (request) => {
          executorCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ status: "ok" }),
            stderr: "",
            tokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            wallSeconds: 0,
            model: request.route.model,
            runtime: null,
          };
        },
      });
      assert.equal(report.researchReadiness, "BLOCKED");
      assert.equal(executorCalls, 0);
      const check = (
        report.checks as Array<{ id: string; status: string; detail: string; blocking: boolean }>
      ).find((candidate) => candidate.id.includes("top-journal-policy-pack"));
      assert.equal(check?.status, "fail");
      assert.equal(check?.blocking, true);
      assert.match(check?.detail ?? "", /unsupportedPinnedConstraint/);
    } finally {
      orchestrator.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes an optional preprocessor to a project gate only when explicitly required", async () => {
    const root = await temporaryDirectory();
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["tiangong.document-granular-decompose"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        settings: { "tiangong.unstructure.base-url": "https://unstructure.example.test" },
        confirmNetworkDownloads: true,
      });
      await initializeResearchWorkspace(root, undefined, "smoke-test");
      const report = await doctorResearchSetup(root, {
        environment: {},
        runner: async ({ command, args }) =>
          command === "python3" && args.includes("--version")
            ? { exitCode: 0, stdout: "Python 3.12.8\n", stderr: "" }
            : { exitCode: 0, stdout: `${command} fixture-version\n`, stderr: "" },
      });
      assert.equal(report.researchReadiness, "READY");
      assert.equal(report.preprocessingReadiness, "DEGRADED");
      const optional = await evaluateRequiredResearchCompanions(root, []);
      assert.equal(optional.ready, true);
      const required = await evaluateRequiredResearchCompanions(root, [
        "tiangong.document-granular-decompose",
      ]);
      assert.equal(required.ready, false);
      assert.ok(
        required.gaps.includes("required-companion-not-ready:tiangong.document-granular-decompose"),
      );
      assert.ok(
        required.components[0]?.failedChecks.includes("preprocessor-live-check-not-passed"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the pinned document companion with a minimal secret environment and no-overwrite atomic output", async () => {
    const root = await temporaryDirectory();
    const inputPath = join(root, "source.pdf");
    const outputPath = join(root, "source.fulltext.md");
    const secret = "document-owner-token-value";
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.document-granular-decompose",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      await writeFile(inputPath, "%PDF-1.4\nfixture\n%%EOF\n");
      const skillDirectory = join(root, ".agents", "skills", skill.skillName);
      await mkdir(join(skillDirectory, "scripts"), { recursive: true });
      await writeFile(join(skillDirectory, "scripts", "mineru_fulltext_extract.py"), "# fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "tiangong.unstructure.auth-token": "OWNER_DOC_TOKEN" },
        settings: { "tiangong.unstructure.base-url": "https://unstructure.example.test" },
        confirmNetworkDownloads: true,
        environment: { OWNER_DOC_TOKEN: secret },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { OWNER_DOC_TOKEN: secret },
      });
      let calls = 0;
      const result = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.document-granular-decompose",
          inputPath,
          outputPath,
          timeoutSeconds: 30,
        },
        {
          environment: {
            PATH: process.env.PATH,
            OWNER_DOC_TOKEN: secret,
            AUTHORIZATION: "must-not-be-inherited",
          },
          runner: async ({ command, args, environment }) => {
            calls += 1;
            assert.equal(command, "python3");
            assert.equal(environment.UNSTRUCTURED_AUTH_TOKEN, secret);
            assert.equal(environment.UNSTRUCTURED_API_BASE_URL, "https://unstructure.example.test");
            assert.equal(environment.OWNER_DOC_TOKEN, undefined);
            assert.equal(environment.AUTHORIZATION, undefined);
            const temporary = args[args.indexOf("--output") + 1];
            assert.ok(temporary);
            assert.notEqual(temporary, outputPath);
            assert.match(temporary!, /^.*\.part$/);
            await writeFile(temporary!, "# Extracted\n\nBound full text.\n");
            return { exitCode: 0, stdout: `${temporary}\n${secret}`, stderr: "" };
          },
        },
      );
      assert.equal(result.status, "complete");
      assert.equal(result.output.path, outputPath);
      assert.equal(await readFile(outputPath, "utf8"), "# Extracted\n\nBound full text.\n");
      assert.equal(calls, 1);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /research\.setup\.companion\.document\.completed/);

      await assert.rejects(
        runResearchSetupCompanion(
          {
            workspace: root,
            skillId: "tiangong.document-granular-decompose",
            inputPath,
            outputPath,
          },
          {
            environment: { PATH: process.env.PATH },
            runner: async () => {
              calls += 1;
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        ),
        errorCode("RESEARCH_SETUP_COMPANION_PATH_INVALID"),
      );
      assert.equal(calls, 1);
      assert.equal(await readFile(outputPath, "utf8"), "# Extracted\n\nBound full text.\n");
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the exact paper result without selecting a concurrent PDF and preserves handoff failure", async () => {
    const root = await temporaryDirectory();
    const outputDirectory = join(root, "papers");
    const secret = "semantic-scholar-owner-key";
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.academic-paper-download",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    const wire = JSON.parse(
      await readFile(new URL("./fixtures/paper-companion-v3.json", import.meta.url), "utf8"),
    );
    assert.equal(
      wire.producerTreeSha256,
      originalTreeSha256,
      "Regenerate the real-producer fixture when the pinned paper Skill changes",
    );
    try {
      await mkdir(outputDirectory);
      const skillDirectory = join(root, ".agents", "skills", skill.skillName);
      await mkdir(join(skillDirectory, "scripts"), { recursive: true });
      await writeFile(join(skillDirectory, "scripts", "fetch.py"), "# fixture\n");
      await writeFile(join(skillDirectory, "scripts", "runtime.py"), "# runtime fixture\n");
      const runtimePath = await realpath(join(skillDirectory, "scripts", "runtime.py"));
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "semantic-scholar.api-key": "OWNER_S2_KEY" },
        settings: { "unpaywall.contact-email": "oa@example.test" },
        confirmNetworkDownloads: true,
        environment: { OWNER_S2_KEY: secret },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { OWNER_S2_KEY: secret },
      });
      const decoyPath = join(outputDirectory, "concurrent-newer.pdf");
      await writeFile(decoyPath, "%PDF-1.4\ndecoy\n%%EOF\n");
      const artifactPath = join(outputDirectory, "bound-paper.pdf");
      const manifestPath = `${artifactPath}.json`;
      const pdf = Buffer.from(wire.pdfBase64, "base64");
      const identity = wire.manifest.identity;
      const result = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.academic-paper-download",
          outputDirectory,
          doi: "10.1234/example",
        },
        {
          environment: {
            PATH: process.env.PATH,
            OWNER_S2_KEY: secret,
            COOKIE: "must-not-be-inherited",
          },
          runner: async ({ command, args, environment }) => {
            assert.equal(command, "python3");
            assert.deepEqual(args.slice(0, 2), [runtimePath, "fetch"]);
            assert.equal(args.includes(join(skillDirectory, "scripts", "fetch.py")), false);
            assert.ok(args.includes("10.1234/example"));
            assert.equal(environment.SEMANTIC_SCHOLAR_API_KEY, secret);
            assert.equal(environment.UNPAYWALL_EMAIL, "oa@example.test");
            assert.equal(environment.OWNER_S2_KEY, undefined);
            assert.equal(environment.COOKIE, undefined);
            await writeFile(artifactPath, pdf);
            const digest = await sha256File(artifactPath);
            const manifest = { ...wire.manifest, file: artifactPath };
            assert.equal(manifest.sha256, digest);
            assert.equal(manifest.size, pdf.length);
            await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
            const envelope = structuredClone(wire.envelope);
            Object.assign(envelope.data.results[0], { file: artifactPath, manifest: manifestPath });
            return {
              exitCode: 0,
              stdout: JSON.stringify(envelope),
              stderr: `provider note ${secret}`,
            };
          },
        },
      );
      assert.equal(result.status, "complete");
      assert.equal(result.artifact.path, artifactPath);
      assert.notEqual(result.artifact.path, decoyPath);
      assert.equal(result.artifact.sha256, await sha256File(artifactPath));
      const goodManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const normalized = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.academic-paper-download",
          outputDirectory,
          doi: "https://doi.org/10.1234/EXAMPLE?from=fixture",
        },
        {
          environment: { PATH: process.env.PATH },
          runner: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              data: {
                results: [
                  {
                    success: true,
                    doi: "10.1234/example",
                    file: artifactPath,
                    manifest: manifestPath,
                    size: pdf.length,
                    sha256: goodManifest.sha256,
                    identity_status: "matched",
                    identity,
                  },
                ],
              },
            }),
            stderr: "",
          }),
        },
      );
      assert.equal(normalized.status, "complete");
      for (const [requestedDoi, canonicalDoi] of [
        ["https%3A%2F%2Fdoi.org%2F10.1234%2FEXAMPLE", "10.1234/example"],
        ["10.1234/percent%25", "10.1234/percent%"],
      ]) {
        const canonicalIdentity = {
          ...identity,
          requested: { ...identity.requested, doi: canonicalDoi },
        };
        const manifest = { ...goodManifest, doi: canonicalDoi, identity: canonicalIdentity };
        const compatible = await runResearchSetupCompanion(
          {
            workspace: root,
            skillId: "tiangong.academic-paper-download",
            outputDirectory,
            doi: requestedDoi!,
          },
          {
            environment: { PATH: process.env.PATH },
            runner: async () => {
              await writeFile(manifestPath, JSON.stringify(manifest));
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  data: {
                    results: [
                      {
                        success: true,
                        doi: canonicalDoi,
                        file: artifactPath,
                        manifest: manifestPath,
                        size: pdf.length,
                        sha256: goodManifest.sha256,
                        identity_status: "matched",
                        identity: canonicalIdentity,
                      },
                    ],
                  },
                }),
                stderr: "",
              };
            },
          },
        );
        assert.equal(compatible.status, "complete");
      }
      for (const variant of [
        "unresolved",
        "wrong-doi",
        "legacy",
        "different-result",
        "missing-result",
      ] as const) {
        const manifest = structuredClone(goodManifest);
        if (variant === "unresolved") manifest.identity.status = "unresolved";
        if (variant === "wrong-doi") manifest.identity.requested.doi = "10.1234/different";
        if (variant === "legacy") manifest.schema_version = "academic-paper-download.artifact.v2";
        await assert.rejects(
          runResearchSetupCompanion(
            {
              workspace: root,
              skillId: skill.id as "tiangong.academic-paper-download",
              outputDirectory,
              doi: "10.1234/example",
            },
            {
              environment: { PATH: process.env.PATH },
              runner: async () => {
                await writeFile(manifestPath, JSON.stringify(manifest));
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    ok: true,
                    data: {
                      results: [
                        {
                          success: true,
                          doi: "10.1234/example",
                          file: artifactPath,
                          manifest: manifestPath,
                          size: pdf.length,
                          sha256: goodManifest.sha256,
                          identity_status: "matched",
                          identity:
                            variant === "missing-result"
                              ? undefined
                              : variant === "different-result"
                                ? { ...manifest.identity, method: "different" }
                                : manifest.identity,
                        },
                      ],
                    },
                  }),
                  stderr: "",
                };
              },
            },
          ),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "RESEARCH_SETUP_COMPANION_ARTIFACT_INVALID",
        );
      }
      const completed = (await readFile(workspacePaths(root).journal, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "research.setup.companion.paper.completed");
      assert.equal(completed.length, 4);

      const privateRuntimePath = join(root, "private-runtime-token");
      await assert.rejects(
        runResearchSetupCompanion(
          {
            workspace: root,
            skillId: "tiangong.academic-paper-download",
            outputDirectory,
            doi: "10.1234/runtime-missing",
          },
          {
            environment: { PATH: process.env.PATH },
            runner: async () => ({
              exitCode: 3,
              stdout: JSON.stringify({
                ok: false,
                error: {
                  code: "runtime_missing",
                  message: "The locked runtime is not installed",
                  runtime_dir: privateRuntimePath,
                },
              }),
              stderr: privateRuntimePath,
            }),
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error && "details" in error);
          assert.equal(
            (error as Error & { code: string }).code,
            "RESEARCH_SETUP_COMPANION_RUNTIME_INVALID",
          );
          assert.equal(JSON.stringify(error).includes(privateRuntimePath), false);
          const details = (error as Error & { details: Record<string, unknown> }).details;
          assert.deepEqual(details.diagnostics, { runtimeErrorCode: "runtime_missing" });
          assert.match(String(details.minimumAction), /runtime\.py bootstrap --locked --json/);
          return true;
        },
      );

      const handoff = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.academic-paper-download",
          outputDirectory,
          doi: "10.1234/unresolved",
        },
        {
          environment: { PATH: process.env.PATH },
          runner: async () => ({
            exitCode: 1,
            stdout: JSON.stringify({
              ok: false,
              data: {
                results: [
                  {
                    success: false,
                    file: null,
                    manifest: null,
                    sources_tried: ["unpaywall", "semantic_scholar", "arxiv"],
                    error: { code: "download_unresolved" },
                    browser_handoff: { reason: "explicit handoff" },
                  },
                ],
              },
            }),
            stderr: "OA exhausted",
          }),
        },
      );
      assert.equal(handoff.status, "browser-handoff-required");
      assert.equal(handoff.artifactCommitted, false);

      await assert.rejects(
        runResearchSetupCompanion(
          {
            workspace: root,
            skillId: "tiangong.academic-paper-download",
            outputDirectory,
            title: "Ambiguous paper title",
          },
          {
            environment: { PATH: process.env.PATH },
            runner: async () => ({
              exitCode: 3,
              stdout: JSON.stringify({
                ok: false,
                data: {
                  results: [
                    {
                      success: false,
                      file: null,
                      manifest: null,
                      sources_tried: ["semantic_scholar", "crossref"],
                      error: {
                        code: "title_low_confidence",
                        message: "No confident match; adapter credential was rejected.",
                        token: secret,
                        diagnostic_url: `https://resolver.example.test/result?api_key=${secret}`,
                      },
                    },
                  ],
                },
              }),
              stderr: `Authorization: Bearer ${secret}`,
            }),
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error && "details" in error);
          assert.equal(
            (error as Error & { code: string }).code,
            "RESEARCH_SETUP_COMPANION_COMMAND_FAILED",
          );
          const serialized = JSON.stringify(error);
          assert.equal(serialized.includes(secret), false);
          const details = (error as Error & { details: Record<string, unknown> }).details;
          assert.match(String(details.reason), /title_low_confidence/);
          assert.equal(
            details.minimumAction,
            "No confident match; adapter credential was rejected.",
          );
          assert.deepEqual(details.diagnostics, {
            adapterError: {
              code: "title_low_confidence",
              message: "No confident match; adapter credential was rejected.",
              token: "[REDACTED]",
              diagnostic_url: "https://resolver.example.test/result?api_key=%5BREDACTED%5D",
            },
            sourcesTried: ["semantic_scholar", "crossref"],
            artifactCommitted: false,
          });
          return true;
        },
      );
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /research\.setup\.companion\.paper\.completed/);
      assert.match(journal, /research\.setup\.companion\.paper\.handoff-required/);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a TTY for the Wizard but supports a fully scripted explicit review", async () => {
    const root = await temporaryDirectory();
    const secret = "wizard-owner-secret-value";
    try {
      const nonInteractive = await invoke(["research", "setup", "--workspace", root, "--json"]);
      assert.equal(nonInteractive.exitCode, 2);
      assert.equal(JSON.parse(nonInteractive.stderr).error.code, "RESEARCH_SETUP_TTY_REQUIRED");

      const prompt = new ScriptedWizardPrompt(root);
      const result = await executeResearchSetupWizard({
        workspace: root,
        environment: { BRAVE_API_KEY: secret },
        prompt,
      });
      assert.equal(result.exitCode, 0);
      assert.equal((result.value as { status: string }).status, "planned");
      const serialized = `${JSON.stringify(result.value)}\n${prompt.notes.join("\n")}`;
      assert.equal(serialized.includes(secret), false);
      const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
      assert.equal(plan.selection.evidenceProfile, EXTERNAL_SKILL_PROFILE);
      assert.ok(plan.selection.skillIds.includes("tiangong.auto-research"));
      assert.ok(plan.selection.skillIds.includes("hugohe3.ppt-master"));
      assert.ok(plan.selection.skillIds.includes("anthropic.pptx"));
      assert.deepEqual(
        prompt.authoringChoices.slice(0, 2).map((choice) => choice.value),
        ["hugohe3.ppt-master", "anthropic.pptx"],
      );
      assert.match(prompt.authoringChoices[0]?.label ?? "", /Preferred for creating PPT/i);
      assert.match(prompt.authoringChoices[1]?.label ?? "", /Situational PPTX/i);
      assert.equal(prompt.noteTones[0], "brand");
      assert.ok(prompt.noteTones.includes("section"));
      assert.ok(prompt.noteTones.includes("summary"));
      assert.ok(prompt.noteTones.includes("success"));
      assert.deepEqual(plan.credentialSources, [
        {
          id: "brave.search.api-key",
          fromEnvironment: "BRAVE_API_KEY",
          storage: "broker",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds a Wizard plan to the canonical target behind a symlinked parent", async () => {
    const fixture = await temporaryDirectory();
    const realParent = join(fixture, "real-parent");
    const linkedParent = join(fixture, "linked-parent");
    const realWorkspace = join(realParent, "workspace");
    const linkedWorkspace = join(linkedParent, "workspace");
    try {
      await mkdir(realParent);
      await mkdir(realWorkspace);
      await symlink(realParent, linkedParent);
      const prompt = new ScriptedWizardPrompt(linkedWorkspace);
      const result = await executeResearchSetupWizard({
        workspace: linkedWorkspace,
        environment: { BRAVE_API_KEY: "wizard-owner-secret-value" },
        prompt,
      });
      assert.equal(result.exitCode, 0);
      const canonicalWorkspace = await realpath(realWorkspace);
      const plan = await loadAndVerifyResearchSetupPlan(
        workspacePaths(canonicalWorkspace).setupPlan,
      );
      assert.equal(plan.workspace.path, canonicalWorkspace);
      assert.ok(
        prompt.notes.some(
          (note) => note.includes(linkedWorkspace) && note.includes(canonicalWorkspace),
        ),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("supports secure, stdin, and explicit-skip Wizard credential sources without disclosure", async () => {
    const secret = "wizard-direct-hidden-owner-value";
    for (const inputMethod of ["secure-input", "stdin", "skipped"] as const) {
      const root = await temporaryDirectory();
      const stdinCredentials =
        inputMethod === "stdin" ? { "brave.search.api-key": secret } : undefined;
      try {
        const prompt = new ScriptedWizardPrompt(root, {
          credentialInputMethod: inputMethod,
          secret,
        });
        const result = await executeResearchSetupWizard({
          workspace: root,
          environment: {},
          prompt,
          ...(stdinCredentials === undefined ? {} : { stdinCredentials }),
        });
        assert.equal(result.exitCode, 0);
        assert.equal((result.value as { status: string }).status, "planned");
        const serialized = `${JSON.stringify(result.value)}\n${prompt.notes.join("\n")}`;
        assert.equal(serialized.includes(secret), false);
        const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
        if (inputMethod === "skipped") {
          assert.deepEqual(plan.credentialSources, []);
          assert.match(serialized, /missingRequiredCredentialIds/);
          assert.match(serialized, /brave\.search\.api-key/);
        } else {
          assert.equal(plan.credentialSources.length, 1);
          assert.match(
            plan.credentialSources[0]!.fromEnvironment,
            inputMethod === "stdin" ? /_STDIN_/ : /_SECURE_INPUT_/,
          );
          assert.match(serialized, new RegExp(`"inputMethod": "${inputMethod}"`));
        }
        if (stdinCredentials) assert.equal(stdinCredentials["brave.search.api-key"], secret);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("reads bounded credential stdin by logical ID and writes it before capability installation", async () => {
    const root = await temporaryDirectory();
    const secret = "stdin-password-manager-owner-value";
    try {
      const parsed = await readResearchSetupCredentialStdin(
        nonTtyInput(`${secret}\nsecond-owner-secret\n`),
        ["brave.search.api-key", "tiangong.sci.api-key"],
      );
      assert.deepEqual(Object.keys(parsed), ["brave.search.api-key", "tiangong.sci.api-key"]);
      assert.equal(parsed["brave.search.api-key"], secret);
      await assert.rejects(
        readResearchSetupCredentialStdin(nonTtyInput(`${secret}\nextra\n`), [
          "brave.search.api-key",
        ]),
        errorCode("RESEARCH_SETUP_CREDENTIAL_STDIN_INVALID"),
      );

      await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: [],
        acceptedLicenseIds: ["brave-search-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
        confirmNetworkDownloads: true,
      });
      let stdout = "";
      let stderr = "";
      const exitCode = await runCli(
        [
          "research",
          "setup",
          "credential",
          "set",
          "--id",
          "brave.search.api-key",
          "--from-stdin",
          "--workspace",
          root,
          "--json",
        ],
        {
          env: {},
          stdin: nonTtyInput(`${secret}\n`),
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: (chunk: string) => void (stderr += chunk) },
        },
      );
      assert.equal(exitCode, 0);
      assert.equal(`${stdout}\n${stderr}`.includes(secret), false);
      assert.equal((await readFile(workspacePaths(root).env, "utf8")).includes(secret), true);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /"inputMethod":"stdin"/);
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).env)).mode & 0o077, 0);
      }

      const conflicting = await invoke([
        "research",
        "setup",
        "credential",
        "set",
        "--id",
        "brave.search.api-key",
        "--prompt",
        "--from-env",
        "BRAVE_API_KEY",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(conflicting.exitCode, 2);
      assert.equal(JSON.parse(conflicting.stderr).error.code, "RESEARCH_SETUP_ARGUMENT_INVALID");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses semantic Wizard colors only for human TTY output", () => {
    assert.equal(
      shouldUseResearchSetupWizardColor({
        outputIsTTY: true,
        json: false,
        environment: {},
      }),
      true,
    );
    for (const disabled of [
      { outputIsTTY: false, json: false, environment: {} },
      { outputIsTTY: true, json: true, environment: {} },
      { outputIsTTY: true, json: false, environment: { NO_COLOR: "" } },
      { outputIsTTY: true, json: false, environment: { TERM: "dumb" } },
    ]) {
      assert.equal(shouldUseResearchSetupWizardColor(disabled), false);
    }

    const colored = createResearchSetupWizardTheme(true);
    const success = formatResearchSetupWizardNote("Plan created\nSHA-256: abc", "success", colored);
    const warning = formatResearchSetupWizardNote("Credential missing", "warning", colored);
    assert.match(success, /\u001B\[1;32m/);
    assert.match(warning, /\u001B\[1;33m/);
    assert.match(success, /✓/);

    const plain = formatResearchSetupWizardNote(
      "Plan created\nSHA-256: abc",
      "success",
      createResearchSetupWizardTheme(false),
    );
    assert.equal(plain, "\n✓ Plan created\n  SHA-256: abc\n");
    assert.doesNotMatch(plain, /\u001B\[/);
  });

  it("exposes catalog automation without creating files", async () => {
    const root = await temporaryDirectory();
    try {
      const result = await invoke(["research", "setup", "catalog", "--workspace", root, "--json"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).catalog, "tiangong-research-setup-ecosystem");
      assert.equal(await pathExistsSafe(workspacePaths(root).control), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("POST capability broker compatibility", () => {
  it("binds an exact POST body, static header, and credential without persisting request content", async () => {
    const root = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    const secret = "post-capability-owner-secret";
    try {
      const initialized = await invoke(["research", "workspace", "init", root, "--json"]);
      assert.equal(initialized.exitCode, 0, initialized.stderr);
      const skillPath = join(root, "post-search-skill");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: post-search-skill\ndescription: Test bounded POST evidence.\n---\n",
      );
      const skillTreeSha256 = await hashRegularTree(skillPath);
      const declaration = {
        schemaVersion: 1,
        capabilities: [
          {
            id: "database.fixture.post-search",
            skillPath,
            source: {
              type: "local",
              locator: "fixture-post-search",
              immutableRef: `sha256:${skillTreeSha256}`,
              expectedTreeSha256: skillTreeSha256,
              license: "MIT",
              catalogId: null,
            },
            requiredForDiscovery: true,
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["post.example.test"],
            http: {
              endpoint: "https://post.example.test/",
              method: "POST",
              accept: "application/json",
              allowedContentTypes: ["application/json"],
              staticHeaders: { "x-region": "test-region" },
              maxRequestBytes: 1024,
              maxResponseBytes: 4096,
              maxItems: 10,
            },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["academic-paper"],
              discoveryScopes: ["database:fixture"],
              fullText: true,
              publicationDates: true,
            },
            credentials: [
              {
                id: "database.fixture.api-key",
                allowedHosts: ["post.example.test"],
                headerName: "x-api-key",
                prefix: "",
              },
            ],
            healthCheck: null,
          },
        ],
      };
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declaration, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.fixture.api-key":"${secret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);
      let observedMethod = "";
      let observedBody = "";
      let observedRegion = "";
      let observedCredential = "";
      let providerCalls = 0;
      globalThis.fetch = async (request, init) => {
        if (!String(request).startsWith("https://post.example.test/")) {
          return originalFetch(request, init);
        }
        providerCalls += 1;
        observedMethod = init?.method ?? "";
        observedBody = String(init?.body ?? "");
        const headers = new Headers(init?.headers);
        observedRegion = headers.get("x-region") ?? "";
        observedCredential = headers.get("x-api-key") ?? "";
        return new Response('{"records":[{"id":"paper-1"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const capsuleProject = join(root, ".tiangong-research", "runtime", "post-broker-project");
      await mkdir(capsuleProject, { recursive: true });
      const broker = await startCapabilityBroker(root, "post-broker", capsuleProject);
      assert.ok(broker);
      try {
        const result = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.fixture.post-search",
            url: "https://post.example.test/search",
            request_body: { query: "unique-body-not-for-journal", topK: 1 },
          },
        });
        assert.notEqual((result.result as Record<string, unknown>).isError, true);
        assert.equal(observedMethod, "POST");
        assert.equal(observedBody, '{"query":"unique-body-not-for-journal","topK":1}');
        assert.equal(observedRegion, "test-region");
        assert.equal(observedCredential, secret);
        assert.equal(providerCalls, 1);

        const rejected = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.fixture.post-search",
            url: "https://post.example.test/search",
            request_body: { token: secret },
          },
        });
        assert.equal((rejected.result as Record<string, unknown>).isError, true);
        assert.equal(providerCalls, 1);
        const journal = await readFile(workspacePaths(root).journal, "utf8");
        assert.equal(journal.includes("unique-body-not-for-journal"), false);
        assert.equal(journal.includes(secret), false);
        assert.match(journal, /requestBodySha256/);
      } finally {
        await broker.stop();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createEmptyPlan(root: string) {
  return createResearchSetupPlan({
    workspace: root,
    mode: "smoke-test",
    evidenceProfile: "none",
    skillIds: [],
    acceptedLicenseIds: [],
    confirmNetworkDownloads: false,
  });
}

async function writeDoctorPolicyPack(root: string, incompatible: boolean): Promise<void> {
  const policyRoot = join(root, "assets", "research-policy", "defaults");
  const documents: Array<[string, string, string]> = [
    ["baseline/top-journal.md", "baseline.top-journal", "baseline"],
    ["article-types/original-empirical.md", "article.original-empirical", "article-type"],
    ["article-types/computational-modeling.md", "article.computational-modeling", "article-type"],
    ["fields/engineering-computing.md", "field.engineering-computing", "field"],
    [
      "journal-classes/discipline-flagship.md",
      "journal-class.discipline-flagship",
      "journal-class",
    ],
    ["journals/exact-journal-template.md", "journal.exact-template", "exact-journal"],
    ["reviewer-rubrics/evidence.md", "reviewer.evidence", "reviewer-rubric"],
    ["project/publication-brief.md", "project.publication-brief", "publication-brief"],
  ];
  for (const [relative, id, kind] of documents) {
    const path = join(policyRoot, relative);
    await mkdir(join(path, ".."), { recursive: true });
    const templateClass =
      kind === "publication-brief"
        ? "project-template"
        : kind === "exact-journal"
          ? "exact-journal-template"
          : "bundled-default";
    const unsupported =
      incompatible && relative === "article-types/computational-modeling.md"
        ? "\n  unsupportedPinnedConstraint: true"
        : "";
    const required =
      kind === "baseline"
        ? "\n  requireScientificDesignContract: true\n  requireEarlyScientificReviews: true\n  requireRealRecordConstructCanary: true"
        : "";
    await writeFile(
      path,
      `---\nschemaVersion: 1\nid: ${id}\nkind: ${kind}\ntemplateClass: ${templateClass}\npolicyVersion: 1\ntargetTier: top\nrules:\n  - central-claim-directly-supported\nconstraints:\n  minDirectPeerReviewedFullText: 3${required}${unsupported}\nrequiredReviewers:\n  - evidence\nreviewAfterDays: 180\n---\n\n# ${id}\n\nPolicy fixture content.\n`,
    );
  }
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === expected;
}

async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env,
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

async function pathExistsSafe(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-setup-test-"));
}

type ScriptedCredentialInputMethod = "secure-input" | "environment" | "stdin" | "skipped";

class ScriptedWizardPrompt implements ResearchSetupWizardPrompt {
  readonly notes: string[] = [];
  readonly noteTones: ResearchSetupWizardNoteTone[] = [];
  readonly authoringChoices: Array<{ value: string; label: string }> = [];

  readonly credentialInputMethod: ScriptedCredentialInputMethod;
  readonly secretValue: string;

  constructor(
    readonly workspace: string,
    options: { credentialInputMethod?: ScriptedCredentialInputMethod; secret?: string } = {},
  ) {
    this.credentialInputMethod = options.credentialInputMethod ?? "environment";
    this.secretValue = options.secret ?? "scripted-hidden-credential";
  }

  note(message: string, tone: ResearchSetupWizardNoteTone = "info"): void {
    this.notes.push(message);
    this.noteTones.push(tone);
  }

  async input(message: string, defaultValue = ""): Promise<string> {
    if (message.includes("Absolute workspace")) return this.workspace;
    return defaultValue;
  }

  async secret(): Promise<string> {
    return this.secretValue;
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    if (message.includes("post-closure authoring")) return true;
    if (message.startsWith("I reviewed and accept")) return true;
    if (message.includes("model IDs")) return false;
    if (message.includes("live provider")) return false;
    if (message.includes("agent smoke")) return false;
    if (message.includes("Authorize downloads")) return true;
    if (message.includes("Create this immutable")) return true;
    if (message.includes("Apply the reviewed")) return false;
    return defaultValue;
  }

  async select<T extends string>(
    message: string,
    _choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T> {
    if (message === "Research mode") return "production-research" as T;
    if (message.includes("public-internet")) return defaultValue;
    if (message.startsWith("Credential source for")) return this.credentialInputMethod as T;
    if (message === "Install targets") return "codex" as T;
    if (message === "Installation scope") return "project" as T;
    return defaultValue;
  }

  async multiSelect<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
  ): Promise<T[]> {
    if (message === "Post-closure authoring Skills") {
      this.authoringChoices.push(...choices);
      return ["hugohe3.ppt-master", "anthropic.pptx"] as T[];
    }
    return [];
  }

  close(): void {}
}

function nonTtyInput(value: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Object.assign(Readable.from([value]), { isTTY: false });
}

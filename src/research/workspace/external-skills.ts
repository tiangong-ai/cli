import { homedir } from "node:os";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CliError } from "../../errors.js";
import {
  buildCapabilityLock,
  loadCapabilityDeclarations,
  parseCapabilityDeclarations,
  verifyCapabilities,
} from "./capabilities.js";
import {
  inspectCapabilityCredentialEnvironment,
  loadCapabilityCredentialMap,
} from "./credentials.js";
import { sanitizeResearchText } from "./sanitization.js";
import {
  hashRegularTree,
  isObject,
  pathExists,
  readJsonFile,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  CapabilityDeclaration,
  CapabilityDeclarations,
  CapabilityHealthCheckDeclaration,
  CapabilitySourceDeclaration,
} from "./types.js";

export const EXTERNAL_SKILLS_CLI_VERSION = "1.5.22";
export const TIANGONG_SKILLS_REPOSITORY = "tiangong-ai/agent-skills";
const TIANGONG_SKILLS_REPOSITORIES = [TIANGONG_SKILLS_REPOSITORY, "tiangong-ai/skills"];
export const EXTERNAL_SKILL_PROFILE = "internet-research";
export const EXTERNAL_SKILL_CONTEXT_PROFILE = "internet-research-with-context";
export const EXTERNAL_SKILL_MEDIA_PROFILE = "internet-research-with-media";

const BRAVE_SOURCE = {
  repository: "brave/brave-search-skills",
  locator: "https://github.com/brave/brave-search-skills.git",
  immutableRef: "3e088af66eb61f1c207c22b2be0278ca8744d1d1",
  license: "MIT",
} as const;

interface ExternalSkillCatalogEntry {
  id: string;
  capabilityId: string;
  skillName: string;
  tier: "required" | "enhanced" | "conditional";
  purpose: string;
  expectedTreeSha256: string;
  requiredForDiscovery: boolean;
  maxResponseBytes: number;
  maxItems: number;
  fullText: boolean;
  publicationDates: boolean;
  healthUrl: string;
}

interface EvaluatedExternalSkillEntry {
  skillName: string;
  expectedTreeSha256: string;
  disposition: "custom-admission" | "not-evidence-source" | "unsupported-execution";
  reason: string;
}

const EXTERNAL_SKILL_CATALOG: readonly ExternalSkillCatalogEntry[] = [
  {
    id: "external.brave.web-search",
    capabilityId: "method.brave.web-search",
    skillName: "web-search",
    tier: "required",
    purpose: "Broad public-internet discovery with ranked URLs, snippets, dates, and pagination.",
    expectedTreeSha256: "0432f4eb084766046a2feeb146f0b3917850d138eb4182c23fc000a058fbe123",
    requiredForDiscovery: true,
    maxResponseBytes: 1024 * 1024,
    maxItems: 100,
    fullText: false,
    publicationDates: true,
    healthUrl:
      "https://api.search.brave.com/res/v1/web/search?q=tiangong+research+connectivity+check&count=1&result_filter=web",
  },
  {
    id: "external.brave.llm-context",
    capabilityId: "method.brave.llm-context",
    skillName: "llm-context",
    tier: "enhanced",
    purpose: "Bounded extracted web content for grounding beyond search-result snippets.",
    expectedTreeSha256: "5abba551d0498a80eba4e64207f483974f5a312cda5b263c1cc2b7f99d81c4a3",
    requiredForDiscovery: true,
    maxResponseBytes: 2 * 1024 * 1024,
    maxItems: 50,
    fullText: false,
    publicationDates: true,
    healthUrl:
      "https://api.search.brave.com/res/v1/llm/context?q=tiangong+research+connectivity+check&count=1&maximum_number_of_tokens=1024&maximum_number_of_tokens_per_url=512",
  },
  {
    id: "external.brave.news-search",
    capabilityId: "method.brave.news-search",
    skillName: "news-search",
    tier: "required",
    purpose: "Date-sensitive news discovery that complements the general web index.",
    expectedTreeSha256: "80f8dcb7c78209cce5315e507f0aba21e3f654f42f6a414c177de644bcd07773",
    requiredForDiscovery: true,
    maxResponseBytes: 1024 * 1024,
    maxItems: 100,
    fullText: false,
    publicationDates: true,
    healthUrl:
      "https://api.search.brave.com/res/v1/news/search?q=tiangong+research+connectivity+check&count=1",
  },
  {
    id: "external.brave.images-search",
    capabilityId: "method.brave.images-search",
    skillName: "images-search",
    tier: "conditional",
    purpose:
      "Image-source discovery for research questions with a material visual-evidence dimension.",
    expectedTreeSha256: "467a9afae0e959b482cb6b2236a57a327959b28985871f88c202dc70b10a7c84",
    requiredForDiscovery: false,
    maxResponseBytes: 1024 * 1024,
    maxItems: 200,
    fullText: false,
    publicationDates: true,
    healthUrl:
      "https://api.search.brave.com/res/v1/images/search?q=tiangong+research+connectivity+check&count=1",
  },
  {
    id: "external.brave.videos-search",
    capabilityId: "method.brave.videos-search",
    skillName: "videos-search",
    tier: "conditional",
    purpose: "Video-source discovery for research questions with a material audiovisual dimension.",
    expectedTreeSha256: "ff3a2e2291efc27f3f09847b7e0b20e77d229f6a44a1a64e562964c820eb9719",
    requiredForDiscovery: false,
    maxResponseBytes: 1024 * 1024,
    maxItems: 100,
    fullText: false,
    publicationDates: true,
    healthUrl:
      "https://api.search.brave.com/res/v1/videos/search?q=tiangong+research+connectivity+check&count=1",
  },
] as const;

const TIANGONG_DATABASE_SPECS = {
  sci: {
    label: "SCI",
    catalogId: "first-party.tiangong.kb-sci-search",
    capabilityId: "database.tiangong.sci-search",
    credentialId: "tiangong.sci.api-key",
    sourceTypes: ["academic-paper", "journal-article"],
    discoveryScope: "database:tiangong-sci",
    healthBody: {
      query: "tiangong research connectivity check",
      topK: 1,
      extK: 0,
      getMeta: true,
    },
  },
  report: {
    label: "report",
    catalogId: "first-party.tiangong.kb-report-search",
    capabilityId: "database.tiangong.report-search",
    credentialId: "tiangong.report.api-key",
    sourceTypes: ["industry-report", "policy-report", "whitepaper"],
    discoveryScope: "database:tiangong-report",
    healthBody: {
      query: "tiangong research connectivity check",
      topK: 1,
      extK: 0,
    },
  },
  patent: {
    label: "patent",
    catalogId: "first-party.tiangong.kb-patent-search",
    capabilityId: "database.tiangong.patent-search",
    credentialId: "tiangong.patent.api-key",
    sourceTypes: ["patent"],
    discoveryScope: "database:tiangong-patent",
    healthBody: {
      query: "tiangong research connectivity check",
      topK: 1,
    },
  },
} as const;
export type TiangongDatabaseKind = keyof typeof TIANGONG_DATABASE_SPECS;
const SETUP_MANAGED_CATALOG_IDS = new Set([
  ...EXTERNAL_SKILL_CATALOG.map((entry) => entry.id),
  ...Object.values(TIANGONG_DATABASE_SPECS).map((entry) => entry.catalogId),
]);

const EVALUATED_EXTERNAL_SKILLS: readonly EvaluatedExternalSkillEntry[] = [
  {
    skillName: "answers",
    expectedTreeSha256: "7c11afce362b8beb6a3c27ef0f77d82d10869db2ee583f74ecf0d76422d4410a",
    disposition: "unsupported-execution",
    reason:
      "Its synthesized-answer endpoint is not a raw-evidence source; broker support for bounded JSON POST does not make synthesized answers admissible evidence.",
  },
  {
    skillName: "bx",
    expectedTreeSha256: "c5847b34c8b3c751891014ffb09c1a7842fef20efb7993c255ff5419ed53d017",
    disposition: "unsupported-execution",
    reason:
      "It delegates to a separately installed executable and credential store; arbitrary command execution is outside brokered evidence admission.",
  },
  {
    skillName: "local-descriptions",
    expectedTreeSha256: "4a5750f8564bb9664366b2250048c5bb59a44420b8e758e23147458a582ee2b9",
    disposition: "custom-admission",
    reason:
      "It consumes location IDs from a prior search, so admit it explicitly when the research question has a material local-place dimension.",
  },
  {
    skillName: "local-pois",
    expectedTreeSha256: "17187a13051014c83a85debfcf42e948b0630ee23e6fbb62817603090bc8a2ef",
    disposition: "custom-admission",
    reason:
      "It consumes location IDs from a prior search, so admit it explicitly when the research question has a material POI dimension.",
  },
  {
    skillName: "spellcheck",
    expectedTreeSha256: "98ec9f346ab442288f3a4cd17ef6dd0a56e0fed61ee273a6df38733087254cd5",
    disposition: "not-evidence-source",
    reason: "It normalizes queries but does not produce independently reviewable evidence.",
  },
  {
    skillName: "suggest",
    expectedTreeSha256: "88213b478e2010bd511d4fc98770093121a47de64ee890d76c91b8b6d8aa61ad",
    disposition: "not-evidence-source",
    reason: "It proposes queries but does not produce independently reviewable evidence.",
  },
] as const;

export async function inspectExternalSkillCatalog(input: {
  selectedPath: string;
  workspace?: string | null;
  skillRoot?: string | null;
}) {
  const selectedPath = resolve(input.selectedPath);
  const workspace = input.workspace ? resolve(input.workspace) : null;
  const roots = skillRoots(selectedPath, input.skillRoot ?? null);
  const declarations = workspace ? await loadCapabilityDeclarations(workspace) : null;
  const verification = workspace ? await verifyCapabilities(workspace) : null;
  let credentialEnvironment: Awaited<
    ReturnType<typeof inspectCapabilityCredentialEnvironment>
  > | null = null;
  let credentialEnvironmentError: string | null = null;
  if (workspace) {
    try {
      credentialEnvironment = await inspectCapabilityCredentialEnvironment(
        workspace,
        declarations?.capabilities ?? [],
      );
    } catch (error) {
      credentialEnvironmentError = sanitizeResearchText(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const entries = [];
  for (const entry of EXTERNAL_SKILL_CATALOG) {
    const installation = await inspectCatalogInstallation(entry, roots);
    const declaration = declarations?.capabilities.find(
      (capability) =>
        capability.source?.catalogId === entry.id ||
        (basename(capability.skillPath) === entry.skillName &&
          capability.id === entry.capabilityId),
    );
    const locked =
      declaration !== undefined &&
      capabilityVerificationErrors(verification, declaration.id).length === 0;
    const credentialStatus = credentialEnvironmentError
      ? "blocked"
      : declaration
        ? declaration.credentials.length === 0
          ? "not-required"
          : declaration.credentials.every((credential) =>
                credentialEnvironment?.configuredIds.includes(credential.id),
              )
            ? "configured"
            : "missing"
        : "not-configured";
    entries.push({
      id: entry.id,
      capabilityId: entry.capabilityId,
      skillName: entry.skillName,
      tier: entry.tier,
      purpose: entry.purpose,
      source: {
        repository: BRAVE_SOURCE.repository,
        locator: BRAVE_SOURCE.locator,
        immutableRef: BRAVE_SOURCE.immutableRef,
        license: BRAVE_SOURCE.license,
        expectedTreeSha256: entry.expectedTreeSha256,
      },
      install: {
        projectPlan: pinnedInstallPlan(false, selectedPath, [entry.skillName]),
        globalPlan: pinnedInstallPlan(true, selectedPath, [entry.skillName]),
        automaticAtRuntime: false,
      },
      configuration: {
        allowedHosts: ["api.search.brave.com"],
        credentialIds: ["brave.search.api-key"],
        discoveryScopes: ["public-internet"],
        requiredForDiscovery: entry.requiredForDiscovery,
        providerPlan:
          entry.tier === "enhanced"
            ? "Requires provider subscription access to LLM Context."
            : "Brave Search API plan with access to the selected endpoint.",
      },
      installation,
      status: {
        configured: declaration !== undefined,
        locked,
        credential: credentialStatus,
      },
    });
  }
  const evaluatedAlternatives = [];
  for (const entry of EVALUATED_EXTERNAL_SKILLS) {
    evaluatedAlternatives.push({
      skillName: entry.skillName,
      recommended: false as const,
      disposition: entry.disposition,
      reason: entry.reason,
      source: {
        repository: BRAVE_SOURCE.repository,
        locator: BRAVE_SOURCE.locator,
        immutableRef: BRAVE_SOURCE.immutableRef,
        license: BRAVE_SOURCE.license,
        expectedTreeSha256: entry.expectedTreeSha256,
      },
      install: {
        projectPlan: pinnedInstallPlan(false, selectedPath, [entry.skillName]),
        globalPlan: pinnedInstallPlan(true, selectedPath, [entry.skillName]),
        automaticAtRuntime: false,
      },
      installation: await inspectCatalogInstallation(entry, roots),
      configuration:
        entry.disposition === "custom-admission"
          ? {
              status: "requires-explicit-import" as const,
              command:
                "tiangong-ai research capability import --definition /absolute/capability.json --workspace /absolute/workspace --json",
            }
          : {
              status: "not-supported" as const,
              command: null,
            },
    });
  }
  const workspaceCapabilities =
    declarations?.capabilities.map((capability) => {
      const lockErrors = capabilityVerificationErrors(verification, capability.id);
      const credentialIds = capability.credentials.map((credential) => credential.id);
      return {
        id: capability.id,
        skillName: basename(capability.skillPath),
        catalogId: capability.source?.catalogId ?? null,
        externalSource: isExternalCapabilitySource(capability.source),
        source:
          capability.source === null
            ? null
            : {
                type: capability.source.type,
                locatorSha256: sha256Text(capability.source.locator),
                immutableRef: capability.source.immutableRef,
                expectedTreeSha256: capability.source.expectedTreeSha256,
                license: capability.source.license,
              },
        requiredForDiscovery: capability.requiredForDiscovery,
        discoveryScopes: capability.coverage?.discoveryScopes ?? [],
        allowedHosts: capability.allowedHosts,
        credentialIds,
        status: {
          locked: verification?.status === "verified" || lockErrors.length === 0,
          credential: credentialEnvironmentError
            ? "blocked"
            : credentialIds.length === 0
              ? "not-required"
              : credentialIds.every((credentialId) =>
                    credentialEnvironment?.configuredIds.includes(credentialId),
                  )
                ? "configured"
                : "missing",
          errors: lockErrors,
        },
      };
    }) ?? [];
  return {
    schemaVersion: 1 as const,
    catalog: "tiangong-research-external-skills",
    policy: {
      implementations: "external-only",
      runtimeInstall: false,
      projectLocalCopyRecommended: true,
    },
    installer: {
      package: "skills",
      version: EXTERNAL_SKILLS_CLI_VERSION,
      source: {
        locator: BRAVE_SOURCE.locator,
        immutableRef: BRAVE_SOURCE.immutableRef,
      },
      projectPlan: pinnedInstallPlan(false, selectedPath),
      globalPlan: pinnedInstallPlan(true, selectedPath),
      allRecommendedProjectPlan: pinnedInstallPlan(
        false,
        selectedPath,
        EXTERNAL_SKILL_CATALOG.map((entry) => entry.skillName),
      ),
      allRecommendedGlobalPlan: pinnedInstallPlan(
        true,
        selectedPath,
        EXTERNAL_SKILL_CATALOG.map((entry) => entry.skillName),
      ),
    },
    profiles: [
      {
        id: EXTERNAL_SKILL_PROFILE,
        description: "Required public-internet evidence discovery and bounded page context.",
        skillIds: EXTERNAL_SKILL_CATALOG.filter((entry) => entry.tier === "required").map(
          (entry) => entry.id,
        ),
      },
      {
        id: EXTERNAL_SKILL_CONTEXT_PROFILE,
        description:
          "Required public-internet discovery plus plan-dependent extracted page context.",
        skillIds: EXTERNAL_SKILL_CATALOG.filter((entry) => entry.tier !== "conditional").map(
          (entry) => entry.id,
        ),
      },
      {
        id: EXTERNAL_SKILL_MEDIA_PROFILE,
        description: "Public-internet evidence discovery plus image and video source discovery.",
        skillIds: EXTERNAL_SKILL_CATALOG.map((entry) => entry.id),
      },
    ],
    conditionalSkillIds: EXTERNAL_SKILL_CATALOG.filter((entry) => entry.tier === "conditional").map(
      (entry) => entry.id,
    ),
    enhancedSkillIds: EXTERNAL_SKILL_CATALOG.filter((entry) => entry.tier === "enhanced").map(
      (entry) => entry.id,
    ),
    entries,
    evaluatedAlternatives,
    credentials: [
      {
        id: "brave.search.api-key",
        provider: "Brave Search API",
        requiredBy: EXTERNAL_SKILL_CATALOG.map((entry) => entry.id),
        obtainAt: "https://api.search.brave.com",
        workspaceEnvironmentKey: "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON",
        exampleAssignment:
          'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"brave.search.api-key":"REPLACE_WITH_OWNER_VALUE"}',
        configureCommand:
          "tiangong-ai research capability credential set --id brave.search.api-key --from-env BRAVE_SEARCH_API_KEY --workspace /absolute/workspace --json",
        minimumUtf8Bytes: 8,
        outputPolicy: "value-is-never-emitted",
      },
    ],
    customExternalCapabilities: {
      supported: true,
      purpose:
        "Bind an owner-selected external Skill to an explicitly allowlisted database or evidence API.",
      supportedKinds: [
        {
          kind: "brokered-evidence",
          execution:
            "The isolated producer translates the staged external Skill's exact documented GET or JSON POST endpoint into the credential broker.",
          permissions: ["project-read", "candidate-write", "brokered-network"],
        },
        {
          kind: "method-guidance",
          execution:
            "The staged external Skill provides reviewed method instructions only; it does not grant network or tool execution.",
          permissions: ["project-read", "candidate-write"],
        },
      ],
      runtimeInstall: false,
      sourceRequirements: [
        "external source identity",
        "immutable source reference",
        "whole-tree lock",
        "license identifier",
      ],
      networkRequirements: [
        "credential-free exact HTTPS endpoint on an allowed host",
        "bounded GET or JSON POST response policy",
        "safe healthCheck",
        "logical credential declarations only",
      ],
      commands: [
        "tiangong-ai research capability import --definition /absolute/capability.json --workspace /absolute/workspace --json",
        "tiangong-ai research capability doctor --live --workspace /absolute/workspace --json",
      ],
      brokeredEvidenceDefinitionTemplate: {
        id: "database.owner-source.search",
        skillPath: "/absolute/path/to/external-database-skill",
        source: {
          type: "git",
          locator: "https://github.com/EXTERNAL_OWNER/EXTERNAL_SKILL.git",
          immutableRef: "FULL_40_CHARACTER_COMMIT_SHA",
          expectedTreeSha256: "FULL_64_CHARACTER_TREE_SHA256",
          license: "SPDX_OR_LICENSE_REF",
          catalogId: null,
        },
        requiredForDiscovery: true,
        permissions: ["project-read", "candidate-write", "brokered-network"],
        allowedHosts: ["database.example.org"],
        http: {
          endpoint: "https://database.example.org/search",
          accept: "application/json",
          allowedContentTypes: ["application/json"],
          maxResponseBytes: 524288,
          maxItems: 100,
        },
        coverage: {
          dimensions: ["*"],
          sourceTypes: ["*"],
          discoveryScopes: ["database:owner-source"],
          fullText: true,
          publicationDates: true,
        },
        credentials: [
          {
            id: "database.owner-source.api-key",
            allowedHosts: ["database.example.org"],
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        ],
        healthCheck: {
          url: "https://database.example.org/search?query=connectivity",
          credentialId: "database.owner-source.api-key",
          expectedContentTypes: ["application/json"],
        },
      },
    },
    workspaceCapabilities,
    summary: {
      recommended: entries.length,
      evaluated: entries.length + evaluatedAlternatives.length,
      notSelected: evaluatedAlternatives.length,
      required: entries.filter((entry) => entry.tier === "required").length,
      enhanced: entries.filter((entry) => entry.tier === "enhanced").length,
      conditional: entries.filter((entry) => entry.tier === "conditional").length,
      installed: entries.filter((entry) => entry.installation.status === "installed").length,
      configured: entries.filter((entry) => entry.status.configured).length,
      credentialsReady: entries.filter(
        (entry) =>
          entry.status.credential === "configured" || entry.status.credential === "not-required",
      ).length,
      workspaceCapabilities: workspaceCapabilities.length,
    },
    workspace,
    skillRoots: roots,
    capabilityVerification: verification,
    credentialEnvironment: credentialEnvironmentError
      ? { status: "blocked" as const, detail: credentialEnvironmentError, missingIds: [] }
      : workspace
        ? {
            status: credentialEnvironment?.missingIds.length
              ? ("blocked" as const)
              : ("ready" as const),
            detail: credentialEnvironment?.detail ?? "unavailable",
            missingIds: credentialEnvironment?.missingIds ?? [],
          }
        : null,
  };
}

export async function configureExternalSkillProfile(input: {
  workspace: string;
  profile: string;
  skillRoot?: string | null;
}) {
  if (
    input.profile !== EXTERNAL_SKILL_PROFILE &&
    input.profile !== EXTERNAL_SKILL_CONTEXT_PROFILE &&
    input.profile !== EXTERNAL_SKILL_MEDIA_PROFILE
  ) {
    throw new CliError(`Unsupported external Skill profile: ${input.profile}`, {
      code: "RESEARCH_EXTERNAL_SKILL_PROFILE_INVALID",
      exitCode: 2,
      details: {
        supportedProfiles: [
          EXTERNAL_SKILL_PROFILE,
          EXTERNAL_SKILL_CONTEXT_PROFILE,
          EXTERNAL_SKILL_MEDIA_PROFILE,
        ],
      },
    });
  }
  const workspace = resolve(input.workspace);
  await requireExistingCapabilitiesVerified(workspace);
  const roots = skillRoots(workspace, input.skillRoot ?? null);
  const selectedEntries = EXTERNAL_SKILL_CATALOG.filter(
    (entry) =>
      input.profile === EXTERNAL_SKILL_MEDIA_PROFILE ||
      entry.tier === "required" ||
      (input.profile === EXTERNAL_SKILL_CONTEXT_PROFILE && entry.tier === "enhanced"),
  );
  const configured = await Promise.all(
    selectedEntries.map(async (entry) =>
      catalogDeclaration(entry, await requireCatalogSkill(entry, roots, workspace)),
    ),
  );
  const existing = await loadCapabilityDeclarations(workspace);
  const configuredById = new Map(configured.map((capability) => [capability.id, capability]));
  for (const capability of existing.capabilities) {
    const replacement = configuredById.get(capability.id);
    if (replacement && capability.source?.catalogId !== replacement.source?.catalogId) {
      throw new CliError(
        `Capability ID conflicts with the external Skill profile: ${capability.id}`,
        {
          code: "RESEARCH_CAPABILITY_CONFLICT",
          exitCode: 3,
        },
      );
    }
  }
  const merged = parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: [
      ...existing.capabilities.filter(
        (capability) =>
          !EXTERNAL_SKILL_CATALOG.some((entry) => entry.id === capability.source?.catalogId) &&
          !configuredById.has(capability.id),
      ),
      ...configured,
    ],
  });
  const lock = await buildCapabilityLock(merged);
  await persistDeclarationsAndLock(workspace, merged, lock);
  return {
    schemaVersion: 1 as const,
    workspace,
    profile: input.profile,
    configured: configured.map((capability) => ({
      id: capability.id,
      skillName: basename(capability.skillPath),
      treeSha256: lock.capabilities.find((record) => record.id === capability.id)?.treeSha256,
      credentialIds: capability.credentials.map((credential) => credential.id),
      requiredForDiscovery: capability.requiredForDiscovery,
    })),
    lockStatus: "written" as const,
    next: [
      "Configure declared logical credential values in .tiangong-research/.env with mode 0600.",
      "Run research capability doctor --live before production preflight.",
    ],
  };
}

export async function reconcileSetupManagedCapabilities(input: {
  workspace: string;
  selectedCapabilityIds: readonly string[];
}) {
  const workspace = resolve(input.workspace);
  await requireExistingCapabilitiesVerified(workspace);
  const selectedCapabilityIds = new Set(input.selectedCapabilityIds);
  const existing = await loadCapabilityDeclarations(workspace);
  const removed = existing.capabilities.filter(
    (capability) =>
      capability.source?.catalogId !== null &&
      capability.source?.catalogId !== undefined &&
      SETUP_MANAGED_CATALOG_IDS.has(capability.source.catalogId) &&
      !selectedCapabilityIds.has(capability.id),
  );
  const retained = parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: existing.capabilities.filter(
      (capability) => !removed.some((candidate) => candidate.id === capability.id),
    ),
  });
  const lock = await buildCapabilityLock(retained);
  await persistDeclarationsAndLock(workspace, retained, lock);
  return {
    schemaVersion: 1 as const,
    workspace,
    selectedCapabilityIds: [...selectedCapabilityIds].sort(),
    removedCapabilityIds: removed.map((capability) => capability.id).sort(),
    preservedCapabilityIds: retained.capabilities.map((capability) => capability.id).sort(),
    installedSkillDirectoriesRemoved: false as const,
    lockStatus: "written" as const,
  };
}

export async function configureTiangongSciCapability(input: {
  workspace: string;
  skillPath: string;
  source: CapabilitySourceDeclaration;
  endpoint: string;
  region?: string | null;
}) {
  return configureTiangongDatabaseCapability({ ...input, kind: "sci" });
}

export async function configureTiangongDatabaseCapability(input: {
  kind: TiangongDatabaseKind;
  workspace: string;
  skillPath: string;
  source: CapabilitySourceDeclaration;
  endpoint: string;
  region?: string | null;
}) {
  const spec = TIANGONG_DATABASE_SPECS[input.kind];
  const workspace = resolve(input.workspace);
  await requireExistingCapabilitiesVerified(workspace);
  if (
    input.source.type !== "git" ||
    !TIANGONG_SKILLS_REPOSITORIES.some(
      (repository) =>
        input.source.locator.replace(/\/+$/, "") === `https://github.com/${repository}.git`,
    ) ||
    input.source.catalogId !== spec.catalogId
  ) {
    throw new CliError(
      `Tiangong ${spec.label} capability source identity is not the reviewed first-party catalog entry.`,
      {
        code: "RESEARCH_SETUP_SOURCE_INVALID",
        exitCode: 3,
      },
    );
  }
  const skillInfo = await lstat(input.skillPath).catch(() => undefined);
  if (!skillInfo?.isDirectory() || skillInfo.isSymbolicLink()) {
    throw new CliError(`Tiangong ${spec.label} Skill must be a regular non-symlink directory.`, {
      code: "RESEARCH_EXTERNAL_SKILL_NOT_READY",
      exitCode: 3,
    });
  }
  const observedTreeSha256 = await hashRegularTree(input.skillPath);
  if (observedTreeSha256 !== input.source.expectedTreeSha256) {
    throw new CliError(`Tiangong ${spec.label} Skill bytes differ from the reviewed tree hash.`, {
      code: "RESEARCH_EXTERNAL_SKILL_NOT_READY",
      exitCode: 3,
      details: {
        expectedTreeSha256: input.source.expectedTreeSha256,
        observedTreeSha256,
      },
    });
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new CliError(`Tiangong ${spec.label} endpoint is invalid.`, {
      code: "RESEARCH_SETUP_SETTING_INVALID",
      exitCode: 2,
    });
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !endpoint.host) {
    throw new CliError(`Tiangong ${spec.label} endpoint must be credential-free HTTPS.`, {
      code: "RESEARCH_SETUP_SETTING_INVALID",
      exitCode: 2,
    });
  }
  const region = input.region?.trim() || "us-east-1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new CliError(`Tiangong ${spec.label} region is invalid.`, {
      code: "RESEARCH_SETUP_SETTING_INVALID",
      exitCode: 2,
    });
  }
  const configured = parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: [
      {
        id: spec.capabilityId,
        skillPath: resolve(input.skillPath),
        source: input.source,
        requiredForDiscovery: true,
        permissions: ["project-read", "candidate-write", "brokered-network"],
        allowedHosts: [endpoint.host.toLowerCase()],
        http: {
          endpoint: endpoint.toString(),
          method: "POST",
          accept: "application/json",
          allowedContentTypes: ["application/json"],
          staticHeaders: { "x-region": region },
          maxRequestBytes: 64 * 1024,
          maxResponseBytes: 2 * 1024 * 1024,
          maxItems: 100,
        },
        coverage: {
          dimensions: ["*"],
          sourceTypes: [...spec.sourceTypes],
          discoveryScopes: [spec.discoveryScope],
          fullText: true,
          publicationDates: true,
        },
        credentials: [
          {
            id: spec.credentialId,
            allowedHosts: [endpoint.host.toLowerCase()],
            headerName: "x-api-key",
            prefix: "",
          },
        ],
        healthCheck: {
          url: endpoint.toString(),
          credentialId: spec.credentialId,
          expectedContentTypes: ["application/json"],
          method: "POST",
          body: spec.healthBody,
        },
      },
    ],
  }).capabilities[0]!;
  const existing = await loadCapabilityDeclarations(workspace);
  const conflict = existing.capabilities.find(
    (capability) =>
      capability.id === configured.id && capability.source?.catalogId !== input.source.catalogId,
  );
  if (conflict) {
    throw new CliError(`Capability ID conflicts with Tiangong ${spec.label}: ${configured.id}`, {
      code: "RESEARCH_CAPABILITY_CONFLICT",
      exitCode: 3,
    });
  }
  const merged = parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: [
      ...existing.capabilities.filter((capability) => capability.id !== configured.id),
      configured,
    ],
  });
  const lock = await buildCapabilityLock(merged);
  await persistDeclarationsAndLock(workspace, merged, lock);
  return {
    schemaVersion: 1 as const,
    workspace,
    configured: {
      id: configured.id,
      skillName: basename(configured.skillPath),
      treeSha256: observedTreeSha256,
      credentialIds: configured.credentials.map((credential) => credential.id),
      requiredForDiscovery: configured.requiredForDiscovery,
      discoveryScopes: configured.coverage?.discoveryScopes ?? [],
    },
    lockStatus: "written" as const,
  };
}

export async function importExternalCapability(input: {
  workspace: string;
  definitionPath: string;
}) {
  if (!isAbsolute(input.definitionPath)) {
    throw new CliError("External capability definition path must be absolute.", {
      code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
      exitCode: 2,
    });
  }
  const info = await lstat(input.definitionPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError("External capability definition must be a regular non-symlink JSON file.", {
      code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
      exitCode: 2,
    });
  }
  let source: unknown;
  try {
    source = JSON.parse(await readFile(input.definitionPath, "utf8")) as unknown;
  } catch {
    throw new CliError("External capability definition is unreadable or invalid JSON.", {
      code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
      exitCode: 2,
    });
  }
  const imported = parseCapabilityDeclarations({ schemaVersion: 1, capabilities: [source] })
    .capabilities[0]!;
  if (!isExternalCapabilitySource(imported.source) || imported.source?.catalogId !== null) {
    throw new CliError("Imported research capabilities must identify an external Skill source.", {
      code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
      exitCode: 2,
    });
  }
  if (imported.permissions.includes("brokered-network") && !imported.healthCheck) {
    throw new CliError("Imported brokered-network capabilities require a safe healthCheck.", {
      code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
      exitCode: 2,
    });
  }
  const workspace = resolve(input.workspace);
  await requireExistingCapabilitiesVerified(workspace);
  const existing = await loadCapabilityDeclarations(workspace);
  if (existing.capabilities.some((capability) => capability.id === imported.id)) {
    throw new CliError(`Capability ID already exists: ${imported.id}`, {
      code: "RESEARCH_CAPABILITY_CONFLICT",
      exitCode: 3,
    });
  }
  const merged = parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: [...existing.capabilities, imported],
  });
  const lock = await buildCapabilityLock(merged);
  await persistDeclarationsAndLock(workspace, merged, lock);
  return {
    schemaVersion: 1 as const,
    workspace,
    imported: {
      id: imported.id,
      skillName: basename(imported.skillPath),
      sourceType: imported.source.type,
      sourceLocatorSha256: sha256Text(imported.source.locator),
      immutableRef: imported.source.immutableRef,
      expectedTreeSha256: imported.source.expectedTreeSha256,
      license: imported.source.license,
      requiredForDiscovery: imported.requiredForDiscovery,
      discoveryScopes: imported.coverage?.discoveryScopes ?? [],
    },
    lockStatus: "written" as const,
  };
}

export async function doctorExternalCapabilities(
  workspace: string,
  options: {
    live?: boolean;
    fetcher?: typeof fetch;
    sleeper?: (milliseconds: number) => Promise<unknown>;
  } = {},
) {
  const root = resolve(workspace);
  const declarations = await loadCapabilityDeclarations(root);
  const verification = await verifyCapabilities(root);
  let credentialEnvironment: Awaited<
    ReturnType<typeof inspectCapabilityCredentialEnvironment>
  > | null = null;
  let credentialError: string | null = null;
  let credentialMap = new Map<string, string>();
  try {
    credentialEnvironment = await inspectCapabilityCredentialEnvironment(
      root,
      declarations.capabilities,
    );
    credentialMap = await loadCapabilityCredentialMap(root, declarations.capabilities);
  } catch (error) {
    credentialError = sanitizeResearchText(error instanceof Error ? error.message : String(error));
  }
  const lock = await readJsonFile<unknown>(
    workspacePaths(root).capabilityLock,
    "Capability lock",
  ).catch(() => null);
  const lockRecords =
    isObject(lock) && Array.isArray(lock.capabilities) ? lock.capabilities.filter(isObject) : [];
  const capabilities = [];
  for (const capability of declarations.capabilities) {
    const lockRecord = lockRecords.find((record) => record.id === capability.id);
    const missingCredentialIds = capability.credentials
      .map((credential) => credential.id)
      .filter((credentialId) => !credentialMap.has(credentialId));
    const staticErrors: string[] = [];
    if (!lockRecord || capabilityVerificationErrors(verification, capability.id).length > 0) {
      staticErrors.push("lock-or-tree-drift");
    }
    if (missingCredentialIds.length) staticErrors.push("credential-missing");
    if (credentialError) staticErrors.push("credential-environment-invalid");
    if (capability.permissions.includes("brokered-network") && !capability.healthCheck) {
      staticErrors.push("health-check-missing");
    }
    if (
      capability.coverage?.discoveryScopes.includes("public-internet") &&
      !isExternalCapabilitySource(capability.source)
    ) {
      staticErrors.push("external-source-required");
    }
    const health = options.live
      ? staticErrors.length
        ? {
            status: "blocked" as const,
            code: missingCredentialIds.length
              ? "BROKER_CREDENTIAL_NOT_CONFIGURED"
              : staticErrors.includes("health-check-missing")
                ? "CAPABILITY_NOT_DECLARED"
                : staticErrors[0]!,
            host: capability.healthCheck ? new URL(capability.healthCheck.url).host : null,
            targetSha256: capability.healthCheck ? sha256Text(capability.healthCheck.url) : null,
            httpStatus: null,
            retryAfterSeconds: null,
            providerCode: null,
            providerRequestId: null,
            minimumAction: missingCredentialIds.length
              ? "Configure each missing logical credential through research setup credential set, then rerun capability doctor."
              : "Resolve the reported static readiness error before retrying live checks.",
            detail: "Live probe was not started because static readiness failed.",
            executionMode: "broker" as const,
            credentialScope: "broker" as const,
            networkAttempted: false,
          }
        : capability.healthCheck
          ? await probeCapability(
              capability,
              capability.healthCheck,
              credentialMap,
              options.fetcher,
              options.sleeper,
            )
          : {
              status: "not-applicable" as const,
              code: "not-applicable",
              host: null,
              targetSha256: null,
              httpStatus: null,
              retryAfterSeconds: null,
              providerCode: null,
              providerRequestId: null,
              minimumAction: null,
              detail: "Capability has no brokered network health check.",
            }
      : {
          status: "not-run" as const,
          code: "not-run",
          host: capability.healthCheck ? new URL(capability.healthCheck.url).host : null,
          targetSha256: capability.healthCheck ? sha256Text(capability.healthCheck.url) : null,
          httpStatus: null,
          retryAfterSeconds: null,
          providerCode: null,
          providerRequestId: null,
          minimumAction: "Rerun capability doctor with --live after reviewing quota impact.",
          detail: "Use --live for an explicit provider connectivity probe.",
        };
    capabilities.push({
      id: capability.id,
      skillName: basename(capability.skillPath),
      catalogId: capability.source?.catalogId ?? null,
      sourceType: capability.source?.type ?? null,
      externalSource: isExternalCapabilitySource(capability.source),
      installed: Boolean(lockRecord),
      locked: Boolean(lockRecord) && verification.status === "verified",
      requiredForDiscovery: capability.requiredForDiscovery,
      discoveryScopes: capability.coverage?.discoveryScopes ?? [],
      credentialIds: capability.credentials.map((credential) => credential.id),
      missingCredentialIds,
      staticStatus: staticErrors.length ? "blocked" : "ready",
      staticErrors,
      health,
    });
  }
  const failures = capabilities.flatMap((capability) => {
    const rows = capability.staticStatus === "blocked" ? [`${capability.id}:static`] : [];
    if (
      options.live &&
      capability.health.status !== "pass" &&
      capability.health.status !== "not-applicable"
    ) {
      rows.push(`${capability.id}:live`);
    }
    return rows;
  });
  if (credentialError) failures.push("credential-environment");
  return {
    schemaVersion: 1 as const,
    workspace: root,
    mode: options.live ? ("live" as const) : ("static" as const),
    status: failures.length ? ("blocked" as const) : ("ready" as const),
    capabilityVerification: verification,
    credentialEnvironment: credentialError
      ? { status: "blocked" as const, detail: credentialError, missingIds: [] }
      : {
          status: credentialEnvironment?.missingIds.length
            ? ("blocked" as const)
            : ("ready" as const),
          detail: credentialEnvironment?.detail ?? "unavailable",
          missingIds: credentialEnvironment?.missingIds ?? [],
        },
    capabilities,
    failures,
  };
}

export function hasPublicInternetCapability(declarations: CapabilityDeclarations): boolean {
  return declarations.capabilities.some(
    (capability) =>
      capability.permissions.includes("brokered-network") &&
      capability.coverage?.discoveryScopes.includes("public-internet") &&
      isExternalCapabilitySource(capability.source),
  );
}

export function requiredDiscoveryCapabilityIds(declarations: CapabilityDeclarations): string[] {
  return declarations.capabilities
    .filter(
      (capability) =>
        capability.requiredForDiscovery && capability.permissions.includes("brokered-network"),
    )
    .map((capability) => capability.id)
    .sort();
}

function catalogDeclaration(
  entry: ExternalSkillCatalogEntry,
  skillPath: string,
): CapabilityDeclaration {
  return parseCapabilityDeclarations({
    schemaVersion: 1,
    capabilities: [
      {
        id: entry.capabilityId,
        skillPath,
        source: {
          type: "git",
          locator: BRAVE_SOURCE.locator,
          immutableRef: BRAVE_SOURCE.immutableRef,
          expectedTreeSha256: entry.expectedTreeSha256,
          license: BRAVE_SOURCE.license,
          catalogId: entry.id,
        },
        requiredForDiscovery: entry.requiredForDiscovery,
        permissions: ["project-read", "candidate-write", "brokered-network"],
        allowedHosts: ["api.search.brave.com"],
        http: {
          endpoint: capabilityEndpoint(entry.healthUrl),
          accept: "application/json",
          allowedContentTypes: ["application/json"],
          maxResponseBytes: entry.maxResponseBytes,
          maxItems: entry.maxItems,
        },
        coverage: {
          dimensions: ["*"],
          sourceTypes: ["*"],
          discoveryScopes: ["public-internet"],
          fullText: entry.fullText,
          publicationDates: entry.publicationDates,
        },
        credentials: [
          {
            id: "brave.search.api-key",
            allowedHosts: ["api.search.brave.com"],
            headerName: "X-Subscription-Token",
            prefix: "",
          },
        ],
        healthCheck: {
          url: entry.healthUrl,
          credentialId: "brave.search.api-key",
          expectedContentTypes: ["application/json"],
        },
      },
    ],
  }).capabilities[0]!;
}

function capabilityEndpoint(healthUrl: string): string {
  const endpoint = new URL(healthUrl);
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

async function inspectCatalogInstallation(
  entry: Pick<ExternalSkillCatalogEntry, "skillName" | "expectedTreeSha256">,
  roots: string[],
): Promise<{
  status: "missing" | "installed" | "drifted" | "ambiguous";
  paths: string[];
  observedTreeSha256: string[];
  errors: string[];
}> {
  const candidates = [];
  const errors: string[] = [];
  for (const root of roots) {
    const path = join(root, entry.skillName);
    if (!(await pathExists(path))) continue;
    try {
      candidates.push({ path, treeSha256: await hashRegularTree(path) });
    } catch (error) {
      errors.push(sanitizeResearchText(error instanceof Error ? error.message : String(error)));
    }
  }
  const exact = candidates.filter((candidate) => candidate.treeSha256 === entry.expectedTreeSha256);
  const status =
    candidates.length > 1
      ? "ambiguous"
      : exact.length === 1
        ? "installed"
        : candidates.length || errors.length
          ? "drifted"
          : "missing";
  return {
    status,
    paths: candidates.map((candidate) => candidate.path),
    observedTreeSha256: candidates.map((candidate) => candidate.treeSha256),
    errors,
  };
}

async function requireCatalogSkill(
  entry: ExternalSkillCatalogEntry,
  roots: string[],
  installBasePath: string,
): Promise<string> {
  const installation = await inspectCatalogInstallation(entry, roots);
  const exactPaths = installation.paths.filter(
    (_path, index) => installation.observedTreeSha256[index] === entry.expectedTreeSha256,
  );
  if (installation.status !== "installed" || exactPaths.length !== 1) {
    throw new CliError(
      `Required external Skill is missing, ambiguous, or differs from its reviewed bytes: ${entry.skillName}`,
      {
        code: "RESEARCH_EXTERNAL_SKILL_NOT_READY",
        exitCode: 3,
        details: {
          catalogId: entry.id,
          status: installation.status,
          expectedTreeSha256: entry.expectedTreeSha256,
          installPlan: pinnedInstallPlan(false, installBasePath),
          remediation:
            installation.status === "ambiguous"
              ? "Pass --skill-root with one explicit installation root."
              : "Run the pinned install command outside the research runtime, then retry configuration.",
        },
      },
    );
  }
  return exactPaths[0]!;
}

function skillRoots(selectedPath: string, explicitRoot: string | null): string[] {
  if (explicitRoot) {
    if (!isAbsolute(explicitRoot)) {
      throw new CliError("External Skill root must be absolute.", {
        code: "RESEARCH_EXTERNAL_SKILL_ROOT_INVALID",
        exitCode: 2,
      });
    }
    return [resolve(explicitRoot)];
  }
  return [
    ...new Set([
      join(resolve(selectedPath), ".agents", "skills"),
      join(homedir(), ".agents", "skills"),
    ]),
  ];
}

function localInstallCommand(
  global: boolean,
  sourceDirectory: string,
  skillNames: readonly string[],
): string {
  const skills = skillNames.join(" ");
  return [
    `npx --yes skills@${EXTERNAL_SKILLS_CLI_VERSION} add`,
    shellQuote(sourceDirectory),
    `--skill ${skills}`,
    "--agent codex --yes --copy",
    global ? "--global" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function pinnedInstallPlan(
  global: boolean,
  selectedPath: string,
  skillNames: readonly string[] = EXTERNAL_SKILL_CATALOG.filter(
    (entry) => entry.tier === "required",
  ).map((entry) => entry.skillName),
) {
  const workingDirectory = resolve(selectedPath);
  const checkoutDirectory = global
    ? join(
        homedir(),
        ".cache",
        "tiangong-ai",
        "external-skills",
        `brave-search-skills-${BRAVE_SOURCE.immutableRef.slice(0, 12)}`,
      )
    : join(
        workingDirectory,
        ".tiangong-external-skills",
        "sources",
        `brave-search-skills-${BRAVE_SOURCE.immutableRef.slice(0, 12)}`,
      );
  return {
    shell: "POSIX",
    workingDirectory,
    checkoutDirectory,
    precondition: "checkoutDirectory must not already exist",
    automaticAtRuntime: false,
    commands: [
      `cd ${shellQuote(workingDirectory)}`,
      `git init --quiet ${shellQuote(checkoutDirectory)}`,
      `git -C ${shellQuote(checkoutDirectory)} remote add origin ${shellQuote(BRAVE_SOURCE.locator)}`,
      `git -C ${shellQuote(checkoutDirectory)} fetch --depth 1 origin ${BRAVE_SOURCE.immutableRef}`,
      `git -C ${shellQuote(checkoutDirectory)} checkout --detach FETCH_HEAD`,
      `test "$(git -C ${shellQuote(checkoutDirectory)} rev-parse HEAD)" = ${shellQuote(BRAVE_SOURCE.immutableRef)}`,
      localInstallCommand(global, checkoutDirectory, skillNames),
    ],
    verification: {
      repository: BRAVE_SOURCE.repository,
      immutableRef: BRAVE_SOURCE.immutableRef,
      expectedTrees: [...EXTERNAL_SKILL_CATALOG, ...EVALUATED_EXTERNAL_SKILLS]
        .filter((entry) => skillNames.includes(entry.skillName))
        .map((entry) => ({
          skillName: entry.skillName,
          sha256: entry.expectedTreeSha256,
        })),
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function persistDeclarationsAndLock(
  root: string,
  declarations: CapabilityDeclarations,
  lock: Awaited<ReturnType<typeof buildCapabilityLock>>,
): Promise<void> {
  const paths = workspacePaths(root);
  await writeJsonAtomic(paths.capabilityDeclarations, declarations);
  await writeJsonAtomic(paths.capabilityLock, lock, 0o444);
}

async function requireExistingCapabilitiesVerified(root: string): Promise<void> {
  const verification = await verifyCapabilities(root);
  if (verification.status !== "verified") {
    throw new CliError(
      "Existing research capabilities are drifted; configuration changes cannot replace their lock.",
      {
        code: "RESEARCH_CAPABILITY_DRIFT",
        exitCode: 3,
        details: {
          verification,
          remediation:
            "Restore the declared Skill bytes or update its immutable source and expected tree hash explicitly before retrying.",
        },
      },
    );
  }
}

async function probeCapability(
  capability: CapabilityDeclaration,
  healthCheck: CapabilityHealthCheckDeclaration,
  credentialMap: Map<string, string>,
  fetcher: typeof fetch = fetch,
  sleeper: (milliseconds: number) => Promise<unknown> = sleep,
) {
  const initial = new URL(healthCheck.url);
  const secrets = [...credentialMap.values()];
  const headers = new Headers(capability.http?.staticHeaders ?? {});
  headers.set("Accept", capability.http?.accept ?? "application/json");
  const body = healthCheck.body === null ? null : JSON.stringify(healthCheck.body);
  if (body) headers.set("Content-Type", "application/json");
  let credentialHosts: string[] | null = null;
  if (healthCheck.credentialId) {
    const credential = capability.credentials.find(
      (candidate) => candidate.id === healthCheck.credentialId,
    );
    const value = credentialMap.get(healthCheck.credentialId);
    if (!credential || !value) throw new Error("health check credential is unavailable");
    credentialHosts = credential.allowedHosts;
    headers.set(credential.headerName, `${credential.prefix}${value}`);
  }
  let current = initial;
  try {
    let redirectCount = 0;
    let rateLimitRetries = 0;
    while (redirectCount <= 5) {
      if (
        current.protocol !== "https:" ||
        current.username ||
        current.password ||
        !capability.allowedHosts.includes(current.host.toLowerCase())
      ) {
        throw new Error("health check redirect escaped the capability host policy");
      }
      if (credentialHosts && !credentialHosts.includes(current.host.toLowerCase())) {
        throw new Error("health check redirect escaped the credential host policy");
      }
      const response = await fetcher(current, {
        method: healthCheck.method,
        headers,
        ...(body === null ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (healthCheck.method === "POST") {
          await response.body?.cancel();
          throw new Error("POST health check redirects are not authorized");
        }
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === 5) {
          throw new Error("health check redirect policy failed");
        }
        current = new URL(location, current);
        redirectCount += 1;
        continue;
      }
      const contentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const responseBody = await readBoundedResponseBody(response, 4 * 1024);
      const diagnostics = providerDiagnostics(response, responseBody.text, contentType, secrets);
      if (response.status === 429 && rateLimitRetries === 0) {
        rateLimitRetries += 1;
        await sleeper(Math.min(5, retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      if (!response.ok) {
        return {
          status: "fail" as const,
          code:
            response.status === 401 || response.status === 403
              ? "PROVIDER_AUTHENTICATION_FAILED"
              : response.status === 429
                ? "PROVIDER_RATE_LIMITED"
                : response.status >= 500
                  ? "provider-unavailable"
                  : "request-rejected",
          host: current.host,
          targetSha256: sha256Text(current.toString()),
          httpStatus: response.status,
          retryAfterSeconds,
          providerCode: diagnostics.providerCode,
          providerRequestId: diagnostics.providerRequestId,
          minimumAction: providerMinimumAction(response.status, diagnostics.providerCode),
          detail: diagnostics.detail
            ? `Provider returned HTTP ${response.status}: ${diagnostics.detail}`
            : `Provider returned HTTP ${response.status}.`,
          executionMode: "broker" as const,
          credentialScope: "broker" as const,
          networkAttempted: true,
        };
      }
      if (!healthCheck.expectedContentTypes.includes(contentType)) {
        return {
          status: "fail" as const,
          code: "content-type-mismatch",
          host: current.host,
          targetSha256: sha256Text(current.toString()),
          httpStatus: response.status,
          retryAfterSeconds,
          providerCode: diagnostics.providerCode,
          providerRequestId: diagnostics.providerRequestId,
          minimumAction:
            "Verify the capability Accept/content-type contract against the selected provider endpoint.",
          detail: `Provider returned unsupported content type ${contentType || "unknown"}.`,
        };
      }
      return {
        status: "pass" as const,
        code: "connected",
        host: current.host,
        targetSha256: sha256Text(current.toString()),
        httpStatus: response.status,
        retryAfterSeconds,
        providerCode: diagnostics.providerCode,
        providerRequestId: diagnostics.providerRequestId,
        minimumAction: null,
        detail: "Provider authentication and response contract passed.",
      };
    }
    throw new Error("health check redirect policy failed");
  } catch (error) {
    void error;
    return {
      status: "fail" as const,
      code: "transport-failed",
      host: initial.host,
      targetSha256: sha256Text(initial.toString()),
      httpStatus: null,
      retryAfterSeconds: null,
      providerCode: null,
      providerRequestId: null,
      minimumAction:
        "Verify network/VPN/proxy access and the exact capability endpoint, then rerun the live check.",
      detail: "Provider connectivity probe failed before a valid response was received.",
      executionMode: "broker" as const,
      credentialScope: "broker" as const,
      networkAttempted: true,
    };
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < maxBytes) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = maxBytes - bytes;
      if (item.value.byteLength > remaining) {
        chunks.push(item.value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(item.value);
      bytes += item.value.byteLength;
      if (bytes === maxBytes) {
        truncated = true;
        await reader.cancel();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    truncated,
  };
}

function providerDiagnostics(
  response: Response,
  responseText: string,
  contentType: string,
  secrets: readonly string[],
): { providerCode: string | null; providerRequestId: string | null; detail: string | null } {
  let value: unknown = null;
  if (contentType === "application/json" && responseText.trim()) {
    try {
      value = JSON.parse(responseText) as unknown;
    } catch {
      value = null;
    }
  }
  const root = isObject(value) ? value : null;
  const error = root && isObject(root.error) ? root.error : null;
  const providerCode = safeProviderIdentifier(
    firstString(error?.code, root?.code, error?.type, root?.type),
    secrets,
  );
  const providerRequestId = safeProviderIdentifier(
    firstString(
      response.headers.get("x-request-id"),
      response.headers.get("request-id"),
      error?.requestId,
      error?.request_id,
      error?.id,
      root?.requestId,
      root?.request_id,
    ),
    secrets,
  );
  const detailSource =
    firstString(error?.detail, error?.message, root?.detail, root?.message) ??
    (value === null ? responseText : null);
  const detail = detailSource
    ? sanitizeResearchText(detailSource, secrets).replaceAll(/\s+/g, " ").trim().slice(0, 320) ||
      null
    : null;
  return { providerCode, providerRequestId, detail };
}

function firstString(...values: unknown[]): string | null {
  return (
    values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null
  );
}

function safeProviderIdentifier(value: string | null, secrets: readonly string[]): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return null;
  if (
    secrets.some((secret) => secret === value || secret.includes(value) || value.includes(secret))
  ) {
    return null;
  }
  return value;
}

function providerMinimumAction(status: number, providerCode: string | null): string {
  if (providerCode === "OPTION_NOT_IN_PLAN") {
    return `Create and apply a reviewed ${EXTERNAL_SKILL_PROFILE} baseline replacement plan, or enable the provider subscription option; setup never switches profiles silently.`;
  }
  if (status === 401 || status === 403) {
    return "Verify the selected logical credential and provider entitlement, then rerun the live check.";
  }
  if (status === 429) {
    return "Honor Retry-After or the provider quota reset; do not retry a deterministic configuration error.";
  }
  if (status >= 500) {
    return "Retry after the provider service recovers; preserve the request ID when reporting the incident.";
  }
  return "Review the sanitized provider code/detail and the exact capability request contract before retrying.";
}

function capabilityVerificationErrors(
  verification: Awaited<ReturnType<typeof verifyCapabilities>> | null,
  capabilityId: string,
): string[] {
  if (!verification) return ["capability verification was not run"];
  if (verification.status === "verified") return [];
  const scoped = verification.errors.filter((error) => error.startsWith(`${capabilityId}:`));
  const global = verification.errors.filter((error) => !error.includes(":"));
  return [...scoped, ...global];
}

function isExternalCapabilitySource(
  source: CapabilityDeclaration["source"],
): source is NonNullable<CapabilityDeclaration["source"]> {
  if (!source) return false;
  const normalized = source.locator.trim().replace(/\/+$/, "").toLowerCase();
  try {
    const locator = new URL(source.locator);
    const repositoryPath = locator.pathname
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    if (
      locator.hostname.toLowerCase() === "github.com" &&
      TIANGONG_SKILLS_REPOSITORIES.some((repository) => repositoryPath === `/${repository}`)
    ) {
      return false;
    }
  } catch {
    // Registry and local locators are not required to be URLs.
  }
  return !normalized.includes("tiangong-ai-workspace-suite/skills");
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

import { CliError } from "../../errors.js";
import { isObject } from "./storage.js";
import type {
  AgentRoute,
  ProjectBudgetEntry,
  ProjectBudgetState,
  ProjectState,
  WorkspaceConfig,
} from "./types.js";

const finiteCost = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const displayCost = (value: number) => Number(value.toFixed(6));

export function projectBudgetAmount(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0)
    throw new CliError("Project budget must be a positive finite USD amount.", {
      code: "RESEARCH_BUDGET_INVALID",
      exitCode: 2,
    });
  return amount;
}

export function createProjectBudget(
  projectId: string,
  maxCostUsd: number,
  openingEstimateUsd = 0,
): ProjectBudgetState {
  projectBudgetAmount(maxCostUsd);
  if (!finiteCost(openingEstimateUsd))
    throw new CliError("Existing accounted cost is invalid.", {
      code: "RESEARCH_BUDGET_INVALID",
      exitCode: 3,
    });
  return {
    schemaVersion: 1,
    authorization: {
      revision: 1,
      maxCostUsd,
      authorizedAt: new Date().toISOString(),
      originProjectId: projectId,
      providerOperationMaxCostUsd: {},
      allowUnpricedProviderOperations: false,
    },
    openingEstimateUsd,
    openingBasis: openingEstimateUsd ? "legacy-accounting" : "new-project",
    openingSourceProjectId: null,
    entries: [],
  };
}

export function projectCostLimit(
  config: WorkspaceConfig,
  project?: Pick<ProjectState, "budget">,
): number {
  return Math.min(
    config.budget.maxCostUsd,
    project?.budget?.authorization.maxCostUsd ?? config.budget.maxCostUsd,
  );
}

export function projectCostExposure(project: Pick<ProjectState, "budget" | "usage">): number {
  if (!project.budget) return project.usage.costUsd;
  return (
    project.budget.openingEstimateUsd +
    project.budget.entries.reduce(
      (sum, entry) =>
        sum + (entry.status === "reserved" ? entry.maxCostUsd : entry.accountedCostUsd!),
      0,
    )
  );
}

export function remainingProjectCostUsd(project: ProjectState, config: WorkspaceConfig): number {
  return Math.max(0, projectCostLimit(config, project) - projectCostExposure(project));
}

export function projectBudgetView(project: ProjectState, config: WorkspaceConfig) {
  const budget = project.budget;
  const accounted = budget
    ? budget.openingEstimateUsd +
      budget.entries
        .filter((e) => e.status === "settled")
        .reduce((sum, e) => sum + e.accountedCostUsd!, 0)
    : project.usage.costUsd;
  const reserved = budget
    ? budget.entries
        .filter((e) => e.status === "reserved")
        .reduce((sum, e) => sum + e.maxCostUsd, 0)
    : null;
  return {
    authorization: budget?.authorization ?? null,
    workspaceMaxCostUsd: config.budget.maxCostUsd,
    effectiveMaxCostUsd: projectCostLimit(config, project),
    accountedEstimateUsd: displayCost(accounted),
    outstandingReservationsUsd: reserved === null ? null : displayCost(reserved),
    remainingUsd: budget ? displayCost(remainingProjectCostUsd(project, config)) : null,
    overrunEstimateUsd: budget
      ? displayCost(Math.max(0, projectCostExposure(project) - projectCostLimit(config, project)))
      : null,
    admissionState: !budget
      ? "legacy"
      : projectCostExposure(project) > projectCostLimit(config, project)
        ? "overrun"
        : remainingProjectCostUsd(project, config) === 0
          ? "exhausted"
          : "available",
    providerInvoiceUsd: null,
    pendingReservations:
      budget?.entries
        .filter((entry) => entry.status === "reserved")
        .map((entry) => ({ ...entry })) ?? [],
    accountingBasis: budget
      ? "software-accounted-estimates-and-allocations"
      : "legacy-accounting-without-numeric-project-authorization",
    openingBasis: budget?.openingBasis ?? null,
    openingSourceProjectId: budget?.openingSourceProjectId ?? null,
  };
}

export function assertProjectRoutePriced(project: ProjectState, route: AgentRoute): void {
  if (project.budget && !route.pricing)
    throw new CliError(
      "The numeric project budget requires declared model pricing before execution; unknown cost is not zero.",
      {
        code: "RESEARCH_PROJECT_BUDGET_PRICE_REQUIRED",
        exitCode: 3,
        details: { agent: route.agent, model: route.model },
      },
    );
}

// The caller holds the existing workspace lease and persists the updated
// project before starting the operation. These helpers introduce no new lock.
export function reserveProjectCost(
  project: ProjectState,
  config: WorkspaceConfig,
  input: Pick<ProjectBudgetEntry, "id" | "kind" | "reference" | "maxCostUsd">,
): ProjectBudgetEntry | null {
  if (!project.budget) return null;
  if (project.lineage.supersededBy)
    throw new CliError("Budget authority belongs to the current recovery project.", {
      code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      exitCode: 3,
    });
  if (!finiteCost(input.maxCostUsd))
    throw new CliError("Operation cost is unbounded or unknown.", {
      code: "RESEARCH_PROJECT_BUDGET_PRICE_REQUIRED",
      exitCode: 3,
    });
  const existing = project.budget.entries.find((entry) => entry.id === input.id);
  if (existing) {
    if (
      existing.kind !== input.kind ||
      existing.reference !== input.reference ||
      existing.maxCostUsd !== input.maxCostUsd
    )
      throw new CliError("Budget reservation identity changed.", {
        code: "RESEARCH_BUDGET_RESERVATION_CONFLICT",
        exitCode: 3,
      });
    return existing;
  }
  const remainingUsd = remainingProjectCostUsd(project, config);
  if (input.maxCostUsd > remainingUsd + 1e-9)
    throw new CliError("The operation does not fit the authorized project budget.", {
      code: "RESEARCH_BUDGET_RESERVATION_FAILED",
      exitCode: 3,
      details: {
        projectId: project.id,
        remainingUsd,
        nextOperationMaxCostUsd: input.maxCostUsd,
        budget: projectBudgetView(project, config),
      },
    });
  const entry: ProjectBudgetEntry = {
    ...input,
    sourceProjectId: project.id,
    authorizationRevision: project.budget.authorization.revision,
    status: "reserved",
    accountedCostUsd: null,
    settlementBasis: null,
    createdAt: new Date().toISOString(),
    settledAt: null,
  };
  project.budget.entries.push(entry);
  return entry;
}

export function settleProjectCost(
  project: ProjectState,
  id: string,
  costUsd: number,
  basis: NonNullable<ProjectBudgetEntry["settlementBasis"]>,
): void {
  if (!project.budget) return;
  if (project.lineage.supersededBy)
    throw new CliError("Budget authority belongs to the current recovery project.", {
      code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      exitCode: 3,
    });
  if (!finiteCost(costUsd))
    throw new CliError("Reported operation cost is invalid.", {
      code: "RESEARCH_BUDGET_INVALID",
      exitCode: 3,
    });
  const entry = project.budget.entries.find((item) => item.id === id);
  if (!entry)
    throw new CliError("The operation has no budget reservation.", {
      code: "RESEARCH_BUDGET_RESERVATION_MISSING",
      exitCode: 3,
    });
  if (entry.status === "settled") {
    if (entry.accountedCostUsd !== costUsd)
      throw new CliError(
        "A settled budget operation cannot be charged again with different usage.",
        { code: "RESEARCH_BUDGET_RESERVATION_CONFLICT", exitCode: 3 },
      );
    return;
  }
  entry.status = "settled";
  entry.accountedCostUsd = costUsd;
  entry.settlementBasis = basis;
  entry.settledAt = new Date().toISOString();
}

export function settleProjectAllocation(project: ProjectState, id: string): void {
  // Historical native cancellation may clean its session, but the successor
  // now owns the unresolved funding obligation.
  if (project.lineage.supersededBy) return;
  const entry = project.budget?.entries.find((item) => item.id === id);
  if (entry?.status === "reserved")
    settleProjectCost(project, id, entry.maxCostUsd, "allocated-upper-bound");
}

export function inheritedProjectBudget(source: ProjectState): ProjectBudgetState | undefined {
  if (!source.budget) return undefined;
  return {
    schemaVersion: 1,
    authorization: structuredClone(source.budget.authorization),
    openingEstimateUsd:
      source.budget.openingEstimateUsd +
      source.budget.entries
        .filter((entry) => entry.status === "settled")
        .reduce((sum, entry) => sum + entry.accountedCostUsd!, 0),
    openingBasis: "recovery-exposure",
    openingSourceProjectId: source.id,
    entries: structuredClone(source.budget.entries.filter((entry) => entry.status === "reserved")),
  };
}

export function isProjectBudgetState(value: unknown): value is ProjectBudgetState {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isObject(value.authorization) ||
    !finiteCost(value.openingEstimateUsd) ||
    !["new-project", "legacy-accounting", "recovery-exposure"].includes(
      String(value.openingBasis),
    ) ||
    (value.openingSourceProjectId !== null && typeof value.openingSourceProjectId !== "string") ||
    !Array.isArray(value.entries)
  )
    return false;
  const auth = value.authorization;
  if (
    !Number.isSafeInteger(auth.revision) ||
    (auth.revision as number) < 1 ||
    !finiteCost(auth.maxCostUsd) ||
    auth.maxCostUsd <= 0 ||
    typeof auth.authorizedAt !== "string" ||
    typeof auth.originProjectId !== "string" ||
    !isObject(auth.providerOperationMaxCostUsd) ||
    Object.values(auth.providerOperationMaxCostUsd).some((cost) => !finiteCost(cost)) ||
    typeof auth.allowUnpricedProviderOperations !== "boolean"
  )
    return false;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isObject(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.sourceProjectId !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      !["native-stage", "review", "provider-operation"].includes(String(entry.kind)) ||
      typeof entry.reference !== "string" ||
      !Number.isSafeInteger(entry.authorizationRevision) ||
      (entry.authorizationRevision as number) < 1 ||
      (entry.authorizationRevision as number) > (auth.revision as number) ||
      !finiteCost(entry.maxCostUsd) ||
      typeof entry.createdAt !== "string"
    )
      return false;
    if (entry.status === "reserved") {
      if (
        entry.accountedCostUsd !== null ||
        entry.settlementBasis !== null ||
        entry.settledAt !== null
      )
        return false;
    } else if (entry.status === "settled") {
      if (
        !finiteCost(entry.accountedCostUsd) ||
        !["reported-usage", "allocated-upper-bound", "owner-estimate"].includes(
          String(entry.settlementBasis),
        ) ||
        typeof entry.settledAt !== "string"
      )
        return false;
    } else return false;
    if (
      entry.settlementBasis === "owner-estimate" &&
      (typeof entry.resolutionReason !== "string" || entry.resolutionReason.trim().length < 8)
    )
      return false;
    ids.add(entry.id);
  }
  return true;
}

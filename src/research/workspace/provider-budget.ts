import { CliError } from "../../errors.js";
import type { ProjectState, WorkspaceConfig } from "./types.js";
import { reserveProjectCost, settleProjectAllocation } from "./project-budget.js";
import { loadProject, saveProject } from "./projects.js";

// Callers own the existing workspace lease. A declared maximum covers one
// logical provider operation, including its bounded retries/pages. It is an
// owner accounting allocation, never a verified provider price or invoice.
export async function reserveProviderOperation(
  root: string,
  project: ProjectState,
  config: WorkspaceConfig,
  capabilityId: string,
  attemptId: string,
): Promise<string | null> {
  if (!project.budget) return null;
  const limits = project.budget.authorization.providerOperationMaxCostUsd;
  if (!Object.hasOwn(limits, capabilityId))
    throw new CliError(
      "This provider operation has no declared cost maximum; unknown cost is not zero.",
      {
        code: "RESEARCH_PROJECT_BUDGET_PRICE_REQUIRED",
        exitCode: 3,
        details: {
          capabilityId,
          minimumAction:
            "Review and explicitly confirm a provider-operation USD maximum with project budget set --provider-costs. Existing local evidence reads do not require a new provider allocation.",
        },
      },
    );
  const id = `provider:${attemptId}`;
  reserveProjectCost(project, config, {
    id,
    kind: "provider-operation",
    reference: capabilityId,
    maxCostUsd: limits[capabilityId]!,
  });
  await saveProject(root, project);
  return id;
}

export async function settleProviderOperation(
  root: string,
  projectId: string,
  id: string | null,
): Promise<void> {
  if (id === null) return;
  const project = await loadProject(root, projectId);
  settleProjectAllocation(project, id);
  await saveProject(root, project);
}

import { Ajv2020 } from "ajv/dist/2020.js";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import { evaluateScientificDesign, type ScientificDesignContract } from "./scientific-design.js";
import { loadScientificFulfillmentView } from "./scientific-fulfillment.js";
import { canonicalJson, pathExists, sha256Text, workspacePaths } from "./storage.js";

type Rule = ScientificDesignContract["policyRuleDispositions"][number];
interface AmendmentInput {
  schemaVersion: 1;
  reason: string;
  changes: Array<
    Pick<Rule, "ruleId" | "dueGate" | "rationale" | "modelStructureIds" | "uncertaintyParameterIds">
  >;
}
const ids = {
  type: "array",
  uniqueItems: true,
  maxItems: 128,
  items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
};
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "reason", "changes"],
  properties: {
    schemaVersion: { const: 1 },
    reason: { type: "string", minLength: 8, maxLength: 4000 },
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ruleId",
          "dueGate",
          "rationale",
          "modelStructureIds",
          "uncertaintyParameterIds",
        ],
        properties: {
          ruleId: { type: "string", minLength: 1, maxLength: 128 },
          dueGate: {
            enum: ["research-design", "evidence-construct", "pilot-methods", "publication-freeze"],
          },
          rationale: { type: "string", minLength: 8, maxLength: 4000 },
          modelStructureIds: ids,
          uncertaintyParameterIds: ids,
        },
      },
    },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile<AmendmentInput>(
  inputSchema,
);

export function scientificAmendmentSchema(): Record<string, unknown> {
  return structuredClone(inputSchema);
}

function invalid(message: string, code = "RESEARCH_SCIENTIFIC_AMENDMENT_INVALID") {
  return new CliError(message, { code, exitCode: code.endsWith("INVALID") ? 2 : 3 });
}

/** Derive a reviewable proposal without changing frozen bytes or authority. */
export async function planScientificAmendment(root: string, projectId: string, value: unknown) {
  if (
    !validate(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  )
    throw invalid("Amendment must match the closed, secret-free lifecycle/binding schema.");
  const input = value as AmendmentInput;
  if (
    input.reason.trim().length < 8 ||
    input.changes.some((change) => change.rationale.trim().length < 8) ||
    new Set(input.changes.map((change) => change.ruleId)).size !== input.changes.length
  )
    throw invalid("Amendment requires a reason, substantive rationales and unique existing rules.");
  const paths = workspacePaths(root);
  const project = await loadProject(root, projectId);
  const events = await readVerifiedJournal(paths.journal);
  assertProjectAuthority(project, projectAuthorityIndex(events));
  const analyze = project.packages.find((item) => item.stage === "analyze");
  if (
    !project.scientificDesign ||
    project.status === "complete" ||
    project.handoff.state !== "agent-actionable" ||
    !analyze ||
    analyze.attempts > 0 ||
    analyze.startedAt ||
    !["ready", "pending"].includes(analyze.status) ||
    (await pathExists(join(paths.projects, project.id, "native/active.json"))) ||
    (await pathExists(join(paths.projects, project.id, "outputs/inference-snapshot.json")))
  )
    throw invalid(
      "Amend only an idle authoritative pre-analysis project. Resolve the active session or handoff; substantive or post-analysis changes require a reviewed successor.",
      "RESEARCH_SCIENTIFIC_AMENDMENT_UNAVAILABLE",
    );
  const view = await loadScientificFulfillmentView(root, project, undefined, events);
  const effective = structuredClone(view.contract);
  const declaredRules = new Set(project.publicationPolicy?.resolvedRules ?? []);
  const models = new Set(effective.identity.modelStructures.map((model) => model.id));
  const parameters = new Set(effective.uncertaintyParameters.map((parameter) => parameter.id));
  const changes = input.changes.map((change) => {
    const rule = effective.policyRuleDispositions.find((item) => item.ruleId === change.ruleId);
    if (
      !rule ||
      !declaredRules.has(change.ruleId) ||
      rule.status !== "planned" ||
      change.modelStructureIds.some((id) => !models.has(id)) ||
      change.uncertaintyParameterIds.some((id) => !parameters.has(id))
    )
      throw invalid(
        "Amend only planned Policy rules and their existing declared model/parameter IDs.",
      );
    const before = structuredClone(rule);
    Object.assign(rule, change);
    const after = structuredClone(rule);
    if (canonicalJson(before) === canonicalJson(after))
      throw invalid("Each proposed rule amendment must change its lifecycle or bindings.");
    return { ruleId: rule.ruleId, before, after };
  });
  const beforeIssues = new Set(evaluateScientificDesign(view.contract).issueCodes);
  const introducedIssues = evaluateScientificDesign(effective).issueCodes.filter(
    (code) => !beforeIssues.has(code),
  );
  if (introducedIssues.length)
    throw new CliError("Amendment introduces blocking scientific-design issues.", {
      code: "RESEARCH_SCIENTIFIC_AMENDMENT_INVALID",
      exitCode: 2,
      details: { issueCodes: introducedIssues },
    });
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-scientific-amendment-plan" as const,
    projectId: project.id,
    parentDesignSha256: project.scientificDesign.designSha256,
    parentFulfillmentSha256: view.headSha256,
    parentEffectiveDesignSha256: view.effectiveSha256,
    parentProjectSha256: sha256Text(canonicalJson(project)),
    reason: input.reason,
    changes,
    proposedEffectiveDesignSha256: sha256Text(canonicalJson(effective)),
    invalidatedScientificRoles: ["research-design", "evidence-construct", "pilot-methods"],
    preservedAcquisitionSnapshotSha256: project.evidenceState.currentSnapshotSha256,
  };
  return {
    ...core,
    planSha256: sha256Text(canonicalJson(core)),
    nextAction:
      "Review the exact changes and their reason. This read-only plan is not authorization, scientific fulfillment or a passing review.",
  };
}

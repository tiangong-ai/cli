import { CliError } from "../../errors.js";
import { canonicalJson, isObject, sha256Text } from "./storage.js";
import type { TaskObjectReader } from "./task-contract.js";
import type { JournalEvent } from "./types.js";

/** Lightweight derived index shared by intake, review context and portable audit.
 * It never loads programs/results for requirements without investigation history. */
export async function investigatedRequirementHashes(
  projectId: string,
  events: Array<Pick<JournalEvent, "scope" | "type" | "payload">>,
  readObject: TaskObjectReader,
) {
  const hashes = new Set<string>();
  for (const event of events) {
    if (
      event.scope !== projectId ||
      !["investigation.approved", "investigation.promotion.approved"].includes(event.type)
    )
      continue;
    const promotion = event.type === "investigation.promotion.approved";
    const value = await readObject<unknown>(
      promotion ? "investigation-promotions" : "investigations",
      String(event.payload.recordSha256),
      "recordSha256",
    );
    if (
      !isObject(value) ||
      value.projectId !== projectId ||
      value.kind !== (promotion ? "tiangong-investigation-promotion" : "tiangong-investigation") ||
      !isObject(value.plan) ||
      value.plan.projectId !== projectId ||
      value.plan.planSha256 !== event.payload.planSha256 ||
      typeof value.plan.requirementSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.plan.requirementSha256)
    )
      throw new CliError(
        "Investigation requirement authority is not bound to its committed plan.",
        { code: "RESEARCH_INVESTIGATION_BINDING_INVALID", exitCode: 3 },
      );
    const { planSha256, ...core } = value.plan;
    if (sha256Text(canonicalJson(core)) !== planSha256)
      throw new CliError("Investigation requirement plan bytes changed.", {
        code: "RESEARCH_INVESTIGATION_BINDING_INVALID",
        exitCode: 3,
      });
    hashes.add(value.plan.requirementSha256);
  }
  return hashes;
}

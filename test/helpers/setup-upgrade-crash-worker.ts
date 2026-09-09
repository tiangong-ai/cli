import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyResearchSetupPlan } from "../../src/research/workspace/setup.js";
import { RESEARCH_SETUP_SKILLS } from "../../src/research/workspace/setup-catalog.js";
const [root, candidate, hash, checkpoint] = process.argv.slice(2);
if (!root || !candidate || !hash || !checkpoint) throw new Error("Missing fixture arguments");
RESEARCH_SETUP_SKILLS.find((skill) => skill.id === "tiangong.auto-research")!.expectedTreeSha256 =
  hash;
await applyResearchSetupPlan(candidate, {
  skipDoctor: true,
  runner: async () => {
    throw new Error("A prepared upgrade must not invoke the installer again");
  },
  upgradeCheckpoint: async (point) => {
    if (point !== checkpoint) return;
    await writeFile(join(root, "crash-checkpoint.txt"), point);
    process.kill(process.pid, "SIGKILL");
    await new Promise<never>(() => {});
  },
});
throw new Error("Expected crash checkpoint was not reached");

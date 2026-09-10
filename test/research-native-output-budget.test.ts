import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { it } from "node:test";
import { captureProcess } from "../src/research/workspace/native-run.js";

it(
  "ends inherited calculation workers when their leader exits",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-output-family-"));
    try {
      const child =
        "setTimeout(()=>process.stdout.write('x'.repeat(8192)),200); setTimeout(()=>{},2500);";
      const leader = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});process.exit(0);`;
      const result = await captureProcess(
        process.execPath,
        ["-e", leader],
        directory,
        { PATH: dirname(process.execPath) },
        1,
        { maxBytes: 1024 },
      );
      assert.equal(
        result.timedOut,
        false,
        "A completed leader must not leave its worker holding the observer open past the deadline",
      );
      assert.ok(result.wallSeconds < 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

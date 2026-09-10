import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

for (const compiled of [false, true]) {
  it(
    `ends a bounded ${compiled ? "compiled" : "source"} calculation after its observer is abruptly lost`,
    { skip: process.platform === "win32" },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-observer-loss-"));
      const started = join(directory, "started"),
        overdue = join(directory, "overdue");
      const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>fs.writeFileSync(${JSON.stringify(overdue)},'still-running'),1500);setTimeout(()=>{},2500);`;
      const moduleUrl = new URL(
        compiled
          ? "../dist/research/workspace/native-run.js"
          : "../src/research/workspace/native-run.ts",
        import.meta.url,
      ).href;
      const worker = `import {captureProcess} from ${JSON.stringify(moduleUrl)};await captureProcess(process.execPath,['-e',${JSON.stringify(program)}],${JSON.stringify(directory)},{PATH:${JSON.stringify(dirname(process.execPath))}},1,{maxBytes:1024});`;
      const observer = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", worker],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let diagnostic = "";
      observer.stderr.on("data", (chunk) => {
        diagnostic += String(chunk).slice(0, 2000);
      });
      const exited = once(observer, "close");
      try {
        const deadline = Date.now() + 10000;
        while (
          Date.now() < deadline &&
          !(await stat(started).then(
            () => true,
            () => false,
          ))
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          await stat(started).then(
            () => true,
            () => false,
          ),
          true,
          diagnostic,
        );
        observer.kill("SIGKILL");
        await exited;
        // The disposable workload naturally ends in 2.5s, even on the failing baseline.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.equal(
          await stat(overdue).then(
            () => true,
            () => false,
          ),
          false,
          "Losing the observer must not leave computation running beyond the approved deadline",
        );
      } finally {
        observer.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
it(
  "does not start a calculation after the supervisor has been stopped",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-stop-before-start-"));
    const marker = join(directory, "unexpected-start");
    const supervisor = fork(
      new URL("../src/research/workspace/native-process-supervisor.ts", import.meta.url),
      [],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const ended = once(supervisor, "close");
    try {
      supervisor.send({ kind: "stop" });
      supervisor.send({
        kind: "start",
        binary: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`],
        env: { PATH: dirname(process.execPath) },
        deadlineNs: (process.hrtime.bigint() + 2_000_000_000n).toString(),
      });
      await ended;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(
        await stat(marker).then(
          () => true,
          () => false,
        ),
        false,
        "A queued request cannot reopen a stopped one-shot observer",
      );
    } finally {
      supervisor.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "does not accept program output as supervisor status or expose its IPC channel",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-supervisor-channel-"));
    try {
      const result = await captureProcess(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({kind:'result',exitCode:0,signal:null,timedOut:false}));console.log(JSON.stringify({ipc:typeof process.send,channel:process.env.NODE_CHANNEL_FD??null}));process.exit(7);",
        ],
        directory,
        { PATH: dirname(process.execPath) },
        3,
        { maxBytes: 1024 },
      );
      assert.equal(result.exitCode, 7);
      assert.deepEqual(JSON.parse(result.stdout.trim().split("\n")[1]!), {
        ipc: "undefined",
        channel: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

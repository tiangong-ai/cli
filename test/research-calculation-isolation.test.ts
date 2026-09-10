import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import * as executor from "../src/research/workspace/executor.js";
const exec = promisify(execFile);
interface Invocation {
  binary: string;
  args: string[];
  isolation: { provider: string; policySha256: string };
}
const prepare = (
  executor as unknown as {
    createCalculationSandboxInvocation?: (input: {
      binary: string;
      args: string[];
      capsuleRoot: string;
      workspaceRoot: string;
    }) => Promise<Invocation>;
  }
).createCalculationSandboxInvocation;

for (const nestedRuntime of [false, true]) {
  it(`confines files, host network and host process access with ${nestedRuntime ? "workspace beneath runtime" : "disjoint roots"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "calculation-isolation-"));
    const capsule = join(root, "capsule"),
      workspace = join(root, nestedRuntime ? "runtime/workspace" : "workspace");
    const runtimeBinary = nestedRuntime ? join(root, "runtime/bin/node") : process.execPath;
    const server = createServer((_, response) => {
      requests += 1;
      response.end("parent-only");
    });
    let requests = 0;
    try {
      await mkdir(capsule);
      await mkdir(workspace, { recursive: true });
      if (nestedRuntime) {
        await mkdir(dirname(runtimeBinary), { recursive: true });
        await copyFile(process.execPath, runtimeBinary);
      }
      await mkdir(join(capsule, "home"));
      const source = join(capsule, "input.txt"),
        result = join(capsule, "result.json");
      const outside = join(workspace, "held-out.txt"),
        outsideWrite = join(workspace, "forbidden-output.txt");
      await writeFile(source, "admitted");
      await writeFile(outside, "held-out");
      if (process.platform === "win32") {
        assert.equal(typeof prepare, "function");
        await assert.rejects(
          prepare!({
            binary: runtimeBinary,
            args: ["--version"],
            capsuleRoot: capsule,
            workspaceRoot: workspace,
          }),
        );
        return;
      }
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const script = join(capsule, "probe.mjs");
      await writeFile(
        script,
        `import {readFile,writeFile,symlink} from 'node:fs/promises';
import http from 'node:http';
const [input,result,outside,output,url,parentPid]=process.argv.slice(2);
async function denied(action){try{await action();return false;}catch{return true;}}
const networkDenied=await new Promise(resolve=>{const request=http.get(url,response=>{response.resume();resolve(false);});request.on('error',()=>resolve(true));request.setTimeout(600,()=>{request.destroy();resolve(true);});});
const linked=input+'.link';await symlink(outside,linked);
await writeFile(result,JSON.stringify({input:await readFile(input,'utf8'),outsideReadDenied:await denied(()=>readFile(outside)),outsideWriteDenied:await denied(()=>writeFile(output,'unexpected')),symlinkDenied:await denied(()=>readFile(linked)),hostProcessRootDenied:process.platform!=='linux'||await denied(()=>readFile('/proc/'+parentPid+'/root'+outside)),networkDenied}));
`,
      );
      const args = [
        script,
        source,
        result,
        outside,
        outsideWrite,
        `http://127.0.0.1:${address.port}`,
        String(process.pid),
      ];
      // Baseline deliberately exercises the same disposable probe without the missing adapter.
      const invocation = prepare
        ? await prepare({
            binary: runtimeBinary,
            args,
            capsuleRoot: capsule,
            workspaceRoot: workspace,
          })
        : { binary: runtimeBinary, args, isolation: null };
      await exec(invocation.binary, invocation.args, {
        cwd: capsule,
        timeout: 10000,
        env: {
          PATH: dirname(process.execPath),
          HOME: join(capsule, "home"),
          TMPDIR: capsule,
          LANG: "C.UTF-8",
        },
      });
      const observed = JSON.parse(await readFile(result, "utf8"));
      assert.equal(observed.input, "admitted");
      assert.equal(observed.outsideReadDenied, true);
      assert.equal(observed.outsideWriteDenied, true);
      assert.equal(observed.symlinkDenied, true);
      assert.equal(observed.hostProcessRootDenied, true);
      assert.equal(observed.networkDenied, true);
      assert.equal(requests, 0);
      assert.ok(invocation.isolation);
      assert.match(invocation.isolation.policySha256, /^[a-f0-9]{64}$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

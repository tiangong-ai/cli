import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

import { runCli } from "../src/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bugs = "https://github.com/tiangong-ai/cli-toolkit/issues/new/choose";
const guide = "https://github.com/tiangong-ai/cli-toolkit/blob/main/CONTRIBUTING.md";

test("offline help exposes the reporting form and standalone guide", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["--help"], {
    env: {},
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.ok(stdout.includes(bugs));
  assert.ok(stdout.includes(guide));
});

test("issue forms accept uncertain ownership and preserve the shared intake fields", async () => {
  for (const [name, expected] of [
    [
      "bug_report",
      [
        "summary",
        "goal",
        "component",
        "versions",
        "environment",
        "stage",
        "reproduction",
        "expected",
        "actual",
        "evidence",
        "cli_details",
      ],
    ],
    [
      "feature_request",
      ["summary", "component", "use_case", "limitation", "proposal", "success", "alternatives"],
    ],
  ] as const) {
    const form = parse(await readFile(resolve(root, `.github/ISSUE_TEMPLATE/${name}.yml`), "utf8"));
    const fields = form.body.filter((field: { type: string }) => field.type !== "markdown");
    assert.deepEqual(
      fields.map((field: { id: string }) => field.id),
      expected,
    );
    assert.equal(new Set(fields.map((field: { id: string }) => field.id)).size, fields.length);
    assert.ok(
      fields
        .find((field: { id: string }) => field.id === "component")
        .attributes.options.includes("Unsure / 不确定"),
    );
    for (const field of fields) {
      assert.equal(
        field.validations.required,
        !["evidence", "alternatives", "cli_details"].includes(field.id),
      );
    }
  }
});

test("npm distribution includes the guide linked by help and README", async () => {
  const npmPath = process.env.npm_execpath;
  assert.ok(npmPath, "run this package contract through npm test or the clean-container gate");
  const manifest = JSON.parse(
    execFileSync(process.execPath, [npmPath, "pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.ok(manifest[0].files.some((file: { path: string }) => file.path === "CONTRIBUTING.md"));
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  assert.ok(readme.includes(guide), "packaged README must link to an accessible guide");
});

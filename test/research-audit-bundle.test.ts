import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import {
  exportProjectAuditBundle,
  verifyProjectAuditBundle,
  type ProjectAuditManifest,
} from "../src/research/workspace/audit-bundle.js";
import { addProjectInput, initializeProject } from "../src/research/workspace/projects.js";
import {
  prepareNativeResearchStage,
  requestResearchHandoff,
} from "../src/research/workspace/runtime.js";
import { sanitizeResearchText } from "../src/research/workspace/sanitization.js";
import { regularTreeFiles, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("portable research audit bundles", () => {
  it("preserves native handoff identifiers and exact ledger bytes in a portable audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-handoff-"));
    const destination = join(tmpdir(), `tiangong-audit-handoff-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Handoff audit fixture");
      const projectId = "handoff-audit";
      await initializeProject(root, projectId, "Preserve an interrupted native stage for audit.");
      const inputPath = join(root, "evidence.txt");
      await writeFile(
        inputPath,
        JSON.stringify({
          observation: "A deterministic, non-sensitive observation.",
          scopeAuthorization: { proposalSha256: "a".repeat(64) },
        }) + "\n",
      );
      await addProjectInput(root, projectId, inputPath, "primary");
      const packet = await prepareNativeResearchStage({
        root,
        projectId,
        stage: "discover",
        hostAgent: "codex",
      });
      await requestResearchHandoff({
        root,
        projectId,
        value: {
          schemaVersion: 2,
          kind: "interactive-challenge",
          state: "user-action-required",
          reasonCode: "fixture-human-action",
          summary: "A synthetic fixture requires an operator decision.",
          requestedActions: ["Review the fixture before resuming."],
          evidenceGaps: ["The synthetic fixture has not acquired full text."],
        },
      });
      const ledgerPath = join(workspacePaths(root).projects, projectId, "evidence", "ledger.jsonl");
      const before = await readFile(ledgerPath, "utf8");
      const events = before
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
        type: string;
        payload: { interruptedSessionId?: string };
      }>;
      assert.equal(
        events.find((event) => event.type === "handoff.requested")?.payload.interruptedSessionId,
        packet.sessionId,
      );

      await exportProjectAuditBundle({ root, projectId, destination });
      assert.equal((await verifyProjectAuditBundle(destination)).status, "verified");
      assert.equal(await readFile(ledgerPath, "utf8"), before);
      assert.equal(
        await readFile(join(destination, "project", "evidence", "ledger.jsonl"), "utf8"),
        before,
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("redacts complete credential fields without corrupting JSON or matching metadata suffixes", () => {
    const uuid = "9b349c65-6c45-42d9-9709-1689dd688dde";
    const secrets = {
      Authorization: "Bearer fixture-auth-credential",
      Cookie: "sid=fixture-cookie-credential",
      apiKey: "fixture-api-'quoted'-tail\\suffix",
      accessToken: "fixture-access-credential",
      refreshToken: "fixture-refresh-credential",
      clientSecret: "fixture-client-credential",
      userPassword: "fixture-user-password",
      providerApiKey: "fixture-provider-key",
      providerAuthorization: "Bearer fixture-provider-auth",
      ownerCredential: "fixture-owner-credential",
      token: 'fixture-token-"quoted"-tail\\suffix',
      sessionId: uuid,
      BRAVE_API_KEY: "fixture-environment-credential",
    };
    const sanitized = sanitizeResearchText(
      JSON.stringify({ interruptedSessionId: uuid, ...secrets }),
    );
    const parsed = JSON.parse(sanitized) as Record<string, string>;
    assert.equal(parsed.interruptedSessionId, uuid);
    for (const key of Object.keys(secrets)) assert.equal(parsed[key], "[REDACTED]", key);
    assert.doesNotMatch(sanitized, /fixture-|quoted|suffix/);
    assert.equal(sanitizeResearchText("token: 'fixture-it\\'s-a-secret'"), "token: '[REDACTED]'");
  });

  it("rejects escaped JSON and JSONL credentials without exempting UUID session values", async () => {
    const fixtures = [
      {
        name: "prefixed-authorization.json",
        content: JSON.stringify({
          providerAuthorization: "Bearer fixture-provider-auth",
          ownerCredential: "fixture-owner-credential",
        }),
      },
      {
        name: "prefixed-credentials.json",
        content: JSON.stringify({
          userPassword: "fixture-user-password",
          providerApiKey: "fixture-provider-key",
        }),
      },
      {
        name: "array-authorization.json",
        content: JSON.stringify({ Authorization: ["Bearer fixture-array-credential"] }),
      },
      {
        name: "object-cookie.json",
        content: JSON.stringify({ Cookie: { value: "sid=fixture-object-credential" } }),
      },
      {
        name: "refresh-token.json",
        content: JSON.stringify({ refreshToken: "fixture-refresh-credential" }),
      },
      {
        name: "client-secret.json",
        content: JSON.stringify({ clientSecret: "fixture-client-credential" }),
      },
      {
        name: "unicode-key.json",
        content: String.raw`{"\u0074oken":"fixture-unicode-credential"}`,
      },
      {
        name: "unicode-header.json",
        content: String.raw`{"note":"Authorization\u003a Bearer fixture-header-credential"}`,
      },
      {
        name: "nested-string.json",
        content: JSON.stringify({ note: JSON.stringify({ token: "fixture-nested-credential" }) }),
      },
      {
        name: "quoted-cookie.json",
        content: JSON.stringify({ Cookie: 'fixture-cookie-"quoted"-tail\\suffix' }),
      },
      {
        name: "session.json",
        content: JSON.stringify({
          interruptedSessionId: "internal-identifier",
          sessionId: "9b349c65-6c45-42d9-9709-1689dd688dde",
        }),
      },
      {
        name: "escaped-url.json",
        content: String.raw`{"url":"https:\/\/public.example/paper?to\u006ben=fixture-url-credential"}`,
      },
      {
        name: "escaped-ledger.jsonl",
        content:
          '{"ordinary":true}\n' +
          String.raw`{"nested":{"api\u004bey":"fixture-jsonl-credential"}}` +
          "\n",
      },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const root = await mkdtemp(join(tmpdir(), "tiangong-audit-encoded-"));
      const destination = join(
        tmpdir(),
        `tiangong-audit-encoded-${process.pid}-${index}-${Date.now()}`,
      );
      try {
        await initializeResearchWorkspace(root, "Encoded credential fixture");
        const projectId = "encoded-audit";
        await initializeProject(root, projectId, "Do not export credential-bearing source bytes.");
        const inputPath = join(root, fixture.name);
        await writeFile(inputPath, fixture.content);
        await addProjectInput(root, projectId, inputPath, "primary");
        await assert.rejects(
          exportProjectAuditBundle({ root, projectId, destination }),
          (error: unknown) => {
            assert.equal(
              (error as { code?: string }).code,
              "RESEARCH_AUDIT_BUNDLE_SENSITIVE",
              fixture.name,
            );
            return true;
          },
        );
        assert.equal(await readFile(inputPath, "utf8"), fixture.content);
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(destination, { recursive: true, force: true }),
        ]);
      }
    }
  });

  it("exports only hash-bound project evidence without host paths or unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-workspace-"));
    const destination = join(tmpdir(), `tiangong-audit-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Portable audit workspace");
      const projectId = "portable-audit";
      await initializeProject(
        root,
        projectId,
        "Can an independent reviewer reproduce this exact bounded evidence package?",
      );
      const inputPath = join(root, "owner-observation.csv");
      await writeFile(inputPath, "id,value\ncase-1,7\n");
      await addProjectInput(root, projectId, inputPath, "primary");
      await writeFile(join(root, "unrelated-concurrent.pdf"), "%PDF-unrelated\n");

      const exported = await exportProjectAuditBundle({ root, projectId, destination });
      assert.equal(exported.projectId, projectId);
      assert.match(exported.manifestSha256, /^[a-f0-9]{64}$/);
      const verified = await verifyProjectAuditBundle(destination);
      assert.equal(verified.status, "verified");
      const manifest = JSON.parse(
        await readFile(join(destination, "manifest.json"), "utf8"),
      ) as ProjectAuditManifest;
      assert.ok(manifest.files.some((file) => file.path.startsWith("inputs/")));
      assert.ok(manifest.files.some((file) => file.path === "state/project.json"));
      assert.equal(
        manifest.files.some((file) => file.path.includes("unrelated-concurrent.pdf")),
        false,
      );

      const textFiles = await regularTreeFiles(destination);
      const combined = (
        await Promise.all(
          textFiles.map(async (path) => {
            const bytes = await readFile(path);
            return bytes.includes(0) ? "" : bytes.toString("utf8");
          }),
        )
      ).join("\n");
      assert.doesNotMatch(combined, new RegExp(escapeRegExp(root)));

      const cliVerified = await invokeCli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        destination,
        "--json",
      ]);
      assert.equal(cliVerified.exitCode, 0, cliVerified.stderr);
      assert.equal(JSON.parse(cliVerified.stdout).status, "verified");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports a safe bundle locator when a JSON input embeds the host workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-json-root-"));
    const destination = join(tmpdir(), `tiangong-audit-json-root-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "JSON root locator fixture");
      await initializeProject(
        root,
        "json-root-locator",
        "Do not export a host-specific workspace path.",
      );
      const inputPath = join(root, "field-log.json");
      const bytes = Buffer.from(
        `${JSON.stringify({ note: `Recorded under ${root}: json-root-marker-4c2a.` })}\n`,
        "utf8",
      );
      await writeFile(inputPath, bytes);
      await addProjectInput(root, "json-root-locator", inputPath, "primary");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await assert.rejects(
        exportProjectAuditBundle({ root, projectId: "json-root-locator", destination }),
        (error: unknown) => {
          const cliError = error as {
            code?: string;
            message?: string;
            details?: { path?: string };
          };
          assert.equal(cliError.code, "RESEARCH_AUDIT_BUNDLE_NONPORTABLE");
          assert.equal(cliError.details?.path, `inputs/${sha256}`);
          const echoed = `${cliError.message ?? ""}${JSON.stringify(cliError.details ?? {})}`;
          assert.doesNotMatch(echoed, new RegExp(escapeRegExp(root)));
          assert.doesNotMatch(echoed, /json-root-marker-4c2a/);
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects host-root text in hash-named extension-less text inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-plain-root-"));
    const destination = join(tmpdir(), `tiangong-audit-plain-root-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Plain text root fixture");
      await initializeProject(
        root,
        "plain-root-locator",
        "Extension-less text must still be scanned.",
      );
      const inputPath = join(root, "field-notes");
      const bytes = Buffer.from(
        `Transcribed at ${root} during the fixture: plain-root-marker-9f31.\n`,
        "utf8",
      );
      await writeFile(inputPath, bytes);
      await addProjectInput(root, "plain-root-locator", inputPath, "primary");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await assert.rejects(
        exportProjectAuditBundle({ root, projectId: "plain-root-locator", destination }),
        (error: unknown) => {
          const cliError = error as {
            code?: string;
            message?: string;
            details?: { path?: string };
          };
          assert.equal(cliError.code, "RESEARCH_AUDIT_BUNDLE_NONPORTABLE");
          assert.equal(cliError.details?.path, `inputs/${sha256}`);
          const echoed = `${cliError.message ?? ""}${JSON.stringify(cliError.details ?? {})}`;
          assert.doesNotMatch(echoed, new RegExp(escapeRegExp(root)));
          assert.doesNotMatch(echoed, /plain-root-marker-9f31/);
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects credential-like text in hash-named extension-less text inputs without echoing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-plain-secret-"));
    const destination = join(tmpdir(), `tiangong-audit-plain-secret-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Plain text credential fixture");
      await initializeProject(
        root,
        "plain-secret-locator",
        "Extension-less credential text must still be rejected.",
      );
      const inputPath = join(root, "secret-notes");
      const bytes = Buffer.from("token: 'fixture-hash-named-secret'\n", "utf8");
      await writeFile(inputPath, bytes);
      await addProjectInput(root, "plain-secret-locator", inputPath, "primary");
      await assert.rejects(
        exportProjectAuditBundle({ root, projectId: "plain-secret-locator", destination }),
        (error: unknown) => {
          const cliError = error as { code?: string; message?: string; details?: unknown };
          assert.equal(cliError.code, "RESEARCH_AUDIT_BUNDLE_SENSITIVE");
          const echoed = `${cliError.message ?? ""}${JSON.stringify(cliError.details ?? {})}`;
          assert.doesNotMatch(echoed, new RegExp(escapeRegExp(root)));
          assert.doesNotMatch(echoed, /fixture-hash-named-secret/);
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("still exports safe UTF-8, CSV, Markdown, hash-named text, and binary inputs unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-safe-scan-"));
    const destination = join(tmpdir(), `tiangong-audit-safe-scan-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Safe scan fixture");
      const projectId = "safe-scan";
      await initializeProject(root, projectId, "Portable safe inputs stay byte-exact.");
      const inputs: Array<{ path: string; bytes: Buffer }> = [
        {
          path: join(root, "notes.md"),
          bytes: Buffer.from(
            "# Field notes\n\nSafe markdown for the portable audit fixture.\n",
            "utf8",
          ),
        },
        {
          path: join(root, "observations.txt"),
          bytes: Buffer.from("Plain observations recorded without host-specific detail.\n", "utf8"),
        },
        {
          path: join(root, "summary.csv"),
          bytes: Buffer.from("id,value\ncase-1,7\n", "utf8"),
        },
        {
          path: join(root, "field-log"),
          bytes: Buffer.from("Hash-named plain text that stays portable.\n", "utf8"),
        },
        {
          path: join(root, "snapshot.bin"),
          bytes: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(32, 0),
            Buffer.from("binary-payload", "utf8"),
          ]),
        },
      ];
      for (const input of inputs) {
        await writeFile(input.path, input.bytes);
        await addProjectInput(root, projectId, input.path, "primary");
      }
      const exported = await exportProjectAuditBundle({ root, projectId, destination });
      assert.equal(exported.projectId, projectId);
      assert.equal((await verifyProjectAuditBundle(destination)).status, "verified");
      for (const input of inputs) {
        const sha256 = createHash("sha256").update(input.bytes).digest("hex");
        assert.equal(
          (await readFile(join(destination, "inputs", sha256))).equals(input.bytes),
          true,
          input.path,
        );
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed on tampering and a symlinked export destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-integrity-"));
    const destination = join(tmpdir(), `tiangong-audit-integrity-${process.pid}-${Date.now()}`);
    const symlinkPath = `${destination}-link`;
    try {
      await initializeResearchWorkspace(root, "Audit integrity workspace");
      await initializeProject(
        root,
        "audit-integrity",
        "Does every portable audit byte remain exactly bound to its manifest?",
      );
      await exportProjectAuditBundle({ root, projectId: "audit-integrity", destination });
      const projectPath = join(destination, "state", "project.json");
      await chmod(projectPath, 0o600);
      await writeFile(projectPath, '{"tampered":true}\n');
      await assert.rejects(verifyProjectAuditBundle(destination), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RESEARCH_AUDIT_BUNDLE_INVALID");
        return true;
      });

      await symlink(destination, symlinkPath);
      await assert.rejects(
        exportProjectAuditBundle({
          root,
          projectId: "audit-integrity",
          destination: symlinkPath,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_AUDIT_BUNDLE_PATH_INVALID");
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
        rm(symlinkPath, { force: true }),
      ]);
    }
  });
});

async function invokeCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

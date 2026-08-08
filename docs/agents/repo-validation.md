---
docType: runbook
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When validating Tiangong AI CLI changes, CI behavior, coverage, or release readiness."
whenToUpdate: "When Node baseline, package scripts, coverage thresholds, docpact rules, or CI workflow change."
checkPaths:
  - package.json
  - package-lock.json
  - .nvmrc
  - .gitattributes
  - .prettierrc.json
  - scripts/**
  - test/**
  - .github/workflows/**
lastReviewedAt: 2026-08-09
lastReviewedCommit: 8e990e24c3ab77058a0f67f9bbcea698c6404a3b
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript
- Stable launcher: `bin/tiangong-ai.js`
- Research execution sandbox: macOS `sandbox-exec` or Linux Bubblewrap
- Repository text checkout uses LF line endings through `.gitattributes`; this
  keeps Prettier behavior consistent across Linux, macOS, and Windows CI
  runners.

## Hosted CI Matrix

`.github/workflows/quality-gate.yml` runs for pull requests and pushes to
`main`, with `fail-fast: false`, across the same four runner/architecture pairs
used by the reference workspace CLI:

- `ubuntu-latest` / `x64`
- `windows-latest` / `x64`
- `macos-latest` / `arm64`
- `ubuntu-24.04-arm` / `arm64`

The runner label selects the actual GitHub-hosted architecture; the explicit
`arch` value keeps job names and matrix intent auditable. Both Linux rows
install Bubblewrap and smoke-test an unprivileged capsule before the test
suite. The remaining lint, test, and coverage steps stay identical across all
four rows.

## Local Gates

Run before delivery:

```bash
npm run lint
npm test
npm run test:coverage
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

`npm run prepush:gate` aggregates the lint, coverage, and docpact checks when
`docpact` is installed locally.

## Release Flow

`.github/workflows/publish.yml` publishes `@tiangong-ai/cli` to npm from
GitHub Actions. It runs the same npm lint, test, and coverage gates before any
publish attempt.

Publishing starts when a `v*` tag is pushed. The tag must match
`package.json` version exactly, for example `v0.1.0` for version `0.1.0`.

Linux CI installs Bubblewrap and smoke-tests an unprivileged capsule before the
test suite. On ephemeral Ubuntu runners that expose the AppArmor user-namespace
restriction, the workflow disables that restriction for the runner lifetime so
the test exercises the same unprivileged Bubblewrap boundary required at
runtime.

The workflow uses npm Trusted Publishing through GitHub OIDC. Configure npm
trusted publisher metadata for this repository and workflow before first use;
do not configure an npm token secret. The publish job keeps `id-token: write`
enabled, upgrades npm for trusted publishing, checks that the version is not
already published, runs the local gates, performs a package dry run, and then
executes `npm publish --access public --provenance`.

## Coverage Policy

The coverage gate uses `c8` and fails when coverage drops below the thresholds
encoded in `scripts/run-test-coverage.cjs`. Coverage ignore pragmas are
forbidden; cover the branch or remove dead code.

The initial v0 threshold is intentionally conservative. Raise it as command
coverage grows.

`test/research-workspace.test.ts` exercises context classification, current
workspace initialization, environment rejection, capability locks, the MCP
broker boundary, platform sandbox invocation, multi-project scheduling,
project-scoped scheduling/exit semantics, pre-call budget enforcement,
independent review, closure, and the public command family.
`test/research-setup.test.ts` covers the separately sourced recommendation
catalog, immutable plan/tamper checks, explicit licenses and global mutation,
credential preflight before downloads, resumable setup state, TTY Wizard
automation and color suppression, pinned Brave source-layout paths across every
evidence profile, minimal secret environments, exact document/paper artifact
binding, no-overwrite/no-directory-scan behavior, explicit browser handoff, and
bounded JSON POST broker credential/body redaction.
`test/research-runtime-production.test.ts` adds zero-cost
production evals for permanent evidence and review packets, exact HTTP policy,
byte/item/offset/estimated-token extraction bounds and raw-object cache reuse,
sanitized 429/422 handling, structured-output and provenance repair,
mechanically normalized dimension/full-text/publication-date coverage,
bounded local context with full-source review, stage tool isolation, runtime
target/wrapper/adapter fingerprinting and drift rejection, telemetry redaction,
owner-only whitelisted Claude settings authentication, production doctor
attestation, two-protocol-turn tool-free review with exact local/broker bounded views,
persistent packet/context tamper rejection at closure, JSONL progress, and
append-only retry/fork recovery. `test/research-external-skills.test.ts`
validates the pinned external recommendation catalog, actionable missing-install
errors, owner-environment credential configuration without disclosure, custom
database Skill admission, whole-tree locks and staged manifests, static/live
provider checks, bounded 429 retry, authentication/rate-limit redaction,
source-to-installed-tree binding, refusal to bless drift through lock/configure/import,
internal-source rejection, invalid-definition errors, sensitive health-URL
rejection, and blocked catalog/doctor status for symlinked credential files.
Production tests additionally require an external
public-internet plan and block downstream work when any capability marked
`requiredForDiscovery` lacks a broker receipt.

Executor regression coverage also verifies that Codex receives exactly one
external-sandbox bypass flag and no nested `--sandbox read-only` flag, while
shell and unified-exec remain disabled. A deterministic fake Codex emits a
90 KiB MCP result to prove the capture reservation includes bounded tool
context instead of failing at the historical 64 KiB floor. Runtime tests verify
that discovery has no filesystem tool policy and receives the exact locked
manifest and staged top-level Skill documentation inline.

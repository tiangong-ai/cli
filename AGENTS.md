---
docType: agent-contract
scope: repository
status: current
authoritative: true
owner: cli
language: en
whenToUse: "Before changing the Tiangong AI CLI implementation."
whenToUpdate: "When CLI command boundaries, environment variables, validation commands, or release flow change."
checkPaths:
  - AGENTS.md
  - README.md
  - package.json
  - .dockerignore
  - Dockerfile.clean-test
  - .github/workflows/**
  - .docpact/config.yaml
  - docs/agents/**
  - src/**
lastReviewedAt: 2026-09-05
lastReviewedCommit: 16b436927ca80ae58b2fefc5c47bdf21f850827d
---

# Tiangong AI CLI Contract

This repository owns the Tiangong AI command-line interface.

## Boundaries

- The CLI is a local operator tool for repeatable, long-running, or batch work.
- The CLI may call public Tiangong HTTP APIs with user-provided credentials.
- The CLI must not embed server-side secrets, Supabase service-role keys, NAS
  credentials, AWS keys, Pinecone keys, or OpenSearch admin credentials.
- Backend services remain responsible for authorization, persistence, dedupe,
  queueing, and state transitions.
- Agent skills may call this CLI, but reusable workflow prompts belong in the
  `skills` repository.

## Current Command Surface

- `tiangong-ai --version`
- `tiangong-ai doctor`
- `tiangong-ai data catalog`
- `tiangong-ai data describe`
- `tiangong-ai data doctor`
- `tiangong-ai data run`
- `tiangong-ai kb ingest`
- `tiangong-ai kb ingest bulk`
- `tiangong-ai kb ingest jobs`
- `tiangong-ai kb ingest resume`
- `tiangong-ai kb ingest export`
- `tiangong-ai kb collections`
- `tiangong-ai kb status`
- `tiangong-ai research context`
- `tiangong-ai research setup`
- `tiangong-ai research policy`
- `tiangong-ai research publication`
- `tiangong-ai research scientific`
- `tiangong-ai research workspace`
- `tiangong-ai research reviewer`
- `tiangong-ai research capability`
- `tiangong-ai research project`
- `tiangong-ai research status`
- `tiangong-ai research run`
- `tiangong-ai research search`
- `tiangong-ai education search`

The built-in atomic data catalog currently contains 17 independently
discoverable capabilities for public environmental, regulatory, news-event,
social, video, and water-project data, including bounded USBR RISE and project
record capabilities.
Regulations.gov connector sources remain in the repository for future
qualification but are not registered, discoverable, or executable while their
production search/detail and attachment paths fail live availability gates.
Connector execution, normalization, schemas, provider limits, and
source/license restrictions belong under `src/data/**`. The execution manifest
digest is deliberately separate from the Agent-facing discovery metadata
digest; Skills may bind to execution contracts but must not copy connector
logic or treat discovery wording as runtime drift.

## Validation

Run before delivery:

```bash
npm run test:clean:cold
npm run lint
npm run typecheck
npm run build
npm test
npm run test:platform
npm run test:coverage
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

For Auto Research changes, `npm run test:clean` is the iterative authoritative
TDD gate. It may reuse input-valid Docker build layers, but every invocation
runs the tests in a separately created offline container with isolated HOME and
temporary filesystems. Write the regression first, observe it fail there, then
make it pass in another fresh container. Host-only results are supplemental.

Run `npm run test:clean:cold` after changing `.dockerignore`, the clean-test
Dockerfile, a dependency manifest or lockfile, and before delivery. Hosted PR
and publish workflows use this cold mode explicitly; it adds `--no-cache` but
does not use `--pull`, because base versions change only through reviewed digest
updates.

Use `npm run typecheck` for a faster TypeScript-only check.
Use `npm run test:platform` for the pure path-style and platform capability
contracts that must run identically on every host before the hosted matrix.
Use `npm run prepush:gate` when `docpact` is installed and you want the
aggregated local quality gate.

## Release

GitHub Actions publishes npm releases through `.github/workflows/publish.yml`.
The workflow uses npm Trusted Publishing through GitHub OIDC and runs npm lint,
test, coverage, and pack checks before publishing.

## Required Docs

- Read `docs/agents/repo-architecture.md` before changing command behavior or
  skill handoff boundaries.
- Read `docs/agents/repo-validation.md` before changing package scripts,
  coverage thresholds, CI, or docpact configuration.
- Read `docs/agents/data-runtime-architecture.md` before changing proposed
  atomic data commands, connectors, machine schemas, receipts, credentials, or
  the Skills/Research data boundary.
- Read `docs/agents/data-runtime-implementation-plan.md` before starting or
  sequencing the TypeScript 7 and atomic data migration work packages.

## User Feedback

`CONTRIBUTING.md` implements the shared workspace reporting policy. Keep the
core form fields aligned with Skills and preserve offline help and packaged
reporting guidance. User reports do not require a root-cause diagnosis.

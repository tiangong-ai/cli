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
  - .github/workflows/**
  - .docpact/config.yaml
  - docs/agents/**
  - src/**
lastReviewedAt: 2026-08-09
lastReviewedCommit: 8e990e24c3ab77058a0f67f9bbcea698c6404a3b
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
- `tiangong-ai kb ingest`
- `tiangong-ai kb ingest bulk`
- `tiangong-ai kb ingest jobs`
- `tiangong-ai kb ingest resume`
- `tiangong-ai kb ingest export`
- `tiangong-ai kb collections`
- `tiangong-ai kb status`
- `tiangong-ai research context`
- `tiangong-ai research setup`
- `tiangong-ai research workspace`
- `tiangong-ai research capability`
- `tiangong-ai research project`
- `tiangong-ai research status`
- `tiangong-ai research run`
- `tiangong-ai research search`
- `tiangong-ai education search`

## Validation

Run before delivery:

```bash
npm run lint
npm run build
npm test
npm run test:coverage
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

Use `npm run typecheck` for a faster TypeScript-only check.
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

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
  - .dockerignore
  - Dockerfile.clean-test
  - .nvmrc
  - .gitattributes
  - .prettierrc.json
  - scripts/**
  - test/**
  - .github/workflows/**
lastReviewedAt: 2026-09-05
lastReviewedCommit: 16b436927ca80ae58b2fefc5c47bdf21f850827d
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript 7.0.2 native compiler (`typescript` range `^7.0.2`, exact
  resolution locked by `package-lock.json`)
- Stable launcher: `bin/tiangong-ai.js`
- Research execution sandbox: macOS `sandbox-exec` or Linux Bubblewrap
- Windows validates setup and deterministic logic in smoke-test mode, but
  production research readiness remains blocked without an approved capsule
  sandbox.
- Repository text checkout uses LF line endings through `.gitattributes`; this
  keeps Prettier behavior consistent across Linux, macOS, and Windows CI
  runners.

## TypeScript 7 Baseline And Data Gates

The TypeScript 7 toolchain gate is complete before connector business logic.
The repository uses the native `tsc` from TypeScript 7.0.2, explicitly loads
Node declarations through `types: ["node"]`, and does not import the compiler's
programmatic API. Node stays on `>=24 <25`.

Every hosted matrix row runs the full TypeScript check, and the clean-container
gate runs it before coverage. This includes test sources, while the declaration
build remains scoped to `src/**`. The migration fixed pre-existing test-only
inference/nullability failures without changing runtime behavior.

The data runtime has a dedicated connector conformance harness rather than
relying only on the repository's aggregate coverage threshold. It covers
execution-manifest, discovery-metadata and schema stability; proves that
discovery-only wording changes do not alter execution bindings; and covers
canonical cross-platform digests, endpoint and redirect policy, bounded HTTP
behavior, header and protected path-segment logical credential injection,
secret-independent request digests, redaction, pagination/partial results,
stable errors, receipt binding, and npm package discovery of the published
schemas. Provider live tests remain explicit opt-ins; ordinary and
clean-container CI use privacy-safe fixtures and synthetic connectors only.

`test/data-airnow-connector.test.ts` reconstructs the official HourlyAQObs CSV
shape and proves multi-file planning, filters, header/value handling, partial
file coverage, source lineage, and preliminary-use restrictions.
`test/data-federal-register-connector.test.ts` uses metadata-only JSON fixtures
to prove stable filter encoding, pagination, empty results, record/page caps,
provider metadata validation, and preservation of earlier pages after a later
failure. Fixture provenance notes live beside the fixtures under
`test/fixtures/data/**`; no provider response, credential, or user data is
checked in.

`test/data-gdelt-connectors.test.ts` generates synthetic DOC JSON and
single-member ZIP/TSV fixtures in memory. It proves four independent capability
contracts, exact 15-minute path planning without `masterfilelist.txt`, latest
size/MD5 verification, bounded ZIP/CRC/UTF-8/column validation, closed named
fields, later-file partial preservation, record-cap early stop, and the
automated-coding/non-representative/content-download discovery boundaries.

`test/data-bluesky-cascade-connector.test.ts` proves bounded public search,
author-feed, custom-feed, and list-feed selection; UTC filtering; optional
thread expansion; failed-request accounting; seed preservation on partial
thread failure; and the public-UGC, indexing, moderation, and mutable-metric
discovery boundaries.

`test/data-youtube-public-content-connector.test.ts` proves header-only API-key
injection, bounded video discovery and enrichment, complete reply pagination,
credential preflight, duplicate-ID and empty-query rejection, per-video partial
isolation, explicit empty partial results for disabled comments, and the quota,
visibility, ranking, and non-representative-public-opinion discovery boundaries.
The bounded HTTP suite separately proves that only a short machine-readable
provider reason is retained from an error body; provider prose and unsafe values
remain excluded.

`test/data-nasa-firms-fire-connector.test.ts` proves required MAP_KEY preflight,
five-day chunk planning, provider availability checks, bbox/window/transaction
limits, VIIRS field normalization, no-results, record caps, invalid-row and
later-chunk partial isolation, and hotspot/non-perimeter discovery boundaries.
The shared CSV parser has its own quoted-field and malformed-input regression,
and the bounded HTTP suite proves a path credential never enters the public
request digest or result.

`test/data-openaq-connector.test.ts` proves required API-key preflight for both
operations, bounded and stable location filters, raw/hourly/daily sensor route
selection, pagination metadata validation, attribution/coverage normalization,
pre-network request rejection, record caps, later-page partial isolation, and
the explicit S3-download, AQI, health, and regulatory boundaries.

`test/data-regulations-gov-connector.test.ts` retains fixture-only proof of API-key preflight for both
read-only operations, posted and Eastern-wall-clock last-modified filters,
stable JSON:API pagination, curated detail and attachment metadata, omission of
named personal-profile fields, pre-network request rejection, record caps,
per-ID partial isolation, and the non-posting, non-download, and
non-representative-public-opinion discovery boundaries. The definitions are not
part of the built-in registry while their production live gates are suspended;
`test/data-builtins.test.ts` enforces that absence.

Target the foundation during iteration with
`node --import tsx --test test/data-*.test.ts`. The ordinary `npm test` and
coverage commands discover the same suites automatically. A build must emit all
nine public contract files under `dist/data/schemas/`, including the independent
discovery metadata contract; the package contract test compares those bytes
with the runtime-loaded documents.

The exact work-package sequence and completion criteria are authoritative in
`docs/agents/data-runtime-implementation-plan.md`.

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
install Bubblewrap and smoke-test an unprivileged capsule. Every row runs lint
and the full TypeScript check, but each row runs the full runtime test suite only
once: Ubuntu x64 obtains that result through coverage, Ubuntu ARM runs
`npm test`, and macOS/Windows run `npm test` plus the small pure
`test:platform` contract. Coverage therefore runs only on Linux x64 and never
follows a duplicate `npm test` in that job.

The pure platform contract models Windows drive letters, separators,
case-insensitive containment and cross-drive paths plus the macOS `/var` to
`/private/var` alias without depending on the current host filesystem. The
central capability profile declares Windows and unsupported systems
configuration/smoke-only: they may validate setup and deterministic logic but
cannot start a native reviewer or reviewer sidecar.

Both PR workflows cancel obsolete runs for the same pull request. Pushes to
`main` are not canceled. The docpact workflow installs the workspace-standard
`0.1.9` release.

## Local Gates

Run before delivery:

```bash
npm run test:clean:cold
npm run lint
npm run typecheck
npm test
npm run test:platform
npm run test:coverage
npm run audit:research-setup-pins
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

`npm run test:clean` is the iterative red/green/refactor entrypoint. It builds
from the digest-pinned Node 24 image, may reuse Docker layers whose declared
inputs still match, copies only the `.dockerignore`-filtered checkout, and runs
the full lint/typecheck/coverage gate as a non-root user in a newly created,
runtime-offline container. Tests run after container creation and are never a
build-cache result. Host tests cannot replace this gate.

`npm run test:clean:cold` selects the same isolation contract with an explicit
`--no-cache` build. Run it after `.dockerignore`, Dockerfile, dependency
manifest, or lockfile changes and before delivery. PR and publish workflows use
cold mode. Neither mode uses `--pull`; the base image stays reproducible until
its reviewed digest changes. Provider live checks and the networked
immutable-pin audit run separately because they are explicit networked
validations.

`npm run test:platform` is a fast host-independent contract for platform
classification. It is not a substitute for the real macOS/Windows matrix; it
moves known path and capability semantics ahead of that matrix so hosted
runners discover only genuinely platform-specific defects.

`test/research-evidence-throughput.test.ts` exercises the public batch/preflight
commands in a synthetic native-host discovery/acquisition flow. It asserts atomic
rejection, orphan-envelope invisibility and recovery, exact replay/conflict/hash
behavior, and deterministic verification/read/append work counts instead of
machine-dependent timing. Artifact preflight tests distinguish per-file and
aggregate output budgets and preserve existing absent-field limits without
rewriting configuration; no large real download or network service is needed.

Every runtime container has no host mounts, Docker socket, credentials, or
runtime network. It enables Docker's privileged namespace mode solely so the non-root
test process can exercise the real nested Bubblewrap capsule instead of skipping
or mocking it; the isolation assertion still rejects root execution, host HOME,
global Skills, and global CLI state.

`test/research-project-recovery.test.ts` kills real child processes after
directory/state/commit writes, then invokes public status, fork, retry and
native preparation from a fresh process. It verifies private uncommitted
targets, committed replay, preserved report archives, no false supersession,
source-change conflicts, linked replacements and secret-free malformed-record
errors. These fixtures do not execute a model or provider. Existing status
filtering tests create real committed successors instead of hand-writing
supersession flags.

`test/research-project-authority.test.ts` verifies lineage identity/cycles and
bounds successor-map lookups for a long chain across repeated queries. It does
not use host-dependent timing thresholds. Scientific-execution tests refuse
uncommitted derived projects before spending a reservation. Publication tests
retain computational negative controls while allowing consistent qualitative
metadata through the same remaining gates; acquisition tests reproduce the
local-PDF forecast/submit discrepancy without weakening submission.

`test/research-acquisition.test.ts` additionally exercises hash-bound same-project
revision, explicit discovery reopening, immutable historical record bytes, budget
and artifact reuse, acquisition commit-point crashes, replay, stale/post-analysis
refusal, decomposition supersession and obsolete-atom exclusion. These cases do
not contact a provider. Forecast asserts its submit-blocker decision separately
from potential typed-content coverage.

`test/research-task-acceptance.test.ts` covers closed task/check schemas, original
intake before execution/scientific review, exact scope consent and before/after
details, crash-safe approval projections, fork history, source/atom/result binding,
raw BOM/CRLF preservation, control-store aliases, stale and failed checks, supported
negative results, and original/current completion separate from workflow status.
It counts one existing reviewer call and one shared result context instead of
using timing assertions. Publication regressions bind task context to the existing
reviewers. Portable audit tests move the bundle, remove the source workspace, and
reject altered task bindings even with a recomputed manifest digest.

Request-provenance regressions preserve exact BOM/CRLF source bytes and hashed
locators, distinguish interpreted/unrecorded origin, and reject false verbatim
claims or retrospective replacement. `test/research-artifact-views.test.ts` covers
complete oversized reads, UTF-8 pagination, bounded per-object verification work,
late-file exclusion, links/tamper, secret refusal, exact persisted receipts,
Host/Origin checks, and actual isolated mock Codex/Claude MCP clients. The mock
Claude client follows its structured-result preference and must receive actual
content, not just receipts. The server sends one complete text response; it must
not attach a metadata-only structured alternative. Native qualification also
requires recovery of unpredictable fixture text omitted from the prompt, not
merely a model assertion that it read a file.
The mock
Codex consumer verifies all 6 MiB of one read before emitting its duplicate JSONL
tool trace; only that duplicate capture is compacted, not delivered evidence.
Unexpected general I/O tool events are rejected. Preflight/design regressions
separate total corpus size and large legacy planning hints from finite execution
budgets; scientific cost tests distinguish a rough estimate from the approved ceiling.
Bridge tests carry the same read-only binding through the signed sidecar and still
refuse general workspace tools or external MCP/broker routes. Native/scientific
regressions first reproduce former context-length refusals, then require normal
preparation and exact on-demand reads without modifying frozen evidence. Mock
passes remain distinct from an external real independent-review canary.

The isolated mock Claude process also receives the actual early scientific
review schema and rejects an unsupported Draft 2020-12 annotation before any
tool/model work. Its provider view and manual `--compatibility claude-code`
share one adapter; constraints, literal values and the canonical validation
schema remain unchanged. Scientific-execution failures retain bounded sanitized
exit diagnostics in both the structured error and journal, never the full prompt.
Executor regressions consume Claude's actual `structured_output` envelope,
prefer it over informal `result` text, and reject `is_error`/error-subtype results
even when a wrapper exits zero. Structured errors take priority over incidental
stderr warnings and are sanitized before truncation, including a secret that
crosses the diagnostic boundary.
The native format probe exposed Claude's untyped numeric `const` becoming a
string tool parameter. The provider projection makes implied scalar types
explicit, while retaining `const`/`enum` and rejecting mismatched returned data.

`test/research-scientific-review.test.ts` exercises same-project fulfillment of
predeclared model/environment slots, byte-identical base design preservation,
idempotent replay, unchanged earlier approvals, stale due-packet rejection, and
portable object export with rehashed-but-disconnected audit rejection.
`test/research-scientific-fulfillment.test.ts` admits a real local synthetic input
through native discover/acquire, freezes its typed atom, and binds exact parameter
states without changing units or identities. It uses mock scientific judgement,
not a provider or a claim of scientific validity.

Native-run regressions execute ordinary local Node programs, including CommonJS,
and use a file-based barrier to prove the workspace lease is free during actual
calculation. They cover exact run/requirement/result binding, replay without
reexecution, failed/timeout/missing-output refusal, credential-free process
environment and sanitized diagnostics. Observed program/input/output bytes must
be packet-readable and portable-audit-bound. Rehashed manifests cannot hide a
missing program or a changed read receipt; a live review loader revalidates its
stored artifact directory. These process tests are not model-driven research.

For this boundary, supplement fresh Docker RED/GREEN with a fresh external native
workspace using the exact locally packed candidate, isolated HOME/npm cache, and
real public input bytes/native calculations. Label any deterministic reviewer as
protocol validation, not a scientific review or a published registry runtime.
Keep native data, prompts, caches and reports outside Git; commit only privacy-safe
regressions and link sanitized validation evidence from the tracked task. Existing
paid-review count, native-producer and scientific-gate boundaries must not change.

On a Linux test host where
`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`, the local gate
stops before building and reports the exact prerequisite. The operator or CI
runner must set that host policy to `0` for the test lifetime; the test script
does not mutate host kernel policy itself.

`npm run prepush:gate` aggregates the lint, coverage, and docpact checks when
`docpact` is installed locally.

When a pinned research setup commit or the whole-tree hash algorithm changes,
recompute every affected catalog entry from a clean detached checkout of its
exact immutable commit. Unit tests remain network-free. The explicit
`audit:research-setup-pins` gate is networked: it creates fresh deterministic
checkouts for every Catalog source, verifies every selected source path and
whole-tree hash, validates exact stable versions, and enforces the
orchestrator's workspace-lock resolver/no-stale-version contract. It also parses
every template in the exact pinned Top-Journal Policy pack and requires its
mandatory scientific-design, early-review, and real-record canary invariants.
It is required locally for a pin change and in release CI.

Release CI additionally sets `TIANGONG_RESEARCH_REQUIRE_SKILLS_MAIN=1`; the
audit then requires the first-party `tiangong-ai/skills` pin to be reachable
from remote `main`. This makes a merged Skills change a prerequisite for CLI
release and prevents publishing a catalog from an unmerged branch while still
allowing the catalog to retain the exact reviewed commit beneath a merge commit.

`test/research-setup.test.ts` covers plan-only context, blocked source checkout,
stored broker credentials without ambient credentials, exact retry commands,
source-specific retry provenance, project/global Skill conflicts, symlinked
ambient CLI resolution, legacy PATH-wrapper detection, the generated
recovery-only Skill, and verified cleanup after the full orchestrator is
available. These cases must remain network-free inside `npm run test:clean`.

`test/research-setup-declarative.test.ts` covers public no-overwrite template
initialization, v1 declaration rejection, complete explicit catalog
materialization, fixed workspace-only
discovery, removal of the earlier implicit credential map, strict
duplicate/alias/unknown/incomplete YAML rejection, catalog-metadata drift,
owner-only non-symlink env intake, disabled optional credential behavior,
undeclared and conflicting variable rejection, secret non-persistence,
mandatory live/reviewer checks, semantic-hash plan reuse, explicit replacement
with archived bindings, and non-zero apply/status/doctor results until overall
readiness is complete. The suite uses injected setup operations for
provider-free execution and must not contact a real provider or reviewer
service.

`test/research-data-evidence-adapter.test.ts` covers dynamic operation
projection, standalone/core receipt parity, owner-only namespaced credential
injection, secret-free evidence persistence, and the Research credential-source
boundary. A host provider variable without the corresponding workspace
credential must return `credential-missing` before connector execution or any
network request.

## Release Flow

`.github/workflows/publish.yml` publishes `@tiangong-ai/cli` to npm from
GitHub Actions. It runs the same npm lint, test, and coverage gates before any
publish attempt, then runs the networked immutable Skill pin/runtime-contract
audit before packaging.

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

`research-reviewer-status.test.ts` and `research-scientific-execution.test.ts`
cover transport-aware read-only status, smoke versus production readiness,
explicit cost consent, exact prepared reviewer execution, immutable proof replay,
project-authority checks on recovered submission, concurrent idempotent replay,
unknown-usage and wall-time reservations, Policy Markdown inclusion, and secret
non-persistence. These tests do not call a real model. The external native
canary runs the packaged CLI and a clearly synthetic reviewer through the real
platform capsule, without credentials or provider requests.

The integrated role forecast regression specifically includes a same-dimension
metadata-only patent and a binary-only patent: neither may fill an atom-level
source-type slot even when global acquisition coverage passes. Runtime tests
also exercise expanded discovery input and context beyond the old input cap,
valid historical/wait states through Doctor, and each due
scientific-gate status through public run/status.

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
credential preflight and 0600 persistence before downloads, resumable setup
state, hidden-TTY/env/bounded-stdin/explicit-skip Wizard paths without secret
disclosure, TTY Wizard automation and color suppression, pinned Brave
source-layout paths across every evidence profile, deterministic Git checkout
configuration, safe hash-mismatch diagnostics and pre-installer fail-closed
behavior, workspace-lock resolver/stale-version rejection, Catalog CLI-drift
warnings, optional setting/credential omission without false readiness
warnings, reusable runtime-bound live
attestations, explicit orchestrator/default-baseline selection,
replacement-time managed capability and credential pruning with custom/Skill
preservation, explicit smoke-failure blocking, minimal secret environments,
exact document/paper artifact
binding, no-overwrite/no-directory-scan behavior, explicit browser handoff, and
bounded JSON POST broker credential/body redaction. Paper companion tests also
require execution and doctor to use the installed Skill's locked `runtime.py`,
including a sanitized actionable missing-runtime error. Authoring readiness
tests cover the complete DOCX/PDF/PPTX/XLSX package and command matrices,
same-runtime binding, component-scoped blocking, all four exact-file functional
canaries, and the prohibition on implicit pip/npm/system installation.
`test/research-setup-instructions.test.ts` covers reviewed project-only Codex
and Claude routing targets, owner-byte preservation, idempotent apply,
new-session status, exact owned-byte removal, pre-mutation conflict detection,
user-modified managed blocks, and symlink escape rejection.
The setup execution regression also fixes the nested installer argv as
`npx --package skills@<pin> -- skills ...`; positional package invocation is
not accepted because it fails inside a clean outer `npx --package
@tiangong-ai/cli` consumer environment.
The same regression requires one absolute apply-scoped npm cache outside HOME,
verifies that nested installer calls receive it, and proves cleanup after both
successful installation and installer verification failure.
`test/research-setup-audit-bundle.test.ts` proves setup-only export is portable,
closed, secret-free, movable, exact-file and semantically hash-bound; missing,
extra, tampered, symlinked, or invalid-attestation inputs fail closed without
rerunning setup work. It also covers an external expected-digest trust anchor,
JSON-escaped secrets, oversized files, closed proof schemas, and recomputed
internal hashes, concurrent file replacement, local-capability path removal,
and digest-only Doctor/static-header/credential-prefix fields. Readiness tests additionally
prove that one capability probe is reused, paid reviewer smoke is skipped after
a blocking prerequisite, Semantic Scholar throttling degrades only acquisition,
and an optional preprocessor becomes a hard gate only when its exact catalog ID
is required by the project.
`test/research-workspace.test.ts` also fixes the whole-tree traversal order to
NFC-normalized UTF-8 byte ordering so default ICU locale changes cannot alter a
capability or setup pin.
`test/research-runtime-production.test.ts` adds zero-cost
production evals for permanent evidence and review packets, exact HTTP policy,
byte/item/offset/estimated-token extraction bounds and raw-object cache reuse,
sanitized 429/422 handling, bounded broker-level 429 retry, structured-output and provenance repair,
audited deterministic Markdown newline-artifact normalization before independent review,
mechanically normalized dimension/full-text/publication-date coverage,
bounded local context with full-source review, stage tool isolation, runtime
target/wrapper/adapter fingerprinting and drift rejection, telemetry redaction,
owner-only whitelisted Claude settings authentication, production doctor
attestation creation, default-doctor reuse, current-runtime drift rejection,
packet-only review with exact local views and cited broker
items selected from hash-bound raw responses by admitted JSON Pointer,
persistent packet/context tamper rejection at closure, JSONL progress,
reviewer-driven synthesis reopening with a read-only prior-report archive,
append-only retry/fork recovery, and zero-target rollback after inherited-output
validation failure. `test/research-external-skills.test.ts`
validates the pinned external recommendation catalog, actionable missing-install
errors, owner-environment credential configuration without disclosure, custom
database Skill admission, whole-tree locks and staged manifests, static/live
provider checks, bounded 429 retry, authentication/rate-limit redaction,
exact endpoint staging and pre-fetch/redirect scope rejection,
distinct report/patent capability admission, broker-store versus provider-auth
diagnostics, bounded sanitized provider code/detail/request-ID retention,
source-to-installed-tree binding, refusal to bless drift through lock/configure/import,
internal-source rejection, invalid-definition errors, sensitive health-URL
rejection, and blocked catalog/doctor status for symlinked credential files.
Native-host regression coverage proves that ordinary `research run` never
invokes the producer executor, prepare/submit advances discover through
synthesize with hash-bound sessions and reserved accounting, native broker
fetches remain call-bounded and sanitized, and only the other-family reviewer
CLI is launched before mechanical closure.
The same native flow checks mode-specific prompt instructions across all four
producer stages: acquire permits only provisionally admitted-source retrieval,
later stages prohibit new evidence, and native submission files do not inherit
headless JSON-only or capsule-only directives. Its reviewer mock separately
requires the unchanged isolated, packet-read, no-broker and JSON-only boundary.
`test/research-policy.test.ts` and `test/research-policy-wizard.test.ts` cover
verified project-installed Policy source resolution, exhaustive bundled-template
parsing, mandatory top-journal invariants, default selection and human
completion, exact-journal requirements, explicit default acknowledgement,
content/manifest tamper detection, expiry, conflict resolution, and stage
binding. Setup doctor tests prove incompatible packs block before paid reviewer
smoke. `test/research-publication-workflow.test.ts` covers mechanical
top-journal assessment, owner-input trust ceilings, immutable manuscript
generations, required manuscript sections, complete distinct-file submission
roles, content/inference/analysis/Claim-Evidence Graph topology bindings,
reproducibility manifests, Policy/evidence/base-output hashes, four
role-specific review schemas, configured other-family producer/reviewer
separation, append-only reviewer-session reuse rejection, raw-session
non-persistence, active-base-research status, revision invalidation, package
status projection, and publication closure language ceilings.
`test/research-acquisition.test.ts` additionally covers honest acquisition
freeze with a separate inference stop, hash-checked input-backed artifact
materialization without bounded-context expansion, exact decomposition lineage,
evidence atoms, typed-content snapshots, target-bound content reconstruction on
recovery fork, inference snapshots, generated Claim-Evidence
Graphs, operator-visible `evidencePipeline` status, semantic audit-chain export,
safe journal-proof derivatives, and pre-export tamper rejection.
The recovery/forecast regressions additionally require read-only acquisition
forecasting, no atom-pass inference from source metadata, non-blocking sealed
outcomes in `limitations`, and exact Download binding reuse across repeated
discovery-resuming forks. Source scientific-design drift still rejects and
rolls back inheritance. `test/research-role-coverage.test.ts` checks shared
role deficits, flat-array all-of, combined allOf/anyOf/distinct-atLeast groups,
and exclusion of unrelated dimensions and duplicate source counts.
`test/research-scientific-design.test.ts` uses the EV pavement-model R9 failure
as a fixed regression for truth-role confusion, non-independent validation,
effective-sample inflation, quantity/threshold overclaim, closest-work
full-text gaps, unresolved blocking gaps, unfair baselines, and context-plan
overflow. Later EV review regressions cover retrievable raw-byte model and
environment bindings, implementation-versus-freeze status, Policy ownership of
pending model/environment/uncertainty objects, exact joint-state mappings,
continuous decision-consequence graphs, explicit factor/uncertainty
composition, and the rule that specification bytes do not establish
executability. `test/research-scientific-admission.test.ts` covers native producer
session hashing, immutable design admission, Policy/design identity, complete
lifecycle reservations, target-specific fork generations, and zero-write
rejection when top-journal recovery requests inheritance beyond acquire.
`test/research-scientific-objects.test.ts` covers the public pre-admission
scientific-object register/inspect flow, raw Python and lock-file promotion,
idempotency, exact media/object-kind packet metadata, symlink and control-store
source rejection, unsupported-media and host-path redaction, preflight gaps,
kind mismatch, immutable-blob drift at project admission, canonical parent
aliases, and Windows cross-volume containment classification.
`test/research-scientific-review.test.ts` covers the ordered research-design,
real-record evidence-construct, and pilot-methods gates; other-family/fresh
reviewer sessions; closed assessment/review schemas; mechanical precedence;
post-acquisition snapshot source/full-text/date binding; exact promoted canary
artifact binding; rejection of invented evidence IDs and unbound digests;
stage-time hash revalidation; machine-visible future obligations before their
due gate and blocking errors at that gate; and the invariant that 200,000
resamples of four independent structures still provide four independent
structures.
`test/research-audit-bundle.test.ts` covers exact portable export and independent
verification, formal evidence/artifact bytes, transformed input bindings,
environment and journal proofs, read-only content, tamper/extra-byte rejection,
and exclusion of credentials, active state, capsules, unrelated projects,
host-specific paths, and sensitive URL/authentication material.
It also runs native prepare-to-handoff export/verify and compares the source and
exported ledger bytes exactly. Credential regressions retain true session UUID,
prefixed API/password and OAuth secret checks, preserve JSON validity with escaped
quotes/backslashes, and reject Unicode-escaped keys, JSONL and nested credential
payloads without exempting whole events or UUID values.
Production tests additionally require an external
public-internet plan and block downstream work when any capability marked
`requiredForDiscovery` lacks a broker receipt. The failure distinguishes a
capability that was never exercised from one that was attempted but yielded no
admissible receipt, including only sanitized failure-kind metadata.

`test/research-evidence-ledger.test.ts` covers append-only ledger integrity,
cross-receipt canonical deduplication, bounded incremental discovery judgments,
compact closeout, and dynamic coverage-derived discovery budgets with early
stop and a hard ceiling. `test/research-acquisition.test.ts` covers native-lead
formalization, hashed native activity, exact download-event and concurrent-file
isolation, failed/cancelled non-commit behavior, sensitive locator redaction,
PDF/ZIP/OpenXML structure checks, false-PDF rejection, derived-artifact lineage,
parent URL inheritance and conflicting derivative URL rejection, binary-only
versus producer-readable full text, artifact drift, immutable
snapshot/delta lineage, and non-destructive addenda. Workspace/runtime tests
additionally verify default superseded-project filtering, authoritative fork
lineage, invalid authority for an uncommitted partial fork, archive/abandon
dispositions, durable user/external handoffs and
challenge gates, and closure rejection when any bound snapshot-chain object
drifts. `test/research-workspace-lock.test.ts` uses real child processes to
prove `SIGKILL` recovery, released single-file-lock migration, live-owner
refusal with sanitized actionable diagnostics, and owner-token-checked release;
the full setup suite also proves that setup initialization accepts only the
exact current lease artifacts while the lock is held.

Scientific route-exhaustion regressions additionally require exact route IDs on
broker, native-host, and download events; reject unbound or selector-mismatched
events; and verify project-scope plus hash-chain integrity before status. They
also reject optional agent routes for required roles, unmapped required
capabilities, and unavailable plan-bound broker capabilities. They
prove that completed-insufficient and explicit authentication/entitlement
blocks may close a route, while failed native work, login/MFA/CAPTCHA/security
challenges, HTTP 422, 429, 5xx, timeouts, and cancelled downloads remain
retry/user-intervention states. Structured handoff tests cover safe official
locators, sensitive URL/token redaction, exact terminal hashes, purchase and
external-request actions, empty-route scope pivots, durable status, and no
manifest/output promotion after a failed or cancelled acquisition.

Reviewer executor regression coverage verifies that a Codex reviewer receives
exactly one external-sandbox bypass flag and no nested `--sandbox read-only`
flag, while shell and unified-exec remain disabled. It also verifies the
capsule-local project-root marker/config override that prevents parent
project-config reads.
`test/research-review-bridge.test.ts` covers explicit no-fallback selection,
missing-sidecar errors, exact capsule copying, owner-only external key state,
signed request/result/policy bindings, model/version/signature drift, atomic
nonce replay rejection, a fixed no-command protocol, secret redaction, real
macOS/Linux negative probes, workspace doctor routing, and the long-running CLI
sidecar lifecycle. WorkBuddy native-host tests separately prove that the CLI
records the real producer identity, refuses to launch it as a child, removes the
single active-session binding after submit, and retains the completed capsule
with a non-sensitive journal disposition instead of requesting a recursive bulk
delete from the outer IDE. A full injected WorkBuddy package flow separately
proves that the reviewer/work-package capsule is retained with the same bounded
disposition while mechanical closure still completes.
Primary/repair reuse tests verify that an identical owner-only auth copy is
accepted idempotently while source drift is rejected without overwriting the
capsule file. Claude subscription regressions verify successful atomic refresh
writeback, concurrent owner-change refusal without overwrite, and retained
capsule disposition when reconciliation fails. The legacy lock regression
parses the exact recovery event before checking that PID data is absent, rather
than treating unrelated timestamp or digest digits as a leak.
Leaf-command help tests run from an unmanaged directory before workspace
resolution. A deterministic fake Codex emits a
90 KiB MCP result to prove the capture reservation includes bounded tool
context instead of failing at the historical 64 KiB floor. The retained
test-only injected-producer seam verifies legacy broker packet bounds without
being reachable from the public CLI; native runtime tests cover the public
prepare/fetch/submit protocol.
Preflight/runtime parity coverage verifies that the full bounded capability
documentation allowance is reserved for every possible broker turn and fits
the default discovery package before project admission.
Broker tests also prove that the configured view ceiling rejects an excess
request before another provider fetch while retaining a sanitized journal event
and the already admitted receipt. Project-cache reuse avoids a second provider
call but still consumes one bounded context-view reservation.

## Reporting Contract

`test/issue-reporting.test.ts` parses the YAML forms, checks stable core field
IDs and required flags, accepts uncertain ownership, exercises offline help,
and checks npm's pack file list for the contributor guide. It runs through
`npm test` and coverage in the normal and clean-container gates. When fields
change, compare labels/IDs/order/required flags with the Skills forms and its
installed Markdown templates under the shared workspace reporting policy.
Check an actual packed artifact before release and audit any changed Skill pin
only after its source commit is merged.

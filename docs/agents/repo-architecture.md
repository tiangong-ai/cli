---
docType: architecture
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When deciding where Tiangong AI CLI command behavior, wrappers, or API boundaries belong."
whenToUpdate: "When command families, runtime layers, environment contracts, or skill handoff boundaries change."
checkPaths:
  - AGENTS.md
  - README.md
  - src/**
  - bin/**
lastReviewedAt: 2026-09-05
lastReviewedCommit: 16b436927ca80ae58b2fefc5c47bdf21f850827d
---

# Repo Architecture

## Ownership

This repository owns the public `tiangong-ai` command-line interface for Tiangong
AI automation.

The CLI owns local operator behavior such as command parsing, filesystem
intake, SQLite checkpoint files, retries, concurrency, and structured output.
Backend services own authorization, collection permission checks, dedupe,
storage writes, queueing, and document status transitions.

## Current Runtime Shape

- `bin/tiangong-ai.js`: stable executable launcher.
- `src/main.ts`: process entrypoint.
- `src/cli.ts`: command dispatch, KB ingest/status orchestration, bulk scan,
  metadata dry-run, SQLite checkpointing, and sliding-window bulk runner.
- `src/args.ts`, `src/data.ts`, `src/env.ts`, `src/errors.ts`, `src/http.ts`,
  and `src/io.ts`: shared CLI primitives for argument parsing, JSON envelope
  parsing, environment loading, structured error payloads, bearer-token JSON
  HTTP requests, edge-function `postJson`, JSON file input, JSON output, and
  process IO.
- `src/kb/**`: KB API boundary modules for config resolution, collection
  selection/list/resolve, document status polling, and pipeline health checks.
- `src/research/commands.ts` and `src/research/config.ts`: the public research
  command router and edge-search source configuration.
- `src/research/orchestration.ts` and `src/research/setup-command.ts`: strict
  parsing for setup, context, workspace, capability, project, status, and run
  commands. Bare `research setup` first checks the fixed workspace-local
  declarative file and otherwise enters the interactive TTY Wizard; explicit
  `setup wizard` always chooses the human path. The remaining setup actions are
  deterministic automation surfaces. Wizard presentation is semantic and
  TTY-aware, with plain output for `NO_COLOR`, dumb terminals, and JSON mode;
  styling never changes plan or command contracts.
- `src/research/workspace/setup-audit-bundle.ts`: setup-only portable audit
  export and offline verification before project initialization. It emits a
  closed allowlist of path-free control-plane projections, binds each exact
  file and its semantic relationship to the manifest, and excludes credential
  stores, source/install trees, native state, provider output, and unrelated
  workspace bytes. Local locators, static-header values, credential prefixes,
  and free-form Doctor fields are digest-only. Verification derives hashes,
  portability checks, and semantics from one stable bounded byte snapshot per
  file and rejects concurrent tree drift. Export is atomic and does not rerun Doctor or perform
  network/model work. Offline verification requires the manifest SHA-256
  returned through the trusted export result; an internally stored digest alone
  proves only self-consistency and is never treated as a provenance anchor.
- `src/research/workspace/setup-declarative.ts`: closed-schema YAML intake,
  no-overwrite example generation, fixed-path discovery, owner-only literal env
  intake, semantic configuration hashing, immutable-plan binding/reuse, and
  mandatory full readiness execution. The declaration materializes every
  current catalog Skill, credential, and setting with exact catalog metadata
  plus an explicit enabled/disabled state. The env example likewise exposes
  every credential name with an empty placeholder; disabled non-empty values
  are rejected rather than selected implicitly. It carries only enabled,
  non-secret plan inputs into the existing setup/apply/doctor implementation
  rather than defining a second setup protocol. Only declaration schema v2 is
  accepted; the removed v1 shape has no migration path. Parent-directory scanning,
  shell expansion, omitted optional catalog entries, YAML aliases, secret
  persistence in plans, implicit replacement, and Wizard fallback after a
  declaration error are forbidden.
- `src/research/workspace/setup-instructions.ts`: project-only native-host
  routing installation. It owns one bounded Codex `AGENTS.md` block and one
  dedicated Claude Code rule file, records content ownership under the setup
  control directory, preserves unrelated owner bytes, rejects links and
  conflicts before mutation, removes only verified owned content, and reports
  new-session activation separately from structural installation.
- `src/research/workspace/platform-capabilities.ts`: pure cross-platform path
  relation and research execution capability contracts. It models Windows
  separators, drive/case behavior, macOS `/var` aliases, native isolation
  providers, production readiness, and reviewer-sidecar eligibility without
  depending on the current host OS. Windows and unknown platforms remain
  configuration/smoke-only until an approved native capsule provider exists.
- `src/research/workspace/**`: the versioned research workspace protocol. It
  owns context classification, immutable input admission, capability policy
  locks, heartbeat-backed setup/workspace mutation leases with same-host
  dead-process recovery, delayed unknown-host expiry, owner-token-checked
  release, safe legacy-file-lock migration, and path-free append-only recovery
  events, a separately sourced external Skill ecosystem catalog, immutable setup
  plans/state/history, reproducible detached source checkout with fixed Git
  line-ending behavior, locale-independent whole-tree hashing, and exact-copy
  installation, custom external capability admission,
  hidden-TTY, bounded-stdin, and owner-environment-to-logical-credential
  configuration with pre-download owner-only persistence, static/live provider
  diagnostics, explicit orchestrator installation, replacement-time
  setup-managed capability/credential reconciliation, role-constrained
  document/paper companions, required-discovery
  receipt gates with distinct never-attempted/attempted-without-evidence
  diagnostics, bounded local-input plans, a scoped HTTPS GET/JSON-POST MCP
  broker with inline bounded result contexts,
  one bounded short-delay 429 retry with sanitized journal provenance,
  a coverage-derived working broker-view budget under a reviewed workspace
  ceiling, content-addressed permanent evidence, paged broker views/cache,
  a hash-chained candidate/admission/artifact/claim/review ledger,
  deterministic candidate deduplication and a supplemental native Web bridge,
  coverage-derived discovery call planning with early stop and a hard ceiling,
  append-only incremental candidate assessment with a compact discovery
  closeout, native Web/Browser activity receipts whose sensitive inputs are
  retained only by hash, exact download-event binding, and explicit exact-file
  artifact registration with PDF/ZIP/OpenXML validation,
  acquisition audits that freeze both success and honest gaps,
  read-only pre-acquisition forecasts using the indexed typed-content role
  evaluator and source-type constraints shared with scientific review, explicit
  all-of/any-of/distinct-at-least groups without a recursive expression language,
  immutable parent/delta evidence snapshots, automatic hash-checked input-backed artifact
  materialization for readable local inputs, exact-lineage artifact decomposition,
  line-range/JSON-Pointer evidence atoms, typed-content coverage snapshots,
  bounded atomic content-registration batches with one operation-local verified
  acquisition/artifact view, one parsed artifact retained at a time, and immutable
  envelopes made visible only by a hash-bound ledger commit; single and batch
  records share validation and idempotency rules. Artifact intake has a separate
  per-file byte limit from aggregate stage outputs and an offline metadata-only
  preflight; large unsupported files stop with provider-subsetting guidance,
  separate inference-stop gates, immutable inference snapshots, schema-v2
  reproducible analysis runs, and mechanically generated Claim-Evidence Graphs,
  addendum supersession, reviewer-driven synthesis revisions with immutable
  prior-report archives, rollback-protected recovery forks that re-sign typed
  content for the target, commit-marker-based rejection of partial forks, one
  authoritative project lineage with explicit archive/abandon dispositions,
  and default historical-project filtering,
  hash-bound native-host producer stage prepare/submit/abort, one-shot native
  broker fetches, schema-driven reviewer output and isolated repair, dedicated
  reviewer capsule homes,
  pre-review deterministic Markdown newline-artifact normalization with
  content-free journal provenance,
  hash-verified idempotent capsule-auth reuse across primary/repair calls,
  owner-hash-bound atomic reconciliation for refreshed Claude subscription
  credentials with concurrent-change refusal and retained-capsule recovery,
  separately fingerprinted reviewer targets/wrappers/adapters, hash-bound
  reviewer doctor attestations with expiry-aware reuse and live runtime-drift
  verification,
  complete pre-call package and tool-context reservations,
  one shared preflight/runtime reservation formula with bounded capability
  documentation included at admission,
  mode-specific budgets with low-cost smoke defaults and deliberately generous
  but finite production runaway ceilings,
  stdin-delivered agent prompts that are independent of host argv limits,
  tool-context-aware process capture, classified retries,
  incremental Codex JSONL compaction of duplicated packet-only MCP payloads
  without trimming model-visible evidence or final answers,
  project-scoped scheduling/exit status, durable user-action and
  external-response handoffs, JSONL progress, recovery events, exact
  companion readiness gates, domain-scoped setup readiness, persistent review
  packets/initial evidence excerpts with exact cited-item JSON-Pointer
  projections, packet-only independent artifact reads, and
  mechanical closure-time hash verification. For `top-journal` goals it also
  owns the project-installed Policy-source resolver, whole-pack Policy parsing
  across every template category before catalog use, generic Policy catalog and
  guided human completion, content/manifest approval hashes and expiry gates.
  Setup doctor rejects an incompatible pinned Policy pack before provider live
  checks or reviewer smoke. Scientific-design, ordered early-review, and
  real-record construct-canary constraints are mandatory top-journal invariants
  that must resolve true; they are not optional runtime switches. It also owns
  a native-authored closed scientific-design contract with mechanical semantic
  validation, a workspace-scoped content-addressed scientific-object registry
  for external regular non-symlink UTF-8 model implementations and environment
  locks, deterministic path-free records, admission/preflight revalidation,
  exact project-local review-packet blob promotion, raw-byte model/environment
  object bindings, executable-versus-
  pending freeze states, exact joint uncertainty state mappings, continuous
  decision-consequence graphs, Policy-owned future-gate obligations, exact
  Policy/design/session bindings, three ordered independent scientific review
  gates at discovery and post-acquisition analysis boundaries,
  frozen-snapshot source/full-text/date revalidation, exact promoted
  real-record construct-canary artifacts, pilot-methods invariants, complete-lifecycle
  review/revision reservations, and target-specific reapproval for every
  authoritative fork or addendum generation,
  mechanical publication assessment, required manuscript sections, explicit
  role-complete submission-file manifests, immutable final-manuscript
  generations that bind content/inference/graph/reproducibility objects,
  append-only fresh-session and configured other-agent-family enforcement
  across four independent reviewer roles, hash-only persistence for
  producer/reviewer session identifiers, and a separate publication closure
  whose language cannot exceed the approved Policy ceiling. It can export and
  independently verify an immutable portable audit directory only after
  semantically revalidating the acquisition/content/inference/graph/publication
  chain. The manifest names that chain alongside exact project inputs,
  evidence/artifact bytes, Policy/design/review objects, environment
  fingerprints, and sanitized hash-preserving journal proofs,
  while excluding credentials, ephemeral/native state, unrelated projects, and
  host paths. Portable text screening preserves field-name boundaries for native
  identifiers and inspects decoded JSON/JSONL keys and values without rewriting
  evidence. Per-file key classification is cached; nested credential arrays or
  objects retain their sensitive-key context. Top-level status exposes the acquisition, typed-content,
  inference, and graph chain and distinguishes active base research from
  invalid scientific or publication state.
- `src/education/**`: education search command handling and source specs for
  course, education, and textbook edge-search functions.
- `src/edge-search.ts`: shared edge-search forwarding helper. It derives
  Supabase Functions base URLs from project root, `/functions/v1`, or
  `/rest/v1` inputs; builds exact POST request plans with `Content-Type`,
  region, input path, and timeout milliseconds; masks credentials for dry-runs;
  and returns raw edge responses without normalizing them.
- `src/data/**`: the versioned atomic data machine boundary. It owns the
  immutable registry, public JSON Schemas, canonical digest and receipt rules,
  strict command router, logical credential resolution, bounded HTTPS client,
  stable error taxonomy, and connector execution/conformance contracts. Its
  built-in registry currently ships seventeen independently discoverable
  capabilities on the same runtime: AirNow hourly observations, public Bluesky
  post cascades, EPA EIS records, Federal Register document metadata, four GDELT
  DOC/table surfaces, NASA FIRMS active-fire detections, three Open-Meteo series,
  OpenAQ location and sensor measurements, two USBR data surfaces, USGS Water
  instantaneous values, and YouTube public video/comment metadata. The
  Regulations.gov source definitions remain compiled and fixture-tested but are
  excluded from the built-in registry until production search/detail and
  attachment live gates pass. The three
  GDELT table capabilities share one bounded ZIP/feed core without collapsing
  their separate discovery and binding identities; the two YouTube operations
  share one provider and credential contract without merging video discovery
  with explicit-ID comment retrieval. Structural expansion from compressed
  provider bytes into closed named-field JSON remains part of the validated
  connector result; Research stores that result as Evidence and independently
  projects a bounded Agent context view.
- `src/research/workspace/data-evidence-adapter.ts`: dynamically projects every
  built-in data operation into the native Research discovery packet, invokes
  the shared TypeScript data service in-process, constructs its provider
  credential environment exclusively from the owner-only Research store,
  applies call, Evidence-package, shape-aware context, coverage, receipt,
  ledger, and audit bindings, and never inherits host provider credentials,
  silently lowers connector acquisition limits, or introduces
  provider-specific Research adapters.
- `scripts/**`: validation helpers.
- `test/**`: Node test runner suites.

## Atomic Data Runtime

The foundational `tiangong-ai data ...` family is implemented under
`src/data/**` and designed in
`docs/agents/data-runtime-architecture.md`; its ordered delivery and cross-repo
dependencies are in `docs/agents/data-runtime-implementation-plan.md`.
`catalog`, `describe`, and static `doctor` are offline; only explicit
`doctor --live` and `run` may call a provider. `data` routing occurs before the
legacy cwd dotenv loader, so credentials come only from the exact environment
variables declared by a manifest.

The CLI owns built-in execution manifests, discovery metadata, closed
input/output schemas, bounded HTTP and credential handling, stable errors,
canonical digests, and core execution receipts under `src/data/**`. Public
contract schemas are emitted under `dist/data/schemas/`; operation schemas
compile with their connector and are exposed by offline `data describe`.
Execution manifests cover versions, endpoints, credentials, limits and schema
bindings. Discovery metadata separately covers the external source, coverage,
granularity, selection guidance, license, freshness and limitations, so prose
changes do not invalidate execution bindings. A standalone data operation
remains independent of Research project/stage state. Research will reuse the
same TypeScript service through one explicit adapter and will continue to own
evidence admission, budgets, journals, persistence, and review.

Skills will remain semantic entrypoints and exact compatibility bindings. They
must not duplicate connector execution or machine schemas. The implementation
baseline is Node 24 with the native TypeScript 7.0.2 compiler; that toolchain
gate is complete before data business logic begins.

The first connector pair deliberately exercises different atomic shapes.
AirNow plans one official hourly file per UTC hour and isolates missing or
invalid files while retaining file lineage. Federal Register builds stable,
bounded query parameters and paginates metadata without retrieving linked
content. Neither connector imports the other, performs interpretation, or
writes Research state.

## Bulk Ingest Boundary

Ingest state is local operator state. The CLI stores job and file checkpoints
in SQLite under the OS app-data directory by default, or an explicit `--state`
path. Compatibility upload aliases route through the bulk runner rather than a
separate checkpoint format.

The CLI may call external bearer-token API routes for collection resolution,
schema snapshots, uploads, and document status polling. The backend remains the
source of truth for authorization, dedupe, pipeline state transitions, and
indexing results.

Bulk derived files are generated lazily as local operator artifacts. Initial
bulk setup only scans, fingerprints, runs lightweight preflight, and writes
SQLite state. When a row enters the upload window, `.docx` files larger than
10MiB are uploaded through 300dpi-normalized ingest copies, while oversized PDFs
are split into the fewest uploadable PDF parts. The default
`.tiangong-kb-ingest-derived` directory is excluded from later bulk scans. DOCX
copies preserve the original logical path for metadata-map evaluation, PDF split
parts preserve the original logical parent directory, and split/normalize
lineage stays in SQLite/export state instead of being uploaded as default KB
metadata. Empty `.docx` files with no body text and no media are marked skipped
before upload.
Bulk polling sends the resolved collection selector to `pipeline/health` so the
backend can scope index preflight/backpressure to the target collection's
search partition rather than unrelated active partitions. Upload-scoped callers
may receive a redacted health payload containing only `healthy`, `pressure`,
`recommendedAction`, `recommendedPollAfterSeconds`, `checkedAt`, and an
optional coarse `reason`; the CLI must not depend on admin-only queue or worker
details. Status polling and upload-window top-up keep their 30-second default
loop. Pipeline health is cached separately and refreshed every 60 seconds by
default; explicit CLI or environment overrides still win, and degraded/paused
server recommendations may lengthen only the health refresh interval.

## Skill Boundary

Reusable skills may call this CLI as a deterministic control plane. Skills
collect task intent, select smoke or production mode, prepare evidence
requirements, obtain budget confirmation, and direct the current interactive
Codex or Claude Code host through hash-bound producer packets. They do not
launch a nested producer CLI or duplicate output schemas, coverage gates,
workspace state transitions, capability admission, scheduling, budgets,
provenance, review, closure, API request construction, retries, or checkpoint
semantics.

Research method implementations are external Skills. Setup may copy only
user-selected, separately licensed trees after freezing the installer integrity,
source commit, whole-tree SHA-256, exact destination, settings, credential
variable names, and declared mutations. It never installs a Skill from a
research package, resolves system/Python dependencies, silently updates a pin,
or overwrites drift.

The recommended `tiangong-auto-research` tree is an external orchestrator role,
not an evidence capability. Wizard selection is explicit and project-local by
default. Evidence defaults to Brave web/news; context and media profiles remain
subscription-dependent choices. A replacement removes only deselected
setup-managed declarations/credentials, preserves custom capabilities, and
never removes installed Skill directories. The Catalog marks the orchestrator
with a `workspace-lock` runtime contract and marks direct SCI/report/patent
wrappers only with their separate `standaloneTestedCliVersion`. Setup verifies
the bundled resolver and forbids stale exact CLI literals in orchestrator
instructions before installation.

For project-scoped orchestrator installation, the immutable plan also declares
exact host instruction mutations. Codex routing is a marker-bounded block in
the workspace-root `AGENTS.md`; Claude routing is an owned file under
`.claude/rules/`. Setup never assumes a WorkBuddy/CodeBuddy private instruction
format: those hosts retain the separately installed thin adapter Skill. Global
Skill scope does not write project instruction files.

The CLI may generate a separate project-local recovery-only Skill after an
accepted apply has stored credentials but before external checkout. It contains
only exact-version context/status recovery instructions bound to the immutable
plan, never producer or evidence logic. It closes the partial-install routing
gap and is removed only after byte verification once the selected external
orchestrator is installed. Setup status/doctor also report the effective CLI,
project Skill, temporary recovery Skill, ignored global conflicts, and legacy
unmanaged PATH fallbacks.

Brokered evidence Skills document allowlisted GET or bounded JSON POST APIs;
credentials remain in an owner-only logical map and are injected only by the
broker. POST request bodies reject credential-like fields, persist only their
hash outside the evidence object, and cannot redirect. A selected production
profile must include an independent public-internet capability. The reviewed
broker response screen requires explicit authentication headers, sensitive
fields, or exact configured secrets; ordinary academic prose containing words
such as `Basic` or `Bearer` is not an authentication signal without that
context. The reviewed
Tiangong SCI, report, and patent adapters are optional, distinct
owner-whitelisted databases and cannot satisfy that public-internet gate or
substitute for one another; arbitrary owner databases still require an explicit
external definition. Project evidence requirements may bind exact capability
IDs and discovery scopes, which preflight reports as structured, actionable
coverage gaps when absent.

Document decomposition is an input-preprocessor and paper download is an
acquisition adapter. Their explicit companion command verifies the installed
tree, builds a minimal child environment, and returns hash-bound output for
later input admission; neither executes inside an agent capsule or becomes
evidence by itself. The paper adapter is entered only through its verified
`runtime.py` lock for both execution and setup doctor; ambient `fetch.py` and
ambient `pypdf` execution are not valid control-plane paths. Authoring Skills
run only after closure. DOCX, PDF, PPTX, and XLSX readiness resolves one
Python/Node runtime, probes the complete selected dependency/command matrix,
and runs isolated exact-file functional canaries through the pinned Skill
helpers, including PDF image conversion/validation and both PPTX/XLSX
MarkItDown conversion. A missing prerequisite or failed canary blocks that authoring
component without blocking research core; setup never installs dependencies.
Optional companion
failures are domain-scoped diagnostics unless a project's
`requiredCompanionIds` (or the explicit operation itself) names that exact
component. Semantic Scholar resolver throttling therefore degrades acquisition
without globally blocking research. Source
commit/version and expected whole-tree SHA-256 must match before any role is
configured or executed. The tree-hash contract rejects symlinks and
canonically equivalent path collisions, normalizes logical paths to NFC, and
orders directory entries by UTF-8 bytes rather than locale collation. New Git
source caches set repository-local `core.autocrlf=false` and `core.eol=lf`
before materializing the detached commit. Apply also gives all nested npm
installer processes one owner-only, operation-scoped cache under the OS
temporary directory and removes it on every exit path; it neither depends on
an executable HOME nor admits the caller's mutable npm cache. Hash failures
stop before installer execution and expose only sanitized, non-secret
identifiers and digests.

The current interactive host is the producer boundary: the CLI prepares an
ephemeral hash-bound packet but does not start Codex or Claude for discover,
acquire, analyze, or synthesize. Prompt generation receives an explicit native or
headless execution mode. Native packets authorize a new JSON submission file and
acquire-only retrieval of provisionally admitted sources; they do not describe
the host as an isolated reviewer capsule. Later-stage evidence restrictions and
headless JSON-only/read-only capsule instructions remain unchanged.
Discovery uses explicit one-shot broker
commands whose request files contain logical IDs only. It records candidate
judgments in bounded append-only batches instead of returning a source-sized
JSON document. Native Web/Browser discovery remains visible as hashed activity
and supplemental candidates; the same URL or DOI must be formalized through
the broker before admission. Acquisition binds a completed network download to
the exact selected file and download event before artifact registration,
requires derived text to name its parent artifact, and lets that derivative
inherit only the parent's canonical source URL instead of fabricating a second
download binding; a conflicting URL is rejected. Acquisition then produces a
complete source audit and verified immutable snapshot even when its separate
inference gate stops on honest gaps. Every acquired binary/data artifact is
then dispositioned through an exact decomposition record; producer-readable
derivatives support line-range or JSON-Pointer atoms whose source, artifact,
role, dimension, scope, and limitations are hash-bound in a typed-content
snapshot. The top-journal evidence-construct canary runs against those frozen
objects, binds its exact external JSON artifact bytes without retaining host
paths, and rejects invented source IDs, unbound atoms, or asserted
full-text/date states before the methods pilot. Only passing acquisition,
content, construct, and pilot gates create the immutable inference snapshot.
Analysis v2 binds one reproducible run plus exact source/atom/design-claim IDs;
the CLI generates the Claim-Evidence Graph mechanically before synthesis. Later
producer packets contain bounded, hash-verified prior artifacts. The platform
`sandbox-exec`/Bubblewrap capsule is used for the independently launched
reviewer CLI; that adapter disables shell, unified-exec, filesystem, and
undeclared integrations.

For accepted local full-text sources, acquisition materialization verifies the
admitted input hash and creates an idempotent artifact identity before the
acquire package closes. Producer-readable inputs can therefore be atomized
without a second manual copy. Binary inputs remain non-readable and stop acquire
until the decision also binds a valid readable derivative. Input-backed
artifacts do not expand an input plan's bounded prompt context; exact bytes stay
available to the artifact, atom, packet, and audit validators.

An independent-review revision can reopen a completed synthesis package only
through the explicit retry command and only while the review package records the
mechanical revision-required failure. The current report remains in place until
the replacement submit commits, and its prior bytes are preserved in a
content-addressed read-only revision archive.

Recovery forks validate top-journal resume limits before target creation, clone
and re-register decomposition/atom records against the target acquisition, and
freeze a new target-bound content snapshot. Top-journal recovery stops at
acquire so the new Policy/design generation can complete its own scientific
reviews. `project-authority.ts` builds one verified journal index shared by
status, run and native/reviewer admission. Successor resolution is memoized only
inside that operation-local view, making long-history enumeration linear
without a persistent cache or artifact rescan.

`project-mutations.ts` is limited to fork, package retry, pre-analysis acquisition
revision, and task-scope approval metadata, not a general workflow engine.
A journal-bound pending intent precedes fork target
creation; all target bytes precede the `project.forked` commit point. Source
state and supersession ledger records are idempotent post-commit projections.
Before commit, recovery retains interrupted target bytes outside the project
namespace; after commit, it completes only projections whose before/after
digests still match. Retry archives remain immutable and their state follows a
`project.retry.requested` commit. Replaying a committed fork or an unchanged
retry acknowledgement performs no provider work. Recovery runs under the
existing workspace lease and has only a constant-size absent-directory check
on the ordinary path. Unknown/symlinked targets, changed state, malformed
records and corrupt journals fail closed without deleting their bytes.
This handles process interruption at filesystem operation boundaries, not
physical power-loss repair. Existing uncommitted derived states cannot execute;
never-committed directories without state are not formal projects.

`acquisition-revision.ts` reopens an idle authoritative project at acquire,
optionally at discover through an explicit flag, before analysis or inference.
It binds the parent snapshot and request hash, keeps immutable evidence/acquisition
record bytes and old snapshots, reuses artifacts/receipts and spent budgets, and
preserves unchanged Policy/design/research-design review. Only post-acquisition
scientific gates reset. Decomposition revisions are explicit descendant-snapshot
chains shared by single/batch registration; superseded artifact atoms do not count
toward current coverage. No operation silently searches, downloads, migrates old
mutable snapshots, or changes the scientific contract. Forecast exposes the same
deterministic submit blockers without turning potential coverage into acceptance.

`task-contract.ts`, `task-acceptance.ts`, and `task-audit.ts` reuse the verified
journal, immutable objects, evidence IDs and existing reviewer pipeline. The
original request and small versioned requirement set are recorded before execution
or review. Scope changes require separate exact-hash operator confirmation and
reset scoped scientific approvals; this is not authenticated human identity.
Acceptance observations bind requirement/source/atom/finding/result versions and
store declared commands by hash; acceptance intake never executes them. Positive and supported
negative outcomes need review; failed, stale, unrun, withdrawn and unanswered
requirements remain distinct. The existing review uses a dynamic taskAssessment
schema, one unique result object per context, and no extra paid round. Missing
checks stop before a call; finite runaway budgets remain without a total
context-length admission gate. Request provenance distinguishes exact source
wording, interpretation, reconstruction and unrecorded origin. Original source
bytes and hashed locators survive scope/fork/audit; supplied transcripts are not
authenticated authorship.
Scientific/publication packets carry the current task binding.
Scientific review stages the request-source bytes as well as the declared origin.
The packet MCP surface has only the two closed read tools. Codex additionally
disables supported I/O features and rejects reported non-packet I/O tool use;
this is not a claim that its runtime has no built-in utility tools. Finite time
and token/cost guards remain; only Claude exposes the configured provider turn cap.

Status/run derive
original/current scope completion independently of workflow/publication state;
there is no mutable acceptance cache. Portable audit shares relationship validation
and uses an operation-local file/JSON index after the original workspace is gone.
It verifies integrity, not execution, authorship, or scientific truth. Absent-task
projects have a cheap unassessed path; there is no retrospective completion.

`scientific-fulfillment.ts` projects append-only, journal-committed fulfillment
records over exact immutable base design bytes. Only predeclared pending model,
environment and source-bound parameter slots can change; assumptions, identities,
units, state sets and Policy are not patches. Idle pre-analysis admission reuses
the narrow project-mutation recovery journal. The due gate and later approvals
are reset; deadline-specific views preserve unaffected earlier reviews. Both
scientific review and acquisition route resolution load that verified view.
Model registration and frozen typed-content atoms remain the source authorities.
`scientific-fulfillment-audit.ts` checks the same slot transitions, raw objects,
registration hashes and committed head using portable indexed files. It does not
turn an object-filing obligation into independent scientific approval.

`analysis-run.ts` centralizes mode consistency for both stage submission and
publication freeze. Qualitative records retain `not-applicable` computational
status rather than inventing a run; computational/mixed records retain exact
reproduced metadata. Neither mode bypasses scientific, evidence, graph or
independent-review validation, and this predicate is not a trusted execution
receipt. Acquisition forecast reuses the artifact media predicate and already
verified input hashes, so local binaries without readable text are not counted
as atom-eligible merely because an admitted full file exists.

`native-run.ts` observes one explicitly requested ordinary Node/Python calculation,
not an AI producer or workflow. It snapshots exact program/frozen input bytes,
plans outputs, releases the workspace lease during the process, and commits a
requirement-bound start/result with stable-input and exit/output checks. Runtime
fingerprints are observed; dependency locks remain declarations, not hermetic
attestation. Failed/incomplete runs cannot grant positive acceptance; identical
committed replay does not execute again. Packets and task audit retain the exact
program, lock, inputs, outputs and event relationships. Unobserved computational
reports remain `unverified-execution`; evidence/proof checks are not forced to run.

`artifact-read-audit.ts` validates persisted read directories, intrinsic receipt
identity, packet/delivery authority and exact byte selectors. It groups pages by
object so full bytes and UTF-8 validity are loaded once per object during this
verification, and reports undeclared interrupted receipts separately from
journal-verified delivery. Live review loading also revalidates the persistent
artifact index before trusting it.

`scientific-review-execution.ts` executes an already prepared early review
through the same reviewer abstraction. It reserves finite token/cost/wall
budgets before invocation, stages exact packet and Policy prose, and records an
immutable output/receipt before atomic idempotent submission. Receipt replay
revalidates canonical upstream and review bytes without another model call;
pending recovered submission also rechecks project authority and production
Policy/readiness. Missing provider usage does not erase a consumed reservation.
Failed processes expose a bounded sanitized diagnostic and exit code in the
structured error and failed journal event without persisting the full prompt.
`schema-compatibility.ts` shares Claude Code's dialect-annotation adapter between
manual schema export and automatic reviewer invocation. Canonical controller
schemas and their strict output checks are unchanged.
The projection also states scalar types already implied by `const`/`enum`, so
numeric constants do not become string parameters in Claude's output tool.
Claude result normalization prefers `structured_output` over narrative `result`
and retains declared error subtypes/messages as sanitized telemetry. An error
envelope cannot become successful merely because its process exits zero.

Reviewer transport is separate from producer host and reviewer model identity.
`artifact-views.ts` owns immutable packet directories, opaque object selection,
UTF-8/base64 byte views, exact delivery receipts and once-per-selected-object
verification for adjacent pages. `artifact-view-mcp.ts` exposes only directory
listing and reading on an ephemeral loopback endpoint with Host/Origin checks.
It returns the complete bytes and receipt in one text result, without a
metadata-only structured alternative that a client could prefer and hide text.
No total corpus or requested-read length gate is added. Initial embedding targets
choose inline content versus a retrievable reference; they do not drop artifacts.
Reviewer invocation carries the exact index/packet binding, disables unrestricted
tools, and keeps finite turn/time/cost guards separate from approximate planning
estimates. Only read objects are additionally preserved, rather than copying the
entire corpus into another evidence store. These receipts prove delivery, not
comprehension or scientific correctness.

`native-direct` invokes the platform capsule in-process. `sandbox-bridge` uses
an owner-only local connection record and short Unix socket to an exact-version
sidecar outside an outer IDE sandbox. The sidecar keeps its Ed25519 private key
and atomic nonce claims in an explicit non-symlink directory outside the
workspace, copies only the hash-bound project capsule into private state, runs
the same native executor, and returns a signed result attestation. The protocol
has only execute/fingerprint/status actions, never accepts environment secrets
or arbitrary commands, runs filesystem negative probes before READY, and does
not fall back between transports. WorkBuddy/CodeBuddy may be recorded as native
producer hosts, but remain forbidden child executors; the reviewer stays Codex
or Claude.

Reviewer status selects the configured transport without running a paid smoke.
Native smoke configuration readiness is labeled separately from production
attestation readiness. Project loaders and Doctor share one closed project
status enum; run/status use one due scientific-gate projection so later gates
do not stop earlier stages and stopped gates never invite a producer call.

Capsule release is host-aware. Codex/Claude stages and work packages normally
remove their capsules after the immutable output and journal event commit. A
failed Claude subscription-credential reconciliation instead fails the package
and retains the capsule with `retained-auth-reconciliation`, so refreshed bytes
are not destroyed before the owner resolves a concurrent source change or local
replacement failure.
WorkBuddy/CodeBuddy stages remove only the active binding, and every native or
reviewer/work-package capsule is retained with a bounded ID and
`retained-outer-sandbox` journal disposition, because an outer IDE may intercept
recursive deletion as a privileged bulk operation. Retention never changes
package completion, makes the capsule active again, or weakens the reviewer
isolation boundary.

Final manuscript authoring follows the same native-host boundary. The CLI
validates required manuscript sections and a distinct-file submission manifest,
then freezes the native artifact, required cover/title/checklist/availability/
source-data files, inference chain, Claim-Evidence Graph, and reproducibility
manifest; it does not author them or launch a nested producer. The base research
reviewer remains a CLI-isolated other-family reviewer. Every one of the four
role-specific final reviewers must use that configured family, a fresh session,
and the same frozen generation. Base closure and publication closure are
distinct objects and neither implies journal acceptance.

Top-journal scientific reasoning follows that same boundary. The current native
host authors the design and the three bounded gate assessments. The CLI rejects
semantic impossibilities, freezes exact objects, prepares hash-bound packets,
launches only the configured independent reviewer family, and mechanically
revalidates every passed gate at each downstream runtime boundary. A reviewer
cannot promote failed mechanics with prose, and a superseding generation must
provide a new target-specific Policy, design, and producer session.

A model/artifact digest establishes byte identity only. The design separately
declares implementation and environment-lock status, retrievable locators,
entrypoints, raw-file hash semantics, and the exact gate by which every pending
object must be replaced. The same contract applies to source-derived
uncertainty states and exact joint-state mappings. Earlier review packets expose
these as Policy-owned future obligations; the due gate converts them into
mechanical blockers unless a new authoritative generation freezes replacements.
Packet logical identity and raw exported file identity remain distinct, with
the latter carried by the portable audit manifest.

When a producer reaches login, MFA, CAPTCHA, paywall, authorization, or another
human-only boundary, it records the activity and requests a durable
`user-action-required` handoff. When a material gap requires an institution or
other third party to respond, it requests `external-response-required` and
stops substitute searching. Resolution is an explicit journaled operation;
neither state consumes another producer attempt while waiting.

A top-journal scientific design freezes a closed acquisition plan before
discovery. Broker, native-host activity, and download events must bind one exact
agent route ID whose class and selector match the event. The access-status
projection verifies the workspace and per-project evidence journals, filters by
exact project scope, and returns terminal event hashes for each route. Success
and explicit authentication/entitlement denial may close a route; malformed or
misconfigured requests, 422, transient/network/rate-limit failures, cancelled
downloads, and interactive challenges may not.

Access status never infers an evidence gap from route completion alone. After
all agent routes are terminal it requires an evidence-role coverage assessment
and exposes purchase/handoff or scope-pivot only as the conditional
`ifEvidenceStillInsufficient` action.

Preflight rejects any agent route for a required evidence role that is marked
optional, any required capability that lacks a required broker-route mapping,
and any plan-bound broker capability absent from the verified current lock.

An `evidence-exhausted` handoff is a schema-v2, append-only stop record, not a
retry hint. It is admitted only when every required agent route relevant to the
cited missing required evidence roles is proven by exact terminal hashes. Its
remaining reviewed non-agent routes become structured, sanitized access
requests for purchase/subscription, institutional access, licensed data, owner
input, external requests, or field collection. With no remaining lawful route,
the only valid user action is a reviewed scope/claim pivot. Project status keeps
the structured exhaustion proof and suppresses further substitute work until
explicit resolution.

Every brokered manifest entry carries a locked non-secret HTTPS endpoint;
initial targets and GET redirects are checked against that endpoint scope
before a provider request.
Broker diagnostics keep standalone ambient credentials, broker logical
credentials, injection policy, and provider authentication as separate failure
classes. They expose only execution mode, credential scope, network-attempt
state, safe request metadata, and minimum action. Setup doctor performs one
bounded Semantic Scholar 429 retry and reports a remaining throttle in
acquisition readiness without changing research-core readiness; no managed
research path silently downgrades to a direct wrapper. When Codex is the
reviewer, it receives a capsule-local project-root marker override so parent host
`.codex/config.toml` discovery stops at the capsule boundary without widening
the sandbox's readable roots.

## Feedback Entry Points

The top-level CLI help and README link to the GitHub issue chooser and
`CONTRIBUTING.md`, which is included in the npm package. Issue forms implement
the shared workspace reporting contract; the CLI bug form adds only optional
CLI diagnostics. The installed Auto Research Skill owns agent report drafting,
while the CLI catalog pins its reviewed commit and complete tree hash. Feedback
discovery through help requires no provider, credential, or research workspace.

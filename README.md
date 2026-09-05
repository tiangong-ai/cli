---
docType: repo-readme
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When installing, running, or validating the Tiangong AI CLI."
whenToUpdate: "When package name, Node baseline, command examples, environment variables, or validation commands change."
checkPaths:
  - README.md
  - package.json
  - bin/**
  - src/**
lastReviewedAt: 2026-09-04
lastReviewedCommit: 25b236a15c846c0168ffb84f8afa390d71985f4b
---

# Tiangong AI CLI

Package: `@tiangong-ai/cli` Executable: `tiangong-ai` Node: `>=24`

## Feedback

Use the [Bug and feature forms](https://github.com/tiangong-ai/cli/issues/new/choose)
and [reporting guide](https://github.com/tiangong-ai/cli/blob/main/CONTRIBUTING.md).
Chinese and English reports are welcome; unknown versions or incomplete
reproduction are accepted with an explanation. CLI help exposes these links,
and the npm package includes `CONTRIBUTING.md`. For Skill instructions and
orchestration, use the [Skills forms](https://github.com/tiangong-ai/skills/issues/new/choose);
uncertain ownership can be reported here for maintainer triage.

## Run From This Repository

```bash
npm install
npm run build
node ./bin/tiangong-ai.js --help
node ./bin/tiangong-ai.js --version
```

Use Node `24.x`; this package declares `>=24 <25` and includes `.nvmrc` for
compatible version managers.

After installation, print the package version with either top-level flag:

```bash
tiangong-ai --version
tiangong-ai -v
```

## Atomic Data Runtime

Inspect the built-in, versioned data capability catalog without network access:

```bash
tiangong-ai data catalog --json
tiangong-ai data describe <capability-id> --json
tiangong-ai data doctor <capability-id> --json
```

Only explicit `doctor --live` and `run` operations may contact a provider. A
run accepts one closed request envelope from a file or stdin:

```bash
tiangong-ai data run <capability-id> <operation-id> \
  --input /absolute/path/to/request.json --json
```

The command-line capability and operation must match the versions in the input
envelope. Credentials are never accepted in argv or input JSON. Each connector
declares exact logical environment-variable bindings, HTTPS endpoint scopes,
and acquisition limits in its execution manifest. Callers may explicitly
tighten those limits, but upper layers do not silently reinterpret Agent
context budgets as provider or record limits. Data commands deliberately do
not load a cwd `.env` file.

`data catalog` also returns a concise capability summary, what the capability
provides and does not provide, operation summaries, a separate discovery
digest, and an explicit `available` or `suspended` status. Suspended entries
remain inspectable, but `doctor` and `run` block before any provider request.
`data describe` expands that layer with source ownership, coverage,
granularity, selection hints, typical uses, official documentation, freshness,
license restrictions, and operation descriptions. Narrative discovery changes
do not change the execution manifest digest used for compatibility binding.
Operation input schemas include field-level descriptions and examples.
Operations may also publish stable feature IDs for Skills that depend on a
specific compatible behavior within the same contract major.

Auto Research keeps three budgets separate: connector acquisition limits,
Evidence package bytes/files, and the Agent-visible context view. A validated
result is persisted in full when it fits the Evidence package budget;
`maxBrokerItems` and the context-token ceiling only shape the Agent view.
Receipts distinguish provider coverage, explicit limits reached, and context
projection instead of forcing them into one status. A projected result returns
an opaque, evidence-bound cursor; `research project evidence data read` serves
the next shape-aware view from immutable local Evidence without another
provider request or provider quota charge. Agents must either continue until
`nextCursor` is null or disclose the exact presented/total fraction.
The public Research command returns receipt identity, coverage, a structured
bounded context view, and continuation metadata. The complete core result
remains in immutable Evidence and is not duplicated into Agent stdout.

JSON exits are `0` for success, `2` for request/contract errors, `3` for a
blocked execution, and `4` for an explicit partial result. Public machine
schemas ship under `dist/data/schemas/`.

The built-in capabilities are:

- `airnow.hourly-observations` / `fetch-hourly`: fetches official AirNow
  `HourlyAQObs` files for a bounded UTC-hour window, bounding box, and pollutant
  list. Results retain source-file lineage and always state that AirNow data are
  preliminary and unsuitable as regulatory-grade AQS evidence. Independent
  hourly files use bounded concurrency while output files and records retain
  deterministic UTC-hour order.
- `bluesky.public-posts` / `fetch-cascades`: fetches bounded public Bluesky
  post seeds from search, an author feed, a custom feed, or a list feed and can
  flatten visible reply cascades. Ranking, counters, moderation visibility, and
  missing nodes remain explicit mutable AppView limitations.
- `epa.eis-records` / `search`: retrieves bounded official EPA EIS Database
  common-search or UI-created search pages and parses title, CEQ/provider IDs,
  document type, dates, agencies, state, detail links, and document-availability
  cues. Its endpoint-scoped, same-origin session cookie jar exists only in
  memory so the provider's initial redirect can complete; cookies never enter
  results, receipts, logs, or cross-origin requests. It does not fetch or assess
  linked EIS documents.
- `federal-register.documents` / `search`: searches bounded
  FederalRegister.gov document metadata by publication date plus term, agency,
  document type, topic, docket, or RIN filters. It does not follow result links,
  fetch document full text, or provide legal interpretation.
- `gdelt.doc-search` / `search`: searches the rolling GDELT DOC 2.0 index for
  bounded article-link metadata or supported aggregate timelines. Automated
  multilingual extraction and uneven monitored-source coverage are explicit;
  it does not retrieve article bodies or establish ground-truth facts.
- `gdelt.events`, `gdelt.gkg`, and `gdelt.mentions` / `fetch`: independently
  discoverable GDELT 2.0 table capabilities backed by one bounded TypeScript
  file-feed core. They fetch either the latest provider entry or at most twenty
  aligned 15-minute files, verify ZIP/CRC and advertised latest-file checksums,
  and emit closed named columns without persisting downloaded files. Their
  wide named-field JSON is preserved as Evidence; Agent context projection is
  handled by Auto Research without changing the connector result.
- `nasa-firms.active-fire` / `fetch-area`: retrieves bounded NASA FIRMS MODIS,
  VIIRS, or Landsat active-fire point detections, optionally validates source
  availability, and exposes chunk-level partial coverage. Hotspots are thermal
  anomalies, not fire perimeters or confirmed incident identities.
- `open-meteo.air-quality` / `fetch-hourly`: retrieves bounded GMT hourly CAMS
  model-grid air-quality series for known coordinates; these are modeled
  background values rather than station observations. Missing and explicitly
  returned all-null series are distinct machine-readable partial issues.
- `open-meteo.flood` / `fetch-daily`: retrieves bounded daily GloFAS simulated
  river-discharge series for the represented river grid; it is neither gauge
  data nor a flood-alert service. Missing and explicitly returned all-null
  series are distinct machine-readable partial issues.
- `open-meteo.historical-weather` / `fetch`: retrieves bounded GMT hourly and/or
  daily historical weather reanalysis for one controlled model and known
  coordinates. ERA5 or ERA5-Land should be selected when multi-decade model
  consistency matters. Missing requested series and provider-returned series
  whose values are all `null` are distinct machine-readable partial issues.
- `openaq.air-quality` / `search-locations` and `fetch-sensor-measurements`:
  discovers filtered OpenAQ v3 locations and retrieves a bounded raw, hourly,
  or daily series for one sensor. It preserves provider/license context but
  does not calculate AQI or make health or regulatory determinations.
- `usbr.project-records` / `fetch`: inventories caller-supplied official
  `www.usbr.gov` project or program pages plus bounded same-origin links. It
  preserves page response provenance but does not follow, download, parse, or
  assess linked records and is not USBR-wide search.
- `usbr.rise` / `discover-items` and `fetch-results`: scans bounded Bureau of
  Reclamation RISE catalog pages for client-filtered candidate item IDs, then
  retrieves bounded result rows for explicitly selected items. Provider scan
  order is not ranking, and operational values require item metadata and domain
  context before interpretation.
- `usgs.water-instantaneous-values` / `fetch`: retrieves bounded legacy USGS
  WaterServices instantaneous observations while preserving site, parameter,
  qualifier, provisional status, and source lifecycle warnings.
- `youtube.public-content` / `search-videos` and `fetch-comments`: discovers
  public YouTube videos with detail enrichment and fetches bounded visible
  comment/reply text for explicit video IDs. It does not download media or
  transcripts and does not treat ranking or comments as representative opinion.

Regulations.gov comment and attachment capabilities remain discoverable with
`availability.status=suspended`, a stable reason code, and explicit resume
criteria. `doctor` and `run` block locally without network access, and Auto
Research excludes them from its executable projection until production
search/detail/attachment live gates qualify them again.

Fourteen capabilities are keyless. NASA FIRMS requires `NASA_FIRMS_MAP_KEY`, which the
CLI injects as a protected provider path segment; OpenAQ requires
`OPENAQ_API_KEY`, and YouTube requires `YOUTUBE_API_KEY`; the CLI injects the
latter two as protected provider headers, with YouTube using `X-Goog-Api-Key`
rather than a URL parameter. No secret is accepted in argv or input JSON. Exact input and output schemas,
endpoint scopes and limits are available through the execution manifest, while
source notes, coverage, selection guidance and license restrictions are
available in the discovery metadata returned by `data describe`; static
`data doctor` remains offline and reports a missing required credential without
making a network request.

Operations that declare local artifact output must be invoked with
`data run ... --artifact-dir <absolute-existing-directory>`. The path is an
out-of-band execution parameter and is excluded from the request, result, and
receipt. Files are staged under hidden temporary names, validated before an
atomic no-overwrite commit, and rolled back when execution or output validation
is blocked.

## KB Ingest

Required environment:

```bash
TIANGONG_AI_API_KEY=
TIANGONG_KB_DEFAULT_COLLECTION_NAME=
```

The KB API server defaults to `https://thuenv.tiangong.world:7300` with path
prefix `/api/v1/kb`.

Run a resumable sliding-window ingest for one file or a folder:

```bash
tiangong-ai kb ingest bulk /path/to/document.pdf \
  --collection-path /course/thu_humanities \
  --poll-interval 30 \
  --health-poll-interval 60
```

Run a larger folder ingest:

```bash
tiangong-ai kb ingest bulk /path/to/folder \
  --collection-path /course/thu_humanities \
  --window-size 100 \
  --top-up-max 50 \
  --upload-concurrency 4 \
  --poll-interval 30 \
  --health-poll-interval 60
```

Bulk scan a large folder and emit a structural JSON summary:

```bash
tiangong-ai kb ingest bulk scan /path/to/folder --json
```

Dry-run a layered metadata map against a folder and collection schema:

```bash
tiangong-ai kb ingest bulk dry-run /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --json
```

The same dry-run is also available through the skill-facing alias:

```bash
tiangong-ai kb ingest metadata dry-run /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --json
```

Run a resumable sliding-window bulk ingest with metadata:

```bash
tiangong-ai kb ingest bulk /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --window-size 100 \
  --top-up-max 50 \
  --upload-concurrency 4 \
  --poll-interval 30 \
  --health-poll-interval 60
```

`tiangong-ai kb ingest bulk run /path/to/folder` is accepted as an explicit
alias for wrappers that want a verb before the folder path.

Bulk ingest uses SQLite as its checkpoint source. By default, job files are
stored under the OS app-data directory:

- macOS: `~/Library/Application Support/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`
- Linux: `~/.local/share/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`
- Windows: `%APPDATA%/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`

Use `--state /path/to/job.sqlite` to override the checkpoint path. Bulk ingest
does not impose a client-side polling limit by default, so it can keep topping
up the sliding upload window until all rows complete. Use `--max-polls <n>` only
when a wrapper or operator needs a bounded run. Status checks and upload-window
top-up run every 30 seconds by default. Pipeline health is cached independently
and refreshed every 60 seconds by default, so health backpressure does not slow
status progress. Override the intervals with `--poll-interval` and
`--health-poll-interval`, or with `TIANGONG_KB_BULK_POLL_INTERVAL` and
`TIANGONG_KB_PIPELINE_HEALTH_POLL_INTERVAL`.

Bulk ingest scans and fingerprints files first, then lazily creates derived
files only when a row enters the active upload window. `.docx` files larger than
10MiB are uploaded through 300dpi-normalized ingest copies; smaller `.docx`
files upload directly unless they are empty. Oversized PDFs are split into the
fewest uploadable PDF parts when they enter the window, and the generated part
rows are written back to SQLite so resume can reuse them. Derived files stay
under `.tiangong-kb-ingest-derived` by default, and that directory is excluded
from future bulk scans. Upload metadata remains the user/business metadata
produced by the metadata map.

Manage bulk jobs:

```bash
tiangong-ai kb ingest jobs
tiangong-ai kb ingest status <job-id>
tiangong-ai kb ingest resume <job-id>
tiangong-ai kb ingest export <job-id> --format csv
```

List uploadable collections:

```bash
tiangong-ai kb collections list --capability upload
```

Resolve a collection and include the effective metadata schema:

```bash
tiangong-ai kb collections schema --collection-path /course/thu_humanities --json
```

Check document status:

```bash
tiangong-ai kb ingest status <document-id>
```

Read course fulltext from the processed S3 bucket:

```bash
tiangong-ai kb course fulltext \
  --document-id 000125ed-c4d9-4fe3-9380-000000000000 \
  --tags thu_humanities
```

The command lists exactly one `.txt` object under
`s3://tiangong/processed_docs/course_pickle/<tags>_pickle/<document-id>/` and
prints its content. Override the location with `--bucket`, `--prefix`, or the
`TIANGONG_COURSE_FULLTEXT_S3_BUCKET` and
`TIANGONG_COURSE_FULLTEXT_S3_PREFIX` environment variables. AWS credentials and
region are resolved by the AWS SDK, including `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`, and
`AWS_DEFAULT_REGION`.

## Research Workspaces

Create a bounded smoke-test workspace and register a question:

```bash
tiangong-ai research workspace init /absolute/path/to/workspace
tiangong-ai research project init gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?"
```

`smoke-test` is the default and is intended for deterministic fixtures and
low-cost canaries. Formal work must use `--mode production-research`, explicit
producer/reviewer model IDs and pricing in `config.json`, a requirements JSON
file, and budget confirmation when `maxCostUsd` exceeds
`confirmationCostUsd`:

```bash
tiangong-ai research setup catalog \
  --workspace /absolute/path/to/workspace --json
# Interactive and user-initiated: select external Skills, configure credentials
# with hidden input/env/stdin, review licenses, choose scope, and run checks.
tiangong-ai research setup \
  --workspace /absolute/path/to/workspace
tiangong-ai research setup status \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project preflight \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?" \
  --requirements /absolute/path/to/evidence-requirements.json --json
tiangong-ai research project init gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?" \
  --requirements /absolute/path/to/evidence-requirements.json \
  --confirm-budget --json
```

The guided setup creates an immutable, hash-bound plan before mutation. No Skill
is bundled or installed without an explicit Wizard confirmation or plan
selection. The Wizard recommends a project-local `tiangong-auto-research`
orchestrator so ordinary research requests can enter the workflow from any
user-selected workspace directory. It pins the installer integrity, source
commits, Skill tree hashes, exact destinations, license acceptance, safe
credential bindings, settings, and checks. For every selected provider, the
Wizard offers hidden TTY input (recommended), a named owner environment
variable, preloaded bounded stdin/password-manager input, or an explicit skip.
Secret values never enter the plan or terminal output. Required credential
preflight and owner-only storage run before downloads. Project-local copy is
the default; global writes, network downloads, live provider checks, synthetic
document uploads, and paid agent smokes each require their applicable
confirmation.

When the orchestrator is selected with project scope, the reviewed plan also
binds its host-routing instructions. Codex receives one bounded managed block
in the workspace-root `AGENTS.md`; setup preserves every owner byte outside
that block. Claude Code receives the dedicated
`.claude/rules/tiangong-auto-research.md` file and setup never replaces an
owner `CLAUDE.md`. Existing conflicting, modified, linked, or otherwise unsafe
targets stop apply before mutation. Replacement plans remove only routing
bytes still proven to be setup-owned. Status and Doctor verify the installed
bytes and report that a new native-host session is required before the routing
instruction becomes active. Global-scope Skill installation does not create
project instruction files.

### Declarative setup

For repeatable provisioning without a TTY, generate a safe workspace-local
template:

```bash
tiangong-ai research setup init \
  --workspace /absolute/path/to/workspace --json
```

This no-overwrite command creates:

- `.tiangong-research/setup.yaml`: every current catalog Skill, credential, and
  setting with explicit enabled/disabled state, plus license acceptances, agent
  routes, verification choices, and confirmations;
- `.tiangong-research/setup.env.example`: every catalog credential variable
  name with an empty value and matching requirement/enabled comments; copy it
  to `setup.env` only when a file-based secret source is needed;
- `.tiangong-research/.gitignore`: excludes `setup.env`.

Review the catalog, edit `setup.yaml`, and never put a key or token in it. For a
file-based credential source:

```bash
cp .tiangong-research/setup.env.example .tiangong-research/setup.env
chmod 600 .tiangong-research/setup.env
# Edit setup.env locally. Keep disabled optional entries empty unless their
# corresponding credentials.<id>.enabled flag is explicitly changed to true.
```

Then run the ordinary command:

```bash
tiangong-ai research setup \
  --workspace /absolute/path/to/workspace --json
```

Bare setup checks only the fixed workspace-local `setup.yaml`; it never scans a
parent directory. When the file exists, setup is fully non-interactive and does
not fall back to the Wizard after a parse, schema, permission, credential, or
readiness failure. Use absolute `--config` and `--env-file` paths only for an
explicit alternative. Use `research setup wizard` to explicitly choose the
interactive path even when a declaration exists.

The closed YAML declaration is `schemaVersion: 2`; the removed v1 shape is not
migrated or accepted. It requires `selection.skills`, `credentials`, and
`settings` to contain exactly all current catalog entries. Skill entries expose
`enabled` and the catalog license ID. Credential and setting entries expose the
catalog- and current-selection-derived `requirement`, catalog `appliesTo`, and
an explicit `enabled` choice;
optional omission is not a configuration state. Missing, extra, or drifted
catalog metadata, incomplete Brave profile combinations, a disabled required
entry, or an enabled setting without a value fails before network access.

`setup.env` must be a regular non-symlink file, no larger than 64 KiB,
owner-only on POSIX, and may contain only credential variable names declared by
the YAML. Empty values keep disabled options visible without selecting them. A
non-empty value for a disabled credential is rejected; enable it in YAML or
remove the value. The file is read as literal data without shell expansion. A
differing value in the ambient environment and `setup.env` is also an error;
setup never chooses between them silently. Enabled secret values are imported
into the existing owner-only logical stores before downloads and never enter
the YAML, immutable plan, declaration binding, output, report, or journal.

The semantic YAML hash is bound to the immutable plan. Re-running unchanged
configuration reuses that exact plan and reruns all verification. A changed
declaration stops until the owner reviews it and sets
`replaceExistingPlan: true`; the prior plan and declaration binding are archived
before replacement.

Declarative setup requires live provider checks and the independent reviewer
CLI agent smoke, including explicit cost authorization. Interactive setup
recommends both by default while retaining explicit quota/cost consent. Apply,
status, doctor, and the Wizard return success only when
`overallReadiness=READY`; skipped checks, warnings, missing dependencies, and
optional selected-component failures remain visible as a non-zero incomplete
setup instead of a false success. The native producer is still not launched as
a child process.

Before project initialization, a setup-only audit can be exported without
rerunning Doctor, contacting a provider, or launching a model. The exporter
creates a new portable directory atomically and verifies it before returning.
The independent verifier accepts the directory from any absolute location:

```bash
tiangong-ai research setup audit export \
  --workspace /absolute/path/to/workspace \
  --output /absolute/path/to/new-setup-audit --json
tiangong-ai research setup audit verify \
  --bundle /absolute/path/to/new-setup-audit \
  --expected-manifest-sha256 <digest-from-trusted-export-record> --json
```

The closed manifest binds portable projections of the immutable setup plan and
state plus every available setup report, runtime/capability lock, Doctor
attestation, and declaration binding. It rejects missing, extra, symlinked,
reordered, hash-drifted, or semantically disconnected entries. Credential
values and environment-variable names, owner secret stores, source caches,
installed Skill trees, browser/auth state, raw provider output, unrelated
workspace files, and host paths are never included. This setup proof is
separate from `research project audit`: readiness may honestly be `BLOCKED` or
`PARTIALLY_READY` while bundle integrity still verifies.
Local capability locators, static-header values, credential prefixes, and
free-form Doctor runtime/telemetry strings are represented only by SHA-256
bindings in their closed portable projections. Verification parses and checks
the exact bytes captured with each file hash, then rejects a tree or file that
changes before completion.
The manifest digest returned by export is an external trust anchor: retain it
in a separate run record, CI record, or other trusted channel. Verification
requires that explicit digest and never trusts a digest read only from the
mutable bundle itself.

If the full orchestrator was selected, accepted apply creates a separate
project-local `tiangong-auto-research-recovery` Skill after credentials are
stored and before source checkout. This CLI-generated, plan-bound shim can only
inspect context/status and execute the exact-version retry returned by setup; it
cannot perform research, call standalone evidence, or access credentials. A
checkout or install failure therefore remains discoverable without falling back
to a global Skill. After the full external orchestrator matches its reviewed
tree hash, setup verifies the shim byte-for-byte and removes only that generated
directory. Modified, symlinked, or ambiguous recovery bytes block cleanup.

Production admission requires at least one locked external capability with
`brokered-network` and `discoveryScopes: ["public-internet"]`; an input plan or
local files alone cannot represent internet coverage. The machine-readable
setup catalog contains only separately sourced external Skills and reports each
orchestrator, evidence, preprocessing, acquisition, and post-closure
recommendation; exact
source commit and tree hash; license and credential requirements; dependencies;
and installed-byte status. Installation is never performed by a research
package.

Whole-tree hashes are platform-stable: logical paths are NFC-normalized and
ordered by UTF-8 bytes rather than the host locale, and newly created detached
source checkouts disable Git line-ending conversion before checkout. A source
hash mismatch remains fail-closed before `npx skills add`; its structured error
reports only the Skill/source IDs, hash algorithm, and expected/observed hashes.
Setup runs every nested npm installer through one apply-scoped owner-only cache
under the OS temporary directory, never through the caller's HOME or global npm
cache, and removes it after either success or failure. This keeps nested
executables usable when HOME is mounted `noexec` without admitting mutable host
cache state into a reviewed installation.
It never treats file existence as installation success or silently rewrites an
immutable plan. Plans created by an earlier CLI release are rejected at the
execution boundary; create and review a new plan with the active release. The
orchestrator additionally declares a `workspace-lock` runtime contract: every
workspace command goes through its bundled resolver, which accepts only the
regular non-symlink `runtime-lock.json` exact stable CLI version. Setup and
release CI reject a missing resolver or any stale exact CLI version in the
orchestrator's `SKILL.md` or `references/*.md`.

### Top-journal Policy, scientific design, and publication gates

A `top-journal` project starts with a human-reviewed Markdown Policy, not with
model execution. After project-scoped setup reaches `READY`, use the guided
Wizard:

```bash
tiangong-ai research policy wizard top-journal-paper \
  --workspace /absolute/path/to/workspace
tiangong-ai research policy status top-journal-paper \
  --workspace /absolute/path/to/workspace --json
```

The Wizard resolves only the verified project-installed
`tiangong-auto-research` tree. Before catalog use, the CLI parses every Markdown
template in every category of that exact locked tree; setup doctor performs the
same compatibility check before any provider live check or reviewer smoke. The
baseline must require the scientific-design contract, ordered early reviews,
and real-record construct canary, and those safeguards must remain true in the
resolved Policy. The Wizard then copies a baseline plus one article type, field,
journal class, project brief, and four reviewer rubrics. Generic defaults are
clearly reported and require a separate acknowledgement. An exact-journal
Policy additionally requires a current official HTTPS guideline URL, retrieval
date, and substantive human content for all journal-specific sections. Approval
binds the manifest and every document by SHA-256; edits, manifest tampering, or
expiry block preflight and all later stages until the Policy is reviewed and
approved again.

Before search, the current native Codex, Claude, WorkBuddy, or CodeBuddy host must author a
project-specific scientific design. The CLI owns the closed schema and rejects
designs that confuse model-to-model disagreement with observed truth, inflate
independent sample size through resampling, omit quantity/threshold semantics,
leave blocking gaps unresolved, or cannot fit the complete review lifecycle.
The CLI validates, freezes, hashes, and routes this design; it does not author
the design or launch a nested producer.

Hash binding alone does not make a model executable. Each model declares raw
implementation bytes, a retrievable safe locator and entrypoint, exact
environment-lock bytes, implementation/environment status, and a freeze gate.
Before authoring a design with frozen model objects, register each external
regular non-symlink file through the public content-addressed intake:

```bash
tiangong-ai research scientific object register \
  --kind model-implementation \
  --path /absolute/path/to/model.py \
  --media-type text/x-python \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research scientific object register \
  --kind environment-lock \
  --path /absolute/path/to/requirements.lock \
  --media-type text/plain \
  --workspace /absolute/path/to/workspace --json
```

Use the returned `sha256` and `objectLocator` verbatim in the design. Registration
is workspace-scoped because it must happen before project admission. It hashes
raw bytes, atomically stores an immutable `lineage/objects/<sha256>/blob`, and
records only deterministic non-path metadata. It never accepts a source inside
`.tiangong-research`, a symlink as the selected file, an unsupported/binary
media type, or invalid UTF-8. Canonical parent-directory aliases are resolved
before containment checks, including macOS `/var` aliases and Windows
cross-volume paths. Re-registration is idempotent, and `research scientific object inspect`
revalidates the record and blob before returning it. Do not hand-copy files into
the control directory.

Source-derived uncertainty states also declare whether their values are frozen
or pending, and every joint state maps exact parameter-state IDs. Pending model,
environment, or uncertainty objects are allowed only when a planned Policy rule
owns the same due gate. Pending implementations use `null` for implementation
SHA-256, locator, and entrypoint; pending environments use `null` for lock
SHA-256 and locator. They are exposed in every earlier review packet as
`futureGateObligations` and become blocking mechanical errors at that gate.
Their predeclared slots may be fulfilled through the append-only same-project
command below. The original design bytes never change; a material assumption,
question, policy or already-frozen value still requires a reviewed successor.

Use the same Policy project ID and exact design when preflighting and admitting
the research project:

```bash
tiangong-ai research schema show scientific-design --json
tiangong-ai research project preflight \
  --question "A specific, testable research question" \
  --goal top-journal --policy-project top-journal-paper \
  --requirements /absolute/path/to/evidence-requirements.json \
  --design /absolute/path/to/scientific-design.json \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project init top-journal-paper \
  --question "A specific, testable research question" \
  --goal top-journal \
  --requirements /absolute/path/to/evidence-requirements.json \
  --design /absolute/path/to/scientific-design.json \
  --design-producer-agent codex \
  --design-producer-session OPAQUE_NATIVE_SESSION \
  --confirm-budget \
  --workspace /absolute/path/to/workspace --json
```

The base evidence lifecycle remains producer-authored in the current interactive
Codex or Claude Code host, but its frozen control sequence is now
`discover -> acquire -> typed decomposition/atoms -> content freeze -> inference freeze -> analyze -> Claim-Evidence Graph -> synthesize -> review -> close`.
A fresh independent reviewer
must first pass three hash-bound scientific gates: `research-design` before
discovery, a real-record and outcome-blind `evidence-construct` canary after
acquisition and typed-content freeze, and `pilot-methods` after that canary and
before analysis. Acquisition always freezes its exact result, including honest
gaps; a stopped acquisition/content gate prevents inference without discarding
the acquired evidence. Evidence-construct coverage may cite only frozen
snapshot source IDs and exact content atoms. Its JSON canary artifacts are promoted and
content-addressed through `--canary-artifacts`; reviewer prose cannot override
an invented ID, unbound digest, or other mechanical failure.

```bash
tiangong-ai research schema show scientific-assessment-research-design --json
tiangong-ai research project scientific review prepare top-journal-paper \
  --role research-design \
  --assessment /absolute/path/to/research-design-assessment.json \
  --reviewer-agent claude \
  --reviewer-session FRESH_OPAQUE_REVIEW_SESSION \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research schema show scientific-review-research-design --json
tiangong-ai research project scientific review submit top-journal-paper \
  --role research-design --review /absolute/path/to/review.json \
  --workspace /absolute/path/to/workspace --json
```

For a prepared packet, use explicit isolated execution instead of writing a
custom reviewer runner:

```bash
tiangong-ai research reviewer status --workspace /absolute/path/to/workspace --json
tiangong-ai research project scientific review execute top-journal-paper \
  --role research-design --confirm-review-cost \
  --workspace /absolute/path/to/workspace --json
```

Confirm the bounded cost before execution. The command uses the configured
`native-direct` or `sandbox-bridge` reviewer, copies exact hash-verified packet
inputs and human Policy documents into its capsule, and submits only a
schema-valid, packet/session-bound review. A saved successful execution is
replayed without another model call after revalidating its immutable proof.
Failures require explicit `--retry` and remain bounded by the attempt budget;
unreported usage and interrupted wall time retain conservative reservations.
Failed processes return a bounded, sanitized exit diagnostic and record it in
the journal; no full prompt or raw authentication output is persisted. Automatic
Claude invocation uses the same dialect-annotation conversion as
`research schema show NAME --compatibility claude-code`; canonical controller
validation and its scientific constraints remain unchanged.
The provider view explicitly types scalar constants/enums; returned values are
never coerced to satisfy the canonical schema.
Claude's structured result is used instead of any accompanying narrative;
declared error results remain failures, with their safe diagnostic ahead of
incidental stderr warnings.
A nonpassing mechanical packet can receive an independent stop verdict, never
an override. The existing manual submit command remains available for an exact
independent review.

Reviewer status is read-only and transport-aware. Native-direct does not
require a bridge connection. Smoke configuration readiness is explicitly not
production readiness and does not demand an attestation that smoke mode never
writes. Production still requires its current reviewer doctor attestation.
Packet read responses carry their actual content and receipt together; a
receipt alone does not establish that the host displayed the content to its model.

Repeat the same prepare/execute route for `evidence-construct`, adding an
owner-reviewed JSON array of absolute canonical canary paths with
`--canary-artifacts /absolute/path/to/canary-paths.json`, and then for
`pilot-methods` at its stage boundary. A top-journal fork or addendum is a
new authoritative generation and therefore requires a target-specific approved
Policy, design, and fresh native producer session; it cannot inherit scientific
approval from a superseded generation.

Review packet `stageInputs` identify promoted portable objects by purpose,
owner, safe source locator, media type, object kind, registration-record hash,
and SHA-256 over raw file bytes. Registered model code and environment locks are
copied as exact project-local `blob` bytes; they are never parsed as JSON merely
because the packet is JSON. `packetSha256` is the
logical packet identity that excludes its own identity field; the portable
audit manifest separately records the raw stored packet-file digest. This keeps
packet identity and byte-level transfer verification explicit rather than
overloading one hash with both meanings.

After base closure, the current native host writes a final Markdown/plain-text
manuscript, schema-valid publication assessment, and an explicit submission
manifest. The manuscript must contain Abstract, Introduction, Methods, Results,
Discussion, Data availability, Code availability, and References. The
submission manifest must bind distinct absolute files for cover letter, title
page, reporting checklist, data availability, code availability, and source
data; figure/table index, extended data, and supplementary methods are optional.
`research publication freeze` then content-addresses the Policy, scientific
design and early reviews, acquisition/content/inference snapshots, mode-bound
analysis, Claim-Evidence Graph, base outputs, manuscript, assessment,
supplements, role-complete submission files, and reproducibility manifest.
Computational/mixed analysis still requires reproduced metadata with exact
implementation/environment bindings. Qualitative analysis uses
`status: not-applicable`, null command/seed and empty implementation/environment
lists; it must not invent a computation. Both paths retain the same evidence,
graph, Policy and independent-review checks. Metadata alone is not proof that
a computation was executed.
Exactly four fresh independent sessions review that frozen generation:
evidence, methods/reproducibility, domain/novelty, and journal-editor. A revised
manuscript invalidates prior reviews. Every reviewer must use the configured
agent family that differs from the native producer; changing only the session
ID is not independent. Reviewer-session reuse is rejected from the append-only
journal even if mutable cache state is removed. The raw opaque
producer/reviewer session identifiers are accepted only at the command boundary;
generation, packet, review, journal, and closure objects persist only their
SHA-256 bindings.

```bash
tiangong-ai research schema show publication-assessment --json
tiangong-ai research publication freeze top-journal-paper \
  --manuscript /absolute/path/to/final-manuscript.md \
  --assessment /absolute/path/to/publication-assessment.json \
  --submission /absolute/path/to/submission-package.json \
  --producer-agent codex --producer-session OPAQUE_NATIVE_SESSION \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research publication status top-journal-paper \
  --workspace /absolute/path/to/workspace --json
```

The CLI returns a mechanically bounded ceiling:
`top-journal-candidate`, `top-journal-class-ready`, or
`target-journal-submission-ready`. Evidence and review failures can only lower
it. None of these states predicts or guarantees editorial acceptance.

Before external handoff or archival, export and independently verify a portable
audit directory. Export first revalidates the semantic acquisition, content,
inference, graph, and publication objects; a copied but stale/tampered chain is
rejected. Its manifest exposes their intrinsic IDs and hashes under
`researchChain`. It contains the selected project, portable copies of admitted
inputs, formal evidence and artifact bytes, Policy/design/review objects,
outputs, environment fingerprints, and safe hash-preserving journal proof
derivatives. Credentials, setup
sources, browser profiles, native active state, capsules, unrelated projects,
and host-specific absolute paths are excluded.

Text inspection distinguishes internal identifiers such as `interruptedSessionId`
from credential fields. It checks raw text and read-only decoded JSON/JSONL,
including escaped keys and nested string payloads, while retaining the exact
evidence and ledger bytes. Authentication values remain blocked even when wrapped
in arrays or objects; an identifier's UUID shape is never a credential exemption.

```bash
tiangong-ai research project audit export top-journal-paper \
  --output /absolute/path/to/new-audit-directory \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project audit verify \
  --bundle /absolute/path/to/new-audit-directory --json
```

`research setup status --json` reports credential persistence separately from
readiness. It also reports the effective exact-npx CLI package/version/root,
the selected project orchestrator, any temporary recovery shim, ignored global
same-name Skills, legacy wrappers that still contain an unmanaged PATH CLI
fallback, and the real failed source/immutable ref/cache state when checkout is
retryable. A direct `research search` inside a managed workspace stops before
network access and returns the same broker-vs-standalone and setup provenance;
it never converts a stored broker credential into an ambient credential.

The default `internet-research` profile selects Brave Web Search and News
Search. `internet-research-with-context` additionally selects the
subscription-dependent LLM Context endpoint, while
`internet-research-with-media` also selects image and video discovery. A
provider-plan or authentication failure blocks the selected profile instead of
silently dropping a Skill. `credential set` accepts exactly one of `--prompt`,
`--from-stdin`, or `--from-env <name>` and stores the value under the declared
logical ID; the value is never returned or journaled. For example:

```bash
tiangong-ai research setup credential set \
  --id brave.search.api-key --prompt \
  --workspace /absolute/path/to/workspace --json

op read 'op://Research/Brave/api-key' | \
  tiangong-ai research setup credential set \
    --id brave.search.api-key --from-stdin \
    --workspace /absolute/path/to/workspace --json
```

The pinned Brave checkout is verified at `skills/<skill-name>` before install.
An explicitly reviewed replacement plan reconciles the complete setup-managed
capability set and both owner-only credential stores: deselected Brave, SCI,
report, or patent declarations and lock records are removed, custom capability
declarations are preserved, and installed Skill directories are never deleted
implicitly.
Provider-dependent context/media choices never fall back silently; select the
baseline in a replacement plan when that is the intended operator decision.

The interactive Wizard uses restrained semantic colors and section markers
only when its terminal output is a TTY. Hidden credential input is not echoed.
Set `NO_COLOR` or `TERM=dumb` for plain text; `--json` also disables Wizard
styling so structured output never contains ANSI escape sequences. Password
managers may preload one line per logical ID with
`--credential-stdin <id[,id...]>`; the remaining Wizard questions use the
controlling terminal.

Optional setup entries have explicit roles. Tiangong SCI, report, and patent
search are distinct owner-whitelisted POST evidence capabilities with separate
logical credentials and discovery scopes; one cannot substitute for another.
Document decomposition is an input preprocessor; academic paper download is an
acquisition adapter; document and
presentation Skills are post-closure authoring only. Run selected preprocessors
and acquisition adapters with `research setup companion run`, then admit their
exact hash-bound output separately. Automatic paper OA exhaustion returns an
explicit browser handoff and never launches or chooses a browser silently.
The paper companion and its setup-doctor preflight both enter the verified
Skill through `scripts/runtime.py`; the CLI never bypasses that lock by invoking
`fetch.py` or importing `pypdf` from ambient Python. A missing runtime remains
an actionable, non-installing failure until the owner explicitly runs the
Skill's hash-locked bootstrap. Selected DOCX, PDF, PPTX, and XLSX authoring
Skills bind one resolved Python and Node environment, check their complete
Python/Node package and external-command matrices, and then run an exact-file
functional canary through the installed pinned Skill helpers. The canaries
create, validate, extract or recalculate, and render synthetic sentinel
artifacts, including the PDF image helpers and both PPTX/XLSX MarkItDown paths,
without scanning a directory for a newest file. A failed prerequisite
or canary makes only that authoring component `BLOCKED`; research-core readiness
remains independent. Setup reports the minimum owner action and never runs pip,
npm, Homebrew, apt, or another dependency installer.
For PPT creation, setup recommends `hugohe3.ppt-master` first;
`anthropic.pptx` remains a compatible situational option, and both may be
selected in the same explicit plan.

Every leaf command accepts `--help` before workspace resolution, so operators
can inspect `capability doctor`, `project preflight`, `project init`, and `run`
syntax safely from an empty or unrelated directory.

The requirements object declares `dimensions`, `sourceTypes`, optional
`requiredCapabilityIds`, `requiredCompanionIds`, and
`requiredDiscoveryScopes`, `minSources`,
`minFullTextSources`, `minDatedSources`, and optional inclusive
`publicationDateFrom` / `publicationDateTo` boundaries (`YYYY-MM-DD` or
`null`). Explicit capability/scope requirements are exact: wildcard web or SCI
coverage cannot satisfy a required report database. Preflight returns both
stable string gaps and structured `coverageGaps` with the affected dimensions,
source types, alternative-coverage decision, and minimum owner action. After
discovery, a mechanical coverage gate verifies the declared
source, full-text, publication-date, and dimension summary before analysis.
For large local sources, pass an immutable `--input-plan` to both preflight and
project initialization. Each plan entry may expose either a separate
`contextPath` or non-overlapping, one-based `contextRanges`; the producer sees
only that bounded context, while independent review receives the hash-verified
full source. Symlinks, duplicate content and changed hashes are rejected.
There is no total stage-context length gate: large admitted objects remain complete
and are read through the packet's artifact directory instead of being forced into
the initial prompt. This does not expose files deliberately withheld by an input plan.

The workspace stores its current protocol state under `.tiangong-research/`.
Each project follows the evidence-first sequence: broad discovery, strict
admission, acquisition audit, immutable evidence freeze, analysis, synthesis,
independent review, and mechanical closure. Discover, acquire, analyze, and
synthesize run in the current interactive Codex, Claude Code, WorkBuddy, or
CodeBuddy session. The CLI never launches a nested producer process. Independent review
runs through the other configured agent family's CLI, and execution is blocked
when the two roles use the same family.

Native packets direct the host to save one new JSON submission file, not to write
admitted output paths. Acquire may retrieve files and readable derivatives for
provisionally admitted sources through the packet's binding/registration commands;
it may not reopen discovery. Analyze, synthesize and the isolated reviewer retain
their no-new-evidence boundary. Headless reviewer prompts remain capsule-scoped
and return JSON rather than saving native submission files.

Every workspace mutation is serialized by an owner-recorded directory lease
with a heartbeat. A later command immediately reclaims a lease whose same-host
owner process is definitely dead; an unverifiable cross-host lease is reclaimed
only after its heartbeat expires. The CLI also recognizes and safely recovers
the single-file lock left by a killed earlier release. Recovery is appended to
the workspace journal using only the prior operation, time, reason, and a
one-way lock identifier—never a PID, hostname, or host path. A live or
unverifiable owner returns `RESEARCH_WORKSPACE_LOCKED` with a minimum action and
must not be bypassed by manually deleting lock state. Idempotent commands such
as an already-recorded download bind may then be replayed normally after safe
recovery.

Independent reviewer execution always requires `/usr/bin/sandbox-exec` on macOS
or Bubblewrap (`bwrap`) on Linux. `reviewerExecution.transport=native-direct`
creates that capsule in the current process. `sandbox-bridge` sends one
hash-bound request to an owner-started, exact-version sidecar outside an IDE
sandbox; the sidecar creates the same capsule and returns an Ed25519-signed
attestation bound to workspace/config/runtime/capsule/request/result/model and
policy hashes. The two transports are explicit and never fall back to each
other. Windows can inspect and configure workspaces but
does not launch reviewer packages; smoke-test setup reports a non-blocking
warning there, while production readiness fails closed. The current native producer remains governed
by its host application's own permissions; the CLI supplies a hash-bound packet
and deterministic broker commands, not a second nested sandbox or agent.

Add immutable local evidence, verify the workspace, and execute ready work:

```bash
tiangong-ai research project input add gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --path /absolute/path/to/inventory.csv \
  --role primary
tiangong-ai research workspace doctor --workspace /absolute/path/to/workspace
tiangong-ai research workspace doctor --workspace /absolute/path/to/workspace \
  --agent-smoke --capability-smoke
tiangong-ai research run --workspace /absolute/path/to/workspace \
  --project gpu-resource-impact --progress-jsonl
# When stopReason is native-stage-required, perform the returned stage here:
tiangong-ai research project stage prepare gpu-resource-impact \
  --stage discover --host-agent workbuddy \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project stage submit gpu-resource-impact \
  --session SESSION_ID --output /absolute/path/to/discover.json \
  --confirm-model EXPECTED_MODEL \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research status --workspace /absolute/path/to/workspace --json
```

For WorkBuddy/CodeBuddy, keep Default Permission and start the sidecar from a
separate native terminal with a private non-symlink state directory outside the
workspace:

```bash
tiangong-ai research reviewer serve \
  --workspace /absolute/path/to/workspace \
  --state-dir /absolute/private/reviewer-sidecar --json

# From the sandboxed IDE:
tiangong-ai research reviewer status --workspace /absolute/path/to/workspace --json
tiangong-ai research reviewer doctor --confirm-agent-smoke-cost \
  --workspace /absolute/path/to/workspace --json
```

Sidecar readiness includes real filesystem negative probes and a fixed
`execute|fingerprint|status` protocol. It has no arbitrary-command endpoint;
reviewer shell, browser, web, undeclared MCP, and Skill tools remain disabled.
Do not use Full Access, sandbox-disable flags, unsandboxed-command exceptions,
or silent transport fallback.

WorkBuddy/CodeBuddy capsule teardown never requests recursive bulk deletion
inside the outer IDE. Native stages remove only the single active-session
binding, while completed, aborted, handed-off, and reviewer/work-package
capsules are retained. The journal records
`capsuleDisposition=retained-outer-sandbox` plus a non-sensitive capsule ID.
Native Codex/Claude hosts normally keep automatic capsule deletion. On Linux/WSL,
when Claude refreshes an owner-only `.credentials.json` capsule copy, the CLI
persists it through a same-directory atomic replacement only while the configured
owner path, real path, mode, and initial hash remain unchanged. Concurrent owner
changes or an unverifiable replacement fail closed and retain the capsule with
`capsuleDisposition=retained-auth-reconciliation` plus a non-sensitive capsule ID
for owner recovery. Static environment credentials are never written back. No path
silently falls back to Full Access, and retained capsules are never reported as
active sessions.

The discover packet derives a bounded multi-channel plan from reviewed evidence
requirements. Required channels run first; exact repeated requests reuse the
project cache without another provider call but still consume a bounded context
view; remaining views are spent only on explicit coverage,
counterevidence, date, applicability, or full-text gaps. Native Web/Browser
leads may be registered as supplemental candidates, but they cannot be admitted
until the same canonical URL/DOI has an immutable broker occurrence. Registered
inputs are formal candidates under their own content-hash identity.
The acquire packet audits every provisional source and registers only explicit
files—never a directory or “latest download.” PDF and Office artifacts are
structurally verified and content-addressed. A registered binary full file is
review-bound but is not counted as producer-readable full text unless an
admitted UTF-8 text/JSON/HTML/CSV/Markdown derivative exists. Such a derivative
names its registered parent and inherits that parent's canonical source URL;
it does not invent a second network-download binding, and a conflicting URL is
rejected.

For top-journal work, the frozen scientific design maps every required evidence
role to all applicable lawful acquisition routes in the configured environment.
Every declared agent route for a required role is mandatory, and every required
capability must map to an available locked broker route at preflight.
Each broker call carries its exact `acquisition_route_id`; native activity and
download records carry `acquisitionRouteId`. A missing or mismatched route ID is
rejected rather than becoming evidence that a method was tried.

Inspect the live, hash-verified route state before declaring a material evidence
ceiling:

```bash
tiangong-ai research project access status gpu-resource-impact \
  --workspace /absolute/path/to/workspace --json
```

Once all agent routes are terminal, the command first recommends assessing
required evidence-role coverage. Its `ifEvidenceStillInsufficient` field is a
conditional access/scope action, not a claim that purchase is always necessary.

Successful broker/native/download completion, explicit broker authentication or
entitlement denial, and validated deterministic no-OA download outcomes can be
terminal. HTTP 422, malformed requests, configuration errors, timeouts, 429,
5xx, cancelled downloads, and login/MFA/CAPTCHA/security challenges are not
route exhaustion. Challenges pause immediately through an
`interactive-challenge` handoff.

Only after every required plan-bound agent route for a still-missing required
evidence role has exact terminal event hashes may the native host submit a
schema-v2 `evidence-exhausted` handoff. The durable handoff names each remaining
purchase, subscription, institutional authorization, owner input, external data
request, or field collection action with an official non-sensitive locator and
resume criteria. Research then stops; it does not spend more budget on
low-yield substitutes. If no lawful remaining route exists, the user must narrow
or abandon the unsupported scope before a new reviewed generation can resume.

Before submitting an acquisition audit, inspect its exact current eligibility:

```bash
tiangong-ai research project evidence content forecast PROJECT \
  --input /absolute/path/acquisition-audit.json --workspace /absolute/workspace --json
```

This read-only check uses the freeze path's source projection and coverage
rules, checks registered artifact bytes and provenance, and forecasts required
roles from potentially assignable source dimensions. Exit `3` identifies known
deficits; exit `0` means only potential eligibility, never successful atom
registration, content freeze, independence certification, or review. Pending
input materialization, decomposition, and exact atom assignments remain
explicit. Re-run after material acquisition changes, not after every atom.
`submissionGate` separately reports deterministic acquire-submit blockers;
`potentially-ready` is not an inference/content pass. An accepted binary without
required readable content stops before submission, while an honest incomplete
audit may still freeze its limitations and separate inference-stop decision.
An admitted local PDF/Office file alone is not producer-readable. Forecast uses
the same media rules as artifact registration and reports a missing readable
derivative unless a verified readable artifact or admitted text/context input
is available. This classification does not reread or decode the binary again.
Flat `sourceTypeRequirements` arrays mean **all-of**. A design may instead use
`{"allOf":["academic-paper"],"anyOf":["government","industry"],"atLeast":{"count":2,"from":["academic-paper","government","industry"]}}`;
every present group applies, and counts use distinct types. Forecast, typed
content, and scientific review use the same source-type evaluator.

Acquisition freezes an immutable evidence snapshot even when lawful retrieval
ends with explicit gaps. Before inference, decompose every acquired PDF,
spreadsheet, archive, or structured file into exact lineage-bound producer-
readable artifacts; register line-range or JSON-Pointer evidence atoms; then
freeze `content-snapshot.json`. `research status --json` exposes acquisition,
content, inference, and graph state under `evidencePipeline` and does not direct
the operator to analysis while content preparation is missing or stopped.
Only passing acquisition/content gates and required scientific reviews can
freeze `inference-snapshot.json`. Analyze schema v2 binds that exact snapshot,
a reproduced analysis run, source IDs, atom IDs, and design claim IDs; the CLI
then creates `claim-evidence-graph.json` mechanically. The reviewer and
mechanical closure bind and recheck the full chain, ledger, receipts, selected
artifacts, excerpts, analysis, graph, and report. Refresh a
closed result with `research project addendum SOURCE --to TARGET`; the original
closure remains unchanged, the child snapshot records a mechanical delta, and
default status hides the superseded project (`research status --all` shows full
lineage).

For many content records, use `research project evidence decomposition batch
<project-id> --record <absolute-json>` or `research project evidence atom batch
<project-id> --record <absolute-json>`, with `--workspace` and `--json` as needed.
The input is `{"schemaVersion":1,"records":[...]}`; each item has exactly the same
schema and validation as the corresponding single-record command. A batch is
bounded to 500 records and 4 MiB of input. The CLI verifies acquisition/artifact
bindings once per batch, groups atoms by artifact to read and parse each referenced
document once without retaining all files in memory, and commits one hash-bound
immutable envelope through one ledger event. A bad item commits nothing; identical
replay is idempotent and a changed ID is rejected. Uncommitted envelopes are never
visible and a retry can safely complete their commit. `work` reports deterministic
verification, read, and append counts; no persistent verification cache is trusted.

Retrieve these CLI-owned input schemas with `research schema show evidence-atom`,
`artifact-decomposition`, `evidence-atom-batch`, or `artifact-decomposition-batch`
and `--json`. Help and command intake share the batch-limit constants. Schemas
validate structure; execution still checks exact artifact/lineage bindings,
locator semantics, stage, and sensitive content. A schema pass is not admission.

Before a potentially large download, use the offline command
`research project evidence artifact preflight --bytes <known-bytes> --workspace
<path> --json`, or replace `--bytes` with `--path <exact-local-file>` for a stat-only
check. `budget.maxBytesPerArtifact` bounds one acquired/downloaded file;
`budget.maxBytesPerPackage` separately bounds aggregate generated stage outputs.
Both are exposed in preflight, and native packets expose `maxArtifactBytes` beside
`maxOutputBytes`. Their defaults remain 20 MiB in smoke mode and 512 MiB in
production. A missing artifact field in an existing configuration retains its
existing package limit in memory without rewriting the owner's file; an explicit
invalid limit is rejected. Preflight exit 3 means stop and request a provider-side
subset/filter or smaller official export preserving required variables/provenance.
A size pass is not content acceptance: download binding, format, archive-expansion,
SHA-256, and snapshot checks still apply. This is not a large-file streaming or
external-reference bypass.

Use acquisition `gaps` only for unresolved blocking evidence deficiencies;
`limitations` holds non-blocking scope constraints and intentionally sealed
outcomes. Future Policy obligations stay in the scientific design and appear
in `futureGateObligations`, including ordinary planned rules without pending
model/uncertainty objects. Their declared gate remains authoritative.

Accepted local inputs are normalized into immutable input-backed artifacts while
the acquire package is still active. JSON, CSV, Markdown, and plain-text inputs
therefore have an atom-capable identity even when the producer omitted an
artifact ID. Binary inputs such as XLSX are registered for audit but still need
a producer-readable derivative in the acquisition decision; the CLI returns
`RESEARCH_INPUT_ATOMIZATION_REQUIRED` before closing acquire when that derivative
is missing. An input hash drift stops normalization instead of silently binding
new bytes. Input-backed artifacts remain packet-bound, while an explicitly
bounded input context continues to control what producer and reviewer prompts
embed.

Use `research run --project <id>` for an auditable project-scoped run: only
that project is checked, scheduled, summarized, and bound to the top-level
JSON/JSONL `projectId`, so historical blocked siblings do not alter its exit
status. Omit `--project` and use `--max-parallel` only for an intentional
workspace-wide run.

Run/status share the same due scientific-gate decision: pending/prepared review,
revision-required, and stopped are distinct from a runnable native stage.
Future gates do not prevent earlier discovery or acquisition. Legitimate
historical and user/external-wait project states remain doctor-readable;
unknown states and broken evidence bindings still block readiness.

Inputs are admitted by SHA-256. Native producer preparation creates an
ephemeral, hash-bound packet directory but does not copy agent authentication
or start an agent. The independent reviewer runs with a dedicated capsule HOME
in an ephemeral platform sandbox. Only the minimal supported reviewer auth file
is copied into that HOME. A reviewer formatting repair reuses that capsule copy
only after its SHA-256 still matches the owner source; changed, symlinked, or
non-owner-only authentication stops execution instead of being overwritten. For Claude, an
owner-only user `settings.json` is never
copied; only the whitelisted API key/token and HTTPS base URL fields from its
`env` object are injected in memory. Permissions, hooks, additional directories,
and unrelated settings are not admitted. Codex project-root discovery is
terminated by a capsule-local marker/config override, so a parent workspace
`.codex/config.toml` is neither required nor made readable. The workspace
credential file and the rest of the host home are not admitted. Production
doctor is blocked until `--agent-smoke` actually starts the independent reviewer
inside this boundary. The native producer is verified as the current host and
is never smoke-tested as a child process. A successful smoke creates a 24-hour
attestation bound to workspace config, capability lock, output schema, and the
resolved reviewer binary/wrapper fingerprints. Production review stops before
invocation if the attestation expires or any bound value drifts. While that
attestation remains current, a plain `workspace doctor` revalidates its hashes
and the current reviewer runtime fingerprint before reuse. Passing the smoke
flags explicitly performs fresh checks instead; missing, expired, or drifted
attestations remain blocking and include the refresh action. Use the exact
`codex` / `claude` route by default. A custom reviewer wrapper must use an
absolute `binary` plus an absolute `wrapperTargetBinary`; the runtime injects
the resolved target path and independently hashes the target executable, route
launcher/wrapper, and internal adapter. A wrapper that performs an unpinned
PATH lookup is not a reproducible route.

The CLI owns the authoritative JSON Schemas for discovery, acquisition,
analysis, synthesis, and review. Inspect one with
`research schema show <stage> --json`.
Native producer preparation returns the exact schema and prompt to the current
host; `stage submit` validates and atomically materializes its JSON. A rejected
native submission keeps the bound session for an explicit correction and never
launches a repair model. The independent reviewer receives its schema through
the reviewer CLI's structured-output option; a reviewer syntax/schema or
mechanical binding failure gets at most one separately budgeted formatting-only
repair with no research tools.

Total, per-package, output, repair, broker-response bytes, estimated broker
context tokens, context items, wall-time, output-count, output-size, and attempt
limits live in `.tiangong-research/config.json`.
New production workspaces use generous but finite runaway ceilings: 50,000,000
total tokens, USD 5,000, 30 days, and package ceilings of 12,000,000 for discovery, 2,000,000 for
acquisition, 1,500,000 each for analysis and synthesis, and 2,500,000 for
review. Primary output is bounded at 32,000 tokens and a separately invoked
repair at 16,000. The production broker hard ceiling is 256 bounded views with
32,000 context tokens per broker view. The legacy `maxInputContextTokens` setting
is an embedding/planning hint, not an input admission or artifact-read ceiling.
Top-journal admission additionally reserves three early scientific reviews at
500,000 tokens each, four final publication reviews at 750,000 each, and one
4,000,000-token revision cycle, including their finite wall-time allowances.
These values are not a target spend. Coverage-derived working plans and early
stop control ordinary use, while the finite ceilings, three attempts per
package, and explicit confirmation above the cost threshold stop runaway work.
Smoke-test workspaces retain their smaller low-cost defaults.
Before project initialization and every executable package, the control plane
requires a token and conservative price estimate to fit the finite execution budget. Native
producer stages reserve prompt, schema, admitted context, bounded broker
context, and output allowance, but the host app does not expose trusted
per-stage usage telemetry to this CLI. A successful native submit therefore
charges the full reviewed package reservation and records
`accountingMode=reserved-native-host`; submit still enforces the exact schema,
output bytes/tokens, provenance, coverage, hashes, and remaining project budget.
It does not claim a provider-side turn or output-token cap for the host app.

Independent review uses the pre-call reservation calculator and the reviewer's
provider-side structured-output/turn controls where available. Claude packet-only
review has a 64-turn provider guard; Codex uses the existing finite wall-time and
token/cost guards because its CLI has no equivalent turn flag. Planning uses a
small initial-context estimate and expected reads, not the entire corpus or an
unbounded legacy context hint. Preflight reports `inputContextTokenLimit=null`.
These are approximate estimates, not precise billing; scientific review keeps
the approved remaining cost ceiling separate from its rough read-cost estimate.
Formatting repair remains one separately budgeted,
tool-free JSON correction. Production workspaces enforce a finite 256-view
broker ceiling mechanically, while each project derives a much smaller working
budget from its reviewed coverage requirements and stops early when they are
supportable. Every successful native evidence fetch reports the remaining
working budget; excess calls are rejected before another provider request or
evidence promotion. Reviewer usage records separate input, cached-input, and
output tokens; configured pricing fills cost when the provider omits it. Run
records and JSONL progress preserve sanitized accounting mode, event/item
counts, provider turns, tool calls, reasoning tokens, and bounded provider
errors.

Every evidence source must resolve to an admitted input, a completed broker
receipt, or a completed structured data-runtime receipt. Successful broker and
data results are immutable content-addressed objects under
`.tiangong-research/evidence/objects`; receipts are project-scoped and verified
for existence, size, and SHA-256 before every capsule stages them. Independent
review binds the requirements, receipts, permanent evidence objects, inputs,
and artifact hashes. Its exact packet and merged bounded evidence context are
also content-addressed under the project `review/packets/` and
`review/contexts/` directories. Mechanical closure re-verifies the packet,
context, evidence objects, and registered local input hashes before recording
their safe locators. Capsule deletion therefore does not delete the durable
review chain.

Native discovery preparation supplies the exact staged capability manifest and
each external Skill's top-level `SKILL.md` inline or by an exact artifact reference.
It also projects every built-in data
operation dynamically, with no per-provider Research adapter. The current host
may fetch generic broker evidence with `research project evidence fetch`, whose bounded request file
contains logical IDs but no credential values. The manifest includes the locked,
non-secret HTTPS endpoint rather than only its host, and each response returns
the exact bounded context plus a hash-bound receipt while retaining the raw
object in the permanent evidence store. Host web/search/database tools cannot
substitute for a required broker receipt.

For structured sources, inspect the packet catalog and the selected operation
with `tiangong-ai data describe`, then run the exact request through:

```bash
tiangong-ai research project evidence data run <project-id> \
  --request /absolute/path/to/data-run-request.json \
  --workspace /absolute/path/to/workspace --json

# When contextView.nextCursor is non-null, continue from persisted Evidence:
tiangong-ai research project evidence data read <project-id> \
  --receipt <attempt-id> --cursor <opaque-next-cursor> \
  --workspace /absolute/path/to/workspace --json
```

This Research command calls the same TypeScript data service in-process; it does
not spawn `tiangong-ai data run`. It preserves the core data and receipt digest,
then adds the project budget, namespaced owner-only credential mapping,
content-addressed evidence/optional artifacts, candidate, ledger, journal, and
review bindings. Research data execution never inherits provider credentials
from the CLI host environment and does not fall back to `process.env`; every
credentialed operation must resolve its namespaced logical credential from the
workspace's owner-only store or it is blocked before any provider request.
Standalone `tiangong-ai data run` keeps its separate manifest-declared
environment-variable policy. A blocked data result is not promoted to evidence.
Native packets publish data commands as `workspace-cli-relative-argv`;
installed Auto Research must prefix them with its workspace-locked resolver
rather than resolving a global CLI from `PATH`.
Data Evidence continuation is read-only and does not consume another evidence-call
or provider-request budget. Provider coverage, limits reached, and Agent context
coverage are reported independently, so a result may be both partial and bounded.
Analyze and synthesize packets contain hash-verified prior-stage artifacts and
require no external evidence calls. Base and scientific review use only the
packet-bound `research_list_artifacts` and `research_read_artifact` tools; shell,
general filesystem, browser, broker and undeclared integrations remain disabled.
The same surface works through native-direct and the signed sandbox-bridge.
Small objects/excerpts are included initially; large objects are referenced without
rejecting the stage. Broker excerpts prioritize deterministic, sanitized
projections of the exact raw-response items selected by admitted evidence JSON
Pointers; uncited receipts retain metadata-only bindings, and unresolved
pointers receive a bounded-context fallback. The packet hash is schema-bound, but complete packet
metadata is not redundantly copied into model context. Full local files,
original per-receipt contexts, raw broker objects, checks and counterevidence stay
discoverable in the exact directory. Reads use opaque object IDs and byte offsets;
UTF-8 pages preserve character boundaries. Omit `length` for a 16 KiB page or use
`length: null` for the whole object, without a CLI read-length ceiling. Objects
actually read are preserved under `reads/objects/`, with exact directory and
packet/object/view hash receipts. Receipts prove bytes delivered, not comprehension
or scientific truth; actual provider/model capacity remains a limitation.

Native hosts can use the same primitives without adding an IDE integration:

```bash
tiangong-ai research project stage artifacts PROJECT --session SESSION --workspace /absolute/workspace --json
tiangong-ai research project stage read PROJECT --session SESSION --artifact OBJECT_ID --offset 0 --length 16384 --workspace /absolute/workspace --json
tiangong-ai research project stage read PROJECT --session SESSION --artifact OBJECT_ID --length all --workspace /absolute/workspace --json
```

Follow `nextOffset` for subsequent pages. `--encoding base64` explicitly requests
binary bytes; prefer a registered text derivative for interpretation. The channel
does not scan arbitrary host paths or discover files created after the snapshot.
Stopped, changed or expired native sessions cannot read through it.
The CLI mechanically derives local full-text availability, source types,
counts, date coverage, source IDs, and the coverage decision. A `partial`
dimension is usable but incomplete; a missing dimension or unmet declared
minimum blocks downstream work. Qualitative gaps remain visible without
silently changing those mechanical fields.

Method Skills are external to this project. Recommended Skills are selected
through `research setup`; a custom owner-selected database, domain index, or
other external method is admitted from an absolute reviewed definition:

```bash
tiangong-ai research capability import \
  --definition /absolute/path/to/external-capability.json \
  --workspace /absolute/path/to/workspace --json
```

`research capability catalog --json` returns the authoritative custom
definition template. Its source must identify an external git, registry, or
local artifact with an immutable reference, explicit `expectedTreeSha256`, and
license. Git references must be full 40-character commits; registry references
must be exact versions; local references must equal
`sha256:<expectedTreeSha256>`. Every source type must match the installed whole
tree before a lock can be written. Skill trees reject symlinks and excessive
file counts/sizes. Project-owned Tiangong Skills are rejected through this
generic import path; the setup catalog has separate reviewed first-party
adapters for Tiangong SCI, report, and patent search. Configure/import refuses to rewrite the lock if any
existing capability has drifted; restore it or explicitly update its source
identity and expected hash first.

External Skills use absolute paths and explicit permissions, then freeze
before execution:

```bash
tiangong-ai research capability lock --workspace /absolute/path/to/workspace
tiangong-ai research capability verify --workspace /absolute/path/to/workspace
```

A capability using `brokered-network` must declare exact `allowedHosts` and an
`http` policy with a credential-free exact `endpoint`, `method` (`GET` or
bounded JSON `POST`), one exact `accept` value, safe `staticHeaders`, `maxRequestBytes`,
`allowedContentTypes`, `maxResponseBytes`, and `maxItems`. Its optional
`coverage` block declares dimensions, source types, full-text availability,
publication-date availability, and named discovery scopes for the preflight gap
report. Mark `requiredForDiscovery: true` for every public index or
owner-whitelisted database the question must exercise. Downstream work is
blocked unless each such capability produces its own verified broker receipt;
another local file cannot substitute for it. POST request bodies may contain
only documented non-secret fields; credential-like keys are rejected, only the
body hash is persisted, and redirects are refused. GET targets and every
redirect must remain on the endpoint path (an explicitly declared `/` endpoint
grants origin-wide paths). A non-network external
method-guidance Skill stages reviewed instructions but does not grant an
undeclared tool or service call.
Optional credentials declare logical IDs, exact host scopes, header names, and
prefixes. Put only the logical value map in `.tiangong-research/.env`:

```bash
TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"source.example.api":"owner-provided-value"}
```

Prefer the non-echoing configuration command over hand editing:

```bash
tiangong-ai research capability credential set \
  --id source.example.api --from-env OWNER_DATABASE_API_KEY \
  --workspace /absolute/path/to/workspace --json
```

The broker injects declared credentials only for admitted HTTPS hosts. Agent
processes do not receive this variable. Keep the file owner-only (`chmod 600`)
and run the production setup/workspace doctor before a run. Setup doctor reuses
one capability probe and never starts the paid reviewer smoke while a blocking
static or low-cost prerequisite is already failing.
Capability doctor retries only one 429 response with bounded `Retry-After`
backoff; deterministic 4xx, missing subscription, authentication, drift, and
content-type failures stop explicitly. It retains only a bounded sanitized
provider code/detail and safe request ID, with an actionable baseline-or-
subscription decision for `OPTION_NOT_IN_PLAN`. Required evidence/reviewer
failures make `researchReadiness=BLOCKED`. Optional preprocessing, acquisition,
and authoring checks have separate readiness fields; they block only a project
or operation that explicitly lists the exact component in
`requiredCompanionIds`.
Credential diagnostics distinguish standalone ambient absence,
broker-store absence, policy-rejected injection, and provider 401/403. Every
such diagnostic identifies the execution mode, credential scope, whether a
network request occurred, and a minimum action without returning credentials
or raw authentication responses. The optional Semantic Scholar resolver check
also performs only one bounded 429 retry. A second 429 leaves acquisition
`DEGRADED`, does not block unrelated research, and never triggers a standalone
fallback; the academic adapter can still use its unchanged Unpaywall → Semantic
Scholar OA → arXiv → explicit browser-handoff order.
The broker preserves a sanitized non-2xx excerpt, safe request ID, and
`Retry-After`. It performs at most one inline 429 retry when the declared or
default delay is at most five seconds; longer throttles return an actionable
rate-limit failure instead of holding the agent call open. The journal records
the bounded retry decision without raw URLs or credentials. It supports JSON
Pointer extraction, bounded item and estimated-token views, and an explicit
public-response cache. For a JSON collection, use the returned
`contextNextOffset` as the next `item_offset`; this creates a distinct bounded
context receipt while reusing the same verified raw object instead of
refetching it. Follow upstream pagination with its next admitted HTTPS URL.
The recorded estimate is `ceil(contextBytes / 3)`. Use `cache_mode=bypass` for
a fresh public request and always for credentialed requests. Raw URLs and
credential values are never journaled.

Retry policy is classified: deterministic configuration/4xx/output failures
stop, schema failures use the formatting repair path, and rate limits or
transient server failures alone may schedule another attempt. Synthesis
semantic validation also rejects literal `/n` or double-escaped
`\\n` markers immediately before Markdown block structures. This unambiguous
case is mechanically converted to the same number of line-feed characters and
recorded as a content-free `package.output.normalized` journal event before
independent review; URLs and other unmatched text are unchanged.
Explicit recovery uses append-only management events:

```bash
tiangong-ai research project retry gpu-resource-impact --package analyze \
  --workspace /absolute/path/to/workspace
tiangong-ai research project retry gpu-resource-impact --package synthesize \
  --workspace /absolute/path/to/workspace
tiangong-ai research project fork gpu-resource-impact \
  --to gpu-resource-impact-v2 --resume-through analyze \
  --workspace /absolute/path/to/workspace
```

Selecting a completed `synthesize` package is allowed only after the downstream
independent review explicitly requested revision. The prior report is retained
read-only under `outputs/revisions/synthesize/<sha256>/report.md`; review and
closure are invalidated, while unchanged discovery, acquisition, content,
inference, analysis, and graph objects remain bound.

Recovery forks have one journal commit point. Before `project.forked` commits,
their target is staging, not an authoritative project; the original source
remains authoritative. Status, run and native/reviewer admission share that
same verified lineage view. A source typed-content snapshot is revalidated
and re-signed for the target generation instead of copying its project-bound
hash. Top-journal generations may resume only through `acquire`, because the
target-specific scientific design must complete fresh evidence-construct and
pilot-methods reviews before analysis.

After process interruption, repeat the same explicit fork request. The next
lease holder settles only hash-bound CLI-owned pending operations: before
commit it retains the interrupted target under
`lineage/interrupted-project-mutations/<operation-id>/target`, outside the
project namespace; after commit it finishes source/ledger projections. Exact
committed replay returns the existing target without recopying evidence or
repeating provider work. A different request for that target is a conflict.
An unchanged completed retry request is likewise acknowledged without another
revision or attempt. A subsequent real failure can still be retried normally.

Unknown targets, symlink replacements, modified source state and invalid
recovery metadata are not overwritten or deleted. Resolve the reported
`RESEARCH_PROJECT_RECOVERY_REQUIRED` conflict or restore a trusted backup before
retrying; do not forge control files. Read-only status ignores never-committed
directories without project state and reports existing uncommitted derived
states as invalid. Missing state for a committed project is still an error.
Recovery does not truncate a corrupt journal or claim power-loss durability.

To repair completed acquisition before any analysis attempt, prefer an explicit
same-project revision when question, Policy, design, and requirements are unchanged:

```bash
tiangong-ai research project evidence acquisition revise PROJECT \
  --expected-snapshot <current-acquisition-sha256> \
  --reason "Add the verified readable derivative before analysis" \
  --workspace /absolute/workspace --json
```

This reopens acquire, preserves discovery, exact artifacts/receipts, historical
snapshot bytes, budgets already spent, and the research-design approval. It
invalidates evidence-construct and pilot-methods approvals because their evidence
changed. Add `--include-discovery` only when new sources must be discovered or
admitted; that explicitly reopens discover then acquire without a new project or
automatic provider call. Prepare the returned stage, reuse unchanged objects,
forecast once per meaningful batch, submit the complete revised audit, and rebuild
typed content. Exact revision replay is idempotent. Stale snapshots, active native
sessions, unresolved handoffs, inference freezes, and later attempts are refused.

Changed failed/limited decomposition records can be superseded under a descendant
acquisition snapshot; unchanged records are reused. Single and batch intake share
this rule. Historical records remain immutable, and atoms from deselected artifacts
cannot fill current coverage. Same-snapshot conflicting extraction still fails.

Actual question/Policy/design changes or post-analysis work require the existing
fork/addendum flow. Pre-feature snapshots without immutable evidence records cannot
be repaired in place; use `research project fork SOURCE --to TARGET
--resume-through discover` to reuse discovery/receipts/artifacts, or explicitly
start a new generation. There is no automatic migration. A top-journal successor
requires a Policy approved for TARGET and `--design`, `--design-producer-agent`,
and `--design-producer-session`; it cannot inherit scientific approval.

### Fulfill predeclared scientific objects

At an idle boundary before analysis, register the exact code/environment files
as scientific objects, then supply only the pending slots already named in the
frozen design:

```bash
tiangong-ai research schema show scientific-fulfillment --json
tiangong-ai research scientific fulfillment status PROJECT --workspace /absolute/workspace --json
tiangong-ai research scientific fulfillment record PROJECT \
  --input /absolute/fulfillment.json --workspace /absolute/workspace --json
```

The closed input names `designSha256`, the exact `parentFulfillmentSha256`
(`null` initially), a non-sensitive reason, and arrays `modelImplementations`,
`environmentLocks`, and `parameterStates`. Model entries bind the registered
`objectLocator`, raw `sha256`, registration `recordSha256`, and the declared
`modelId`; implementations additionally supply `entrypoint`. Parameter entries
name the existing `parameterId` and every exact `stateId`, its source-derived
`value`, and admitted `evidenceAtomIds` from the frozen typed-content snapshot.
Units, state sets, ranges, factors, composition, claims, thresholds and Policy
cannot be changed through this intake. At least one pending slot is required.

Identical replay returns the same immutable record. Replacing an already-frozen
slot, guessing a parent, an active native session, or analysis/inference already
started is refused. The journal is the commit point; interrupted state projection
uses the same narrow recovery mechanism as acquisition/scope revisions.

Only the fulfillment's due gate and later scientific gates are reset; earlier
reviews remain bound to their unchanged deadline-specific design view. New review
packets include the original design, the exact fulfillment chain, the effective
view and registered code/environment bytes. Filing objects does **not** mark the
original Policy rule scientifically satisfied or certify code execution. The
existing independent reviewer must assess the actual objects and rule. Portable
audits retain the raw objects and registration metadata and verify the committed
fulfillment head, slot semantics and current review view after relocation.

### Original task, current scope, and actual checks

For a new research project, record a small original-requirement checklist after
project initialization and before any producer execution or scientific review.
The native host authors the content; the CLI owns its schema and hash bindings:

```bash
tiangong-ai research schema show task-contract --json
tiangong-ai research project task define PROJECT \
  --input /absolute/task.json --workspace /absolute/workspace --json
tiangong-ai research project task status PROJECT --workspace /absolute/workspace --json
```

Each requirement has a stable ID, acceptance condition, `checkKind` (`evidence`,
`computation`, or `proof`), and optional bindings to existing design claims and
coverage dimensions. Original wording cannot be overwritten. Old projects without
a task remain explicitly unassessed rather than retrospectively accepted.

Optional `requestProvenance` supplies `mode` (`verbatim`, `interpreted`, or
`reconstructed`), `source` (`kind: user-message|user-file`, exact `text`, `locator`
or null), and `explanation`. A null source is valid only for reconstruction.
Verbatim source text must equal `originalRequest` exactly, including BOM and line
endings. Source bytes are immutable; locator values are retained only by hash.
Missing provenance is explicitly `unrecorded`, never inferred retroactively.
Scope changes and forks preserve it. Declared origin is not authenticated authorship;
secrets are rejected before admission.
Scientific review also stages the exact supplied request-source object, so its
original bytes are available through the same packet-only read channel as its hash.

Before analysis, use `research schema show task-scope-change` and
`project task scope propose PROJECT --input FILE --expected-contract SHA` to
propose a change. Review the returned `changes.details` before/after values, then
approve only with both `--proposal SHA` and `--confirm-change SHA` on
`project task scope approve`. A generic continue instruction is not scope consent.
The record is an **operator confirmation**, not authenticated proof of a human's
identity. Scope approval does not rewrite scientific design or evidence floors;
it invalidates prior scoped scientific reviews. Withdrawn original requirements
remain visible and a fork/addendum retains original history without inheriting
task completion.

Use `research schema show task-acceptance` and
`project task acceptance record PROJECT --input FILE` after acquisition and
between native stages. Records bind the exact requirement version, source/atom/
finding IDs, and explicitly selected bounded UTF-8 result files. The declared
command is stored only by hash and is **not executed by this command**. Raw result
bytes are copied into immutable hash-addressed objects; secrets and control-store
sources are rejected. A reported computation without an observed run remains
`unverified-execution`, not an answered computational requirement. Failed,
inconclusive and not-run checks remain honest without invented results. Evidence
and proof checks need no fabricated computation. All records say
`trust=native-observation`, `executionCertified=false`.

For an actual calculation, the native host authors and reviews one ordinary
Node/Python program and explicitly requests observation:

```bash
tiangong-ai research schema show task-native-run --json
tiangong-ai research project task run observe PROJECT \
  --input /absolute/native-run.json --confirm-execution --workspace /absolute/workspace --json
tiangong-ai research project task run inspect PROJECT --run RUN_ID \
  --workspace /absolute/workspace --json
```

The closed request binds the computational requirement version, explicit
interpreter, script, environment-lock declaration, current acquisition artifact
IDs/hashes, unique output filenames, non-secret arguments and finite timeout.
Use `{input:ID}` / `{output:ID}` placeholders rather than host paths in arguments,
and name `nativeSessionId` when a producer stage is active. The CLI snapshots
inputs and plans exact output paths before invoking the ordinary program. It
adds no permission bypass or dependency installation, forwards no provider
credentials and launches no reasoning agent. The workspace lease is released
during computation. Program authoring and scientific decisions remain native.

The returned record binds runtime/code/input/output bytes, process exit/signal
and time. Use `nativeRunSha256` at acceptance; those results come only from that
run, not a directory scan or unrelated external files. Success requires a zero
exit, stable inputs and every declared output; failure/timeout/cancellation and
missing or changed outputs remain nonpassing records. Committed replay does not
run again. An incomplete interrupted run requires inspection and an explicitly
new run ID, not automatic retry. `stagingDirectoryName` is only a safe relative
local-inspection hint; permanent hash-bound objects carry audit authority.
`observation=cli-observed-native-process` is not mathematical correctness or an
authenticated execution certificate. The dependency lock is explicitly
`declared-lock-not-attested`; no hermetic-environment claim is inferred.

One unchanged result blob is stored once and appears once in the reviewer directory. The
existing independent review receives the original request, original/current
requirements, exact checks and results, and returns a bound `taskAssessment`;
there is no additional default paid review round. Missing current checks stop
before review, and stale/failed/inconclusive checks cannot be promoted to answered.
Publication packets and portable audit verification retain these relationships;
hash integrity does not prove execution, scientific validity, or editorial acceptance.
Native and scientific packets stage observed programs, locks, inputs and outputs
for exact on-demand inspection. Portable audit checks native start/completion
events, requirement versions and all run objects. It also replays read selectors
against the exact stored object, directory and packet/delivery records; a rehashed
outer inventory cannot hide missing program bytes or a changed read receipt.

`project task status` and each `research run` project summary report original and
current task completion separately from workflow completion and publication verdict.
A completed workflow or approved reduced scope must not be described as satisfying
unanswered original requirements. Use the selected runtime's help/schema discovery
once before adopting these commands; they are not an implicit runtime upgrade.

## Research Search

Forward research-oriented search requests to SCI, report, patent, and ESG edge
search sources:

```bash
tiangong-ai research search \
  --input ./sci-request.json \
  --sources all \
  --dry-run \
  --json
```

Required environment:

```bash
TIANGONG_AI_APIKEY=
```

`--input <file>` reads a JSON object and forwards it unchanged as the POST body
to every selected source. Use `--dry-run` to emit the exact request plan,
including method, URL, masked headers, input path, body, and timeout
milliseconds, without remote calls.
For quick calls, `--query <text>` builds a minimal body with `query` plus
optional `--top-k`, `--ext-k`, and `--get-meta`.

`--sources` accepts concrete IDs and presets. `default` expands to `sci`; `all`
expands to `sci,report,patent,esg`. Use source-specific endpoint or credential
overrides with `--sci-url`, `--report-url`, `--patent-url`, `--esg-url`,
`--sci-api-key`, `--report-api-key`, `--patent-api-key`, and `--esg-api-key`.
The equivalent ESG environment variables are `TIANGONG_ESG_SEARCH_URL` and
`TIANGONG_ESG_APIKEY`. When source URLs are not provided, `--api-base-url` or
`TIANGONG_AI_API_BASE_URL` may be a Supabase project root, `/functions/v1`, or
`/rest/v1`; the CLI derives the Functions base URL and appends `sci_search`,
`report_search`, `patent_search`, or `esg_search`.

## Education Search

Forward education-oriented search requests to course, education, and textbook
edge search sources:

```bash
tiangong-ai education search \
  --query "activated sludge process principles" \
  --sources all \
  --json
```

`--input <file>` forwards the JSON request body unchanged. `--query <text>`
builds a minimal body with `query` plus optional `--top-k` and `--ext-k`.
`--sources default` expands to `course`; `--sources all` expands to
`course,edu,textbook`. `course` search can use a scoped bearer token through
`--bearer-token` or `TIANGONG_EDUCATION_BEARER_TOKEN`; all education sources can
use `--api-key` or `TIANGONG_AI_APIKEY`. When source URLs are not provided,
`--api-base-url` or `TIANGONG_AI_API_BASE_URL` may be a Supabase project root,
`/functions/v1`, or `/rest/v1`; the CLI derives the Functions base URL and
appends `course_search`, `edu_search`, or `textbook_search`.

## Boundary

The CLI owns local operator workflows. Research workspaces keep bounded local
state, capability locks, isolated agent runs, usage accounting, provenance,
independent review, and deterministic closure. Research capability credentials
remain in the workspace broker and are not forwarded to agent processes.

For KB operations, the CLI sends bearer-token requests to the Tiangong KB
ingest API and records SQLite checkpoints for batch recovery. Ingest uses
the bulk runner and releases sliding-window capacity only when document status
is `completed` and both `opensearchIndexed` and `pineconeIndexed` are true. If
the status API does not return those index flags yet, the file remains in
`waiting_for_index_flags`. The backend owns authorization, collection
permissions, duplicate detection, NAS raw writes, parse queueing, and status
transitions.

## Validation

```bash
npm run test:clean:cold
npm run lint
npm run typecheck
npm test
npm run test:platform
npm run test:coverage
npm run audit:research-setup-pins
npm pack --dry-run
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

## Release

Publishing is handled by GitHub Actions in `.github/workflows/publish.yml`.
Push a `v*` tag that matches `package.json` version. The workflow publishes
`@tiangong-ai/cli` to npm through npm Trusted Publishing after lint, tests,
coverage, immutable remote Skill pin/runtime-contract audit, version
availability, and a package dry run pass.

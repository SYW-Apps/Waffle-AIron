# Pack scoping — the central store, project selection, and reproducibility

> Status: **implemented (A1–A10)**. Kept as the rationale record — the "problem"
> section below describes the behaviour as it was BEFORE this work (global packs
> auto-loading for every project), not as it is now. Written against wairon 5.1.0.

---

## The problem (as it was)

wairon has two pack stores and no concept that connects them:

| Today | Behaviour |
|-------|-----------|
| `wairon pack add <source> --global` | copies into `~/.wairon/packs` (or `WAIRON_PACKS_DIR`) and **applies to every project on the machine**, registered in no project config |
| `wairon pack add <source>` | copies into `.wai/packs/<name>` **inside the repo** and registers a relative ref in `project.yaml → extensions.packs` |

Three distinct concepts are collapsed into those two commands:

1. **Installed** — the pack is available on this machine to choose from.
2. **Selected** — *this* project applies it.
3. **Bundled** — a committed copy so the selection resolves for a clone or CI.

`--global` fuses *installed* with *selected*: a pack governs projects that never
mentioned it. Project packs fuse *selected* with *bundled*: the only way to
select is to copy the whole pack into the repo. There is no way to say "installed
here, used by this one project."

Three consequences, all real:

- **Silent doctrine.** Whatever a contributor happens to have installed
  machine-wide injects profiles, rules, assertions, and skills into every project
  on that machine. The gate, `wairon skills list`, and the MCP
  `instructions`/resources then differ per developer, and CI — which has no
  global packs — validates against a different rule set than the author's laptop.
  This bit this very repo: three tests in `tests/mcp/skill-resources.test.ts`
  and one in `tests/core/extensions.test.ts` failed locally and passed in CI,
  purely because of a globally installed pack.
- **`enforceReproducibility` is a dead flag.** Declared in
  `models/project.ts:128` with `default(true)`, written by `commands/init.ts:557`
  and `core/provision.ts:44` — and **read nowhere in `src/`**. It names precisely
  the hole the global default punches, and enforces nothing.
- **`--pack` at init does not seed.** `cli/index.ts:85-90` simply calls
  `addPack(source)` after `runInit`, identical to running `wairon pack add`
  manually. Nothing records a machine-installed pack into a new project's config,
  so "apply by default" can only be expressed as "apply to everything, always."

### Prior art: the hosted plane already models this correctly

`InstancePackPolicy` (`.wai/specs/types/instance_pack_policy.yaml`) already
carries `requiredGlobalPacks`, `defaultProjectPacks` ("declarative project packs
applied to newly initialized projects unless policy or caller opts out"),
`blockedPackNames`, and `allowedProfileIds`, driven by
`sdd_host_policy_evaluate` / `sdd_host_policy_reconcile`.

So pool + policy + apply-at-creation + reconcile **already ship** — on the hosted
side only. This design brings the local CLI in line with the model wairon
already enforces for hosted projects, rather than inventing a second one.

---

## The model

**One store per wairon install. Projects select from it by name. The store is the
runtime source; a bundle is an optional committed copy for CI and sharing.**

```
┌─ the pack store (per wairon install) ───────────────────────────┐
│  WAIRON_PACKS_DIR, else ~/.wairon/packs                          │
│    appenser/1.2.0/    sha256-9f2c…                               │
│    appenser/1.3.0/    sha256-04ab…                               │
│    org-doctrine/2.0.1/ sha256-7dd1…                              │
│  Installed ≠ applied. Nothing here governs a project by itself.   │
└──────────────────────────────────────────────────────────────────┘
                │  resolved by name@version (+ digest)
                ▼
┌─ the project selects ───────────────────────────────────────────┐
│  .wai/project.yaml → extensions.packs                            │
│    - name: appenser                                              │
│      version: 1.2.0                                              │
│  Missing from the store ⇒ a LOUD finding, never silent silence.   │
└──────────────────────────────────────────────────────────────────┘
```

### Store layout

`<store>/<name>/<version>/` — versioned, so two projects on one machine can
select different versions of the same pack. (Today's flat
`<store>/<file>.yaml` is read as `<name>@0.0.0-unversioned`; see Migration.)

### Selection in `project.yaml`

```yaml
extensions:
  packs:
    - name: appenser                   # required — the only mandatory field
      version: 1.2.0                   # optional pin; omitted ⇒ latest installed
      integrity: sha256-9f2c…           # optional pin on pack content
      source: https://…/appenser-{version}.wpack   # recorded automatically; see Sources
      bundle: true                     # optional: materialize into .wai/packs
```

A project states **which packs and which profiles it applies** — nothing else
governs it. Legacy string entries (`.wai/packs/foo.yaml`, absolute paths, module
ids) keep loading, deprecated.

### Version resolution: latest by default, pin when you mean it

`wairon pack use appenser` records **just the name**, and the selection resolves
to the **highest version installed** in the store. Adding `version:` pins it.
That keeps the common case frictionless — install a newer pack, every project
picks it up.

Floating has a cost, so it is graded rather than forbidden:

| Context | An unpinned selection |
|---------|----------------------|
| `wairon validate`, `status`, MCP | **warning** — `UNPINNED_PACK_SELECTION` |
| `wairon validate --ci` | **error** (warnings are errors in CI) |
| `wairon lock` | **warning only** — see below |

This is the severity model wairon already uses for draft specs: relaxed while you
work, strict at the gate. `enforceReproducibility: true` (the existing default) is
what raises the warning — set it `false` to silence it entirely.

**As-built correction:** the original design said `lock` would refuse a floating
selection. It does not. `validateAsComplete` escalates only the *draft-gated*
completeness codes (it flips spec statuses in memory), and `runLock` refuses on
errors alone — so a warning does not block a freeze. Making `lock` refuse would
need the rule to know it is running as-complete, which is a separate change.
Today the practical guard is `validate --ci`, which every pipeline runs anyway.
A9 (the gate StateId) does cover the related risk: a lock records WHICH pack set
validated it, so a later doctrine change invalidates the lock regardless.

Version comparison reuses the `isNewer` comparator already in
`commands/update.ts:409` (lifted into core), so no semver dependency is added.
**Ranges** (`^1.2.0`) are deliberately out of scope for v1: exact pin, or latest.

### Resolution order

1. **Bundled copy** under `.wai/packs/<name>/<version>/`, when present — the
   committed truth wins, so a clone and CI resolve with an empty store.
2. **The store**, matched on `name` + `version` (+ `integrity` when pinned).
3. Otherwise a finding — `PACK_NOT_INSTALLED`, error by default.

If both exist and their digests differ for the same `name@version`, that is
`PACK_STORE_DRIFT` (warning): the repo and the machine disagree about what the
pack contains. The bundle still applies — it is the repository's own copy — so the
warning exists to explain why an edit to the installed copy had no effect.

**A pinned `integrity` is verified on whichever path wins, recomputed from the
files.** Two things follow, and both matter:

- A committed bundle is *not* exempt. It overrides the store, which makes it the
  most important place to honour a pin, not a place to skip it — a bundle carrying
  different content while the project claims a digest would be doctrine
  substitution that validates clean.
- The store's recorded digest (`.install.yaml`) is not trusted as the answer. A
  recorded hash is only as good as the last writer, so a pack edited in place
  would satisfy a pin it no longer matches. Recomputing costs a few small file
  reads and only happens when a pin exists.

### Availability is enforced, not assumed

An unresolvable selection is an **error everywhere** — `validate`, `status`,
`lock`, `generate`, and every `sdd_*` MCP call. There is no "warn instead" knob:
a project whose declared doctrine is absent is misconfigured, and the job of the
message is to say so and say how to fix it. The finding carries the pack name,
the wanted version, the recorded `source`, and the exact commands:

```
✖ [PACK_NOT_INSTALLED] Project requires pack "appenser@1.2.0", which is not
  installed in this wairon install (~/.wairon/packs).
  Install every declared pack from its recorded source:  wairon pack sync
  Or install just this one:  wairon pack install https://…/appenser-1.2.0.wpack
  Or reconcile automatically:  wairon doctor --fix
```

`wairon doctor --fix` performs the same `sync` for missing packs, so the one
command a user already reaches for when something is off resolves this too.

This follows the rule the codebase already holds for `EXTENSION_LOAD_ERROR`:
**validation never silently runs without declared doctrine.** A weakened gate
must be loud, because a quiet gate reads as "clean."

### Sources — how a fresh machine knows where a pack comes from

A selection that names only `appenser` tells a fresh CI runner *what* it needs and
nothing about *where to get it*. So the origin is recorded and travels with the
project:

1. **The store keeps an install record per pack** —
   `<store>/<name>/<version>/.install.yaml`: the origin (URL or path), the
   content digest, the wairon version, and when it was installed.
2. **`wairon pack use` copies that origin into the selection automatically.** You
   never type a URL; using a pack you installed from a release makes the project
   self-describing.
3. **`wairon pack sync`** reads the selections, downloads each missing pack from
   its `source`, verifies `integrity` when pinned, and installs into the store.

`source` supports a `{version}` placeholder so one recorded template serves both
pinned and future versions:

```yaml
- name: appenser
  version: 1.2.0
  source: https://github.com/org/appenser/releases/download/v{version}/appenser.wpack
```

For a **floating** selection, GitHub resolves "latest" with no API call and no
token, which keeps `sync` a plain download:

```yaml
- name: appenser
  source: https://github.com/org/appenser/releases/latest/download/appenser.wpack
```

`source` also expands `${VAR}` from the environment, so a private pack can carry
a token from a CI secret without committing it:
`https://${PACK_TOKEN}@git.internal/…/appenser.wpack`.

### Where do the URLs come from? wairon hosts nothing

There is no wairon-operated pack index, and this design does not add one — **wairon
core ships zero packs** (its profiles are built in), so there would be nothing in
it. What wairon provides instead is the convention plus the tooling that makes a
release asset the natural artifact:

`wairon pack build` already emits **`<name>-<version>.wpack`**
(`sdk/src/orchestrator.ts:62`) with integrity sealed in the envelope. That file is
a GitHub release asset as-is:

```sh
wairon pack build                      # → appenser-1.2.0.wpack
gh release create v1.2.0 appenser-1.2.0.wpack
```

Both `source` shapes then work with no API call and no token:

| Selection | `source` |
|-----------|----------|
| pinned | `…/releases/download/v{version}/appenser-{version}.wpack` |
| floating | `…/releases/latest/download/appenser.wpack` |

A pack author publishes once; every consuming project gets the URL recorded for
free at `pack use`. No consumer ever types one.

### When there is no fetchable URL: bundle

Private packs, internal doctrine, air-gapped CI, and packs still under development
have no URL — and for those the answer is not "figure it out", it is
`bundle: true`. The committed copy under `.wai/packs/` resolves with an empty
store and no network at all. Every project has a working option regardless of how
its doctrine is distributed.

### The guard: an unfetchable origin must not be discovered in CI

The common development case is `wairon pack install ./appenser-1.2.0.wpack`, whose
recorded origin is a **local path** — worthless to a runner. Left alone, that
surfaces as a red CI job long after the fact. So:

- `wairon pack use` inspects the recorded origin and, when it is not fetchable,
  says so immediately and points at the two fixes.
- The selection carries the finding `PACK_SOURCE_UNFETCHABLE` — warning during
  development, **error under `--ci` and `lock`**, the same grading as
  `UNPINNED_PACK_SELECTION`. A project cannot be frozen in a state a clone
  cannot reproduce.
- `wairon pack use <name> --source <url>` records a URL explicitly when it
  differs from where the pack was installed from; `--bundle` chooses the other
  route.

**`pack install` must learn to take a URL.** Today it cannot: `resolveSourceUnit`
(`commands/packs.ts:67`) does `path.resolve(source)` and requires
`fs.existsSync`, so a URL fails with *"Pack source does not exist."* — the only
route is download-by-hand, then pass the local `.wpack`. Adding URL support is
part of A8; the archive is fetched to a temp file and handed to the existing,
already-hardened SDK extraction path (`inspectArchive` → reject code packs →
`extractPack` under hosted-strict limits), so nothing about pack validation
changes.

### No implicit network

Fetching happens **only** in explicit `wairon pack install <url>` and `wairon pack
sync` (including via `doctor --fix`). It is never triggered by `validate`,
`status`, `generate`, or an MCP tool call, because "works offline (core)" is a
stated architectural invariant (`docs/roadmap.md`). Resolution reads the store
and the bundle; nothing else touches the network.

### Bundling: the answer to CI and sharing

`bundle: true` (or `wairon pack bundle <name> [--all]`) materializes the pack
into `.wai/packs/<name>/<version>/` for committing. The bundle then satisfies the
selection with **zero machine setup** — which is what makes CI, a fresh clone,
and handing the repo to someone else work without out-of-band instructions.

The store stays the ergonomic default for day-to-day work; bundling is the switch
you throw when the repo must be self-sufficient.

### The StateId must cover the resolved pack set

**A gap in wairon today, independent of this design but made sharper by it.**

`computeStateId` (`core/statehash.ts:29-40`) hashes only the spec tree — system,
subsystems, components, interfaces, implementations, types. **The pack set is
invisible to it.** So the commit-scoped lock can be defeated through doctrine
instead of specs:

1. `wairon lock` validates the tree under `appenser@1.2.0` and records a lock
   scoped to StateId `X`.
2. The pack selection floats to `1.3.0` (or a pack is uninstalled, or the store
   is replaced) — the *rules that validated the tree* are now different or gone.
3. The spec tree never changed, so the StateId is still `X`. The lock still
   matches. **Promotion proceeds.**

That is precisely the stale-approval / time-of-check-to-time-of-use hole the
commit-scoped lock exists to close (feature request §4), entering through the
doctrine door. Locking a tree means "these specs pass this gate", and the pack
set *is* the gate.

**Implemented** — as a *second* identity, not a change to the existing one, because
the same StateId also stamps surface snapshots and drives their freshness
comparison, where doctrine is irrelevant. Folding doctrine into the one function
would have marked every vendored contract snapshot stale on a pack bump.

| Function | Covers | Used by |
|----------|--------|---------|
| `computeStateId()` | spec tree | surface snapshot stamps, `computeStateIdAt` freshness, landscape snapshots |
| `computeGateStateId()` | spec tree **+** doctrine projection | `wairon lock`, hosted lock, the promote-time re-check |

The doctrine projection covers only what can change a **verdict**: pack
identities (name/version/scope), the merged profile and language tables, patterns,
guarantee tokens, assertions, and programmatic rule names with their codes. Pack
`skills` and `instructions` are excluded — agent-facing prose cannot alter a
verdict, and including it would invalidate every lock on a documentation tweak.

`algorithm: 'sha256+doctrine'` marks the gate flavour, and `stateIdEquals`
compares the algorithm — so a lock record written before doctrine coverage can
never satisfy a gate comparison. Old locks read as **stale** and force a re-lock
rather than silently passing: the migration fails closed, which resolves what was
listed here as an open question.

Note the projection digests the *merged, resolved* profile and language tables, so
an in-place edit of a local YAML pack at the same `name@version` still shifts the
identity — which a version pin alone could not catch.

### `enforceReproducibility` gets teeth

When `true` (already the default), an unpinned, unbundled selection raises
`UNPINNED_PACK_SELECTION` — a warning during development, an error under `--ci`
and `lock` (see Version resolution). A floating version resolved off a mutable
machine store is exactly what the flag was named to prevent; grading it by
context means the default can finally be enforced without blocking day-to-day
work.

### `applyByDefault` — your "default apply at creation"

A store pack may declare `applyByDefault: true` in its manifest. `wairon init`
then writes it into the new project's selection (name + version + digest) —
explicit in `project.yaml`, visible in review, and removable. Opt out with
`wairon init --no-default-packs`.

This is what a machine-wide install *should* mean: a default for projects you
create from now on, not retroactive authority over every project on disk.

---

## CLI surface

| Command | Meaning |
|---------|---------|
| `wairon pack install <source>` | into the store; applies to nothing |
| `wairon pack uninstall <name>[@version]` | remove from the store |
| `wairon pack use <name>[@version]` | select for THIS project (writes `project.yaml`); `--source <url>` to record a fetch URL, `--bundle` to commit a copy instead |
| `wairon pack unuse <name>` | deselect |
| `wairon pack list` | store contents + this project's selections + resolution status |
| `wairon pack which <name>` | identify: resolved path, version, digest, origin (store or bundle) |
| `wairon pack sync` | install every declared-but-missing pack from its `source` |
| `wairon pack bundle <name> \| --all` | materialize into `.wai/packs/` for commit |

Deprecated, kept working with a warning: `pack add --global` → `pack install`;
`pack add` → `pack use` + `pack bundle`.

---

## CI: a reusable wairon setup step

A fresh runner has an empty store, so the gate would fail closed on
`PACK_NOT_INSTALLED` — correct, but it needs a one-line fix. Ship a composite
action at `.github/actions/setup-wairon` so consumers do not hand-roll it:

```yaml
- uses: SYW-Apps/Waffle-AIron/.github/actions/setup-wairon@v5
  with:
    version: 5.1.0        # pin the wairon binary; default = latest stable
    packs: sync           # sync (default) | none | an explicit source list
- run: wairon validate --ci
```

- **`packs: sync`** — runs `wairon pack sync`, which needs no arguments because
  every selection carries its own recorded `source`. This is the path that makes
  a cloned repo work with zero workflow configuration.
- **`packs: none`** — for a repo that bundles (`bundle: true`); the committed
  copies resolve and nothing is fetched.
- **An explicit list** — the escape hatch for a pack whose source is not recorded
  or needs credentials:
  ```yaml
  packs: |
    https://github.com/org/appenser/releases/download/v1.2.0/appenser.wpack
    https://${{ secrets.PACK_TOKEN }}@git.internal/org/private-pack.wpack
  ```
  Each entry is passed to `wairon pack install <source>` — the same command a
  human runs, so there is no CI-only code path to diverge.

Cache the store on the resolved pack digests (`~/.wairon/packs`), so a warm run
skips the downloads entirely. wairon's own `.github/workflows/ci.yml` needs none
of this, because this repo sets `useGlobalPacks: false` and selects no packs —
which is the point: its gate depends on nothing outside the repo.

## Remaining gaps this design closes or names

- **Uninstalling a selected pack.** `wairon pack uninstall` must refuse (or warn
  loudly) when a known project selects it; today nothing connects the two.
- **Transitive pack dependencies** — a pack depending on another pack — remain
  **out of scope**. Packs are leaves; a bundle of doctrine that needs another
  bundle should be one pack or two independent selections.
- **`onMissingPack` is deliberately not a field.** An absent declared pack always
  errors, everywhere.

## New findings

| Code | Severity | Meaning |
|------|----------|---------|
| `PACK_NOT_INSTALLED` | error | selected pack absent from store and bundle |
| `PACK_VERSION_UNSATISFIED` | error | present, but no installed version satisfies the range |
| `PACK_INTEGRITY_MISMATCH` | error | resolved content does not match the pinned digest |
| `PACK_STORE_DRIFT` | warning | bundle and store disagree for the same `name@version`. The bundle applies, so the store copy is silently ignored — reported so "my edit had no effect" is explained rather than mysterious. Compared only when a store copy of that exact version exists, so bundling costs no extra I/O |
| `UNSELECTED_STORE_PACK` | doctor-only | installed but applied by no route — **built as a `doctor` report rather than a named code** (it is project configuration, not a spec finding, so it never needed to enter the rule registry) |
| `UNPINNED_PACK_SELECTION` | warning; error under `--ci` / `lock` | floating selection under `enforceReproducibility` |
| `PACK_SOURCE_UNFETCHABLE` | warning; error under `--ci` / `lock` | selection is neither bundled nor fetchable (e.g. a local-path origin) |

---

## Migration

The dangerous direction is a gate going *quiet*. Every step below is loud.

1. **Legacy refs keep loading.** String entries in `extensions.packs` resolve
   exactly as today, with a deprecation notice.
2. **Flat store entries** are read as `<name>@0.0.0-unversioned`, so an existing
   `~/.wairon/packs/appenser/` keeps resolving; `pack install` rewrites to the
   versioned layout.
3. **`useGlobalPacks` default flips to `false`.** The field is still honoured, so
   a project that explicitly sets `true` is unaffected.
4. **`wairon doctor` reports the delta** — store packs that no project selected,
   selections that do not resolve, and bundle/store drift. `doctor --fix`
   converts what was being loaded implicitly into an explicit selection list, so
   upgrading is a visible diff in `project.yaml` rather than a silent change of
   enforced rules.
5. **A project with no `extensions` block and a non-empty store** gets an
   informational notice on `validate`/`status` naming exactly what stopped
   applying and how to re-select it.

`tests/core/extensions.test.ts` pins the current pre-flip default in
`documents the current default: an omitted useGlobalPacks auto-loads global
packs`, so step 3 is a deliberate one-line test change, not drift.

---

## Hosted alignment

The instance store replaces the machine store; the selection model is unchanged.
`InstancePackPolicy.defaultProjectPacks` becomes the hosted spelling of
`applyByDefault`, and `requiredGlobalPacks` becomes a policy-injected selection
every project carries. `sdd_host_pack_install` installs into the instance store;
`sdd_host_policy_reconcile` already does the reconcile half.

---

## Open questions

- ~~**Digest scope.**~~ **Resolved:** the `.wpack` envelope already carries a
  per-entry sha256 map plus a manifest digest, and `inspectArchive` reports
  `integrityVerified` (`sdk/src/types.ts:32-34`, `pack_archive_info`). The store
  digest is a canonical fold of that same per-entry map, computed identically for
  a directory install — so an archive install, a directory install, and a bundle
  of the same pack all compare equal. Nothing new to invent.
- **A named registry.** `source` templates cover the release-asset case, but every
  project repeats the URL. Resolving `appenser@1.2.0` through an index is the
  cleaner end state and a materially larger design — out of scope here rather
  than half-specified. Worth revisiting only once more than a handful of packs
  exist in the wild.
- **Profile restriction.** `projectType`/`profile` are already project-declared;
  worth deciding whether a selection may also *restrict* which of a pack's
  profiles are offered, mirroring hosted `allowedProfileIds`.
- ~~**StateId migration.**~~ **Resolved by the algorithm marker:** existing lock
  records carry `algorithm: 'sha256'` and therefore never satisfy a
  `'sha256+doctrine'` comparison, so they read as stale and force a re-lock
  instead of silently passing. Correct (those locks were taken without doctrine
  coverage and cannot be retro-verified) and it fails closed — still worth a
  release-note line.
- ~~**Should the wairon version join the gate identity?**~~ **Resolved: no — the
  rule REGISTRY does instead.** Hashing the version would invalidate every lock on
  every patch; hashing nothing would let a minor that adds a rule leave locks
  asserting they passed a gate that no longer exists. The identity keys on the
  builtin rule set (names, codes, default severities), so a release touching no
  rule keeps every lock valid and one that adds, removes, or re-grades a code
  invalidates exactly the locks it should. The project's governing `projectType`
  and `rules` config join it for the same reason — both decide verdicts.
  Residual gap, accepted knowingly: a rule whose *implementation* grows stricter
  without its name, codes, or default severity changing is not caught. Catching it
  needs the version, at the cost of churning every lock on every release.

---

## Implementation order

A3 before A4 — name-based refs must exist before the default flips — and A7
with or before A4, so migration reporting lands before behaviour changes.

1. ~~**A1**~~ **DONE** — store model: versioned `<name>/<version>/` layout,
   content digests, per-pack install records, `pack install`/`uninstall`/`which`,
   and back-compat with the pre-versioned flat store (including teaching
   `discoverPacks` the versioned layout, so an installed pack never silently
   becomes invisible to the legacy auto-load path).
2. ~~**A2**~~ **DONE** — `pack use`/`unuse` + the `PackSelection` schema
   (name-only, optional `version`/`integrity`/`source`/`bundle`). `use` copies the
   store's recorded origin into the selection, so the project self-describes how
   to obtain its doctrine, and warns when that origin is not fetchable.
3. ~~**A3**~~ **DONE** — name-based resolution with bundle-then-store order and
   latest-installed when unpinned (landed with A2, because a selection you can
   write but not resolve is worse than useless), plus the distinct finding codes
   as a registered `pack-resolution` rule: `PACK_NOT_INSTALLED` (absent),
   `PACK_VERSION_UNSATISFIED` (installed, but the pin is not — the message names
   what *is* installed), and `PACK_INTEGRITY_MISMATCH` (content off the pinned
   digest). All error severity, all in `wairon rules list` and therefore tunable
   via `rules.sddRuleSeverity`, unlike the generic `EXTENSION_LOAD_ERROR` they
   replaced. Resolution stays in the loader and the rule only surfaces what it
   found, so the two can never disagree about whether a pack applies.
4. ~~**A7**~~ **DONE** — `wairon doctor` reports unresolvable selections,
   installed-but-unapplied packs, and opted-in machine-wide packs;
   `doctor --fix` records the unapplied set as explicit name+version selections
   and turns machine-wide loading off. It refuses to invent selections for a
   project that deliberately applies nothing, distinguishing "never decided"
   (absent field in the raw file) from "chose deliberately".
5. ~~**A4**~~ **DONE** — `useGlobalPacks` defaults to `false`, behind the single
   `GLOBAL_PACKS_DEFAULT` constant that every reader and config writer shares.
6. ~~**A5**~~ **DONE** — a store pack declaring `applyByDefault: true` is seeded
   into the selections of projects created from then on by `wairon init`, as an
   explicit name@version entry. A pack whose manifest will not load seeds nothing.
7. ~~**A6**~~ **DONE** — the flag was declared, defaulted to true, and read
   NOWHERE. A new `pack-reproducibility` rule raises
   `UNPINNED_PACK_SELECTION` and `PACK_SOURCE_UNFETCHABLE` as warnings while you
   work and errors under `--ci`, so a one-line `pack use` stays frictionless
   while CI refuses a pack set it cannot reproduce. A bundled selection is exempt:
   its committed bytes ARE the pin.
8. ~~**A8**~~ **DONE** — `pack bundle` (a committed copy that resolves before the
   store, pinning the selection's version so the bytes and the declared intent
   cannot drift), URL support in `pack install` (fetched to a temp file, then the
   identical SDK archive path — no second validation route), and `pack sync`,
   which takes **no arguments** because every selection carries its own source.
   `{version}` and `${VAR}` expansion make one recorded template serve pinned,
   floating, and private-with-a-CI-token cases. Fetching lives only in these two
   commands, never in resolution, so the offline invariant holds.
9. ~~**A9**~~ **DONE** — the gate StateId. Implemented as a *second* identity
   rather than a change to the existing one: `computeStateId` still hashes the
   spec tree alone (surface snapshot stamps, freshness comparisons), and
   `computeGateStateId` hashes the tree plus the doctrine projection. `lock` and
   the promote-time re-check use the gate flavour; `algorithm: 'sha256+doctrine'`
   makes the two incomparable, so pre-upgrade lock records read as stale.
10. ~~**A10**~~ **DONE** — `.github/actions/setup-wairon`, with `packs: sync |
    none | <explicit list>` and the store cached on `.wai/project.yaml` (that file
    *is* the declaration of what the store must contain). Landing it exposed that
    `install.sh` had no way to pin a version at all — it always fetched latest —
    so the action's `version` input would have silently lied. `install.sh` now
    honours `WAIRON_VERSION`, which is what makes a pinned CI install real.
    (`install.ps1` still has no equivalent; a Windows runner cannot pin yet.)

A3 before A4 (name refs must exist before the default flips). A7 before A4
(reporting before behaviour). A8 before A10 (the action calls `pack sync`). A9 is
independent and can land at any point — it is a correctness fix that stands on its
own, so it need not wait for the rest.

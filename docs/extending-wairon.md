# Extending wairon — packs & wrapper products

Wairon core is a spec engine and a rule enforcer. Everything platform- or
product-specific — custom architectural profiles, language/platform tables,
extra conformance rules — is injected from outside through **extension
packs**: plain configuration files (YAML, or a JS module for programmatic
rules) that wairon reads and imports. A product built this way (a
*wrapper*) is just packs + an installer on top of the user's existing
wairon installation: no fork, no build step, and wairon core never learns
the platform exists.

A working wrapper lives at [`examples/wrapper/`](../examples/wrapper/) and
is guarded by `tests/examples/wrapper-example.test.ts`, so it cannot
silently rot.

## Installing and selecting packs

> **New model (preferred).** Installing a pack makes it *available*; a project
> then *selects* it. Installing no longer grants a pack authority over every
> project on the machine — see [pack scoping](design/pack-scoping.md).

```sh
wairon pack install ./appenser-1.2.0.wpack   # into this wairon install's store
wairon pack which appenser                   # which version/digest/origin resolves?
cd my-project
wairon pack use appenser                     # THIS project applies it
```

`pack use` records the selection by name in `.wai/project.yaml`, carrying the
origin the pack was installed from so a fresh clone or CI runner can obtain it:

```yaml
extensions:
  packs:
    - name: appenser
      version: 1.2.0          # only when pinned; omit to track latest installed
      integrity: sha256-…      # written by --pin
      source: https://…/appenser-{version}.wpack
```

- `--pin` freezes the resolved version **and** its content digest.
- `--source <url>` records an explicit fetch URL (overriding the install origin).
- `--bundle` marks the pack for committing under `.wai/packs/`, so the repo needs
  no machine setup at all — the answer for private packs and air-gapped CI. A
  committed bundle resolves *before* the store.
- `wairon pack unuse <name>` drops the selection; the pack stays installed.

**A declared pack that cannot be resolved is an error**, not a silent skip:
`validate`, `status`, `lock`, `generate`, and every `sdd_*` MCP call refuse and
name the pack plus how to install it. A gate that quietly enforces less than the
project declared is worse than one that fails.

The code names the remedy, so the message tells you which fix applies:

| Code | Meaning |
|------|---------|
| `PACK_NOT_INSTALLED` | absent from both the store and `.wai/packs/` — obtain it (`pack sync` / `pack install`) |
| `PACK_VERSION_UNSATISFIED` | the pack *is* installed, but not at the pinned version (which the message lists) — correct the pin |
| `PACK_INTEGRITY_MISMATCH` | resolved content does not match the pinned digest — reinstall, or update the pin if the change is intended |

All three are error severity and appear in `wairon rules list`, so a project can
retune them through `rules.sddRuleSeverity` if it must.

If you install from a local path, no fetchable source can be recorded and
`pack use` says so — bundle it, or pass `--source`.

### Applying a pack to new projects by default

A pack in the store can ask to be selected by every project created from then on:

```yaml
# pack.yaml
applyByDefault: true
```

`wairon init` seeds it into the new project's `extensions.packs` as an explicit
`name@version` selection. That is what a machine-wide install *should* mean — a
default for new work, written where it is visible in review and removable — rather
than retroactive authority over projects that never mentioned it.

### Reproducibility

With `rules.enforceReproducibility` (the default), a selection that neither pins a
version nor bundles is reported: `UNPINNED_PACK_SELECTION` resolves to whatever
this machine happens to have installed, so a clone or CI can enforce a different
rule set than you do. `PACK_SOURCE_UNFETCHABLE` means nothing can obtain the pack
elsewhere at all.

Both are **warnings while you work** and errors under `wairon validate --ci`, so
`wairon pack use appenser` stays a one-liner while CI refuses a pack set it cannot
reproduce. `--pin` or `pack bundle` clears them; `enforceReproducibility: false`
accepts the drift deliberately.

### CI and a fresh machine

`wairon pack install` accepts an HTTP(S) URL, and **`wairon pack sync` takes no
arguments** — each selection carries its own source, so one command restores a
project's doctrine anywhere:

```yaml
- uses: SYW-Apps/Waffle-AIron/.github/actions/setup-wairon@v5
  with:
    packs: sync          # sync (default) | none (bundled repos) | explicit sources
- run: wairon validate --ci
```

Publishing a pack needs no registry — `wairon pack build` already emits
`<name>-<version>.wpack`, which is a release asset as-is:

```sh
wairon pack build && gh release create v1.2.0 appenser-1.2.0.wpack
```

`source` supports `{version}` for pinned selections, and GitHub's
`releases/latest/download/<asset>` resolves floating ones with no API call or
token. `${VAR}` expands from the environment, so a private URL can take a token
from a CI secret without committing it.

Fetching happens **only** in `pack install <url>` and `pack sync` — never during
`validate`, `status`, `generate`, or an MCP call, because the core workflow is
required to work offline.

## Governance — what a pack changes, and what a parent requires

**Packs may loosen wairon's checks, and that is by design.** Packs exist to
adjust wairon's checks and behaviour: a pack for an automation or integration
platform — system design on a far less capable runtime — may have to turn rules
down or remove concepts that cannot exist there. A pack's loosening is never a
finding. What wairon insists on is that installing a pack is **intentional**,
that its **impact is understood** before it applies, and that it applies **per
project**.

### Pack impact: shown before every pack write

```sh
wairon pack impact appenser          # or appenser@1.2.0 — writes nothing
```

The report states, and never judges:

- the pack's **doctrine against wairon's defaults** — per profile, each rule it
  loosens, raises, turns off or adds and a design depth it changes; each profile
  it adds (or builtin profile it redefines), stereotype it removes or
  discourages and edge it licenses; pack-wide, the patterns, guarantee tokens,
  language tables and assertion codes it adds;
- which of its **profiles would govern** this project;
- the **findings that change** on this project if it is applied — a dry
  validate of the current and the candidate configuration, neither written —
  introduced, resolved and regraded, with both totals. What the report says the
  findings will be is what validation reports after the write.

`pack use`, `pack unuse`, `pack add`, `pack remove`, and `pack install` when it
moves this project's floating selection all show this report and **ask before
writing**; anything but yes writes nothing. `-y, --yes` (or a run with no
terminal, as in CI) writes without the report and says so. On the MCP server,
`sdd_pack_impact` answers the same report read-only, so an agent can propose a
pack and its human applies it with `wairon pack use`.

A hosted instance does the same for its projects: the admin API, the web UI
and the hosted MCP tool `sdd_host_pack_impact` preview an install, an adoption
from the server-global catalog, or a removal with `project:read`, writing
nothing, and the web UI asks before it writes (an uploaded `.wpack` archive has
no preview yet, and the UI says so before asking). The hosted **policy** writes
— reconcile, setting a project type, and creating a project under the instance
pack policy — are unattended by nature, so they show nothing first; they return
the impact of every pack they applied instead, and a policy-governed creation
also records it in its audit event and, when it ran through an approval, on the
approval as its `executionSummary`.

### Requiring packs of members — `composition.requirePolicies`

A project that contains others ([members](cli.md#members)) can require that
they run with given packs:

```yaml
# the parent's .wai/project.yaml
composition:
  requirePolicies:
    - pack: acme/service-baseline
      version: ^1.2            # a semver range: 1.2.0, ^1.2, ~1.2.3, 1.x, >=1.2.0 <2.0.0, a || b, *
      profile: service          # optional: the member must be governed by this profile of the pack
```

A member **adopts** a requirement by selecting the pack in its own
`extensions.packs` — the same exact, digested selection `wairon pack use --pin`
records; there is no separate policy format. `*` also admits a pack that
declares no version. The hosted instance pack floor and hosted profile
selections keep working beside it; neither reads the other.

Requirements are judged **only in the family run** (`wairon validate` at a
project that declares members, or `--family`). A member's own gate never reads
its parent's requirements, so its verdict is the same with and without them.

| Code | Severity | Meaning |
|------|----------|---------|
| `POLICY_NOT_ADOPTED` | error | A member does not select a required pack, selects it unpinned (a floating selection is judged by nothing a family can reproduce), outside the range, or is not governed by the required profile. The message names the requirement and the member's selection. |
| `POLICY_DEVIATION` | notice | A member selects the pack but changes one of its settings in its own configuration — a rule severity, the design depth, a subsystem profile, a `lint.allow` over a rule the pack sets, or its naming, complexity or documentation settings. It names the setting, the pack's value and the member's. `--ci` never fails on it; a team that wants it to can raise it with `rules.sddRuleSeverity`. |
| `POLICY_REQUIREMENT_INVALID` | error | The requiring project's own `composition.requirePolicies` names a range that does not parse — reported at that project's own gate. |

The first two are tuned by the **requiring** project's `rules.sddRuleSeverity`.
A pack's own loosening of wairon's defaults is never reported by any of them.

`wairon member add`, and `wairon init` in a subdirectory, write the parent's
required packs into a new member's selection **once**, at creation — each pinned
to the highest installed version its range admits — and say what they applied
and which requirement nothing installed satisfies. Afterwards the selection is
the member's own.

## Installing packs (legacy vendoring)

**Per project (recommended for repo doctrine):**

```sh
wairon pack add path/to/pack.yaml       # or a .cjs file, or a pack directory
```

This **vendors** the pack into `.wai/packs/` and registers it in
`.wai/project.yaml → extensions.packs`. Commit `.wai/` — CI and every clone
then enforce the same doctrine; `wairon validate`, `--ci`, and the MCP
server's `sdd_validate_tree` all load packs identically, so an AI agent
authoring specs is held to the same rules as the pipeline.

**Machine-wide:**

```sh
wairon pack add path/to/pack.yaml --global
```

Installs into the global packs folder (`WAIRON_PACKS_DIR` or
`~/.wairon/packs`) — every pack there is auto-loaded for **every project on
this machine**, before the project's own packs (project packs win on
collision). Dropping pack files into that folder by hand works too; wairon
discovers `*.yaml`/`*.cjs`/`*.js` files and directories containing a pack
entry file (`pack.yaml` | `pack.cjs` | `index.cjs` | …). Because global
packs don't travel with the repo, use them for personal/org-machine
additions — a project can opt out with `extensions.useGlobalPacks: false`
for strict reproducibility.

**By hand** — packs are just config; you can skip the commands entirely:

```yaml
# .wai/project.yaml
extensions:
  packs:
    - .wai/packs/my-doctrine.yaml
```

Inspect and uninstall:

```sh
wairon pack list                 # global + project packs, what each provides
wairon pack remove <name>        # deregister + delete vendored files
wairon pack remove <name> --global
wairon init --pack <source>       # doctrine applied at project birth
```

## Distributing a wrapper product (the ZIP recipe)

Wairon is distributed as standalone CLI binaries (GitHub releases) — a
wrapper product does **not** need npm either. Ship a release ZIP containing
your pack files plus a small install script; the user unzips and runs it:

```sh
wairon pack add ./my-product-pack            # per project, or:
wairon pack add ./my-product-pack --global   # machine-wide
```

The installer injects once and leaves — from then on plain `wairon
validate` enforces the doctrine, and `wairon pack remove` undoes it. See
[`examples/wrapper/install.js`](../examples/wrapper/install.js) for the
template. A spec-only product (implementation lives on a cloud platform)
needs nothing more: the wrapped repository holds specs + docs, wairon holds
the gate.

## Declarative packs (YAML)

Data only — profiles and language/platform tables:

```yaml
name: my-doctrine

profiles:
  my-platform:                    # becomes a valid `profile` / projectType value
    family: neutral               # neutral | backend-like | frontend-like
    forbiddenStereotypes:         # error: PROFILE_FORBIDDEN_STEREOTYPE
      - types: [Actor, Supervisor]
        reason: why this platform cannot express them
    discouragedStereotypes:       # warning: PROFILE_DISCOURAGED_STEREOTYPE
      - types: [Observer]
        reason: why to avoid them here

languages:
  my-platform:                    # matched against targetLanguage (L0/L1), lowercased
    unsupportedFlow:              # warning: LANGUAGE_FOREIGN_FLOW
      # keyspace: branch | switch | forEach | for | while | doWhile | try | throw | jump
      doWhile: remodeling guidance shown to the spec author
```

Semantics worth knowing:

- `family` opts into the built-in stereotype fencing (backend-like ⇒
  frontend stereotypes are violations; frontend-like ⇒ backend runtime
  stereotypes are warned; neutral ⇒ only your explicit lists apply).
- Language tables **merge over** the built-in ones (Rust/Go/Python/C gaps);
  later packs win on collision, and project packs load after global packs —
  load order is precedence.
- Flow gating is **warning severity by design**: "possible but not clean"
  is guidance, not prohibition. `lint.allow` (with a reason) covers
  deliberate exceptions; a project can harden a code to `error` via
  `rules.sddRuleSeverity`.
- Unregistered `profile` / `projectType` names get `UNKNOWN_PROFILE`
  (warning) naming the registered set.
- `foreignBuiltins` is **deprecated**: contracts speak one language-neutral
  type grammar (see [the architecture standard](standards/architecture.md#6-entities-and-types)), so there is no
  per-language builtin vocabulary left to declare. A pack that still declares
  it loads, ignores the field and gets a `PACK_FIELD_DEPRECATED` notice; the
  field is removed in the next release.

## Pack-provided AI-agent skills

A **directory** pack can ship declarative AI-client skills (SKILL.md files)
alongside its manifest. `wairon skills install` / `wairon generate` install
them into the supported client targets, and the hosted MCP server publishes
them through the same `wairon-skill://` resource mirror as the built-ins — so
a profile can carry platform/domain implementation guidance while wairon stays
platform-agnostic. These are **AI-client skills, not MCP tools**.

```yaml
name: appenser              # a directory pack: pack.yaml + skills/
version: 1.2.0              # optional; shown as the skill's provenance version

skills:
  - id: domain-implementer
    source: skills/domain-implementer/SKILL.md   # relative to the pack directory
    targets: [claude, gemini]                     # client targets to install into
```

### Extending a builtin skill instead of standing beside it

A platform delta usually belongs *inside* the relevant builtin, not next to it.
Declare `extends` instead of `id`:

```yaml
skills:
  - extends: sdd-implement          # sdd-architect | sdd-narrative | sdd-auditor
    source: skills/make-implementer/SKILL.md
    targets: [claude]
  - id: make-control-plane          # unchanged: a genuinely new skill
    source: skills/make-control-plane/SKILL.md
    targets: [claude]
```

The section is appended to the builtin under `## Platform: <pack>`, in pack load
order, both on install and on `resources/read`. So an implementing agent reads
**one coherent instruction** with the platform part clearly attributed — instead
of noticing a parallel `appenser-make-implementer` and reconciling it, or (worse)
every wrapper forking the builtin wholesale.

- The **builtin stays wairon's**: an upgrade still updates the base text, and the
  composed skill keeps the builtin's own frontmatter, so its identity does not
  change. Only the appended sections come from packs.
- An extending skill publishes **no separate resource** — it *is* part of the
  builtin now. Untouched builtins stay byte-identical to their templates.
- `extends` pointing at a skill that does not exist is an
  `EXTENSION_LOAD_ERROR`, not a silently dropped section: an older wairon must
  never quietly fail to apply a newer pack's doctrine.
- Exactly one of `id` / `extends` per entry.

- **Namespaced install.** Every *new* pack skill installs as
  `<pack-id>-<skill-id>` (e.g. `appenser-domain-implementer`) — so skills from
  different packs never collide, and provenance is legible in the name. The
  built-in `sdd-*` skill names are reserved; a pack cannot shadow them, only
  extend them.
- **Provenance + version** come from the pack (`name` + `version`), visible in
  `wairon skills list` and each MCP resource descriptor.
- **Reproducibility** is automatic — pack skills are vendored under
  `.wai/packs/` and pinned in `project.yaml`, so they travel with the repo.
- **No change when unused** — projects with no pack skills install exactly the
  built-ins, as before.

## Teaching the connecting agent (`instructions`)

An agent that connects to a wairon MCP server is **taught the SDD model on the
handshake**: wairon returns MCP `instructions` on `initialize` — the protocol's
field for "how to use this server", which clients inject into the agent's system
prompt. It states what a spec tree is, the L0→L5 shape, the authoring order, that
the `sdd_*` schemas are self-describing, the bound project's governing profile,
the loaded packs, and — pointing rather than repeating — that
`wairon-skill://sdd-architect` must be read **before** authoring.

That default is **wairon's**, deliberately: wairon owns the model, so wairon
teaches it, and it changes with wairon versions instead of drifting across every
wrapper that would otherwise reimplement it. A pack does not restate it — a pack
appends its **platform delta**:

```yaml
# pack.yaml
instructions: >-
  Specs in this project stay target-agnostic. Make.com mechanics (method
  selector, JSON argument envelope, Router branches, blueprint patches) never
  enter a spec — read wairon-skill://appenser-architect first.
```

Blocks are appended after wairon's own text under an attributed heading
(`## From pack "appenser"`), in **pack load order** — so a reader can always tell
platform doctrine from wairon doctrine. For finer control, spell blocks out and
scope them to the governing profile the way assertions scope theirs:

```yaml
instructions:
  - text: Applies to every project this pack governs.
  - text: Router branches never appear in a spec — model them as narrative branch steps.
    profile: [make-automation]        # only when this profile governs the project
```

- A block with no `profile` always applies; a scoped block applies only when the
  project's `projectType` matches one of its entries (a block scoped to a profile
  that cannot be resolved is withheld, so platform doctrine never leaks into an
  unrelated project).
- Because the text is composed **per server construction**, a hosted instance
  reports each request's own bound project — its profile, its packs.
- Pack skills stay the place for depth. `instructions` is the map that makes an
  agent go and read them; keeping it short is the point.

## Reusable, versioned pattern references

Packs can declare named, versioned architecture patterns; component specs
reference them, and wairon resolves + surfaces the reference. This publishes a
reusable convention across projects without copy-pasting a spec shape, and
makes adoption/versioning explicit. Core only validates *identity* — the
pattern's actual constraints are enforced by the **pack's own rules**.

```yaml
patterns:
  - id: org/domain-pattern
    version: 1.0.0
    description: The organization's canonical domain-module shape.
```

A component opts in via `patterns` (matching pack + version):

```yaml
# a component spec
patterns:
  - id: org/domain-pattern
    version: 1.0.0            # optional; omit to accept any resolved version
```

- A reference to a pattern no loaded pack declares is `UNKNOWN_PATTERN_REF`; a
  pinned version with no match is `PATTERN_VERSION_MISMATCH` (both warnings,
  tunable via `rules.sddRuleSeverity`).
- Loaded patterns are listed by `wairon patterns list` (id, version, source
  pack) and exposed to programmatic pack rules via `ctx.ext.patterns`, giving
  them a stable, typed target to enforce against.

## Component variants (a dynamic layer on top of packs)

A **variant** is a named, base-anchored specialization of a core stereotype — a
"kind of `Orchestrator`/`Adapter`/`Portal`/…" (e.g. a `publisher`) — carrying
implementation guidance so the implementer treats every component of the same
variant alike, reusing one shared approach instead of reinventing it per instance.
The base stereotype stays authoritative for all of wairon's generic semantics and
dependency rules; the variant adds domain vocabulary + a stable rule target + the
guidance. It adds no dependency rule of its own: what an Orchestrator may depend on
is its `dependencyClass` field, not its variant.

**Built-in variants.** wairon ships five, described in the
[architecture standard](standards/architecture.md) §8:

| Variant | Base | Shape |
|---|---|---|
| `arbiter` | Orchestrator | subject + supplied facts → deterministic verdict + reasons |
| `projector` | Orchestrator | source model → self-contained derived view |
| `composer` | Orchestrator | templates + values → authored text or files |
| `codec` | Orchestrator | format ↔ format, both directions in one component |
| `gateway` | Portal | a Portal that authenticates, authorizes, validates or rate-limits before it dispatches |

**Three layers.** Variants load built-in first, then from the global directory
(`WAIRON_VARIANTS_DIR`, else `~/.wairon/variants`), then from the project's
`.wai/variants/`; a later layer overrides a variant with the same id, so a team can
reword a built-in's guidance without forking wairon.

Variants deliberately live **outside packs**: define one on demand — no pack edit
or release — and share it anywhere (a variant is a tiny, portable YAML). A
machine/org-wide directory makes a good variant reusable across projects, orgs,
and tenants.

```yaml
# .wai/variants/publisher.yaml  (or WAIRON_VARIANTS_DIR for machine/org-wide)
id: publisher
base: Orchestrator               # required — the stereotype this variant specializes
guidance: >
  In-process fan-out emitter. Reuse the shared publisher helper; do not
  reimplement dispatch per instance.
# target: typescript             # optional — only applies for this target language
# profile: event-driven          # optional — only applies under this profile
```
```yaml
# on a component
componentType: Orchestrator
variant: publisher
```

- A component's `variant` must resolve to a declared variant (`UNKNOWN_VARIANT`)
  and its stereotype must equal the variant's `base` (`VARIANT_BASE_MISMATCH`,
  error). A variant is always *a kind of a stereotype* — so cross-cutting
  attributes (retriable, cached) can't be variants; those stay method `guarantees`.
- **One variant per component**: a genuine combination is a *new* combined variant,
  not two stacked (combining is almost always a purity smell).
- Listed by `wairon variants list`; exposed to programmatic pack rules via
  `ctx.variants` (a stable, typed target); and — the payoff — a component's
  variant guidance and its same-variant siblings are **injected into the generated
  owner/implementer agent context**, so the implementer reuses one shared approach
  across every component of that variant.

## Programmatic packs (JS)

A CommonJS module: the same declarative fields, plus `rules`. The pack does
NOT import wairon — rules are plain objects receiving the rule context:

```js
module.exports = {
  name: 'my-rules',
  rules: [{
    name: 'my-rule',
    description: 'One paragraph: what it enforces and why.',
    codes: [{ code: 'MY_CODE', defaultSeverity: 'warning', summary: '…' }],
    check(ctx) {
      for (const comp of ctx.components) {
        // ctx: components/interfaces/implementations/types + componentMap,
        // getComponentProfile(id), targetLanguageFor(subsystemId),
        // isComponentDraft(id), ctx.ext.{profiles,languages}, …
        ctx.addIssue('warning', 'MY_CODE', 'message', comp.id, ctx.isComponentDraft(comp.id));
      }
    },
  }],
};
```

What `ctx.addIssue` gives you for free:

- **Severity overrides** — projects re-tune your code via
  `rules.sddRuleSeverity` (`error | warning | off`).
- **`lint.allow`** — a spec can suppress your *warning* on itself with a
  reasoned allow; error findings always surface. Your codes are
  automatically part of the known-code set, so allows against them don't
  trip `UNKNOWN_LINT_ALLOW_CODE`, and the staleness audit runs after your
  rules.
- **Scoping** — granular (`--subsystem`) validation filters your issues by
  the `specId` you pass; always pass one when the finding is about a spec.
- The `isDraftContext` flag only downgrades codes in the completeness set —
  for pack codes it is currently informational; pass it anyway.

Resolution: `./relative` and absolute paths resolve against the project
root; a directory loads its pack entry file; anything else resolves with
Node module semantics from the project root. A pack that fails to load or
is malformed becomes `EXTENSION_LOAD_ERROR` (error severity) — validation
never silently runs without declared doctrine. Pack rules appear in
`wairon rules list` tagged with their pack.

## What packs can NOT do — the closed flow algebra

Packs can **gate** narrative flow constructs and enforce anything over the
spec tree, but cannot add new step kinds. Reachability/region analysis
depends on a closed successor semantics, and step renumbering relocates a
fixed set of jump fields — an unknown step-reference field would silently
corrupt narratives on insert/delete. (Same reason ESLint plugins add rules,
never AST node types.) A construct that genuinely cannot be expressed with
the existing algebra is essentially never platform-specific — propose it
for core, where it lands gated-off in profiles that lack it.

## Embedding wairon as a library (advanced)

Only needed to build a branded gate binary with doctrine compiled in —
packs + installer cover everything else. Install the npm package
(`npm install @wairon/cli`) and require it; the library entry is CommonJS and
ships no TypeScript declarations:

```js
const wairon = require('@wairon/cli');

wairon.setProjectRoot(projectDir);
const extensions = wairon.loadExtensions([...packPathsOrModuleIds], projectDir);
// extensions.errors: string[] — surface these; don't run "open"
const result = wairon.validateProject({ extensions });
```

An explicitly passed `extensions` takes precedence over config/global
auto-loading. The relevant exported API: `validateProject(options)` (the
owner's gate: one project from its own files), `validateFamily(options)` (the
family run: every member's own gate verbatim, the composition of each
project's externals against their live producers, and the family checks),
`exportDesign` (the `wairon export` document — see [the format](design-export.md)),
`loadExtensions`, `loadExtensionPacks`, `loadProjectExtensions`,
`globalPacksDir`, `discoverPacks`, `setProjectRoot`, the `SddRule` /
`RuleContext` / `LoadedExtensions` / `DeclarativePack` types, `SDD_RULES`,
`composeRuleSequence`, and the spec loaders/savers. See
[`examples/wrapper/wrapper.js`](../examples/wrapper/wrapper.js).

## Spec-only wrappers

A wrapper whose implementation happens elsewhere (e.g. a cloud automation
platform) uses wairon purely for **specs + docs in the repository**. That
works out of the box; the natural configuration:

```yaml
rules:
  requireOwnedPaths: false            # agents own no source paths
  generateComponentImplementers: false
```

Narratives still carry full value: the detail dial (`full | calls-only |
intent`) describes platform scenarios as well as code, `sourcePath` is
simply omitted, and L4 `technologies` still fences vendor specifics (e.g.
a datastore product) behind their owning Adapter/Store boundaries.

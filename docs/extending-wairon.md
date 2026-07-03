# Extending wairon — packs & wrapper products

Wairon core is a spec engine and a rule enforcer. Everything platform- or
product-specific — custom architectural profiles, language/platform tables,
extra conformance rules — is injected from outside through **extension
packs**: plain configuration files (YAML, or a JS module for programmatic
rules) that wairon reads and imports. A product built this way (a
*wrapper*) is just packs + an installer on top of the user's existing
wairon installation: no fork, no npm, and wairon core never learns the
platform exists.

A working wrapper lives at [`examples/wrapper/`](../examples/wrapper/) and
is guarded by `tests/examples/wrapper-example.test.ts`, so it cannot
silently rot.

## Installing packs

**Per project (recommended for repo doctrine):**

```sh
wairon packs add path/to/pack.yaml       # or a .cjs file, or a pack directory
```

This **vendors** the pack into `.wai/packs/` and registers it in
`.wai/project.yaml → extensions.packs`. Commit `.wai/` — CI and every clone
then enforce the same doctrine; `wairon validate`, `--ci`, and the MCP
server's `sdd_validate_tree` all load packs identically, so an AI agent
authoring specs is held to the same rules as the pipeline.

**Machine-wide:**

```sh
wairon packs add path/to/pack.yaml --global
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
wairon packs list                 # global + project packs, what each provides
wairon packs remove <name>        # deregister + delete vendored files
wairon packs remove <name> --global
wairon init --pack <source>       # doctrine applied at project birth
```

## Distributing a wrapper product (the ZIP recipe)

Wairon is distributed as standalone CLI binaries (GitHub releases) — a
wrapper product does **not** need npm either. Ship a release ZIP containing
your pack files plus a small install script; the user unzips and runs it:

```sh
wairon packs add ./my-product-pack            # per project, or:
wairon packs add ./my-product-pack --global   # machine-wide
```

The installer injects once and leaves — from then on plain `wairon
validate` enforces the doctrine, and `wairon packs remove` undoes it. See
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
      - types: [Specialist]
        reason: why to avoid them here

languages:
  my-platform:                    # matched against targetLanguage (L0/L1), lowercased
    unsupportedFlow:              # warning: LANGUAGE_FOREIGN_FLOW
      # keyspace: branch | switch | forEach | for | while | doWhile | try | throw | jump
      doWhile: remodeling guidance shown to the spec author
    foreignBuiltins: [bundle]     # builtin vocabulary unambiguous to THIS language
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
packs + installer cover everything else. It requires a built checkout of
this repo as a `file:` dependency (wairon is not published to npm):

```js
const wairon = require('waffle-airon'); // this repo, built

wairon.setProjectRoot(projectDir);
const extensions = wairon.loadExtensions([...packPathsOrModuleIds], projectDir);
// extensions.errors: string[] — surface these; don't run "open"
const result = wairon.validateSddTree({ extensions });
```

An explicitly passed `extensions` takes precedence over config/global
auto-loading. The relevant exported API: `validateSddTree(options)`,
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

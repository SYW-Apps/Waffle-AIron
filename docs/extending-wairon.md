# Extending wairon — packs & wrapper tools

Wairon core is a spec engine and a rule enforcer. Everything platform- or
product-specific — custom architectural profiles, language/platform tables,
extra conformance rules — is injected from outside through **extension
packs**. A product built this way (a *wrapper*) ships as
`wairon` + its packs + its own UX: no fork, and wairon core never learns the
platform exists.

A working wrapper lives at [`examples/wrapper/`](../examples/wrapper/) and is
guarded by `tests/examples/wrapper-example.test.ts`, so it cannot silently
rot.

## Two integration paths (they compose)

**1. Config-injected** — the project lists packs itself:

```yaml
# .wai/project.yaml
extensions:
  packs:
    - .wai/packs/my-doctrine.yaml     # declarative (path relative to project root)
    - '@acme/wairon-pack'             # programmatic (requireable module id)
```

Plain `wairon validate`, `wairon validate --ci`, and the MCP server's
`sdd_validate_tree` all load and enforce these identically — an AI agent
authoring specs over MCP is held to the same doctrine as CI.

**2. Programmatic** — the wrapper owns the doctrine and embeds wairon as a
library (`npm install waffle-airon`):

```js
const wairon = require('waffle-airon');

wairon.setProjectRoot(projectDir);
const extensions = wairon.loadExtensions([...packPathsOrModuleIds], projectDir);
// extensions.errors: string[] — surface these; don't run "open"
const result = wairon.validateSddTree({ extensions });
```

An explicitly passed `extensions` takes precedence over config auto-loading.
The relevant exported API: `validateSddTree(options)`, `loadExtensions`,
`loadProjectExtensions`, `setProjectRoot`, the `SddRule` / `RuleContext` /
`LoadedExtensions` / `DeclarativePack` types, `SDD_RULES`,
`composeRuleSequence`, and the spec loaders/savers (`loadComponentSpecs`,
`saveImplementationSpec`, …).

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
  later packs win on collision — pack order in `extensions.packs` is
  precedence.
- Flow gating is **warning severity by design**: "possible but not clean"
  is guidance, not prohibition. `lint.allow` (with a reason) covers
  deliberate exceptions; a project can harden a code to `error` via
  `rules.sddRuleSeverity`.
- Unregistered `profile` / `projectType` names get `UNKNOWN_PROFILE`
  (warning) naming the registered set.

## Programmatic packs (JS)

A requireable CommonJS module: the same declarative fields, plus `rules`:

```js
/** @type {{ name: string, rules: import('waffle-airon').SddRule[] }} */
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

Resolution: module ids resolve with Node semantics from the project root
(so npm-installed packs just work); `./relative` paths resolve against the
project root. A pack that fails to load or is malformed becomes
`EXTENSION_LOAD_ERROR` (error severity) — validation never silently runs
without declared doctrine.

## What packs can NOT do — the closed flow algebra

Packs can **gate** narrative flow constructs and enforce anything over the
spec tree, but cannot add new step kinds. Reachability/region analysis
depends on a closed successor semantics, and step renumbering relocates a
fixed set of jump fields — an unknown step-reference field would silently
corrupt narratives on insert/delete. (Same reason ESLint plugins add rules,
never AST node types.) A construct that genuinely cannot be expressed with
the existing algebra is essentially never platform-specific — propose it
for core, where it lands gated-off in profiles that lack it.

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

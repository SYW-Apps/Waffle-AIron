# Example wrapper — a product built on wairon

A minimal but complete **wrapper product**: wairon stays the engine (spec
tree, rule registry, CLI, MCP), the wrapper is just packs + an installer.
"FlowOps" is a fictional low-code automation platform standing in for
Make.com / n8n / Zapier. Full reference:
[`docs/extending-wairon.md`](../../docs/extending-wairon.md).

```text
packs/flowops.yaml        declarative pack: the flowops-automation profile
                          (forbids Actor/Supervisor with a reason) and the
                          flowops language table (gates do-while and jump,
                          declares the platform's builtin vocabulary)
packs/flowops-rules.cjs   programmatic pack: one custom SddRule —
                          FLOWOPS_PORTAL_TRANSPORT (Portals in flowops
                          subsystems must be MessageBus-triggered)
install.js                the installer a wrapper actually ships: injects
                          the packs via `wairon packs add`, then leaves —
                          plain `wairon validate` enforces from then on
wrapper.js                ADVANCED: embedding wairon as a library to build
                          a branded gate binary (most wrappers skip this)
demo-project/             a spec-only project governed by the doctrine —
                          CI-clean; its .wai/project.yaml lists the packs
                          (the post-`install.js` end state, committed)
```

## Distribution model (no npm)

Wairon ships as standalone CLI binaries (GitHub releases). A wrapper
product ships a **release ZIP**: its pack files + an install script. The
user unzips and runs it — the script calls `wairon packs add` (per project,
vendored into `.wai/packs/` and committed) or `wairon packs add --global`
(machine-wide, `~/.wairon/packs`, auto-loaded for every project). Uninstall
is `wairon packs remove <name> [--global]`. The installer automates exactly
what a user can do by hand — nothing stays resident.

## Try it

```sh
npm run build
node examples/wrapper/wrapper.js              # embedded gate → clean
cd examples/wrapper/demo-project
node ../../../dist/cli/index.js validate      # config path → same doctrine
node ../../../dist/cli/index.js packs list    # see the loaded packs
```

Break something to see the doctrine bite: add an `Actor` component to the
demo project (→ `PROFILE_FORBIDDEN_STEREOTYPE`), give a Portal
`portalType: HTTP_API` (→ `FLOWOPS_PORTAL_TRANSPORT`), or mention
"Google Sheets" in a component outside `record-repository`
(→ `TECH_LEAKAGE` — the demo's `sheets-adapter` L4 declares
`technologies: [google-sheets]`). The golden test
(`tests/examples/wrapper-example.test.ts`) does exactly this, so the
example is verified on every CI run.

## Spec-only note

The demo is a **spec-only** project (the FlowOps scenarios would live on the
platform, not in this repo): `requireOwnedPaths: false` and
`generateComponentImplementers: false` in its `project.yaml`, no
`sourcePath` on L4s. Wairon still provides the full value chain — spec tree,
conformance gate, diagrams/canvas, docs — with implementation happening
elsewhere.

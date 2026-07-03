# Example wrapper — a product built on wairon

A minimal but complete **wrapper tool**: wairon stays the engine (spec tree,
rule registry, CLI, MCP), the wrapper injects its platform doctrine as
extension packs. "FlowOps" is a fictional low-code automation platform
standing in for Make.com / n8n / Zapier. Full reference:
[`docs/extending-wairon.md`](../../docs/extending-wairon.md).

```
packs/flowops.yaml        declarative pack: the flowops-automation profile
                          (forbids Actor/Supervisor with a reason) and the
                          flowops language table (gates do-while and jump,
                          declares the platform's builtin vocabulary)
packs/flowops-rules.cjs   programmatic pack: one custom SddRule —
                          FLOWOPS_PORTAL_TRANSPORT (Portals in flowops
                          subsystems must be MessageBus-triggered)
wrapper.js                the wrapper binary: embeds wairon as a library,
                          injects the packs, brands the report
demo-project/             a spec-only project governed by the doctrine —
                          CI-clean, and its .wai/project.yaml ALSO lists the
                          packs so plain `wairon validate` enforces them
```

## Try it

```sh
npm run build
node examples/wrapper/wrapper.js            # programmatic path → clean
cd examples/wrapper/demo-project
node ../../../dist/cli/index.js validate    # config path → same doctrine
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

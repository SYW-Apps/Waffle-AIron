# Examples

- **[`hosted-server/`](hosted-server/)** — a runnable, self-verifying demo of the
  **hosting server** (`wairon serve`): provision an isolated project, mint a
  scoped API key, drive the HTTP data plane (auth + a project-scoped `sdd_*` tool
  call), then lock with the state-scoped TOCTOU guard. `node
  examples/hosted-server/demo.mjs` (after `npm run build`). Reference:
  [`docs/design/hosted-mcp-server.md`](../docs/design/hosted-mcp-server.md).

- **[`wrapper/`](wrapper/)** — a product built ON wairon: extension packs
  (custom profile + language table + injected rule), the installer such a
  product ships (`install.js` → `wairon pack add`), an advanced
  library-embedding demo (`wrapper.js`), and a CI-clean spec-only demo
  project governed by the doctrine. Guarded by
  `tests/examples/wrapper-example.test.ts`, so it stays conformance-true.
  Reference: [`docs/extending-wairon.md`](../docs/extending-wairon.md).

- **[`ci/strict-gate.yml`](ci/strict-gate.yml)** — a ready-to-copy GitHub Actions
  workflow for the strict merge gate (`wairon lock-check --strict` plus
  `wairon validate --ci` through the reusable workflow, pinned to a tag), with the
  repository protections that make the approval meaningful. Reference:
  [`docs/cli.md`](../docs/cli.md#using-it-in-github-actions).

The `wrapper/demo-project/` doubles as the reference spec tree: a Portal →
Orchestrator → Repository (Store + Adapter) slice with structured params,
narratives with control flow, the detail dial, a keyed entity type, and an
L4 `technologies` declaration.

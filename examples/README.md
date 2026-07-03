# Examples

- **[`wrapper/`](wrapper/)** — a product built ON wairon: extension packs
  (custom profile + language table + injected rule), the installer such a
  product ships (`install.js` → `wairon packs add`), an advanced
  library-embedding demo (`wrapper.js`), and a CI-clean spec-only demo
  project governed by the doctrine. Guarded by
  `tests/examples/wrapper-example.test.ts`, so it stays conformance-true.
  Reference: [`docs/extending-wairon.md`](../docs/extending-wairon.md).

The `wrapper/demo-project/` doubles as the reference spec tree: a Portal →
Orchestrator → Repository (Store + Adapter) slice with structured params,
narratives with control flow, the detail dial, a keyed entity type, and an
L4 `technologies` declaration.

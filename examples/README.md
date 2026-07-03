# Examples

- **[`wrapper/`](wrapper/)** — a product built ON wairon: extension packs
  (custom profile + language table + injected rule), the installer such a
  product ships (`install.js` → `wairon packs add`), an advanced
  library-embedding demo (`wrapper.js`), and a CI-clean spec-only demo
  project governed by the doctrine. Guarded by
  `tests/examples/wrapper-example.test.ts` — this is the maintained,
  conformance-true example. Reference:
  [`docs/extending-wairon.md`](../docs/extending-wairon.md).
- **`ecommerce-platform/`** *(legacy)* — an illustrative multi-subsystem
  spec tree (orders, inventory, notifications). Predates several current
  rules (e.g. its Repository owns no members) — for reading, not as a
  conformance reference.
- **`todo-service/`** *(legacy)* — the smallest possible spec tree, in the
  pre-`.wai` flat layout.
- **`configs/` / `generated/`** *(legacy)* — a hand-written agent registry
  and generated agent files from the era before topology was derived from
  the spec tree. Kept for historical reference only; current wairon never
  reads a hand-maintained `agents.json`.

# Examples

- **[`wrapper/`](wrapper/)** — a product built ON wairon: extension packs
  (custom profile + language table + injected rule), a wrapper binary
  embedding wairon as a library, and a CI-clean spec-only demo project
  governed by the doctrine. Guarded by `tests/examples/wrapper-example.test.ts`.
  Reference: [`docs/extending-wairon.md`](../docs/extending-wairon.md).
- **`ecommerce-platform/`** — an illustrative multi-subsystem spec tree
  (orders, inventory, notifications). Predates several current rules — for
  reading, not as a conformance reference.
- **`todo-service/`** — the smallest possible spec tree, legacy flat layout.
- **`configs/` / `generated/`** — sample agent registry configuration and the
  agent files wairon generates from it.

# Architecture Standards

The canonical, language-neutral definition of wairon's architecture model — the
building blocks, patterns, entity/behavior rules, spec-tree layout, and the rules a
conformant design must obey. The schema, validator, MCP tools, and SDD skills all
reconcile to this.

- [Architecture Standard](architecture.md) — the single source of truth:
  - the two axes (containment vs refinement; folders vs files)
  - the ten building blocks + dependency rules + default interfaces
  - self-initiated processes (Actor) and external I/O / emission (Adapter)
  - object modeling: where behavior lives; composition over inheritance
  - entities & types: defined once, scoped by ownership
  - patterns (Repository, Gateway) and the Specialist-as-wildcard rule
  - `owns` vs `dependsOn`, the visibility rule, ownership-leaf vs dependency-sink
  - composition & layering (no nesting; promote to L1)
  - implementation/concurrency strategy (language-neutral)
  - spec-driven diagram generation (planned V2)
- [Language Bindings](language-bindings.md) — how the neutral strategies map to
  concrete primitives (Rust, Go, Java, C#, TypeScript, Python).

# Architecture Standards

The canonical, language-neutral definition of wairon's architecture model — the
building blocks, patterns, entity/behavior rules, spec-tree layout, and the rules a
conformant design must obey. The schema, validator, MCP tools, and SDD skills all
reconcile to this.

- [Architecture Standard](architecture.md) — the single source of truth:
  - the two axes (containment vs refinement; folders vs files)
  - the ten building blocks + dependency rules + default interfaces
  - logic as Orchestrators, bounded by a dependency class (`pure`, `read`, or a workflow)
  - the process layer (Supervisor trees, Actors, entity Actors, timers) and external I/O / emission (Adapter)
  - object modeling: where behavior lives; composition over inheritance
  - entities & types: defined once, scoped by ownership
  - the Repository pattern (one aggregate: Store, Registry, Indexes, Queries), the built-in variants (the `gateway` Portal variant among them), and the retired Specialist and Gateway stereotypes
  - `owns` vs `dependsOn`, the visibility rule, ownership-leaf vs dependency-sink
  - composition & layering (no nesting; promote to L1)
  - implementation/concurrency strategy and transactions (language-neutral)
  - spec-driven diagram generation
  - a worked example: a live auction
- [Language Bindings](language-bindings.md) — how the neutral strategies map to
  concrete primitives (Rust, Go, Java, C#, TypeScript, Python), and an Orchestrator
  as a class or a module of functions.

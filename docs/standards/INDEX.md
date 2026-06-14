# Waffler Standards & Principles

**Version:** 1.0 · **Date:** 2025-10-01

This folder is the authoritative reference for how Waffler is designed, built, and extended.
Every document here is binding for both human developers and AI agents working in this codebase.

> **For AI agents:** Read the relevant standards document(s) before writing, modifying, or reviewing
> any code in this repository. These standards override any general-purpose conventions you may have
> learned from other codebases.

---

## Authority & status

For all `waffler_core` work, `docs/waffler_core/CANONICAL_DECISIONS.md` (the ledger) is the
single source of truth for **design decisions** (component model, wire shapes, service set,
security/bus/VFS/package/runtime mechanics). **The ledger supersedes a standards document wherever
they describe a design decision** — on conflict, the ledger wins (see the ledger's "Authority order").
The standards remain authoritative for **HOW code is written**: narrative coding, single-responsibility
components and the building-block vocabulary, naming hygiene, separation of concerns, and
architecture-conformance review.

| Status | Standards |
|--------|-----------|
| **CURRENT** (code-style / still authoritative) | 00, 02, 05, 09, 10 |
| **CURRENT for code-style, but SUPERSEDED on the COMPONENT MODEL** (the ledger §0/§0.1 owns the Portal=CapabilityRegistry+InterceptorChain / Store=authoritative-no-persist / Registry=write + separate Index / no-Orchestrator-by-default model; read these for naming + narrative-coding only, NOT for the component definitions) | 01, 12, 13, 14 |
| **LEGACY / SUPERSEDED** (pre-ledger design snapshot — see banner in each) | 03, 04, 06, 07, 08, 11, 15 |

> **01/12/13/14 caveat:** these are retained as **current code-style** authority (building-block
> vocabulary, narrative coding, conformance), but their **component-model wording is superseded by the
> ledger §0.1** (Portal grew into a composed entrypoint orchestrator; Store no longer persists;
> Registry = write-path with separate read Indexes; `fs_secure`/`fs_zip` are extensions, not services).
> On any component-model conflict, the ledger wins.

Legacy documents carry a banner at the top pointing to the authoritative ledger section(s) and the
relevant per-service docs under `docs/waffler_core/services/<service>/`.

---

## Documents

| File | Topic |
|------|-------|
| [00_WHAT_IS_WAFFLER.md](./00_WHAT_IS_WAFFLER.md) | What Waffler is, why the standards exist, the core/package boundary, robustness requirements, and the target user spectrum |
| [01_ARCHITECTURE_PATTERNS.md](./01_ARCHITECTURE_PATTERNS.md) | Component roles: Portal, Orchestrator, Supervisor, Store, Registry, Observer, Specialist, Actor |
| [02_NAMING_CONVENTIONS.md](./02_NAMING_CONVENTIONS.md) | Naming rules for structs, functions, variables, packages, capabilities, and files |
| [03_MESSAGE_BUS.md](./03_MESSAGE_BUS.md) | Message bus usage: commands, events, routing, and topic/command naming conventions |
| [04_PACKAGE_SYSTEM.md](./04_PACKAGE_SYSTEM.md) | Package types, manifests, capabilities, runtimes, and the SDK contract |
| [05_CODING_STANDARDS.md](./05_CODING_STANDARDS.md) | Narrative coding, function design, code quality rules for Rust and TypeScript |
| [06_NAMESPACE_VFS.md](./06_NAMESPACE_VFS.md) | Virtual filesystem, namespace tree, entity types, and disk synchronization |
| [07_BLUEPRINT_SYSTEM.md](./07_BLUEPRINT_SYSTEM.md) | Blueprint structure, execution model, node types, variable scoping, subroutines |
| [08_SECURITY_MODEL.md](./08_SECURITY_MODEL.md) | Security middleware, permission groups, firewall rules, secrets, encryption |
| [09_ENTITY_WIRE_FORMAT.md](./09_ENTITY_WIRE_FORMAT.md) | Canonical JSON wire format for all entities (NamespaceSegment, Blueprint with context, TypeRef, ResolvedClassView): one field per concept, snake_case only, no portal-injected duplicates |
| [10_CONTEXT_TAG_SYSTEM.md](./10_CONTEXT_TAG_SYSTEM.md) | Context tag system: tag naming, well-known catalogue, package registration, compatibility rule, WafflerRuntimeContext, BridgeMechanism taxonomy, TagRegistry bus API |
| [11_TYPE_SYSTEM.md](./11_TYPE_SYSTEM.md) | Entity type system: WafflerType/Class/Interface/Enum/Signature, TypeRef, generics, self pattern, constructors, loose/strict mode, inheritance validation, per-entity compilation table |
| [12_ARCHITECTURE_CONFORMANCE.md](./12_ARCHITECTURE_CONFORMANCE.md) | Enforcement rules for applying Portal/Orchestrator/Supervisor/Store/Registry patterns correctly, with bus-centered collaboration and current drift hotspots |
| [13_STRICT_COMPONENT_RULES.md](./13_STRICT_COMPONENT_RULES.md) | Strict component taxonomy and decomposition rules: what a component is, how orchestrators/scanners/observers/routers fit, and how to split workflows into small maintainable units |
| [14_COMPONENT_BUILDING_BLOCKS.md](./14_COMPONENT_BUILDING_BLOCKS.md) | Copy-paste building block guide and minimal templates for every standard component type, including required shape, allowed dependencies, and decision rules |
| [15_SERVICE_COMPONENT_MAP.md](./15_SERVICE_COMPONENT_MAP.md) | Target component composition for each separate Waffler service, defining which portals, orchestrators, supervisors, stores, indexes, observers, specialists, and actors each service should contain |
| [16_SPEC_DRIVEN_DEVELOPMENT.md](./16_SPEC_DRIVEN_DEVELOPMENT.md) | The Spec-Driven Development (SDD) framework: 3-layer spec architecture, folder layout, YAML schemas, and the AI feedback loop for airtight design. |
| [RFC 007](../rfcs/007-blueprint-context-and-compilation-targets.md) | Blueprint context model (InvocationMode, ownership, compilation targets), route consolidation, capability filtering |
| [RFC 008](../rfcs/008-entity-type-system.md) | Entity type system: WafflerType/Class/Interface/Enum/Signature relationships, generics, self pattern, constructors, loose/strict mode, per-entity compilation |

---

## Scope of These Standards

These documents define the **expected design intent** for Waffler's codebase. They answer:

- Which component type should own a given responsibility?
- What should this thing be named?
- How should packages and the core communicate?
- What does a well-formed blueprint, package, or SDK implementation look like?
- What is allowed vs. prohibited from a security perspective?

They do **not** replace the architecture documents in `docs/2_architecture/` — those describe
*what* the system does. These standards describe *how* to implement it correctly.

---

## Relationship to Other Docs

- `docs/2_architecture/` — Detailed architecture specs (what the system does)
- `docs/standards/` — Implementation standards (how to do it correctly) ← **you are here**
- `docs/3_guides/` — How-to guides for package/extension developers
- `.ai/AI.md` — Multi-agent workflow order for AI assistants
- `.ai/GLOBAL_POLICY.md` — Non-negotiable safety and quality rules

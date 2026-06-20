# wairon — Roadmap

> Last updated: 2026-06-14

wairon is an AIDD support tool built around Spec-Driven Development. This roadmap
reflects what is actually shipped in `src/` and what is planned.

---

## Shipped

- **SDD spec tree** — L0 System → L1 Subsystem → L2 Component → L3 Interface →
  L4 Implementation → L5 Narrative, stored under `.wai/specs/`.
- **Architecture-conformance validation** (`wairon validate`) — reference
  integrity, contract↔implementation method symmetry, narrative-call
  resolution, component-stereotype dependency rules, dependency-cycle detection,
  and draft-aware severity.
- **Spec-derived agent topology** (`wairon list` / `generate`) — agents are
  derived from the spec tree (`system-architect`, `<subsystem>-owner`,
  `<component>-implementer`) and written as native subagent files. There is no
  hand-maintained agent registry.
- **Domains** (`wairon domains`) — subsystem-derived domains plus free-standing
  domains declared in `.wai/topology.yaml`, each with a derived owner agent.
- **SDD skills** (`wairon skills`) — installed into each active target tool to
  drive the spec-driven workflow in-session.
- **MCP server** (`wairon mcp`) — topology tools + `sdd_*` tools for authoring
  and validating specs.
- **Shared context** (`.wai/context/`) — project description + auto-generated
  domain map and AI guide.
- **Tooling** — `init`, `status`, self-update with release channels, command
  aliases, multi-target exporters (Claude, Gemini, custom).

---

## Planned

- **Conformance engine depth** — glob-aware ownership overlap, richer stereotype
  rules, and clearer remediation messages. This is wairon's core differentiator.
- **Spec-driven diagram generation (V2)** — the spec tree is a typed graph, so it
  renders to diagrams with no extra modeling: component/`dependsOn` → C4 &
  component diagrams, `owns` → containment diagrams, and **L5 narratives →
  sequence diagrams**. Living, always-accurate documentation from the same source
  of truth as the code.
- **Derive specs from existing code** — bootstrap a draft spec tree from a repo
  so teams can adopt conformance without greenfield modeling.
- **`wairon generate` cohesion** — optional MCP auto-registration during
  generate (currently explicit via `wairon mcp install`).
- **CI integration** — `wairon validate --ci` in PR checks; conformance diff
  reporting.
- **Org scale** — shared template libraries and cross-project standards.
- **Multi-Domain Architectural Profiles** — Support non-backend domains cleanly to prevent context waste. First version of the engine integration is shipped, supporting the following blueprints:
  - **Frontend Profiles** (`frontend-reactive` and `frontend-controller`):
    - *Concept*: Enforces a strict separation of presentation views from reactive logic custom hooks or class controllers.
    - *Stereotypes*: Introduces `View` blocks representing pure presenter elements (like React JSX, Vue templates, or Flutter StatelessWidgets).
    - *Validation*: Views are strictly passive; they cannot depend on database Stores, Registries, or Adapters. They only receive properties and forward callbacks.
  - **OS Profile** (`lowlevel-os`):
    - *Concept*: Models OS kernel scheduling loops, thread tasks, virtual filesystem blocks, and hardware interfaces.
    - *Stereotypes*: `Supervisor` maps to the kernel scheduler, `Actor` represents thread contexts/tasks, `Adapter` represents device drivers/VFS layers, and `Store` represents process tables.
    - *Zero-Cost Target*: Spec boundaries are compile-time virtual boundaries. Calls from system calls (`Portals`) to handlers are aggressively inlined, monomorphized, or resolved static-statically in systems languages (C, Rust `no_std`).
  - **Game Profile** (`game-ecs`):
    - *Concept*: Structures Entity-Component-System simulation loops.
    - *Stereotypes*: `Store` represents the component array registries, `Specialist` represents systems (e.g. Physics, Collision), and `Observer` manages game event buses.
    - *Zero-Cost Target*: Systems query data directly from entity storage, but architectural boundaries compile down to raw pointer arithmetic. Repository facade lookups are monomorphized or exploded inline.
  - **Embedded/PLC Profile** (`realtime-embedded`):
    - *Concept*: Structures real-time event loops, hardware pin control, sensor arrays, and actuator drivers.
    - *Stereotypes*: `Adapter` wraps physical pin/device register I/O, `Orchestrator` implements control loop logic (e.g., PID controllers), and `Observer` captures interrupt service routines (ISRs).
    - *Validation*: Strictly isolates controllers from hardware registers (requiring all pin access to flow through Adapter interfaces), and checks narratives for static memory guarantees (e.g., banning dynamic heap allocations).

---

## Architectural invariants

| Invariant | Why |
|-----------|-----|
| **`.wai/` boundary** | All wairon state lives under `.wai/`; nothing is written elsewhere without explicit opt-in. |
| **No hidden server** | Everything runs on-demand; the MCP server is a subprocess, not a daemon. |
| **No database** | All state is human-readable YAML/JSON. |
| **Works offline** | No network requirement; update checks are opt-in. |
| **Specs are the source of truth** | Agents and conformance are derived from `.wai/specs/`; generated files are outputs. |
| **wairon equips, not orchestrates** | wairon does not run AI sessions — it produces subagents, skills, and MCP tools the host tool consumes. |

---

## History note

Earlier drafts explored a local AI orchestration hub (session spawning,
delegation, multi-model pipelines, git worktrees). That direction was retired in
favour of equipping the host AI tool's own native subagent mechanism. The
orchestration code has been removed; this roadmap supersedes those plans.

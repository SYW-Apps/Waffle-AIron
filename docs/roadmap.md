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
- **Hosted server** (`wairon serve` / `wairon host`) — the `sdd_host` subsystem
  serves the `sdd_*` tools over streamable HTTP for many fully-isolated projects,
  each scoped per-request to its authenticated project. Split data plane
  (project-API-key auth) / admin control plane (project & key lifecycle plus a
  commit-scoped `lock`/`promote` with a promote-time state re-check). Self-host
  via Docker. See the [hosted server guide](design/hosted-mcp-server.md).

---

## Planned

- **Conformance engine depth** — glob-aware ownership overlap, richer stereotype
  rules, and clearer remediation messages. This is wairon's core differentiator.
- **Spec-driven diagram generation** — stage 1 shipped: `wairon diagram` emits
  Mermaid component diagrams (subsystem subgraphs, boundary-hop edges, `owns`
  containment, public-surface marking) and **L5 narrative → sequence diagrams**.
  Stage 2 shipped: `wairon diagram --canvas` emits an interactive single-page
  HTML canvas — subsystem/pattern boundaries as collapsible containers,
  collapsed boundaries aggregate external edges into labeled tubes,
  click-through detail panel (description, interfaces, methods, endpoints,
  narratives, dependencies, trusted links), search, and a validation-issue
  overlay. Fully self-contained (no libraries, offline). Living,
  always-accurate documentation from the same source of truth as the code.
- **Derive specs from existing code** — bootstrap a draft spec tree from a repo
  so teams can adopt conformance without greenfield modeling.
- **`wairon generate` cohesion** — optional MCP auto-registration during
  generate (currently explicit via `wairon mcp install`).
- **CI integration** — `wairon validate --ci` in PR checks; conformance diff
  reporting.
- **Org scale** — shared template libraries and cross-project standards.
- **Multi-Domain Architectural Profiles** — Support non-backend domains cleanly to prevent context waste. The engine integration is shipped (profiles resolve per subsystem, family fencing applies, extension packs register custom profiles with their own doctrine/severities/designDepth), but the depth of **builtin** doctrine varies by profile — labeled honestly below. Platform-specific doctrine is expected to arrive as extension packs (profile + rules + language table), not as core code.
  - **Frontend Profiles** (`frontend-reactive` and `frontend-controller`) — *doctrine enforced today*:
    - *Concept*: Enforces a strict separation of presentation views from reactive logic custom hooks or class controllers.
    - *Stereotypes*: Introduces `View` blocks representing pure presenter elements (like React JSX, Vue templates, or Flutter StatelessWidgets).
    - *Validation*: Views are strictly passive; they cannot depend on database Stores, Registries, or Adapters. They only receive properties and forward callbacks. `Actor`/`Supervisor` in a frontend subsystem draw a sanity warning. (The two frontend profiles currently share one doctrine; reactive-dataflow-specific checks are future work.)
  - **PLC Cyclic Profile** (`plc-cyclic`) — *core doctrine enforced today*:
    - *Concept*: Structures industrial control programs executing inside strict scan cycles (e.g., Structured Text, CODESYS, Beckhoff TwinCAT, Siemens S7).
    - *Stereotypes*: `Portal` maps to external HMI/network interfaces, `Orchestrator` maps to cyclic sequence programs, and `Specialist` / `Store` map to Function Blocks and instance memory. `cyclic` lifecycle entrypoints root the scan loop.
    - *Validation*: Strict single-threaded execution model — **forbids concurrent runtime blocks** (`Actor` and `Supervisor` stereotypes) because execution must complete deterministically inside a single scan cycle. (Narrative-level checks — e.g. flagging blocking loops without watchdogs — are *not* yet implemented.)
  - **OS / Game ECS / Embedded Profiles** (`lowlevel-os`, `game-ecs`, `realtime-embedded`) — *blueprints: today these enforce only the backend-family fencing (frontend stereotypes are refused). The stereotype mappings below are modeling guidance for humans; the platform-specific validations described are NOT implemented in core.*
    - **OS Profile** (`lowlevel-os`): Models OS kernel scheduling loops, thread tasks, virtual filesystem blocks, and hardware interfaces. `Supervisor` maps to the kernel scheduler, `Actor` represents thread contexts/tasks, `Adapter` represents device drivers/VFS layers, and `Store` represents process tables. Envisioned zero-cost target: spec boundaries as compile-time virtual boundaries in systems languages (C, Rust `no_std`).
    - **Game Profile** (`game-ecs`): Structures Entity-Component-System simulation loops. `Store` represents the component array registries, `Specialist` represents systems (e.g. Physics, Collision), and `Observer` manages game event buses. Envisioned zero-cost target: boundaries compiling down to direct storage queries. (Note: the standard dependency matrix is profile-blind today and does not yet license the ECS system→Store idiom specially.)
    - **Embedded Profile** (`realtime-embedded`): Structures real-time microcontroller firmware, hardware pin control, sensor loops, and actuator drivers. `Adapter` wraps physical pin/device register I/O, `Orchestrator` implements control loops (e.g., PID controls), and `Observer` captures hardware interrupt routines (`interrupt` lifecycle entrypoints root ISR flows). Envisioned validation: pin access strictly behind Adapters, static-memory narrative checks (banning dynamic heap allocation) — both unimplemented; ISR/memory/WCET annotations would ride the `ext:` data channel.

---

## Architectural invariants

| Invariant | Why |
|-----------|-----|
| **`.wai/` boundary** | All wairon state lives under `.wai/`; nothing is written elsewhere without explicit opt-in. |
| **No hidden server (by default)** | The core workflow runs on-demand; the stdio MCP server is a subprocess, not a daemon. `wairon serve` is an explicit, opt-in hosting daemon. |
| **No database** | All state is human-readable YAML/JSON. |
| **Works offline (core)** | The core workflow has no network requirement; `wairon serve` and update checks are opt-in. |
| **Specs are the source of truth** | Agents and conformance are derived from `.wai/specs/`; generated files are outputs. |
| **wairon equips, not orchestrates** | wairon does not run AI sessions — it produces subagents, skills, and MCP tools the host tool consumes. |

---

## History note

Earlier drafts explored a local AI orchestration hub (session spawning,
delegation, multi-model pipelines, git worktrees). That direction was retired in
favour of equipping the host AI tool's own native subagent mechanism. The
orchestration code has been removed; this roadmap supersedes those plans.

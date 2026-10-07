# wairon — Roadmap

> Last updated: 2026-10-05 (for v6.0.0)

wairon is an AIDD support tool built around Spec-Driven Development. This roadmap
reflects what is actually shipped in `src/` and what is planned. The
[CHANGELOG](https://github.com/SYW-Apps/Waffle-AIron/blob/main/CHANGELOG.md) has the per-release detail.

---

## Shipped

- **SDD spec tree** — L0 System → L1 Subsystem → L2 Component → L3 Interface →
  L4 Implementation → L5 Narrative, stored under `.wai/specs/`.
- **Architecture-conformance validation** (`wairon validate`) — a documented
  rule registry (`wairon rules list`): reference integrity,
  contract↔implementation method symmetry, narrative-call resolution and
  control-flow soundness, component-stereotype dependency rules (including the
  Supervisor/Actor doctrine and the Repository pattern), technology-leakage
  fencing, dependency-cycle detection, draft-aware severity, per-project
  severity overrides and per-spec `lint.allow`. `--ci` for pipelines.
- **Code↔spec conformance** — a spec's `sourcePath` is checked against the code:
  declared exports, methods, params and the import graph, recorded beside the
  approval and enforced by `validate --ci`.
- **One type grammar** — language-neutral type spellings (`list<T>`, `T?`,
  `async T`, `int`/`float`, enums, named value-objects, signature types), with
  `wairon doctor --fix` rewriting older spellings.
- **Approval and the merge gate** — `wairon lock` records a human's approval of
  the design as one digest per spec in the committed `.wai/lock.json` (it never
  rewrites the spec tree); `wairon lock-check` answers in CI whether the design
  being merged is the approved one, also as a reusable GitHub workflow.
- **Members, parts and projects** — a project grows from subsystems, to
  **parts** (some of its subsystems stored in another folder or repository), to
  member **projects** with their own id, exports and lock, reached as
  `alias::name`. Declared `externals` are pinned (`wairon externals pin`) and
  compared with their live producers. `validate` at a parent is the family run.
- **Family migrations and renames** — attach, detach, adopt, promote, demote,
  internalize, externalize, project and alias renames, each planned first
  (`--report` / `dryRun`) and applied all or nothing; in-tree renames of
  components, methods and types, and method moves, rewrite every reference.
- **Design export** (`wairon export`) — the whole resolved design as one JSON
  document with a published schema, stamped with the approval verdict, for
  generators and translators.
- **Spec-derived agent topology** — agents are derived from the spec tree
  (`system-architect`, `<subsystem>-owner`, optionally a
  `<component>-implementer` per component) and served as **live briefs**
  (`sdd_get_agent_brief`, `wairon agent brief`), composed from the current tree
  on every call. Agent files on disk are an opt-in materialized view
  (`rules.materializeAgentFiles`). Execution budgets derive a model tier and
  allowance per agent. There is no hand-maintained agent registry.
- **Domains** (`wairon domains`) — subsystem-derived domains plus free-standing
  domains declared in `.wai/topology.yaml`, each with a derived owner agent.
- **SDD skills** (`wairon skills`) — installed into each active target tool to
  drive the spec-driven workflow in-session.
- **MCP server** (`wairon mcp`) — topology tools + `sdd_*` tools for authoring
  and validating specs, and MCP `instructions` returned on `initialize` so a
  connecting agent is taught the SDD model (tree shape, authoring order, the
  bound project's profile and packs, read-the-skill-first) instead of depending
  on a human having briefed it. Packs append their platform delta to that text
  via `instructions` in `pack.yaml`.
- **Shared context** (`.wai/context/`) — project description + auto-generated
  domain map and AI guide.
- **Diagrams** (`wairon diagram`) — Mermaid component and L5-derived sequence
  diagrams, an interactive canvas (Cytoscape.js, embedded, works offline) with
  scoped navigation, narrative flowcharts and relation health, and editable
  draw.io / Excalidraw exports.
- **Extension packs** (`wairon pack`) — profiles, language tables, rules,
  patterns, variants and skills injected from outside; a machine pack store
  with per-project selection, pinning, bundling and `pack sync` for CI, and
  `pack impact` before every pack write.
- **Tooling** — `init`, `status`, `doctor` (health checks and upgrade
  repairs), `wairon dev` (the web UI over a local project), self-update with
  release channels, command aliases, multi-target exporters (Claude, Gemini /
  Antigravity, custom), npm packages and standalone binaries.
- **Hosted server** (`wairon serve` / `wairon host`) — the `sdd_host` subsystem
  serves the `sdd_*` tools over streamable HTTP for many fully-isolated projects,
  each scoped per request to its authenticated project. Split data plane / admin
  control plane; organization units and a permission grid; owner-bound API keys
  and SSO; a state-scoped `lock` with approval requests; hosted members as
  records of their own; git-backed projects; Notion / Miro producers; a web UI
  (canvas, specs, admin). Self-host via Docker. See the
  [hosted server guide](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md).

---

## Planned

- **Conformance engine depth** — call-graph↔narrative conformance beyond the
  current checks, event-topology completeness, and clearer remediation
  messages. This is wairon's core differentiator.
- **Upgrade automation** — more of the mechanical rewrites `wairon doctor
  --fix` leaves to an author today (for example language-flavoured result
  types), and per-member repairs run from a family's top.
- **Derive specs from existing code** — bootstrap a draft spec tree from a repo
  so teams can adopt conformance without greenfield modeling.
- **CI reporting** — conformance diffs between two revisions in PR checks (the
  pass/fail gates, `validate --ci` and `lock-check`, ship today).
- **Org scale** — shared template libraries and cross-project standards.
- **Multi-Domain Architectural Profiles** — Support non-backend domains cleanly to prevent context waste. The engine integration is shipped (profiles resolve per subsystem, family fencing applies, extension packs register custom profiles with their own doctrine/severities/designDepth), but the depth of **builtin** doctrine varies by profile — labeled honestly below. Platform-specific doctrine is expected to arrive as extension packs (profile + rules + language table), not as core code.
  - **Frontend Profiles** (`frontend-reactive` and `frontend-controller`) — *doctrine enforced today*:
    - *Concept*: Enforces a strict separation of presentation views from reactive logic custom hooks or class controllers.
    - *Stereotypes*: Introduces `View` blocks representing pure presenter elements (like React JSX, Vue templates, or Flutter StatelessWidgets).
    - *Validation*: Views are strictly passive; they cannot depend on database Stores, Registries, or Adapters. They only receive properties and forward callbacks. `Actor`/`Supervisor` in a frontend subsystem draw a sanity warning. (The two frontend profiles currently share one doctrine; reactive-dataflow-specific checks are future work.)
  - **PLC Cyclic Profile** (`plc-cyclic`) — *core doctrine enforced today*:
    - *Concept*: Structures industrial control programs executing inside strict scan cycles (e.g., Structured Text, CODESYS, Beckhoff TwinCAT, Siemens S7).
    - *Stereotypes*: `Portal` maps to external HMI/network interfaces, `Orchestrator` maps to cyclic sequence programs, and Function Blocks map to an Orchestrator with `dependencyClass: pure` or `read` over `Store` instance memory. `cyclic` lifecycle entrypoints root the scan loop.
    - *Validation*: Strict single-threaded execution model — **forbids concurrent runtime blocks** (`Actor` and `Supervisor` stereotypes) because execution must complete deterministically inside a single scan cycle. (Narrative-level checks — e.g. flagging blocking loops without watchdogs — are *not* yet implemented.)
  - **OS / Game ECS / Embedded Profiles** (`lowlevel-os`, `game-ecs`, `realtime-embedded`) — *blueprints: today these enforce only the backend-family fencing (frontend stereotypes are refused). The stereotype mappings below are modeling guidance for humans; the platform-specific validations described are NOT implemented in core.*
    - **OS Profile** (`lowlevel-os`): Models OS kernel scheduling loops, thread tasks, virtual filesystem blocks, and hardware interfaces. `Supervisor` maps to the kernel scheduler, `Actor` represents thread contexts/tasks, `Adapter` represents device drivers/VFS layers, and `Store` represents process tables. Envisioned zero-cost target: spec boundaries as compile-time virtual boundaries in systems languages (C, Rust `no_std`).
    - **Game Profile** (`game-ecs`): Structures Entity-Component-System simulation loops. `Store` represents the component array registries, `Orchestrator` represents systems (e.g. Physics, Collision), and `Observer` manages game event buses. Envisioned zero-cost target: boundaries compiling down to direct storage queries. (Note: the standard dependency matrix is profile-blind today and does not yet license the ECS system→Store idiom specially.)
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

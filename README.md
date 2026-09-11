# wairon

**Waffle AIron** — an AI-Driven Development (AIDD) support tool built around
**Spec-Driven Development (SDD)**.

> **Status:** stable, actively developed — the SDD spec tree, the conformance gate (a 40-plus-rule
> registry with narrative control-flow validation, technology
> boundaries, and per-spec `lint.allow`), spec-derived agent topology,
> skills, the MCP server, diagrams (Mermaid, interactive canvas + ERD,
> draw.io/Excalidraw), extension packs (injectable profiles, language
> tables, and rules), and a self-hostable HTTP **hosting server**
> (`wairon serve` — HTTP MCP for many isolated projects) are working. See the
> [roadmap](docs/roadmap.md) for what's next.

---

## What is it?

`wairon` turns a validated **spec tree** into (a) an enforced architecture
**conformance gate** and (b) a ready-made **agent topology + skills** that any AI
coding tool (Claude Code, Gemini CLI, …) consumes to do the work itself.

It is optional and additive: if a project has a `.wai/specs/` tree the workflow
is active; otherwise you ignore wairon and work normally. wairon does **not** run
or orchestrate AI sessions — it *equips* the session you already use.

```
.wai/specs/  (the SDD spec tree — source of truth)
   │
   ├── wairon validate ──▶ architecture-conformance gate
   │                       (stereotype dependency rules, contract↔impl
   │                        symmetry, reference integrity, cycle detection)
   │
   └── wairon generate ──▶ .claude/agents/  .gemini/agents/  (derived subagents)
                           + SDD skills installed into each tool
                           + wairon MCP server (sdd_* tools)
```

The host AI tool spawns the generated agents as its **own native subagents**,
guided by the SDD skills and the `sdd_*` MCP tools.

---

## The SDD spec tree

A complete system is specified top-down across six levels:

| Level | File | What it defines |
|-------|------|-----------------|
| **L0 System** | `.wai/specs/.index.yaml` | Vision, boundaries, global requirements, target language |
| **L1 Subsystem** | `.wai/specs/<sub>/.index.yaml` | An isolated software service, its public interfaces, and trusted links |
| **L2 Component** | `…/<component>/.index.yaml` | A building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist) or pattern (Repository, Gateway) + `owns`/`dependsOn` |
| **L3 Interface** | `…/<component>/.interface.yaml` | Method signatures & structured params (+ optional wire endpoint bindings) |
| **L4 Implementation** | `…/<component>/.implementation.yaml` | Concrete implementation of a contract: narrative detail level, bound `technologies` (the swap seam for vendors/engines), optional source path |
| **L5 Narrative** | (within L4) | Step-by-step method logic as a flat numbered list — `call` steps resolve to real dependency methods, and flow steps (`branch`/`switch`/`loop`/`try`/`jump`/`return`/`throw`) jump by step number |

(Legacy undotted names — `system.yaml`, `subsystem.yaml`, … — still load;
`wairon doctor --fix` migrates them.)

`wairon validate` enforces conformance across the tree: reference integrity,
contract↔implementation method symmetry, narrative-call resolution and
control-flow soundness, the component-stereotype dependency rules (e.g. a
Portal may not depend on a Store), technology-leakage fencing, language-aware
checks, and dependency-cycle detection — a documented rule registry
(`wairon rules list`) with per-project severity overrides and per-spec
`lint.allow` suppressions. Severity is relaxed to warnings while specs are
`draft`/`design`. Extension packs can inject custom profiles, language
tables, and rules — see [Extending wairon](docs/extending-wairon.md).

---

## Domains & agents

Agents are **derived from the spec tree** — you never hand-maintain an agent
registry:

- a **`system-architect`** from L0,
- a **`<subsystem>-owner`** per subsystem,
- a **`<component>-implementer`** per component.

A **domain** is a unit of ownership. Subsystems yield spec-backed domains
automatically; you can also declare **free-standing domains** (docs, infra,
cross-cutting scopes) in `.wai/topology.yaml`, each of which gets its own owner
agent. A subsystem is *software*; a domain is *who owns a scope* — every
subsystem yields a domain, but not every domain comes from a subsystem.

---

## Installation

### Binary install (recommended)

No Node.js required — downloads a self-contained binary for your platform.

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/SYW-Apps/Waffle-AIron/main/install.ps1 | iex
```

**macOS / Linux** (bash/sh):
```sh
curl -fsSL https://raw.githubusercontent.com/SYW-Apps/Waffle-AIron/main/install.sh | sh
```

Both `wairon` and `wai` are registered as commands. (wairon is distributed
as standalone binaries — it is not published to npm.)

### Local development

```sh
git clone https://github.com/SYW-Apps/Waffle-AIron
cd Waffle-AIron
npm install
npm run build
node dist/cli/index.js --help

# Without a build step (tsx):
npm run dev -- --help
```

### Updating

```sh
wairon update          # check and install the latest stable release
wairon update --check  # check only
```

Release channels: `stable` (default), `beta`, `preview` — switch with
`wairon update --channel <name>` (persists in `~/.wairon/config.json`).

---

## Quick Start

```sh
cd my-project
wairon init                 # bootstrap .wai/ (spec tree, context, skills, MCP-ready)

# Design the system with the SDD architect skill (in your AI tool), or via the
# sdd_* MCP tools. Then:

wairon status               # spec-tree completeness dashboard
wairon validate             # architecture-conformance gate
wairon generate             # regenerate agent files + (re)install skills
wairon list                 # agents resolved from the spec tree
```

---

## Aliases

`wai` is a built-in short alias for `wairon`. Manage aliases with
`wairon aliases list | enable <name> | disable <name>`.

---

## CLI Reference

See [docs/cli.md](docs/cli.md). Summary:

| Command | Description |
|---------|-------------|
| `wairon init` | Bootstrap `.wai/` and the SDD spec tree |
| `wairon status` | Spec-tree completeness dashboard |
| `wairon validate [--ci]` | Architecture-conformance gate |
| `wairon generate [--target] [--domain] [--dry-run]` | Regenerate agent files + install skills |
| `wairon list` / `wairon show <id>` | Inspect agents resolved from the spec tree |
| `wairon diagram [--all] [--canvas] [--drawio] [--excalidraw] [--sequence <comp:method>]` | Mermaid, interactive canvas, and editable draw.io/Excalidraw exports |
| `wairon rules list` | The conformance rule registry (the architecture linter) |
| `wairon packs add \| list \| remove [--global]` | Extension packs: injected profiles, language tables, and rules |
| `wairon domains list \| scan \| add \| remove` | Domains (subsystem-derived + free-standing) |
| `wairon skills list \| install` | Manage the SDD skills installed into your tools |
| `wairon lock [-y]` | Validate the tree as-complete and freeze it (generates the implementer agents) |
| `wairon mcp serve \| install \| status` | The wairon MCP server (`sdd_*` tools) |
| `wairon serve [--port] [--data-dir] [--no-auth]` | Self-host: HTTP MCP for many isolated projects + admin plane |
| `wairon host project \| key \| lock \| promote` | Administer the hosting server (projects, keys, state-scoped lock/promote) |
| `wairon update` / `wairon aliases` | Self-update / command aliases |

---

## Documentation

- [Architecture](docs/architecture.md) — layers and design
- [Requirements](docs/requirements.md) — goals, non-goals, scope
- [Roadmap](docs/roadmap.md) — what's done and what's next
- [Vision](docs/vision.md) — long-term direction
- [CLI Reference](docs/cli.md) — all commands
- [Hosted server](docs/design/hosted-mcp-server.md) — self-host wairon over HTTP (Docker, auth, sizing)
- [Pack scoping](docs/design/pack-scoping.md) — the pack store, per-project selection, and reproducibility (design)
- [Connecting-agent entrypoint](docs/design/connecting-agent-entrypoint.md) — MCP `instructions`, prompts, and skill composition
- [Approval baselines](docs/design/approval-baseline.md) — what `lock` approves, and why it stopped rewriting your spec tree (design)
- [Extending wairon](docs/extending-wairon.md) — extension packs & wrapper products (with a [working example](examples/wrapper/))
- [Templates](docs/templates.md) — agent rendering templates
- [Standards](docs/standards/INDEX.md) — the architecture standards the SDD model is built on

---

## Technology Stack

TypeScript + Node 18+, Commander (CLI), Inquirer (prompts), Zod (schema
validation), js-yaml, the MCP SDK, and Vitest. Bundled with tsup.

---

## Contributing

Actively developed. For bugs or questions, open an issue.

## License

MIT

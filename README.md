# wairon

**Waffle AIron** — an AI-Driven Development (AIDD) support tool built around
**Spec-Driven Development (SDD)**.

> **Status:** v0.1 — the SDD spec tree, architecture-conformance validation,
> spec-derived agent topology, skills, and MCP server are working. See the
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
| **L0 System** | `.wai/specs/system.yaml` | Vision, boundaries, global requirements |
| **L1 Subsystem** | `.wai/specs/<sub>/subsystem.yaml` | An isolated software service and its public interfaces |
| **L2 Component** | `…/<component>/component.yaml` | A building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist) or pattern (Repository, Gateway) + `owns`/`dependsOn` |
| **L3 Interface** | `…/<component>/interface.yaml` | Method signatures (+ optional HTTP/gRPC/event bindings) |
| **L4 Implementation** | `…/<component>/implementation.yaml` | Maps a contract to a source file |
| **L5 Narrative** | (within L4) | Step-by-step method logic; each `call` step resolves to a real dependency method |

`wairon validate` enforces conformance across the tree: reference integrity,
contract↔implementation method symmetry, narrative-call resolution, the
component-stereotype dependency rules (e.g. a Portal may not depend on a Store),
and dependency-cycle detection. Severity is relaxed to warnings while specs are
`draft`/`design`.

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

### npm install

```sh
npm install -g wairon
```

Both `wairon` and `wai` are registered as commands.

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
| `wairon domains list \| scan \| add \| remove` | Domains (subsystem-derived + free-standing) |
| `wairon skills list \| install` | Manage the SDD skills installed into your tools |
| `wairon mcp serve \| install \| status` | The wairon MCP server (`sdd_*` tools) |
| `wairon update` / `wairon aliases` | Self-update / command aliases |

---

## Documentation

- [Architecture](docs/architecture.md) — layers and design
- [Requirements](docs/requirements.md) — goals, non-goals, scope
- [Roadmap](docs/roadmap.md) — what's done and what's next
- [Vision](docs/vision.md) — long-term direction
- [CLI Reference](docs/cli.md) — all commands
- [Templates](docs/templates.md) — agent rendering templates
- [Standards](docs/standards/INDEX.md) — the architecture standards the SDD model is built on

---

## Technology Stack

TypeScript + Node 18+, Commander (CLI), Inquirer (prompts), Zod (schema
validation), js-yaml, the MCP SDK, and Vitest. Bundled with tsup.

---

## Contributing

Early development. For bugs or questions, open an issue.

## License

MIT

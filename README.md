# wairon

**Waffle AIron** — an AI-Driven Development (AIDD) support tool built around
**Spec-Driven Development (SDD)**.

> **Status:** stable, actively developed — the SDD spec tree, the conformance gate (a
> documented rule registry — `wairon rules list` — with narrative control-flow
> validation, code↔spec conformance, technology boundaries, and per-spec
> `lint.allow`), human approval (`wairon lock`) with a CI merge gate
> (`wairon lock-check`), members and cross-project references, live agent
> briefs and skills, the MCP server, the design export, diagrams (Mermaid,
> interactive canvas + ERD, draw.io/Excalidraw), extension packs (injectable
> profiles, language tables, and rules), and a self-hostable HTTP **hosting
> server** (`wairon serve` — HTTP MCP for many isolated projects, with a web UI)
> are working. See the [roadmap](docs/roadmap.md) for what's next.

---

## What is it?

`wairon` turns a validated **spec tree** into (a) an enforced architecture
**conformance gate**, (b) a recorded **approval** that CI can check, and (c) a
ready-made **agent topology + skills** that any AI coding tool (Claude Code,
Gemini CLI, …) consumes to do the work itself.

It is optional and additive: if a project has a `.wai/specs/` tree the workflow
is active; otherwise you ignore wairon and work normally. wairon does **not** run
or orchestrate AI sessions — it *equips* the session you already use.

```
.wai/specs/  (the SDD spec tree — source of truth)
   │
   ├── wairon validate ────▶ architecture-conformance gate
   │                          (stereotype dependency rules, contract↔impl
   │                           symmetry, reference integrity, cycle detection)
   │
   ├── wairon lock ────────▶ .wai/lock.json  (the human approval, committed)
   │     └ wairon lock-check ▶ CI merge gate: is this the approved design?
   │
   └── wairon MCP server ──▶ sdd_* tools + live agent briefs (sdd_get_agent_brief)
                              + SDD skills installed into each tool
```

The host AI tool spawns subagents of its own from the **live briefs** — each
composed from the current spec tree on every call — guided by the SDD skills
and the `sdd_*` MCP tools. Agent files on disk (`.claude/agents/`,
`.gemini/agents/`) are an optional materialized view of the same topology:
off by default, on with `rules.materializeAgentFiles: true`.

---

## The SDD spec tree

A complete system is specified top-down across six levels:

| Level | File | What it defines |
|-------|------|-----------------|
| **L0 System** | `.wai/specs/.index.yaml` | Vision, boundaries, global requirements, target language |
| **L1 Subsystem** | `.wai/specs/<sub>/.index.yaml` | An isolated software service, its public interfaces, and trusted links |
| **L2 Component** | `…/<component>/.index.yaml` | A building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry, Adapter, Observer, and View for UIs) or pattern (Repository; FeatureComponent and RouterComponent for UIs) + `owns`/`dependsOn`. A gateway is a Portal with the `gateway` variant; logic is an Orchestrator whose `dependencyClass` bounds what it may depend on |
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
- a **`<component>-implementer`** per component, when
  `rules.generateComponentImplementers` is on.

Each agent is served as a **live brief** (`sdd_get_agent_brief`, or
`wairon agent brief <id>`), composed from the current tree whenever it is
asked for, so it is never stale. Writing them to disk as agent files is opt-in
(`rules.materializeAgentFiles: true`).

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

Both `wairon` and `wai` are registered as commands.

### npm

wairon is also published to npm as `@wairon/cli` (Node 18+):

```sh
npm install --save-dev @wairon/cli    # per project; run it with npx wairon
npm install --global @wairon/cli      # or machine-wide
```

The dist-tags are the release channels: `latest` (stable), `beta`, `preview`
and `dev`, e.g. `npm install -D @wairon/cli@dev`.

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

Release channels: `stable` (default), `beta`, `preview`, `dev` — switch with
`wairon update --channel <name>` (persists in `~/.wairon/config.json`). Each
channel sees its own tier and every narrower one, so `stable` only ever
installs a `vX.Y.Z` release and `dev` sees the `-dev.N` build cut from every
merge to `dev`. Installing from npm, the channels are the dist-tags:
`@wairon/cli@latest`, `@beta`, `@preview`, `@dev`.

---

## Quick Start

```sh
cd my-project
wairon init                 # bootstrap .wai/ (spec tree, context, skills, MCP registration)

# 1. Design: in your AI tool, use the sdd-architect skill, which authors the
#    spec tree through the sdd_* MCP tools.

wairon status               # the tree, its authoring readiness, and its approval state
wairon validate             # architecture-conformance gate (--ci in CI)

# 2. Approve: once it validates, a human approves the design.
wairon lock                 # records the approval in .wai/lock.json
git add .wai && git commit -m "Approve the design"

# 3. Gate: in CI, check that what merges is the approved design
#    (or use the reusable workflow with strict: true — see docs/cli.md).
#    --strict also fails when .wai/lock.json is missing or a member project was
#    never approved; plain lock-check only fails an approval that no longer matches.
wairon lock-check --strict

# 4. Implement: your AI tool delegates each component with the sdd-delegate
#    skill, from its live brief (sdd_get_agent_brief).

# Optional
wairon export --out design.json   # the whole resolved design as JSON
wairon diagram                    # interactive canvas in .wai/docs/diagrams/
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
| `wairon status` | The spec tree, its authoring readiness, and its approval state |
| `wairon validate [--ci] [--all]` | Architecture-conformance gate (the family run at a project with members) |
| `wairon doctor [--fix]` | Health check and upgrade repairs |
| `wairon generate [--target] [--domain] [--dry-run]` | Reconcile guides, skills and context; agent files only when `rules.materializeAgentFiles` is on |
| `wairon list` / `wairon show <id>` / `wairon agent brief <id>` | Inspect agents resolved from the spec tree; print one's live brief |
| `wairon export [--out <file>]` | The whole design, resolved, as one JSON document ([format](docs/design-export.md)) |
| `wairon diagram [--all] [--canvas] [--drawio] [--excalidraw] [--sequence <comp:method>]` | Mermaid, interactive canvas, and editable draw.io/Excalidraw exports |
| `wairon rules list` | The conformance rule registry (the architecture linter) |
| `wairon pack init \| build \| install \| use \| unuse \| impact \| sync \| bundle \| which \| list \| add \| remove` | Extension packs: injected profiles, language tables, and rules |
| `wairon member …` / `wairon subsystem externalize` / `wairon project rename` | Members (parts and projects) and the family migrations |
| `wairon externals pin \| status \| list` | Pin and check the externals a project consumes |
| `wairon domains list \| scan \| add \| remove` | Domains (subsystem-derived + free-standing) |
| `wairon skills list \| install` | Manage the SDD skills installed into your tools |
| `wairon lock [-y]` | Validate the design as complete and record its approval in `.wai/lock.json`, code findings beside it; no spec file is rewritten |
| `wairon lock-check [--strict]` | Merge gate: is the design in this tree the design that was approved? Importable as a [reusable workflow](https://github.com/SYW-Apps/Waffle-AIron/blob/main/.github/workflows/lock-check.yml) |
| `wairon mcp serve \| install \| status` | The wairon MCP server (`sdd_*` tools) |
| `wairon serve [--port] [--data-dir] [--no-auth]` | Self-host: HTTP MCP for many isolated projects + admin plane |
| `wairon host unit \| project \| permission \| key \| lock \| doctor \| packs \| git \| producer \| secret \| demo` | Administer the hosting server (units, projects, permissions, keys, the state-scoped lock) |
| `wairon login` / `wairon remote` / `wairon mcp install --hosted` | Connect a checkout or an AI tool to a hosted instance |
| `wairon dev` | Local single-project web UI over the current project |
| `wairon update` / `wairon aliases` | Self-update / command aliases |

---

## Documentation

- [Architecture](docs/architecture.md) — layers and design
- [Requirements](docs/requirements.md) — goals, non-goals, scope
- [Roadmap](docs/roadmap.md) — what's done and what's next
- [Vision](docs/vision.md) — long-term direction
- [CLI Reference](docs/cli.md) — all commands and MCP tools
- [Design export](docs/design-export.md) — the `wairon export` JSON format for generators and translators
- [Supervisor doctrine](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/supervisor-doctrine.md) — how Supervisors and Actors may depend on data and effects
- [Hosted server](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md) — self-host wairon over HTTP (Docker, auth, sizing)
- [Pack scoping](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/pack-scoping.md) — the pack store, per-project selection, and reproducibility (design)
- [Connecting-agent entrypoint](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/connecting-agent-entrypoint.md) — MCP `instructions`, prompts, and skill composition
- [Execution budgets](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/execution-budgets.md) — what each agent's work costs to do, derived alongside what it owns (design)
- [Approval baselines](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/approval-baseline.md) — what `lock` approves, and why it stopped rewriting your spec tree (design)
- [Extending wairon](docs/extending-wairon.md) — extension packs & wrapper products (with a [working example](https://github.com/SYW-Apps/Waffle-AIron/blob/main/examples/wrapper/))
- [Templates](docs/templates.md) — agent rendering templates
- [Standards](docs/standards/INDEX.md) — the architecture standards the SDD model is built on

---

## Technology Stack

TypeScript + Node 18+, Commander (CLI), Inquirer (prompts), Zod (schema
validation), js-yaml, the MCP SDK, and Vitest. Bundled with tsup.

---

## Contributing

Actively developed. For bugs or questions, open an issue.

Working on this repo (or delegating work in it) — see
[CONTRIBUTING.md](https://github.com/SYW-Apps/Waffle-AIron/blob/main/CONTRIBUTING.md) for what this checkout does differently: line
endings, the gate commands and their baselines, and the stale-MCP-server tell.
The conventions that hold for *any* wairon project ship in the `sdd-implement`
and `sdd-delegate` skills.

## License

MIT

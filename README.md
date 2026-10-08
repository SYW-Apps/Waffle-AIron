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

## Reachability: what reaches each verb

Every Portal verb must be **reached**: either a modelled caller in the design
calls it (a `call` step along a `dependsOn` edge, or `alias::portal.verb` across
projects), or the verb is declared an **entry** — callers outside the design
reach it. Nothing else counts, so a Portal nobody calls and nobody enters is
reported (`UNUSED_COMPONENT` / `UNUSED_METHOD`), with both remedies named.

- **Transports.** A Portal states its `transport`, one vocabulary with its
  endpoints: network (`HTTP`, `gRPC`, `GraphQL`, `MessageBus`, `Custom`), local
  (`CLI`, `IPC`, `NamedPipe`, `JSONRPC` for stdio JSON-RPC such as a language
  server or stdio MCP) or `InProcess` (a library, which binds no endpoint).
- **Entries.** `invokedBy: { kind: entry, caller: "…" }` on the Portal (every
  verb inherits it) or on one verb. Declare one only where the callers really are
  outside the design: browsers, a CLI user, an AI tool over stdio, the
  applications that link a library. Never invent one to silence a finding —
  model the caller instead.
- **Networks.** A project may declare `network: true` (or `{ description }`) in
  `.wai/project.yaml`: it and its members form an isolated network. An entry's
  `scope` is relative — `outside` (the default) or `network` (sibling services
  inside the innermost network). Inside a network only a `gateway` Portal takes
  entries from outside, and a modelled call crossing in must land on one. The
  family run at the root proves every `network` entry has a modelled caller
  (`ENTRY_UNPROVEN`). A project with no network never sees any of this.
- **Libraries are called directly.** Another project's `InProcess` Portal is
  called from any component — no client Adapter needed. Pure and read logic may
  only call library verbs whose `effect` allows it (`LIBRARY_CALL_IMPURE`), and a
  native library called from another language needs an `abi` (`c` or `wasm`)
  (`LANGUAGE_BRIDGE_MISSING`). Wrapping a volatile third-party API in an Adapter
  stays a good habit, never a rule.
- **Extension points.** A producer exports a contract consumers implement with
  `role: implement`; the consumer's interface declares `implements: alias::name`.
- **Networking is derived.** `wairon network flows | policy | diagram | check |
  why` turns the modelled reach into an allowed-flows matrix, Kubernetes
  `NetworkPolicy`, a trust-boundary diagram and live-flow checks — the specs
  never hold an address. See [Derived networking](docs/network.md).

Upgrading a tree written before this model: `wairon doctor --fix` migrates the
retired forms (`portalType`, listener `mounts`, the old `invokedBy` kinds), then
declare the entries it will not invent.

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
asked for, so it is never stale. A brief fences exact files — the code its
specs alone name, planned files and the agent's own types included — and lists
the shared files (module setup, files other components also name, unnamed
helpers) it may touch only for its own needs, so parallel implementers never
overlap and a first implementation is never blocked. Writing them to disk as
agent files is opt-in (`rules.materializeAgentFiles: true`).

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
npm ci                      # TS/JS project with code: install the project's dependencies first
                            # (pnpm install --frozen-lockfile / yarn install --immutable), so the
                            # gate reads your code with YOUR TypeScript (5 or 6); without one —
                            # or on TypeScript 7 — it reads with the copy wairon ships. The
                            # reusable workflow does this for you.
wairon validate --ci        # the conformance gate, run at the FAMILY ROOT (the project that
                            # declares the members): there it is the family run, which judges
                            # the network proofs; externals are judged against their pins
# Optional: gate on the LIVE producers of your externals as well
# (exit 1 when one is incompatible, 2 when one could not be compared).
wairon externals status

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
| `wairon network flows \| policy \| diagram \| check \| why` | Networking derived from the design: allowed flows, Kubernetes `NetworkPolicy`, a trust-boundary diagram, live-flow checks ([details](docs/network.md)) |
| `wairon rules list` | The conformance rule registry (the architecture linter) |
| `wairon pack init \| build \| install \| use \| unuse \| impact \| sync \| bundle \| which <name> \| list \| add \| remove` | Extension packs: injected profiles, language tables, and rules |
| `wairon member …` / `wairon subsystem externalize` / `wairon project rename` | Members (parts and projects) and the family migrations |
| `wairon externals add \| pin \| status \| list \| remove \| use \| consumers [--search <dirs>]` | Declare, pin and check the externals a project consumes (`status` is the opt-in live gate); from a producer, `consumers --search ..` finds who consumes it, sibling checkouts included |
| `wairon surface export \| import \| list \| diff [--against <ref\|file>]` | Exchange a public surface (native snapshot or OpenAPI, one document per portal); `diff` is the public-surface changelog since the last committed approval |
| `wairon method rename <component> <method> <new-name> [--dry-run] [--search <dirs...>] [--no-pin-symbol]` | Rename a contract method and retarget every reference; `--dry-run` names every consumer it breaks (`--search` scans sibling checkouts too), `--no-pin-symbol` lets the implementation follow the new name |
| `wairon method rename-param` / `wairon type rename-field` | Rename a contract parameter or a type field and respell every reference; the old name joins the rename trace |
| `wairon domains list \| scan \| add \| remove` | Domains (subsystem-derived + free-standing) |
| `wairon skills list \| install` | Manage the SDD skills installed into your tools |
| `wairon lock [-y]` | Validate the design as complete and record its approval in `.wai/lock.json`, code findings beside it; no spec file is rewritten |
| `wairon lock-check [--strict]` | Merge gate: is the design in this tree the design that was approved? Importable as a [reusable workflow](https://github.com/SYW-Apps/Waffle-AIron/blob/dev/.github/workflows/lock-check.yml) (on `dev` and the dev tags until 6.0.0 ships it on `main`; pin a tag — see [docs/cli.md](docs/cli.md#using-it-in-github-actions)) |
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
- [Supervisor doctrine](docs/design/supervisor-doctrine.md) — how Supervisors and Actors may depend on data and effects
- [Hosted server](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md) — self-host wairon over HTTP (Docker, auth, sizing)
- [Pack scoping](docs/design/pack-scoping.md) — the pack store, per-project selection, and reproducibility (design)
- [Connecting-agent entrypoint](docs/design/connecting-agent-entrypoint.md) — MCP `instructions`, prompts, and skill composition
- [Execution budgets](docs/design/execution-budgets.md) — what each agent's work costs to do, derived alongside what it owns (design)
- [Approval baselines](docs/design/approval-baseline.md) — what `lock` approves, and why it stopped rewriting your spec tree (design)
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
[CONTRIBUTING.md](CONTRIBUTING.md) for what this checkout does differently: line
endings, the gate commands and their baselines, and the stale-MCP-server tell.
The conventions that hold for *any* wairon project ship in the `sdd-implement`
and `sdd-delegate` skills.

## License

MIT

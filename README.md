# wairon

**SYW Waffle AIron** — manage AI coding agent topology across projects.

> **Status:** v0.1 MVP — core init flow, generation, and validation are working.
> Several commands are planned but not yet implemented (see [roadmap](docs/roadmap.md)).

---

## What is it?

`wairon` is a CLI tool that manages the AI coding agent topology for your
software projects. Instead of manually maintaining agent files for Claude Code,
Gemini CLI, or other tools, you define your agents once in a structured
**source of truth** (`.wai/`) and generate the tool-specific files from it.

```
.wai/ (source of truth)
  └── project.yaml, registry/agents.json, templates/, bundles/
          │
          ▼  wairon generate
          │
  .claude/agents/  .gemini/agents/  .cursor/agents/  (generated outputs)
```

---

## Why?

Large projects benefit from **architecture-scoped agents** — agents defined around
real boundaries like services, package families, and bounded contexts — not just
broad roles like "implementer" or "reviewer."

Managing these manually across multiple AI tools doesn't scale. When agent files
drift or conflict, there's no validation and no easy way to regenerate.

wairon gives you:
- A single, version-controlled source of truth for all your agents
- Reproducible generation of tool-specific files from that source
- Validation of topology rules (no overlapping ownership, required paths, etc.)
- Reusable templates and bundles for consistent patterns across scopes
- An **Agent Architect** meta-agent that knows how to use the CLI itself

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Source of truth** | `.wai/` — the internal registry, templates, and config. Never edit generated files directly. |
| **Agent Registry** | `.wai/registry/agents.json` — the authoritative list of all agents for this project. |
| **Template** | A reusable agent shape (instructions, role, defaults). Built-ins: architect, domain-owner, implementer, reviewer, tester, guardian. |
| **Bundle** | A recipe for creating multiple related agents for a scope. Built-ins: service-default, package-family-default. |
| **Exporter** | Renders agent records into tool-specific files (Claude, Gemini, custom path). |
| **Rules** | Topology invariants enforced by `wairon validate` (no overlapping ownership, etc.). |

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

Both scripts:
- Detect your OS and architecture (x64 / arm64)
- Download the matching binary from the latest GitHub release
- Install to `~/.local/bin` (Unix) or `%LOCALAPPDATA%\wairon\bin` (Windows)
- Add that directory to your PATH if it isn't already
- Create the `wai` short alias automatically (see [Aliases](#aliases))

To install to a custom directory, set the environment variable before running:

```sh
WAIRON_INSTALL_DIR=/usr/local/bin curl -fsSL .../install.sh | sh
```

---

### npm install

If you already have Node.js 18+ installed:

```sh
npm install -g wairon
```

Both `wairon` and `wai` are registered as bin entries — no extra steps needed.

---

### Local development / contributing

```sh
git clone https://github.com/SYW-Apps/wairon
cd wairon
npm install
npm run build

# Run from the build output:
node dist/cli/index.js --help

# Or link globally so `wairon` resolves from anywhere:
npm link
wairon --help
```

**Without a build step** (tsx, slower):

```sh
npm run dev -- --help
# equivalent to: npx tsx src/cli/index.ts --help
```

---

### Updating

```sh
wairon update          # check and install latest stable release
wairon update --check  # check only (exits 1 if an update is available)
```

#### Release channels

| Channel | Tags | Description |
|---------|------|-------------|
| `stable` | `v1.2.3` | Default. Production-ready releases only. |
| `beta` | `v1.2.3-beta.1` | Includes beta pre-releases for early testing. |
| `preview` | `v1.2.3-preview.1` | Everything, including the earliest previews. |

```sh
# Switch to beta channel (persists in ~/.wairon/config.json)
wairon update --channel beta

# Switch back to stable
wairon update --channel stable
```

---

### Aliases

`wai` is a built-in short alias for `wairon`. Both commands are identical.

```sh
wai init       # same as: wairon init
wai generate   # same as: wairon generate
```

**For binary installs**, the install script creates the alias automatically.
If `wai` is already used by another tool on your system, the script will
skip creating it and warn you instead.

Manage aliases at any time:

```sh
wairon aliases list              # show all aliases and their status
wairon aliases disable wai    # remove the alias file; persists across updates
wairon aliases enable wai     # re-create it (refuses if there's a conflict)
```

The `disable` preference is saved to `~/.wairon/config.json` and survives
reinstalls and updates — the install script will not re-create a disabled alias.

**For npm installs**, both `wairon` and `wai` are always registered as bin
entries by npm. The `aliases` command reports their status but npm manages the
files, not wairon.

---

## Quick Start

```sh
# Initialize a project
cd my-project
wairon init

# > Project name: my-project
# > Which AI coding tools will you use?
#   ◉ Claude Code (.claude/agents/)
#   ◯ Gemini CLI (.gemini/agents/)
#   ◯ Other (custom path)

# What gets created:
# .wai/
#   project.yaml
#   registry/agents.json
#   rules/topology.yaml
#   docs/topology.md
# .claude/agents/
#   agent-architect.md     ← generated architect agent

# See what was created:
wairon list

# Validate the topology:
wairon validate

# After modifying the registry, regenerate outputs:
wairon generate
```

---

## Example Generated Structure

After `wairon init` with Claude target selected:

```
my-project/
├── .wai/
│   ├── project.yaml
│   ├── registry/
│   │   └── agents.json
│   ├── templates/          ← project-local overrides (empty initially)
│   ├── bundles/            ← project-local bundles (empty initially)
│   ├── rules/
│   │   └── topology.yaml
│   └── docs/
│       └── topology.md
└── .claude/
    └── agents/
        └── agent-architect.md   ← generated
```

After adding a service scope (once `create-bundle` is implemented):

```
.wai/registry/agents.json        ← 5 agents now
.claude/agents/
  agent-architect.md
  core-service-owner.md
  core-service-implementer.md
  core-service-reviewer.md
  core-service-tester.md
```

---

## `.wai/project.yaml` Format

```yaml
schemaVersion: '1.0.0'
name: my-project
targets:
  - type: claude
    outputDir: .claude/agents
    enabled: true
rules:
  noOverlappingOwnership: true
  requireOwnedPaths: true
  enforceReproducibility: true
```

---

## Agent Architect

Every initialized project gets an **Agent Architect** agent. This meta-agent
is the AI's entry point for managing topology. When you ask Claude or Gemini
to help with agent topology, they will use this agent and its CLI quick-reference.

The architect agent:
- Explains the wairon CLI commands
- Defines when to create new agents (only at durable architectural boundaries)
- Defines the standard operating workflow (inspect → decide → modify → validate → generate)
- Lives at `.claude/agents/agent-architect.md` (and other selected targets)

---

## CLI Reference

### Project

| Command | Description |
|---------|-------------|
| `wairon init` | Initialize project — create `.wai/`, generate architect agent, detect domains |
| `wairon generate [--target] [--dry-run]` | Regenerate all agent output files from registry |
| `wairon validate` | Validate config and registry for errors/rule violations |
| `wairon list` | List all agents in the registry |

### Domains

Domains are git submodules, nested repos, or package roots that get their own
local agent files.

| Command | Description |
|---------|-------------|
| `wairon domains list` | Show all tracked domains as a tree |
| `wairon domains scan [--add]` | Detect untracked domain candidates; `--add` to interactively add them |
| `wairon domains add [--path] [--id]` | Manually register a domain by path |
| `wairon domains remove <id>` | Remove a domain from the registry |

### Delegation

Spawn an AI session in a domain's directory with a scoped task.

| Command | Description |
|---------|-------------|
| `wairon delegate <domain-id> -p "task"` | Start an AI session in the domain directory |
| `wairon delegate ... --async` | Write a job file and return immediately (no session spawned) |
| `wairon delegate ... --backend gemini` | Use Gemini CLI instead of Claude |
| `wairon delegate ... --backend ollama --model codellama:13b` | Use a local model |

### Jobs

Inspect the history of delegated tasks.

| Command | Description |
|---------|-------------|
| `wairon jobs list [--domain] [--status]` | List jobs with optional filters |
| `wairon jobs show <job-id>` | Show full details and result for a job |
| `wairon jobs clean [--all]` | Remove completed/failed/abandoned jobs |

### Tooling

| Command | Description |
|---------|-------------|
| `wairon update [--check] [--channel]` | Check and install latest release; optionally switch channel |
| `wairon aliases list` | Show all command aliases and their status |
| `wairon aliases enable <name>` | Create alias symlink / wrapper |
| `wairon aliases disable <name>` | Remove alias and opt out of future re-creation |

### Planned (not yet implemented)

| Command | Phase | Description |
|---------|-------|-------------|
| `wairon create-agent` | 2 | Interactively create an agent from a template |
| `wairon create-bundle` | 2 | Scaffold a set of agents from a bundle |
| `wairon analyze` | 3 | Analyze repo for topology coverage gaps |
| `wairon suggest-topology` | 3 | Suggest topology improvements |
| `wairon split` | 4 | Split an agent into two more focused agents |
| `wairon merge` | 4 | Merge two agents into one |

### Global flags

```
--verbose   enable verbose output
--silent    suppress all output except errors
-v          print version
```

---

## Documentation

- [Architecture](docs/architecture.md) — design decisions and layer overview
- [Requirements](docs/requirements.md) — goals, non-goals, MVP scope, assumptions
- [Roadmap](docs/roadmap.md) — phased development plan
- [CLI Reference](docs/cli.md) — all commands and options
- [Templates](docs/templates.md) — template system and built-ins
- [Bundles](docs/bundles.md) — bundle system and built-ins
- [Registry](docs/registry.md) — registry schema and conventions

---

## Technology Stack

- **TypeScript + Node 18+** — fast iteration, rich ecosystem, clean packaging
- **Commander.js** — CLI parsing
- **Inquirer.js** — interactive prompts
- **Zod** — runtime schema validation for all config/registry formats
- **js-yaml** — YAML parsing/serialization
- **Vitest** — testing
- **tsup** — bundling

TypeScript was chosen over Python for this first version because of the richer
CLI tooling ecosystem (Commander, Inquirer), familiar feel for JS/TS-heavy teams,
and the ease of bundling to a single binary with `tsup`. See
[docs/architecture.md](docs/architecture.md) for more on the stack rationale.

---

## Development

```sh
npm install

# Run tests
npm test

# Typecheck
npm run typecheck

# Build
npm run build

# Watch mode
npm run build:watch
```

### Project Structure

```
src/
  cli/          # CLI entrypoint (Commander setup)
  commands/     # Command implementations
  core/         # Templates, bundles, registry ops, validation
  config/       # Config loading/writing, path constants
  models/       # Zod schemas and TypeScript types
  exporters/    # Tool-specific output generators
  templates/    # Built-in template YAML files
  bundles/      # Built-in bundle YAML files
  utils/        # Logger, fs helpers, yaml helpers, errors
docs/           # Documentation
examples/       # Example configs and generated outputs
tests/          # Test files
```

---

## Contributing

This project is in early development. Contributions welcome once the v0.1
foundation stabilizes. See [docs/roadmap.md](docs/roadmap.md) for planned work.

For bugs or questions, open an issue.

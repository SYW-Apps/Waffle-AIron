# waffagent

**SYW Waffler Agents** — manage AI coding agent topology across projects.

> **Status:** v0.1 MVP — core init flow, generation, and validation are working.
> Several commands are planned but not yet implemented (see [roadmap](docs/roadmap.md)).
>
> _The product name "waffagent" is a working name and may change._

---

## What is it?

`waffagent` is a CLI tool that manages the AI coding agent topology for your
software projects. Instead of manually maintaining agent files for Claude Code,
Gemini CLI, or other tools, you define your agents once in a structured
**source of truth** (`.ai/`) and generate the tool-specific files from it.

```
.ai/ (source of truth)
  └── project.yaml, registry/agents.json, templates/, bundles/
          │
          ▼  waffagent generate
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

waffagent gives you:
- A single, version-controlled source of truth for all your agents
- Reproducible generation of tool-specific files from that source
- Validation of topology rules (no overlapping ownership, required paths, etc.)
- Reusable templates and bundles for consistent patterns across scopes
- An **Agent Architect** meta-agent that knows how to use the CLI itself

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Source of truth** | `.ai/` — the internal registry, templates, and config. Never edit generated files directly. |
| **Agent Registry** | `.ai/registry/agents.json` — the authoritative list of all agents for this project. |
| **Template** | A reusable agent shape (instructions, role, defaults). Built-ins: architect, domain-owner, implementer, reviewer, tester, guardian. |
| **Bundle** | A recipe for creating multiple related agents for a scope. Built-ins: service-default, package-family-default. |
| **Exporter** | Renders agent records into tool-specific files (Claude, Gemini, custom path). |
| **Rules** | Topology invariants enforced by `waffagent validate` (no overlapping ownership, etc.). |

---

## Installation

### Local development

```sh
git clone https://github.com/syw/waffagent
cd waffagent
npm install
npm run build

# Run locally:
node dist/cli/index.js --help

# Or link globally:
npm link
waffagent --help
```

### Development mode (no build step)

```sh
npm install
npx tsx src/cli/index.ts --help
# or
npm run dev -- --help
```

---

## Quick Start

```sh
# Initialize a project
cd my-project
waffagent init

# > Project name: my-project
# > Which AI coding tools will you use?
#   ◉ Claude Code (.claude/agents/)
#   ◯ Gemini CLI (.gemini/agents/)
#   ◯ Other (custom path)

# What gets created:
# .ai/
#   project.yaml
#   registry/agents.json
#   rules/topology.yaml
#   docs/topology.md
# .claude/agents/
#   agent-architect.md     ← generated architect agent

# See what was created:
waffagent list

# Validate the topology:
waffagent validate

# After modifying the registry, regenerate outputs:
waffagent generate
```

---

## Example Generated Structure

After `waffagent init` with Claude target selected:

```
my-project/
├── .ai/
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
.ai/registry/agents.json        ← 5 agents now
.claude/agents/
  agent-architect.md
  core-service-owner.md
  core-service-implementer.md
  core-service-reviewer.md
  core-service-tester.md
```

---

## `.ai/project.yaml` Format

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
- Explains the waffagent CLI commands
- Defines when to create new agents (only at durable architectural boundaries)
- Defines the standard operating workflow (inspect → decide → modify → validate → generate)
- Lives at `.claude/agents/agent-architect.md` (and other selected targets)

---

## CLI Reference

| Command | Status | Description |
|---------|--------|-------------|
| `waffagent init` | ✅ | Initialize project, create `.ai/`, generate architect agent |
| `waffagent generate` | ✅ | Regenerate all agent output files from registry |
| `waffagent validate` | ✅ | Validate config and registry for errors/rule violations |
| `waffagent list` | ✅ | List all agents in the registry |
| `waffagent create-agent` | 🔜 Phase 2 | Interactively create an agent from a template |
| `waffagent create-bundle` | 🔜 Phase 2 | Scaffold agents from a bundle |
| `waffagent analyze` | 🔜 Phase 3 | Analyze repo for topology coverage |
| `waffagent suggest-topology` | 🔜 Phase 3 | Suggest topology improvements |
| `waffagent split` | 🔜 Phase 4 | Split an agent into two |
| `waffagent merge` | 🔜 Phase 4 | Merge two agents into one |

See [docs/cli.md](docs/cli.md) for full options.

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

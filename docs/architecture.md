# waffagent — Architecture

> Last updated: 2026-04-10 | Version: 0.1.0

---

## Design Philosophy

waffagent is built around one central idea: **the source of truth for AI agent
topology should live inside the repository, be version-controlled, and be
independent of any specific AI coding tool.**

Claude Code, Gemini CLI, and similar tools each have their own agent definition
formats, directory conventions, and file schemas. If you manage agents by editing
those tool-specific files directly, you end up with:

- No single place to understand the full agent topology
- No easy way to regenerate if tool formats change
- No ability to target multiple tools from one definition
- No validation of topology rules (overlapping ownership, missing paths, etc.)

waffagent solves this by being a **topology registry and exporter**, not a tool
wrapper.

---

## Source-of-Truth First

The `.ai/` directory is the canonical home for everything topology-related.

```
.ai/
├── project.yaml          # project config: targets, rules, metadata
├── registry/
│   └── agents.json       # the full agent registry (CLI-managed)
├── templates/            # project-local template overrides
├── bundles/              # project-local bundle definitions
├── rules/
│   └── topology.yaml     # governance rules
├── docs/
│   └── topology.md       # human notes and decisions
└── generated/            # optional: cached generation metadata
```

**Generated files are artifacts.** The files in `.claude/agents/`, `.gemini/agents/`,
or any custom path are outputs that can always be regenerated from `.ai/`.

This distinction matters because:
1. You can evolve tool-specific formats without losing your topology model
2. You can target new tools by adding an exporter, without changing existing agents
3. CI can validate the topology (rules, conflicts, coverage) independently of
   which tools are installed

---

## Layer Separation

```
┌─────────────────────────────────────────────────────────┐
│                      CLI (commands/)                    │
│       init · generate · validate · list · ...           │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                    Core (core/)                         │
│    templates · bundles · registry ops · validation      │
└──────┬────────────────────┬────────────────────────────┘
       │                    │
┌──────▼──────┐   ┌─────────▼───────────────────────────┐
│  Config      │   │         Exporters (exporters/)      │
│  (config/)  │   │  claude · gemini · custom · generate │
│  loader     │   └─────────────────────────────────────┘
│  defaults   │
└──────┬──────┘
       │
┌──────▼──────────────────────────────────────────────────┐
│                    Models (models/)                     │
│    AgentRecord · Template · Bundle · ProjectConfig      │
│    Registry · all Zod schemas                           │
└─────────────────────────────────────────────────────────┘
```

**models/** — pure data shapes with Zod schemas. No I/O, no business logic.

**config/** — reads and writes `.ai/` files. The only layer that knows where
files live on disk.

**core/** — topology logic: template loading, bundle loading, registry mutations,
validation rules. Depends on models and config, never on exporters.

**exporters/** — tool-specific rendering. Each exporter knows how to turn an
`AgentRecord + Template` into a file at a target path. Completely independent
of core topology logic.

**CLI (commands/ + cli/)** — glues everything together for user interaction.
Thin layer: reads options, calls core/exporter functions, handles errors, formats output.

---

## Templates vs Bundles vs Registry

These three concepts are often confused. Here's the distinction:

| Concept | What it is | Mutability | Lives at |
|---------|-----------|------------|----------|
| **Template** | A reusable agent shape (instructions, defaults) | Stable, rarely changes | `src/templates/` or `.ai/templates/` |
| **Bundle** | A recipe for creating multiple related agents for a scope | Stable, occasionally evolves | `src/bundles/` or `.ai/bundles/` |
| **Registry** | The actual agents in *this project*, with their specific ids, paths, and config | Changes as topology evolves | `.ai/registry/agents.json` |

**Example flow:**

1. You have a `service-default` bundle
2. You run `waffagent create-bundle --bundle service-default --scope core-service --dir services/core`
3. The bundle creates registry entries for `core-service-owner`, `core-service-implementer`, etc.
4. Running `waffagent generate` exports those registry entries into `.claude/agents/`

The bundle was used once to *populate* the registry. Afterward, the registry is the
source of truth — you can modify those agents directly without touching the bundle.

---

## Rules Layer

Topology rules live in `.ai/rules/topology.yaml` and are also configurable in
`project.yaml`. Rules define invariants the CLI enforces during validation:

- `noOverlappingOwnership` — no two agents should claim the same owned path
- `requireOwnedPaths` — non-meta agents must have at least one owned path
- `enforceReproducibility` — generated files should match what the registry would produce

Validation runs on every `waffagent validate` call and can be integrated into CI.

---

## Init Flow

```
waffagent init
     │
     ├─ prompt: project name
     ├─ prompt: select targets (claude / gemini / custom)
     │
     ├─ create .ai/ directory structure
     ├─ write .ai/project.yaml
     ├─ create empty .ai/registry/agents.json
     ├─ write .ai/rules/topology.yaml
     ├─ write .ai/docs/topology.md
     │
     ├─ create architect agent in registry
     │
     └─ generate architect agent → each selected target
           └─ .claude/agents/agent-architect.md
           └─ .gemini/agents/agent-architect.md
```

The architect agent is always created. It is the entry point for any AI model
working with the project's agent topology.

---

## Why CLI-First (Not MCP-First)

MCP (Model Context Protocol) servers are a powerful pattern for giving AI models
structured tool access to external systems. However, building MCP-first introduces
several premature complexities:

- Requires a running server process
- Complicates local development and testing
- Adds transport layer concerns (stdio/HTTP)
- Forces a specific integration model

By building a clean CLI first, we get:

- A tool that works immediately without any AI model
- A library API (`src/index.ts`) that any integration can use
- Easy testing of all logic through standard CLI invocation
- A solid foundation that an MCP server can wrap later

### MCP in the Future

The `src/index.ts` exports are designed to be the public API for a future MCP
wrapper. An MCP server would simply:

1. Import the waffagent library
2. Map MCP tool calls to library function calls
3. Return structured results to the model

No architectural changes to core logic would be needed.

---

## Output Format

Generated agent files use **YAML front-matter + Markdown body**. This format is:

- Human-readable
- Compatible with Claude Code's sub-agent spec
- Easy to extend with tool-specific front-matter fields
- Diff-friendly in version control

Each exporter can customize the front-matter fields it emits. The body is always
the rendered template instructions.

---

## Configuration Format Choices

| File | Format | Reason |
|------|--------|--------|
| `project.yaml` | YAML | Human-edited; benefits from comments and readability |
| `agents.json` | JSON | CLI-managed; strict, predictable, universal parsing |
| `templates/*.yaml` | YAML | Human-authored multi-line instructions; YAML handles this well |
| `bundles/*.yaml` | YAML | Human-authored; benefits from comments |
| `rules/topology.yaml` | YAML | Human-authored; evolves slowly |
| Generated outputs | Markdown | Tool-specific; front-matter + prose |

---

## Future: Topology Analysis

The `analyze` and `suggest-topology` commands (Phase 3) will:

1. Walk the repository structure
2. Identify paths not covered by any agent's `ownedPaths`
3. Identify agents with overly broad ownership (e.g., `/**`)
4. Suggest new agents or path rebalancing

This analysis will be read-only — suggestions are presented to the user,
who then decides whether to apply them.

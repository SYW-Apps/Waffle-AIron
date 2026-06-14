# wairon — Architecture

> Last updated: 2026-06-14

---

## Overview

wairon is a TypeScript CLI. Its data flow is a single pipeline from the spec tree
to the artifacts the host AI tool consumes:

```
.wai/specs/ ──┬─ validate ─▶ conformance result (gate)
              │
              └─ resolve ──▶ agent topology ──▶ generate ──▶ .claude/agents/ …
                                                          └─▶ skills installed
                                                          └─▶ MCP server (sdd_*)
```

---

## Layers (`src/`)

| Directory | Responsibility |
|-----------|----------------|
| `cli/` | Commander entrypoint; wires commands |
| `commands/` | Command implementations (init, validate, status, generate, list, show, domains, skills, mcp, update, aliases) |
| `core/` | The engine: `specs` (load/scan the tree), `validation` (conformance), `agent_resolver` (spec → agents), `domains` (resolve + free-standing CRUD), `skills` (export), `context`, `detection`, `templates` |
| `config/` | `loader` (paths, project config, topology config, derived registry), defaults |
| `models/` | Zod schemas: `specs`, `agent`, `domain`/topology, `project`, `template`, `registry` |
| `exporters/` | Render an agent into a tool-specific file (Claude, Gemini, custom) |
| `mcp/` | The MCP server (topology + `sdd_*` tools) |
| `templates/` | Built-in agent templates + the SDD skill files |
| `utils/` | Logger, fs, yaml, errors, the AI guide |

---

## Key design points

- **Specs are the single source of truth.** `loadRegistry()` always derives the
  agent set from the spec tree via `resolveAgentTopology()`. There is no
  hand-maintained `agents.json`.
- **Domains are a superset of subsystems.** `resolveDomains()` returns
  subsystem-derived domains (`boundTo` set) plus free-standing domains from
  `.wai/topology.yaml`. A subsystem is a software unit; a domain is an ownership
  scope.
- **Generation is a single native-subagent render** per agent into each target's
  output directory. wairon does not do per-directory or session-based rendering.
- **Conformance is centralized** in `core/validation.ts` (`validateSddTree`),
  reused by both the `validate` command and the `sdd_validate_tree` MCP tool.
- **Everything is file-based** under `.wai/` — no database, no daemon.

---

## Stack

TypeScript + Node 18+, Commander, Inquirer, Zod, js-yaml, the MCP SDK, Vitest,
and tsup for bundling. See [docs/standards/](standards/INDEX.md) for the
architecture standards the SDD component model is built on.

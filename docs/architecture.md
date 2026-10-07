# wairon — Architecture

> Last updated: 2026-10-05 (for v6.0.0). wairon's own design is specified in its
> spec tree under `.wai/specs/`; this page is the orientation map, and the tree
> is authoritative where they differ.

---

## Overview

wairon is a TypeScript CLI. Its data flow is a single pipeline from the spec tree
to the artifacts the host AI tool consumes:

```
.wai/specs/ ──┬─ validate ─▶ conformance result (gate)
              ├─ lock ─────▶ .wai/lock.json (approval) ──▶ lock-check (CI gate)
              ├─ export ───▶ design JSON (wairon-design)
              └─ resolve ──▶ agent topology ──┬─▶ live briefs (sdd_get_agent_brief)
                                              ├─▶ skills installed
                                              ├─▶ MCP server (sdd_*)
                                              └─▶ agent files (opt-in)
```

---

## Layers (`src/`)

| Directory | Responsibility |
|-----------|----------------|
| `cli/` | Commander entrypoint; wires commands |
| `commands/` | Command implementations, some thin ones in `cli/runner.ts` (init, validate, status, generate, lock, lock-check, doctor, diagram, export, rules, pack, member, project, subsystem, externals, surface, remote, produce, agent, list, show, domains, skills, mcp, execution, update, aliases, `dev`, and the hosting commands `serve` / `host`); `commands/adapters/` holds the forwards into core |
| `core/` | The engine: `specs` (load/scan the tree), `validation` and `family-validation` (the owner's gate and the family run), `rules/` (the rule registry), `authoring` (the gated spec writes), `agent_resolver` (spec → agents and briefs), `domains`, `skills`, `statehash` (deterministic StateId), `lockfile` and `approval` (the lock record), `externals` / `project-family` (members and pins), `design-export`, `extensions` / `packstore` (packs), `source-analysis` (code↔spec conformance), `diagram` / `canvas`, `provision`, `context`, `templates` |
| `migrations/` | Family migrations and the upgrade migrations: plan on a private copy, then apply all or nothing through a journaled transaction |
| `git/` | Git-backed hosted projects (commits only `.wai/`) |
| `producers/` | Projecting a spec tree to Notion / Miro |
| `config/` | `loader` (paths, request-scoped project root, project config, topology config, derived registry), defaults |
| `models/` | Zod schemas: `specs`, `agent`, `domain`/topology, `project`, `template`, `registry` |
| `exporters/` | Render an agent into a tool-specific file (Claude, Gemini, custom) |
| `mcp/` | The stdio MCP server (topology + `sdd_*` tools + the `wairon-agent://` brief resource) |
| `server/` | The hosting server (`sdd_host`): HTTP data plane (`/mcp`), admin control plane, web UI, per-request project scoping, auth, units and permissions, and the credential/project registries |
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
- **Agents are briefs first.** Each agent's brief is composed live from the
  current tree; writing it as a native subagent file into each target's output
  directory is opt-in (`rules.materializeAgentFiles`). wairon does not do
  per-directory or session-based rendering.
- **Approval is a file, not a status.** `lock` writes the gate identity and one
  digest per spec to `.wai/lock.json` and never rewrites a spec; `lock-check`
  and `status` compare against it.
- **Conformance is centralized** in `core/validation.ts`: `validateProject` (the
  owner's gate, one project from its own files) and `validateFamily` (the
  family run in `core/family-validation.ts`: each member's own gate verbatim,
  plus composition and the family checks), reused by both the `validate`
  command and the `sdd_validate_tree` MCP tool.
  `validateAsComplete` runs the same gate at full strictness for `lock`.
- **Optionally hosted.** `wairon serve` (the `sdd_host` subsystem, in `server/`)
  serves the `sdd_*` tools over streamable HTTP for many fully-isolated projects,
  binding each request to its authenticated project via `AsyncLocalStorage`
  (`runWithProjectRoot`) — reusing the core, validation, and MCP layers unchanged.
- **Everything is file-based** under `.wai/` — no database, and no daemon for the
  core workflow. `wairon serve` is an **opt-in** hosting daemon (see the
  [hosted server guide](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md)) that serves the same
  file-based tools over HTTP.

---

## Stack

TypeScript + Node 18+, Commander, Inquirer, Zod, js-yaml, the MCP SDK, Vitest,
and tsup for bundling. See [docs/standards/](standards/INDEX.md) for the
architecture standards the SDD component model is built on.

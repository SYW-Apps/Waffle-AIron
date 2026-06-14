# wairon — CLI Reference

All commands operate on the `.wai/` directory in the current project. Global
flags: `--verbose`, `--silent`, `-v`/`--version`.

---

## Project

### `wairon init [-y, --yes]`
Bootstrap `.wai/` in the current project: project config, the SDD spec tree
(an L0 `system.yaml` is seeded), the shared `.wai/context/`, the architect agent
file, and the SDD skills installed into each selected target tool. `--yes` uses
defaults without prompts. Re-running on an initialized project is a no-op that
points you back to the SDD flow.

### `wairon status`
Print a hierarchical completeness dashboard of the SDD spec tree (which
subsystems/components/interfaces/implementations are drafted vs complete).

### `wairon validate [--ci]`
Run the architecture-conformance gate over the spec tree: reference integrity,
contract↔implementation method symmetry, narrative-call resolution, component
stereotype dependency rules, and dependency-cycle detection. `--ci` treats
warnings as errors.

### `wairon generate [--target <type>] [--domain <id>] [--domains <ids>] [--root] [--dry-run]`
Regenerate agent output files from the spec-derived topology and (re)install the
SDD skills. Filters limit generation to a target type or to specific domains.
`--dry-run` previews without writing.

### `wairon list` (alias `ls`) / `wairon show <id>`
List, or show full details of, the agents resolved from the spec tree
(`system-architect`, `<subsystem>-owner`, `<component>-implementer`, and owners
for free-standing domains).

---

## Domains

A domain is a unit of agent ownership. Subsystem-derived domains come from the
spec tree (read-only); free-standing domains live in `.wai/topology.yaml`.

| Command | Description |
|---------|-------------|
| `wairon domains list` | List all domains (subsystem-derived + free-standing) |
| `wairon domains scan [--add]` | Detect physical directory candidates; `--add` adds selected ones as free-standing domains |
| `wairon domains add [--path] [--id]` | Manually add a free-standing domain |
| `wairon domains remove <id>` | Remove a free-standing domain (subsystem-derived domains cannot be removed here) |

---

## Skills

The SDD skills (`sdd-architect`, `sdd-narrative`, `sdd-auditor`, `sdd-implement`)
drive the spec-driven workflow inside your AI tool.

| Command | Description |
|---------|-------------|
| `wairon skills list` | List the built-in SDD skills |
| `wairon skills install` (alias `sync`) | Install/refresh the skills into each active target's skills dir |

---

## MCP

The wairon MCP server exposes topology and `sdd_*` tools so AI tools can query
and author specs directly.

| Command | Description |
|---------|-------------|
| `wairon mcp serve` | Start the MCP server (stdio transport) |
| `wairon mcp install [--global] [--backend claude\|gemini]` | Register the server in Claude Code / Antigravity settings |
| `wairon mcp status` | Show whether the server is registered |

**Tools:** `listAgents`, `getAgent`, `listDomains`, `validateTopology`,
`getProjectConfig`, `sdd_initialize_system`, `sdd_add_subsystem`,
`sdd_add_component`, `sdd_define_interface`, `sdd_write_narrative`,
`sdd_validate_tree`, `sdd_get_status`.

---

## Tooling

| Command | Description |
|---------|-------------|
| `wairon update [--check] [--channel <name>]` | Check/install the latest release; switch channel |
| `wairon aliases list` | Show command aliases (`wai`) and their status |
| `wairon aliases enable <name>` / `disable <name>` | Create / remove an alias |

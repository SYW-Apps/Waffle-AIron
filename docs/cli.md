# wairon — CLI Reference

All commands operate on the `.wai/` directory in the current project. Global
flags: `--verbose`, `--silent`, `-v`/`--version`.

---

## Project

### `wairon init [-y, --yes] [--pack <source>]`
Bootstrap `.wai/` in the current project: project config, the SDD spec tree
(an L0 `.index.yaml` is seeded), the shared `.wai/context/`, the architect agent
file, and the SDD skills installed into each selected target tool. `--yes` uses
defaults without prompts; `--pack <source>` (repeatable) vendors + registers an
extension pack right after init (see `wairon packs`). Re-running on an
initialized project is a no-op that points you back to the SDD flow.

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

### `wairon lock [-y, --yes] [--subsystem <id>] [--no-recursive]`
Review and approve the design. Validates the spec tree **as if complete** (full
strictness, no draft-status relaxation) and — only if it passes — records the
current tree as approved and regenerates the agent topology.

It writes **nothing into your spec tree**. The approval is one sha256 per spec
file on `.wai/lock.json`, the record that was always committed — so your
teammates, a fresh clone and CI all see the same approval you gave, and
`wairon status` elsewhere can name what has drifted from it. Keys are sorted, so
re-approving a one-spec change shows up as a two-line diff. A failed or
cancelled lock changes nothing at all.

`lockedBy` records who approved **and how that identity was established**: your
git author identity where there is one (so a reviewer can match it against the
author of the commit carrying the lock), else `user@hostname`. On a hosted
instance it is the authenticated subject. None of it is proof — the commit that
introduces `lock.json` is what carries that.

Before approving, it reports what moved since the last approval — the question
a human is actually answering:

```
3 spec(s) changed since the last approval:
  ~ sdd_core/spec_loader/.index.yaml
  ~ sdd_core/spec_loader/.interface.yaml
  + sdd_core/spec_index/.index.yaml
```

`--yes` skips the confirmation (for CI); `--subsystem`
limits the scope.

### `wairon doctor [--fix]`
Health check: flags stale generated guides/skills, an unregistered MCP server,
and spec-tree issues. `--fix` regenerates stale in-project guides/context/skills
and registers the MCP server.

### `wairon list` (alias `ls`) / `wairon show <id>`
List, or show full details of, the agents resolved from the spec tree
(`system-architect`, `<subsystem>-owner`, `<component>-implementer`, and owners
for free-standing domains).

### `wairon rules list`
List the SDD conformance rule registry — every rule group, the issue codes it
can emit, default severities, and any per-project overrides from
`rules.sddRuleSeverity`. The gate is a documented architecture linter: each
rule is a self-contained module in `src/core/rules/`. Rules injected by
extension packs are listed too, tagged with their pack.

### `wairon execution show` (alias `ls`) / `wairon execution set-tier <tier>`
Execution budgets — the resource axis of the derived topology. Where authority
says which paths an agent owns, a budget says what its work costs to do:
a capability tier, a reasoning effort, a turn ceiling, a tool class, and
whether it may delegate further or load MCP servers.

`show` lists every agent's allowance next to the rationale that produced it
(component stereotype, owned-path breadth, role), so a tier choice is auditable
rather than magic. It also flags any agent an override has pinned to the
`frontier` tier — derivation never selects it.

`set-tier` moves the aggressiveness dial and states what the new tier costs:

| Tier | What it does |
|------|--------------|
| `off` (default) | No budgets derived. Output is byte-identical to before this feature existed. |
| `free` | Structural constraints only — tool class, MCP access, nested delegation. No model or effort selection, so no quality tradeoff at all. |
| `default` | Adds capability-tier selection per role and turn ceilings. Mechanical work (Store, Index, Registry, Adapter) runs smaller; work carrying decisions (Orchestrator, Supervisor, Specialist) keeps the capable tier. |
| `trade` | Adds effort reduction on mechanical work and steps standard work down a tier. Real but bounded quality cost. |
| `aggressive` | Small tier for everything but deep reasoning, halved turn ceilings. Expect partial results and worse judgment. |

Raising the dial can only tighten a budget, so it is safe to turn without
auditing every agent. Per-agent overrides live in `.wai/project.yaml` under
`execution.overrides`.

### `wairon packs list | add <source> [--global] | remove <name> [--global]`
Extension packs — plain config files (YAML, or a JS module for programmatic
rules) injecting custom profiles, language/platform tables, and conformance
rules (see [Extending wairon](extending-wairon.md)).

- `add <source>`: verify the pack loads, then vendor it into `.wai/packs/`
  and register it in `project.yaml → extensions.packs` (commit `.wai/` so CI
  and every clone enforce it). With `--global`, install machine-wide into
  `WAIRON_PACKS_DIR` / `~/.wairon/packs` — auto-loaded for every project on
  this machine (project packs win on collision; a project opts out via
  `extensions.useGlobalPacks: false`). A source may be a file or a directory
  with a pack entry file (`pack.yaml` | `pack.cjs` | `index.cjs` | …).
- `list`: global + project packs and what each provides (profiles,
  languages, rules), with load errors inline.
- `remove <name>`: deregister by pack name and delete vendored files under
  `.wai/packs/` (files elsewhere are left in place); `--global` removes a
  machine-wide pack.

### `wairon diagram [--format <fmt>] [--subsystem <id>] [--sequence <component:method>] [--depth <n>] [--all] [--out <path>]`
Generate architecture diagrams derived from the spec tree — living
documentation from the same source of truth as the conformance gate. Every
format writes a file (paths are printed); nothing opens automatically.

- **default (no flags): the interactive canvas** (`canvas.html`).
- `--format mermaid` (or `--subsystem <id>`): system-wide or scoped Mermaid
  **component diagram** as a markdown file (subsystems as subgraphs,
  `dependsOn` edges, thick edges for boundary hops, dashed `owns`
  containment, bold border on the published surface). Use a `.mmd` `--out`
  path for raw Mermaid.
- `--subsystem <id>`: scope to one subsystem plus its directly-connected
  external neighbors.
- `--sequence <component:method>`: a **sequence diagram** derived from the
  method's L5 narrative, recursively expanding `call` steps (cycle-guarded,
  `--depth` limits expansion; default 3).
- `--canvas`: an **interactive HTML canvas** — the whole system on one page.
  Subsystems as containers, pattern compounds nested inside, components laid
  out in dependency layers (entrypoints left → data right), subsystems in
  topological order (callers left of providers) with barycenter
  crossing-reduction so links stay short and untangled. Pan/zoom,
  double-click a boundary to collapse it (its external edges aggregate into
  labeled "tubes"), click anything for a spec-derived detail panel
  (description, interfaces, methods, endpoints, narratives, dependencies,
  trusted links), search, and a validation-issue overlay. The computed
  layout is locked by default — enable "rearrange" to drag, "reset layout"
  to undo — and "export PNG" renders the full graph to a high-res image for
  Miro/docs/slides. Fully self-contained (Cytoscape.js embedded inline,
  works offline).
- `--format <mermaid|canvas|drawio|excalidraw>`: friendly alias for the flags below/above.
- `--drawio` / `--excalidraw`: **editable** exports in open formats
  (draw.io / diagrams.net XML, Excalidraw scene JSON) with the exact same
  computed layout as the canvas — import into diagrams.net, excalidraw.com,
  VS Code extensions, or any whiteboard tool that accepts these formats.
- `--all`: write the full set (system, per-subsystem, one sequence per
  entrypoint method with a narrative, plus `canvas.html`,
  `architecture.drawio`, and `architecture.excalidraw`) into
  `.wai/docs/diagrams/` (or `--out`).

The canvas is a small single-page app with **C4-style scoped navigation**:
each view renders one scope's direct children (System → subsystems →
components → pattern members, infinitely deep by ownership); double-click
drills in, the breadcrumb navigates back, "Internals" previews children
inside boxes, "Externals" shows out-of-scope references as ghosts. Plus
SYW/light themes, presentation mode, per-view layout persistence,
narrative flowcharts with call drill-down, and an Export menu
(PNG / draw.io / Excalidraw) capturing the current view and layout.

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
| `wairon mcp install [--global] [--config-dir <path>] [--backend claude\|gemini]` | Register the server. Default: project-local. `--global` uses the home config (respects `CLAUDE_CONFIG_DIR`/`GEMINI_CONFIG_DIR`); `--config-dir` installs into an explicit, validated config dir (requires `--backend`) |
| `wairon mcp status` | Show whether the server is registered |

**Tools:** `listAgents`, `getAgent`, `listDomains`, `validateTopology`,
`getProjectConfig`, `sdd_initialize_system`, `sdd_add_subsystem`,
`sdd_set_public_interfaces`, `sdd_set_subsystem_project_path`,
`sdd_add_component`, `sdd_define_interface`, `sdd_set_endpoints`,
`sdd_write_narrative`, `sdd_add_type`, `sdd_get_spec`, `sdd_update_spec`,
`sdd_delete_spec`, `sdd_validate_tree`, `sdd_get_status`.

---

## Hosting (self-hosted server)

`wairon serve` runs wairon as an HTTP server that hosts many **fully-isolated**
projects behind one endpoint — a public **data plane** (the `sdd_*` tools over
streamable HTTP, per-project API-key scoped) and an admin **control plane**
(project & key lifecycle, state-scoped lock). See the
[hosted server guide](design/hosted-mcp-server.md) for the architecture, Docker
self-hosting, auth, and sizing.

### `wairon serve [--host <h>] [--port <p>] [--admin-host <h>] [--admin-port <p>] [--data-dir <path>] [--no-auth]`
Start the hosting server. Data plane on `0.0.0.0:8080` (`POST /mcp`, `/healthz`,
`/readyz`); admin plane on `127.0.0.1:8081` (`/admin/*`). Auth is **on by
default** and requires `WAIRON_ADMIN_TOKEN` (the master credential) — the server
refuses to start without it; `--no-auth` disables data-plane auth for a trusted
network. `--data-dir` (or `WAIRON_DATA_DIR`, default `~/.wairon/data`) is the data
root holding `projects/` and `auth/`.

### `wairon host …` — control plane
Runs **in-process** (no running server needed), so it works over SSH /
`docker exec`. Reads the master credential from `WAIRON_ADMIN_TOKEN`.

| Command | Description |
|---------|-------------|
| `wairon host project create --id <id>` | Provision a new isolated project (its own `.wai/` tree) |
| `wairon host project list` | List hosted projects |
| `wairon host project destroy --id <id>` | Remove a project and its tree |
| `wairon host key mint --project <id\|*> [--role editor\|admin]` | Mint an API key (plaintext shown once) |
| `wairon host key list [--project <id>]` | List API keys |
| `wairon host key revoke --id <id>` | Revoke a key |
| `wairon host lock --project <id>` | Validate-as-complete + write the state-scoped lock record |

---

## Tooling

| Command | Description |
|---------|-------------|
| `wairon update [--check] [--channel <name>]` | Check/install the latest release; switch channel |
| `wairon aliases list` | Show command aliases (`wai`) and their status |
| `wairon aliases enable <name>` / `disable <name>` | Create / remove an alias |

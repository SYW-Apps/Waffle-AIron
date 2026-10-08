<!-- wairon-version: 5.1.1-dev.111 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Domain Map (13 domains)

| ID | Source | Name |
|----|--------|------|
| `sdd_authoring` | subsystem `sdd_authoring` | SDD Spec Authoring |
| `sdd_cli` | subsystem `sdd_cli` | Wairon CLI Interfaces |
| `sdd_core` | subsystem `sdd_core` | SDD Core Spec Manager |
| `sdd_git` | subsystem `sdd_git` | SDD Git Backing |
| `sdd_host` | subsystem `sdd_host` | SDD Hosting Server |
| `sdd_mcp` | subsystem `sdd_mcp` | SDD MCP Server |
| `sdd_migrations` | subsystem `sdd_migrations` | SDD Family Migrations |
| `sdd_network` | subsystem `sdd_network` | SDD Derived Networking |
| `sdd_producers` | subsystem `sdd_producers` | SDD Producers |
| `sdd_sdk` | subsystem `sdd_sdk` | SDK / Pack Authoring & Archive |
| `sdd_skills` | subsystem `sdd_skills` | SDD Skills Exporter |
| `sdd_surfaces` | subsystem `sdd_surfaces` | SDD Public Surface Exchange |
| `sdd_validator` | subsystem `sdd_validator` | SDD Architectural Validator |

---

# wairon MCP Tools

The **wairon MCP server** is active in this project. The tools are self-describing; call them directly:

- Authoring: `sdd_initialize_system`, `sdd_add_subsystem`, `sdd_set_public_interfaces`, `sdd_add_component`, `sdd_define_interface`, `sdd_set_endpoints`, `sdd_write_narrative`, `sdd_add_type`.
- Members (declared in project.yaml `members`; a PART by default — this project's own subsystems stored elsewhere, by local id — or a PROJECT, referenced as `alias::name`): `sdd_add_member`, `sdd_move_member`; and the family migrations, each with `dryRun` (run it first and show the plan; applied, it writes every project or none and never locks): `sdd_promote_member` / `sdd_demote_member` (a part made a project in place, and back), `sdd_attach_member`, `sdd_detach_member`, `sdd_adopt_member`, `sdd_rename_project`, `sdd_rename_member_alias`, `sdd_internalize_member`, `sdd_externalize_subsystem`.
- Reading & maintenance: `sdd_get_spec`, `sdd_update_spec`, `sdd_delete_spec`, `sdd_validate_tree`, `sdd_get_status`.
- Topology: `listAgents`, `getAgent`, `listDomains`, `validateTopology`, `getProjectConfig`.

Use these MCP tools to query and change project state — never the `wairon` CLI (that is the human developer's tool).

---

## wairon — Spec-Driven Development (optional)

If `.wai/specs/` exists, the wairon SDD workflow is active; otherwise ignore it. wairon does not orchestrate sessions — it equips yours.

### In SDD Projects:
- **Source of Truth**: All architecture lives in the spec tree under `.wai/specs/` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → L5 Narrative). Agent files under `.claude/agents/` are an opt-in generated view (`rules.materializeAgentFiles`) — never edit them; agents are served as live briefs.
- **Validation**: Conformance checks (stereotype rules, cycle checks, reference integrity) are run via the `sdd_validate_tree` MCP tool.
- **Operating Rules**:
  1. **Skills**: Use `sdd-architect` to design (and `sdd-implement`, `sdd-narrative`, `sdd-auditor`). Refer to project's local guide file for detailed constraints.
  2. **MCP Tools Only**: Author/validate specs *only* via `sdd_*` tools (e.g. `sdd_initialize_system`, `sdd_validate_tree`).
  3. **No CLI Exec**: Do not run the `wairon` CLI (human tool). Use MCP tools `sdd_validate_tree` and `sdd_get_status` instead.
  4. **Delegation**: Delegate implementation via the `sdd-delegate` skill — live agent briefs (`sdd_get_agent_brief` MCP tool / `wairon-agent://` resource) are composed per call and always current; no session restart. Generated agent files are an optional materialized view of the same topology. User-owned per-agent guidance may live in `.wai/agents/<agent-id>.md` (folded into every brief; scaffold via `wairon agent customize <id>`).
  5. **Design First, then approval**: Complete the spec and pass `sdd_validate_tree`, then ask the human to approve it with `wairon lock` before writing code. Approval is the lock record (`.wai/lock.json`), not a spec's `status` — the lock does not rewrite statuses; `sdd_get_status` reports the approval state. Code linkage (`sourcePath`, `symbol`, `simPath`, …) is not part of the approval: declare planned source paths at design time, they cost no re-lock.
  6. **Prose is design; linkage is not**: an L4/L5 prose change — an implementation's or a method's description, intent or narrative step text — IS a design change: it re-opens the approval, so `wairon lock` is owed before code is implemented against it (an implement step asked for in the same turn as a prose edit waits for the human's re-lock; sequence spec turn → lock → code turn). Only code linkage is outside it.
  7. **Consistency**: Code must match L3 interfaces and L5 narratives exactly. If the spec is wrong, stop and update the spec.
  8. **Members & References**: A project may declare **members** in its `.wai/project.yaml` `members` (create one with `sdd_add_member`). A **part** (the default) stores some of this project's subsystems in another folder or repository: local ids, this project's lock. A **project** member is an independent boundary with its own spec tree and lock, designed from its own root. Reference what another project exports as `alias::name` (the alias is a member or a declared external, the name a public name of its L0 export table); an id without `::` is local. A leading `::`, `super::`, member paths and an L1 subsystem carrying `projectPath` are deprecated: they still resolve for one release, are reported, and `wairon doctor --fix` rewrites them.
  9. **Reachability**: every Portal verb is reached by a modelled caller or declared an entry (`invokedBy: { kind: entry }`) for real callers outside the design — never an entry invented to silence a finding.

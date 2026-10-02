<!-- wairon-version: 5.1.1-dev.88 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Domain Map (12 domains)

| ID | Source | Name |
|----|--------|------|
| `sdd_authoring` | subsystem `sdd_authoring` | SDD Spec Authoring |
| `sdd_cli` | subsystem `sdd_cli` | Wairon CLI Interfaces |
| `sdd_core` | subsystem `sdd_core` | SDD Core Spec Manager |
| `sdd_git` | subsystem `sdd_git` | SDD Git Backing |
| `sdd_host` | subsystem `sdd_host` | SDD Hosting Server |
| `sdd_mcp` | subsystem `sdd_mcp` | SDD MCP Server |
| `sdd_migrations` | subsystem `sdd_migrations` | SDD Family Migrations |
| `sdd_producers` | subsystem `sdd_producers` | SDD Producers |
| `sdd_sdk` | subsystem `sdd_sdk` | SDK / Pack Authoring & Archive |
| `sdd_skills` | subsystem `sdd_skills` | SDD Skills Exporter |
| `sdd_surfaces` | subsystem `sdd_surfaces` | SDD Public Surface Exchange |
| `sdd_validator` | subsystem `sdd_validator` | SDD Architectural Validator |

---

# wairon MCP Tools

The **wairon MCP server** is active in this project. The tools are self-describing; call them directly:

- Authoring: `sdd_initialize_system`, `sdd_add_subsystem`, `sdd_set_public_interfaces`, `sdd_add_component`, `sdd_define_interface`, `sdd_set_endpoints`, `sdd_write_narrative`, `sdd_add_type`.
- Members (projects this one contains, declared in project.yaml `members`, referenced as `alias::name`): `sdd_add_member`, `sdd_move_member`; and the family migrations, each with `dryRun` (run it first and show the plan; applied, it writes every project or none and never locks): `sdd_attach_member`, `sdd_detach_member`, `sdd_adopt_member`, `sdd_rename_project`, `sdd_rename_member_alias`, `sdd_internalize_member`, `sdd_externalize_subsystem`.
- Reading & maintenance: `sdd_get_spec`, `sdd_update_spec`, `sdd_delete_spec`, `sdd_validate_tree`, `sdd_get_status`.
- Topology: `listAgents`, `getAgent`, `listDomains`, `validateTopology`, `getProjectConfig`.

Use these MCP tools to query and change project state — never the `wairon` CLI (that is the human developer's tool).

---

## wairon — Spec-Driven Development (optional)

If `.wai/specs/` exists, the wairon SDD workflow is active; otherwise ignore it. wairon does not orchestrate sessions — it equips yours.

### In SDD Projects:
- **Source of Truth**: All architecture lives in the spec tree under `.wai/specs/` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → L5 Narrative). Do not edit generated agent config files under `.claude/agents/` (rebuilt via `wairon generate`).
- **Validation**: Conformance checks (stereotype rules, cycle checks, reference integrity) are run via the `sdd_validate_tree` MCP tool.
- **Operating Rules**:
  1. **Skills**: Use `sdd-architect` to design (and `sdd-implement`, `sdd-narrative`, `sdd-auditor`). Refer to project's local guide file for detailed constraints.
  2. **MCP Tools Only**: Author/validate specs *only* via `sdd_*` tools (e.g. `sdd_initialize_system`, `sdd_validate_tree`).
  3. **No CLI Exec**: Do not run the `wairon` CLI (human tool). Use MCP tools `sdd_validate_tree` and `sdd_get_status` instead.
  4. **Delegation**: Delegate implementation via the `sdd-delegate` skill — live agent briefs (`sdd_get_agent_brief` MCP tool / `wairon-agent://` resource) are composed per call and always current; no session restart. Generated agent files are an optional materialized view of the same topology. User-owned per-agent guidance may live in `.wai/agents/<agent-id>.md` (folded into every brief; scaffold via `wairon agent customize <id>`).
  5. **Design First**: Complete spec and pass `sdd_validate_tree` before writing code.
  6. **Consistency**: Code must match L3 interfaces and L5 narratives exactly. If the spec is wrong, stop and update the spec.
  7. **Members & References**: A project may contain other wairon projects as **members**, declared in its `.wai/project.yaml` `members` (create one with `sdd_add_member`); each member has its own spec tree, designed from its own root. Reference what another project exports as `alias::name` (the alias is a member or a declared external, the name a public name of its L0 export table); an id without `::` is local. A leading `::`, `super::`, member paths and an L1 subsystem carrying `projectPath` are deprecated: they still resolve for one release, are reported, and `wairon doctor --fix` rewrites them.

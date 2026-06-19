<!-- wairon-version: 0.1.8 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Domain Map (5 domains)

| ID | Source | Name |
|----|--------|------|
| `sdd_cli` | subsystem `sdd_cli` | Wairon CLI Interfaces |
| `sdd_core` | subsystem `sdd_core` | SDD Core Spec Manager |
| `sdd_mcp` | subsystem `sdd_mcp` | SDD MCP Server |
| `sdd_skills` | subsystem `sdd_skills` | SDD Skills Exporter |
| `sdd_validator` | subsystem `sdd_validator` | SDD Architectural Validator |

---

# wairon MCP Tools

The **wairon MCP server** is active in this project. You can call these tools directly:

| Tool | Purpose |
|------|---------|
| `listAgents` | List agents resolved from the spec tree (optionally filter by domainId) |
| `getAgent` | Get full details of an agent by id |
| `listDomains` | List domains (subsystem-derived + free-standing) |
| `validateTopology` | Check for topology errors/warnings |
| `getProjectConfig` | Get the project configuration |
| `sdd_initialize_system` | Create the L0 system spec |
| `sdd_add_subsystem` | Add an L1 subsystem |
| `sdd_add_component` | Add an L2 component |
| `sdd_define_interface` | Define an L3 interface contract |
| `sdd_write_narrative` | Write an L4 implementation + L5 narrative |
| `sdd_validate_tree` | Validate the whole spec tree |
| `sdd_get_status` | Spec-tree completeness dashboard |

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
  4. **Subagents**: Spawn generated `<component>-implementer` subagents for coding.
  5. **Design First**: Complete spec and pass `sdd_validate_tree` before writing code.
  6. **Consistency**: Code must match L3 interfaces and L5 narratives exactly. If the spec is wrong, stop and update the spec.

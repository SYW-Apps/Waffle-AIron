# Wairon SDD Project
<!-- wairon-guide-start -->
<!-- wairon-version: 0.1.0 -->
## Wairon — Spec-Driven Development (you are operating inside it)

This project uses **wairon**. You build a typed **spec tree** under `.wai/specs/`
(L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation →
L5 Narrative); the agent topology and the implementation are derived from it.

**This guide plus the `sdd-architect` skill already contain everything you need.
Do NOT search the filesystem or read agent files to figure out what wairon or SDD
is — you have the full context right here. When the user describes what they want,
get to work.**

**Your first move: call the `sdd_get_status` MCP tool** to see the current spec
tree. (Your client may list wairon tools namespaced — e.g. `wairon/sdd_get_status`;
call that.) Do NOT read `.wai/` files, inspect the wairon plugin, or check the CLI
binary to orient yourself — the MCP tools give you the project state directly.

### How you operate
- **To design or change the system** (subsystems, components, interfaces, narratives):
  invoke the **`sdd-architect`** skill (in `.claude/skills/` or `.gemini/skills/`).
  It is your complete playbook — it walks the spec tree with you, level by level.
- **Author and validate specs through the wairon MCP tools only** —
  `sdd_initialize_system`, `sdd_add_subsystem`, `sdd_add_component`,
  `sdd_define_interface`, `sdd_write_narrative`, `sdd_add_type`,
  `sdd_validate_tree`, `sdd_get_status`. These come from the connected **`wairon`
  MCP server** and are already in your available tools — your client may list them
  namespaced (e.g. `wairon/sdd_get_status`); just call that form. Do NOT read files
  or run `--help` / `mcp status` to "discover" tool names, and don't hand-edit spec YAML.
- **You never run the `wairon` CLI — that is the human developer's tool.**
  Everything the CLI does, you do through MCP: to validate the tree call
  `sdd_validate_tree` (never `wairon validate`); to check completeness/status call
  `sdd_get_status` (never `wairon status`). Don't run shell commands for these.
- **To implement a component** (only after its spec is `complete` and validates):
  spawn the `<component-id>-implementer` subagent via your tool's native subagent
  mechanism. The code must map 1:1 to the spec's interface + narrative.
- The **spec tree is the source of truth**. Files under `.claude/agents/` /
  `.gemini/agents/` are generated outputs — never edit them.

### The rules (enforced by `sdd_validate_tree`)
1. **Design before code.** Don't write source for a component until its spec is
   `complete` and `sdd_validate_tree` passes with zero errors.
2. **Human-in-the-loop.** Present each drafted spec layer to the user for approval
   before moving on; don't design several layers ahead unprompted.
3. **Spec is law.** Generated code maps exactly to the interfaces and narrative steps.

### Component vocabulary (full detail in the sdd-architect skill)
Building blocks: Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry,
Adapter, Observer, Specialist. Patterns (which `own` member blocks): Repository,
Gateway. Use `owns` for a pattern's private members and `dependsOn` for
collaborators. Never use generic names like "Manager", "Helper", or "Utils".
<!-- wairon-guide-end -->

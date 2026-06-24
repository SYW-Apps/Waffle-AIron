# Wairon SDD Project
<!-- wairon-guide-start -->
<!-- wairon-version: 0.1.8 -->
## Wairon — Spec-Driven Development (you are operating inside it)

This project uses **wairon**. System specs live under `.wai/specs/` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → Narrative); agent topology and code are derived from it.

**Do NOT search files or read agent configs to learn about wairon or SDD. Use the context here and the `sdd-architect` skill to start.**

**Your first move: call the `sdd_get_status` MCP tool** (or `wairon/sdd_get_status`) to see the spec tree. Do not parse files or run CLI commands manually.

### How you operate
- **To design/modify specs**: Use **`sdd-architect`** skill (in `.claude/skills/` or `.gemini/skills/`).
- **Manage specs via MCP tools only**: Use `sdd_initialize_system`, `sdd_add_subsystem`, `sdd_add_component`, `sdd_define_interface`, `sdd_write_narrative`, `sdd_add_type`, `sdd_get_spec`, `sdd_delete_spec`, `sdd_validate_tree`, and `sdd_get_status` (namespaced if needed). Do not edit specs manually.
- **Subprojects & Namespacing (Chaining)**: If a subsystem defines a `projectPath`, its entire `.wai/` spec tree is recursively loaded and namespaced with the subsystem ID as a prefix (using `::`, e.g. `billing::invoice::invoice_portal`). Use the qualified namespaced ID with the parent MCP tools; wairon will resolve the path and strip the prefix automatically.
  - **Leading `::`**: Bypasses the local subsystem prefix to resolve absolute from the system root (e.g. `::shared::error-type`).
  - **`super::`**: Goes up one parent subsystem level (e.g. `super::sibling_comp`, `super::super::parent_sibling`).
- **Do not run the `wairon` CLI**: Use `sdd_validate_tree` and `sdd_get_status` instead of CLI commands.
- **Handoff to implementation**: Once design is complete and validates cleanly, tell the human: *"The specs are complete and validate. Please run `wairon lock` to confirm and generate the implementer agents, then restart this session to load them."*
- **To implement code**: Spawn the generated `<component-id>-implementer` subagent. Implementations must match L3 interfaces and L5 narratives exactly. If you are operating inside a subproject directory context (e.g. subfolder) and cannot see or spawn the generated implementer agent or its skills, instruct the user to start a new agent session from the parent wairon project directory root.

### Rules (enforced by `sdd_validate_tree`)
1. **Design before code**: Complete spec and pass validator before writing source code.
2. **Human-in-the-loop**: Ask user approval for each spec layer before proceeding.
3. **Spec consistency**: If a 1:1 narrative match is incorrect or conflicts with L0 requirements, escalate a spec revision first. Never ship mismatched code.
4. **No persistence shortcuts & strict layers**: A Portal must never depend directly on a Repository, Store, Registry, or Adapter (enforce Portal -> Orchestrator -> Repository/Store). Every stored entity (even simple configs/permissions/rules) must use a proper Repository (composed of Store, Registry, and Index). Never store state inside Orchestrators or Specialists directly, and never combine Store/Registry/Index roles into one component.

### Component Vocabulary
* **Blocks**: Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist.
* **Patterns**: Repository, Gateway (these composable patterns `own` member blocks).
* Use `owns` for private member containment (exactly one hop) and `dependsOn` for collaborators. Never use generic suffixes like "Manager", "Helper", or "Utils".
<!-- wairon-guide-end -->

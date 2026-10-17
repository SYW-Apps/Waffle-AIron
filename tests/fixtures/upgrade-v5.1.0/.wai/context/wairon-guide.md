<!-- wairon-version: 5.1.0 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Project Context — shop

# shop

## Overview
A new project initialized with Wairon.
(The AI agent should overwrite this description with a complete overview of the project concept and stack once the user specifies their choices)

## Tech Stack
- [Specify Language, Framework, and Databases here]

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon.
- Refrain from writing code implementation until specifications are approved.

---

# Domain Map (4 domains)

| ID | Source | Name |
|----|--------|------|
| `billing` | subsystem `billing` | billing |
| `catalog` | subsystem `catalog` | Catalog |
| `orders` | subsystem `orders` | Orders |
| `billing::charges` | subsystem `billing::charges` | Charges |

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
  7. **Subprojects & Namespacing**: If a subsystem uses `projectPath` delegation, target its specs using namespaced IDs (e.g. `subsystem::component`). Use leading `::` to target root (e.g. `::shared::type`) and `super::` to go up a level (e.g. `super::sibling`). wairon automatically resolves the path and strips the prefix on writes.

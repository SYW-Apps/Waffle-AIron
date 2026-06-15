<!-- wairon-generated — do not edit directly -->
<!-- source: .wai/context/project.md — run `wairon context sync` to rebuild -->

# Project Context — gatekeeper-saas

# gatekeeper-saas

## Overview
A new project initialized with Wairon.
(The AI agent should overwrite this description with a complete overview of the project concept and stack once the user specifies their choices)

## Tech Stack
- [Specify Language, Framework, and Databases here]

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon.
- Refrain from writing code implementation until specifications are approved.

---

# Domain Map (0 domains)

_No domains yet._

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

Prefer MCP tools over running `wairon` CLI commands when querying project state.

---

## wairon — Spec-Driven Development (optional)

A project *may* use **wairon**, an optional spec-driven development (SDD) workflow.
If a `.wai/specs/` tree exists, the workflow is active for that project; otherwise
you can ignore wairon and work normally. wairon does not run or orchestrate AI
sessions — it *equips* yours.

### What wairon owns when active

- `.wai/specs/` is a typed spec tree: L0 System → L1 Subsystem → L2 Component →
  L3 Interface → L4 Implementation → L5 Narrative. It is the source of truth for
  the project's **architecture**.
- Agent files in `.claude/agents/` (and other tools) are **generated from the
  spec tree** — never edit them by hand. Run `wairon generate` to refresh them.
- `wairon validate` is an architecture-conformance gate: reference integrity,
  contract↔implementation method symmetry, component-stereotype dependency rules
  (e.g. Portals may not depend on Stores), and dependency-cycle detection.

### How wairon fits your session

- **Subagents:** the generated agent files (a `system-architect`, a `*-owner`
  per subsystem/domain, a `*-implementer` per component). Spawn them with your
  tool's own native subagent mechanism — wairon does not spawn sessions itself.
- **Skills:** `sdd-architect`, `sdd-narrative`, `sdd-auditor`, `sdd-implement` —
  run them in-session to drive the workflow.
- **MCP tools:** `sdd_*` tools to author and validate specs (see the project guide).

### Strict once enabled

If the SDD workflow is active, follow it strictly:
1. **Design before code.** Do not write source for a component until its spec is
   complete and `sdd_validate_tree` passes with zero errors.
2. **Spec is law.** Generated code maps 1:1 to the interfaces and narrative steps.
   If the spec is incomplete, stop and extend the spec — do not improvise.
3. **Human-in-the-loop.** Present each drafted spec layer for approval before
   moving on; do not design several layers ahead unprompted.

### Key commands (human-run)
```
wairon status                spec-tree completeness dashboard
wairon validate              architecture-conformance gate
wairon generate              regenerate agent files + (re)install skills
wairon list                  list agents resolved from the spec tree
wairon domains list          list domains (subsystem-derived + free-standing)
wairon skills install        (re)install the SDD skills into your tools
wairon mcp install           register the wairon MCP server
```

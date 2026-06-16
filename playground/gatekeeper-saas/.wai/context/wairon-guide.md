<!-- wairon-version: 0.1.0 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Project Context — gatekeeper-saas

# gatekeeper-saas

## Overview
The `gatekeeper-saas` is a high-performance, resilient microservice designed to track customers, meter API access, enforce subscription limits, and handle notification alerts for over-limit/warning usage. It integrates with Stripe for lifecycle billing and subscription events, and manages client access token authentication and rate-limiting.

## Tech Stack
- **Language/Runtime:** Rust (stable)
- **Primary Database:** PostgreSQL (for relational metadata: users, subscriptions, configurations)
- **Caching & Metering Store:** Redis (for low-latency, high-throughput token-bucket or sliding-window rate-limiting and usage counters)
- **External Services:** Stripe (Billing/Subscriptions), SMTP/SendGrid (Email Notifications)

## Key Conventions
- **Spec-Driven Development (SDD):** Built using the Wairon SDD framework. Spec tree under `.wai/specs/` is the single source of truth.
- **Architectural Perfection:** Narrative composition, semantic naming, zero-copy models, zero-wait concurrency, and passive foundations.
- **Testing Gate:** Unit and integration test coverage must be developed test-first before component implementation.

---

# Domain Map (3 domains)

| ID | Source | Name |
|----|--------|------|
| `identity-billing` | subsystem `identity-billing` | Identity & Billing Subsystem |
| `metering` | subsystem `metering` | Metering & Enforcement Subsystem |
| `notifier` | subsystem `notifier` | Alerts & Notifications Subsystem |

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

A project *may* use **wairon**, an optional spec-driven development (SDD) workflow.
If a `.wai/specs/` tree exists, the workflow is active for that project; otherwise
you can ignore wairon and work normally. wairon does not run or orchestrate AI
sessions — it *equips* yours.

### What wairon owns when active

- `.wai/specs/` is a typed spec tree: L0 System → L1 Subsystem → L2 Component →
  L3 Interface → L4 Implementation → L5 Narrative. It is the source of truth for
  the project's **architecture**.
- Agent files in `.claude/agents/` (and other tools) are **generated from the
  spec tree** — never edit them by hand.
- A conformance gate enforces reference integrity, contract↔implementation method
  symmetry, component-stereotype dependency rules (e.g. Portals may not depend on
  Stores), and dependency-cycle detection. You run it via the `sdd_validate_tree`
  MCP tool.

### How you work in an SDD project

- **Skills:** invoke `sdd-architect` to design (plus `sdd-narrative`, `sdd-auditor`,
  `sdd-implement`). The project's own `.claude/CLAUDE.md` / `.gemini/GEMINI.md` guide
  is your full playbook — read it and follow it; you don't need to search for more.
- **MCP tools:** author and validate specs through the `sdd_*` tools
  (`sdd_initialize_system`, `sdd_add_subsystem`, `sdd_add_component`,
  `sdd_define_interface`, `sdd_write_narrative`, `sdd_add_type`, `sdd_validate_tree`,
  `sdd_get_status`).
- **You never run the `wairon` CLI — it is the human developer's tool.** Everything
  it does, you do through MCP: validate with `sdd_validate_tree` (not `wairon
  validate`); check status with `sdd_get_status` (not `wairon status`). Don't run
  shell commands for these.
- **Subagents:** spawn the generated `<component>-implementer` agents via your tool's
  own native subagent mechanism — wairon does not spawn sessions itself.

### Strict once enabled

If the SDD workflow is active, follow it strictly:
1. **Design before code.** Do not write source for a component until its spec is
   complete and `sdd_validate_tree` passes with zero errors.
2. **Spec is law.** Generated code maps 1:1 to the interfaces and narrative steps.
   If the spec is incomplete, stop and extend the spec — do not improvise.
3. **Human-in-the-loop.** Present each drafted spec layer for approval before
   moving on; do not design several layers ahead unprompted.

<!-- wairon-version: 0.1.0 -->
<!-- wairon-generated — do not edit directly; the human developer rebuilds this with `wairon generate` -->

# Project Context — gatekeeper-saas-claude-v1

# gatekeeper-saas-claude-v1

## Overview
**Gatekeeper** is a multi-tenant SaaS control-plane microservice that sits in front of
our platforms' APIs. It tracks customers, meters their API access in real time, and
enforces subscription limits backed by Stripe. On every protected API call, a customer
platform asks Gatekeeper to authorize the request; Gatekeeper checks the caller's
subscription tier and remaining quota, returns an allow/deny decision, and decrements
the usage counter. It reconciles metered usage against Stripe subscriptions, manages
per-tier limits, and emits usage-threshold notifications to each account's billing
email.

## Tech Stack
- **Language / Runtime:** Rust (async, Tokio).
- **Inbound transport:** HTTP/JSON (and optionally gRPC) ingress for the gate.
- **Authoritative store:** PostgreSQL (accounts, subscriptions, plans/limits, invoices,
  usage rollups) accessed via `sqlx`.
- **Hot path / counters:** Redis for per-subscription rate-limit & quota counters,
  accessed via `deadpool-redis`. The inline gate reads/decrements here.
- **External integrations (Adapters only):** Stripe via `async-stripe`
  (subscriptions, metered billing, webhooks); transactional email via an HTTP email
  provider adapter (e.g. SendGrid/Postmark).

## Enforcement Model
- **Inline synchronous gate.** Customer platforms call Gatekeeper to authorize each
  protected API call. The decision path is latency-critical: it reads cached
  limits + Redis counters, never blocking on Postgres in the hot path.
- Postgres is the source of truth; Redis counters are projections seeded from
  Postgres and periodically reconciled / flushed back as usage rollups.

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon. The spec tree under `.wai/specs/`
  is the source of truth; agents and code are derived from it.
- Refrain from writing code implementation until specifications are approved and
  `sdd_validate_tree` passes with zero errors.
- Architectural vocabulary only (Portal, Orchestrator, Store, Index, Registry,
  Adapter, Observer, Specialist; Repository/Gateway patterns). No "Manager/Helper/Utils".
- Only `Portal` components accept external traffic. All external I/O (Postgres, Redis,
  Stripe, email) happens exclusively in `Adapter` components.

---

# Domain Map (5 domains)

| ID | Source | Name |
|----|--------|------|
| `accounts` | subsystem `accounts` | Accounts Subsystem |
| `gatekeeping` | subsystem `gatekeeping` | Gatekeeping Subsystem |
| `metering` | subsystem `metering` | Metering Subsystem |
| `notifications` | subsystem `notifications` | Notifications Subsystem |
| `subscriptions` | subsystem `subscriptions` | Subscriptions Subsystem |

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

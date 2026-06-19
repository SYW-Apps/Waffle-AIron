# SDD Phased Design Blueprint & Quest Log

This document serves as your living system-design workbook and project-level guide for AI Spec-Driven Development (SDD) in **gatekeeper-saas-claude-v1**. 
It aligns developer intent with structured, verified specifications under the `wairon` framework.

---

## Stage 1: The Constitution (Guardrails & Rules)

Define the non-negotiable architectural guardrails here. The AI agent must follow these constraints.

*   [x] **Primary Language & Runtime:** Rust (async / Tokio).
*   [x] **Architectural Style:** Hexagonal / DDD — bounded subsystems, all external I/O behind Adapters.
*   [x] **Data Persistence Rules:**
    *   PostgreSQL (`sqlx`) is the authoritative store; Redis (`deadpool-redis`) holds hot gate counters.
    *   No raw SQL or Redis access outside `Adapter` components; domain logic reaches persistence only through a `Repository` facade.
    *   Redis counters are projections of Postgres state, reconciled/flushed back as usage rollups; Postgres is never on the inline gate hot path.
*   [x] **Stereotype Dependencies:**
    *   `Store` holds authoritative state; it is depended upon and never depends on a `Registry`/`Index`.
    *   `Adapter` components are the only blocks doing external I/O (Postgres, Redis, Stripe, email) and never depend on `Orchestrators` or `Stores`.
    *   Only `Portal` components accept external traffic; Portals never depend directly on Stores/Repositories/Adapters.
    *   External integrations (Stripe, email) are isolated in dedicated Adapters within their owning subsystem.

---

## Stage 2: System Definition (Level 0 & Level 1)

*   [x] **System Vision (L0):** Defined in `.wai/specs/system.yaml`.
*   [x] **Subsystem Isolation (L1):** 5 subsystems declared — `accounts`, `subscriptions`, `metering`, `gatekeeping`, `notifications`.

> **Subsystem design order (dependency-first):** accounts → subscriptions → metering → gatekeeping → notifications.
> Leaf/authoritative contexts first; gatekeeping & notifications (which consume the others) last.
> **Status:** ✅ accounts ✅ subscriptions ✅ metering — L2+L3 committed & validated (draft). Next: gatekeeping L2/L3, then notifications.
> **NEW VALIDATOR RULES (learned this session):**
> - `PUBLIC_INTERFACE_UNBOUND` — every subsystem publicInterface must bind to a realizing component (`sdd_set_public_interfaces`).
> - Cross-subsystem `dependsOn` may only target a *published* public component of the target subsystem.
> - `PUBLIC_INTERFACE_TYPE_MISMATCH` / `PUBLIC_INTERFACE_EVENT_MISTYPED` — a publicInterface's type must match its realizer: `REST`→Portal(HTTP), `RPC`→Portal(gRPC), `MessageBus`→Observer or Portal(MessageBus) **(inbound/consume only)**, `Custom`→any (used for in-process APIs). The validator reads the description: phrasing an egress as "publishes events" while backing it with an Adapter is flagged.
> **Architecture decisions locked:** This is ONE Rust service; cross-subsystem calls are in-process → published as `Custom`. Event publishing (metering→bus) is internal Adapter egress, NOT a public interface; the `usage.threshold` contract is realized on the CONSUMER side (notifications Observer = MessageBus public interface).
> - `CROSS_SUBSYSTEM_NON_ADAPTER` (ERROR) — a subsystem boundary may be crossed **only by a local client Adapter** that calls the remote subsystem's published interface. Orchestrators/Specialists must depend on a local client Adapter, never directly on a remote component.
> Published in-process contracts so far: subscriptions `entitlement-resolver` (Custom), metering `usage-meter` (Custom). Both consumed by gatekeeping **via local client adapters** (`subscriptions-client-adapter`, `metering-client-adapter`).
> **Status:** ✅ gatekeeping L2+L3 (with client-adapter boundary fix). Next: notifications (last). Will need: accounts to publish a billing-email lookup (Custom), a notifications accounts-client-adapter, and an edge-triggered threshold flag in metering's redis-counter-adapter.
> RESOLVED: Portal wire endpoints now bound structurally via `sdd_set_endpoints` (HTTP transport, verb+path per method). All 18 `MISSING_ENDPOINT` warnings cleared. Only `DRAFT_*` status warnings remain (human `wairon` CLI promotion step).

---

## Stage 3: Ingress/Egress Portals (Level 2 & Level 3)

Portals are the boundaries of your subsystems. Define how requests enter and leave.

*   [x] **Define Ingress Portals (REST / gRPC / MessageBus):** HTTP portals for accounts, subscriptions (+Stripe webhook), metering, gatekeeping; MessageBus Observer for notifications.
    *   *Done:* all 18 HTTP endpoints bound structurally via `sdd_set_endpoints` (verb+path per method); `MISSING_ENDPOINT` warnings cleared.
*   [x] **Define Egress / Cross-boundary Adapters:** Stripe adapter, Redis counter adapter, usage-event adapter (bus egress), email adapter, audit/notification-log adapters, and client adapters (subscriptions-client, metering-client, accounts-client).

---

## Stage 4: Subsystem Core & Stereotypes (Level 2 & Level 3)

Flesh out the internal components that do the actual work.

*   [x] **Orchestrators:** account/plan/subscription/stripe-event/gate/credential/notification orchestrators + usage-meter; usage-reconciler (Actor).
*   [x] **Stores & Repositories:** Repositories for account, plan, subscription, usage-rollup, credential (each = Store+Registry+Index+DB-Adapter).
*   [x] **Adapters:** Stripe, Redis counter, usage-event, email, audit, notification-log, 3 DB adapters per repo, 3 cross-subsystem client adapters.
*   **DONE:** all 53 L2 components + L3 interfaces committed; `sdd_validate_tree` = 0 errors (only draft + advisory http warnings). Stages 3 & 4 complete.

---

## Stage 5: Execution Flow Narratives (Level 4 & Level 5)

Map the behavior step-by-step.

*   [x] **Write Narratives (L4/L5): COMPLETE — all 53 components, `sdd_validate_tree` = 0 errors.**
    *   [x] gatekeeping (12) · [x] subscriptions (18) · [x] metering (11) · [x] accounts (8) · [x] notifications (5)
    *   Refinements made during narrative tracing: (a) api-key/auth-result drop billing_account_id (from entitlements); (b) Stripe ownership in subscriptions (stripe_customer_id on subscription; metadata carries our subscription_id for webhook mapping); (c) added account-orchestrator.get_customer; (d) added billing-account-client-adapter (subscriptions→accounts); (e) Redis counter stores cumulative USED per window (queryable), adapter derives remaining from quota; (f) edge-triggered threshold via try_mark_threshold.
    *   **Note:** No MCP tool sets component `status` → promoting draft→complete is the developer's `wairon` CLI step (gates Stage 6). Specs validating at 0 errors is the design milestone.

---

## Stage 6: Sandbox Implementation

Once the specs are clean and compiled, mark the components as `status: complete` to lock them, then generate the agents and write code!

*   [x] **Validation Check (AI):** `sdd_validate_tree` returns **0 errors / 0 warnings**; all 18 Portal endpoints bound via `sdd_set_endpoints`.
*   [x] **Promote draft → complete (human):** `wairon lock` flipped every spec to `complete`.
*   [x] **Agent Generation (human):** implementer agents generated.
*   [x] **Code Implementation:** ALL 53 components implemented 1:1 to interface + narrative at their `sourcePath`. `sdd_get_status` = **100% Complete**; `cargo build` clean; `cargo test` = 72 passing.

### Implementation summary (single Rust crate, modules per subsystem)
* Each L3 interface → a Rust trait; components hold `Arc<dyn Trait>` deps (mockable for TDD). Method bodies map 1:1 to L5 narrative steps (`// Step N:` comments).
* Stores use the write-lock / read-swap hybrid (`arc-swap` snapshot reads, mutex-serialized COW writes). Adapters are the only blocks doing external I/O (sqlx Postgres, deadpool-redis, reqwest→Stripe/email). Cross-subsystem calls only via local client Adapters.
* In-process realizations: cross-subsystem APIs are direct `Arc<dyn>` calls; the `usage.threshold` MessageBus is a `tokio::broadcast` channel (metering publishes, notifications subscribes). Reconciler + notification consumer run as spawned background tasks.
* Migrations `0001`–`0005` (accounts, subscriptions, metering, gatekeeping, notifications).

### Known divergences from narrative (flagged, faithful to the typed interfaces)
1. **subscription-orchestrator**: narrative mentions a `NoBillingEmail` outcome absent from the `SubscriptionError` enum → mapped to `Conflict`.
2. **Adapter boundaries can't be unit-tested without infra** (Postgres/Redis/Stripe/email); their tests are at the mapping/logic level (e.g. real HMAC webhook verification is unit-tested). Live integration requires the services.

### Stage 6 remediation — conformance gate (new validator rules)
The gate (`wairon validate` CLI / `sdd_validate_tree` MCP) introduced two new rules; remediated as follows:
1. **`CROSS_SUBSYSTEM_TARGET_NON_PORTAL` (4 errors → 0):** a cross-subsystem client Adapter must enter the remote subsystem through its **Portal** (front door), not an internal component. Each remote Portal now exposes the in-process op (1:1 forward) and the 4 client Adapters depend on the Portal: metering-portal.`consume`→usage-meter; subscriptions-portal.`resolve_entitlements`→entitlement-resolver; accounts-portal.`resolve_billing_email`→account-directory. The `Custom`→{usage-meter, entitlement-resolver, account-directory} public interfaces were dropped (the REST Portals are the published surface). In code: each Portal carries a `*PortalApi` in-process trait; subsystems expose `portal` not the internal component; composition root + test harness wire Portal→Portal.
2. **`NARRATIVE_SEMANTIC_UNBACKED` (7 warnings → 0):** declared guarantees where genuinely delivered — `atomic` on redis `check_and_decrement`/`try_mark_threshold`; `idempotent` on subscription-repository/registry `mark_event_processed`. Reworded narratives where the guarantee wasn't backed (dropped the cross-boundary "atomic" assertion; dropped the misplaced "transactional" wording — the registry does not open one DB transaction, and transactional is **not** an L0 requirement).
3. **`usage-reconciler` idempotency (was divergence #1) — FIXED:** L0 mandates *"Idempotent usage accounting"*, so the additive overcounting was a requirement violation, not a tolerable divergence. The rollup write is now **set-style** (store `upsert_add`→`set_used`, registry `increment`→`set_usage`, repository `record_usage` declared `idempotent`): a pass sets the period rollup to the counter's cumulative `used`, so overlapping/retried flushes never double-count.

**Tests:** `cargo nextest run` = **80 passed** (72 unit + 5 composition + 3 infra-gated). Build clean.
**Re-lock required:** the spec edits reset 7 components to `draft`. Run `wairon lock` to re-promote them to `complete` and regenerate the implementer agents, then restart the session.

---

## SPEC DEFINITION: COMPLETE — no gaps

The full project is defined in specs. Nothing in the spec tree is left as TODO.

* **L0** system vision + 3 boundaries + 6 global requirements.
* **L1** 5 subsystems, all public interfaces bound to realizing components (REST / Custom in-process / MessageBus-consumer).
* **L2** 53 components, boundaries validated (cross-subsystem only via client Adapters).
* **L3** every component has an interface (~115 methods total).
* **L4/L5** every method has a narrative; every component carries a `sourcePath`.
* **Types** 47 types defined — all entities, value-objects, id newtypes, and shared infra errors (api/db/stripe) referenced in signatures resolve.
* **Validation:** `sdd_validate_tree` = 0 errors.

* **Endpoints** all 18 Portal HTTP endpoints bound structurally (verb+path) via `sdd_set_endpoints`.

**Only non-spec remainders (cannot be done via MCP / are not spec content):**
1. `draft → complete` status flip — human `wairon` CLI step.
2. Source `.rs` files — implementation (Stage 6), intentionally after specs.

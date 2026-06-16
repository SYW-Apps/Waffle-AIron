# SDD Phased Design Blueprint & Quest Log

This document serves as your living system-design workbook and project-level guide for AI Spec-Driven Development (SDD) in **gatekeeper-saas**. 
It aligns developer intent with structured, verified specifications under the `wairon` framework.

---

## Stage 1: The Constitution (Guardrails & Rules)

Define the non-negotiable architectural guardrails here. The AI agent must follow these constraints.

*   [x] **Primary Language & Runtime:** Rust (stable)
*   [x] **Architectural Style:** Wairon SDD / Bounded Context Isolation
*   [x] **Data Persistence Rules:** PostgreSQL (via Prisma Adapter) for relational data, Redis Adapter for low-latency metering.
*   [x] **Stereotype Dependencies:**
    *   `Store` components can only call other `Stores` or `Registries`.
    *   `Adapter` components cannot depend on `Orchestrators` or `Stores` directly.
    *   Only `Portal` components can accept external traffic.

---

## Stage 2: System Definition (Level 0 & Level 1)

*   [x] **System Vision (L0):** Define `.wai/specs/system.yaml`.
    *   *AI Action:* Run `sdd_initialize_system` to create the system vision.
*   [x] **Subsystem Isolation (L1):** Define subsystems in `.wai/specs/subsystems/*.yaml`.
    *   *AI Action:* Run `sdd_add_subsystem` to declare the core bounded contexts (e.g. `billing`, `catalog`, `users`).

---

## Stage 3: Ingress/Egress Portals (Level 2 & Level 3)

Portals are the boundaries of your subsystems. Define how requests enter and leave.

*   [x] **Define Ingress Portals (REST / gRPC / MessageBus):**
    *   *AI Action:* Create L2 Portal components with `status: draft` and map their L3 interfaces.
    *   *Design check:* Ensure HTTP endpoints (method, path) or gRPC names are correctly declared in the method bindings.
*   [x] **Define Egress Portals (Clients / Publishers):**
    *   *AI Action:* Declare any external event publishing or client communication Portals.

---

## Stage 4: Subsystem Core & Stereotypes (Level 2 & Level 3)

Flesh out the internal components that do the actual work.

*   [x] **Orchestrators:** Handle transaction scripts and workflow coordination.
*   [x] **Stores & Repositories:** Handle persistence.
*   [x] **Adapters:** Call external third-party APIs (e.g. Stripe, SendGrid).
*   *AI Action:* Create components with `status: draft` and define their interfaces/signatures.

---

## Stage 5: Execution Flow Narratives (Level 4 & Level 5)

Map the behavior step-by-step.

*   [x] **Write Narratives:** Write Level 5 narrative steps mapping methods to internal calls.
    *   *AI Action:* For each interface method, describe the sequential call stack (e.g. Call `payment_store.save`, then Call `stripe_adapter.charge`).
    *   *AI Action:* Call the `sdd_get_status` MCP tool to verify completeness, and `sdd_validate_tree` to ensure no circular loops or dependency leaks exist.

---

## Stage 6: Sandbox Implementation

Once the specs are clean and compiled, mark the components as `status: complete` to lock them, then generate the agents and write code!

*   [x] **Validation Check (AI):** Call the `sdd_validate_tree` MCP tool (must return 0 errors).
*   [ ] **Agent Generation (human):** The developer runs `wairon generate` from their terminal to instantiate agent sandboxes — the AI does not run this.
*   [ ] **Code Implementation:** Let the agent implement the component code matching the narrative.

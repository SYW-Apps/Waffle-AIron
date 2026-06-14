# SDD Phased Design Blueprint & Quest Log

This document serves as your living system-design workbook and project-level guide for AI Spec-Driven Development (SDD) in **gatekeeper-saas**. 
It aligns developer intent with structured, verified specifications under the `node "C:/Users/ShutYourWaffle/source/Waffle-AIron/dist/cli/index.js"` framework.

---

## Stage 1: The Constitution (Guardrails & Rules)

Define the non-negotiable architectural guardrails here. The AI agent must follow these constraints.

*   [ ] **Primary Language & Runtime:** Node.js (TypeScript) / Python / etc.
*   [ ] **Architectural Style:** Clean Architecture / Hexagonal / Domain-Driven Design (DDD).
*   [ ] **Data Persistence Rules:** E.g. No raw SQL in controllers; all DB operations must use a `Store` / `Repository`.
*   [ ] **Stereotype Dependencies:**
    *   `Store` components can only call other `Stores` or `Registries`.
    *   `Adapter` components cannot depend on `Orchestrators` or `Stores` directly.
    *   Only `Portal` components can accept external traffic.

---

## Stage 2: System Definition (Level 0 & Level 1)

*   [ ] **System Vision (L0):** Define `.wai/specs/system.yaml`.
    *   *AI Action:* Run `sdd_initialize_system` to create the system vision.
*   [ ] **Subsystem Isolation (L1):** Define subsystems in `.wai/specs/subsystems/*.yaml`.
    *   *AI Action:* Run `sdd_add_subsystem` to declare the core bounded contexts (e.g. `billing`, `catalog`, `users`).

---

## Stage 3: Ingress/Egress Portals (Level 2 & Level 3)

Portals are the boundaries of your subsystems. Define how requests enter and leave.

*   [ ] **Define Ingress Portals (REST / gRPC / MessageBus):**
    *   *AI Action:* Create L2 Portal components with `status: draft` and map their L3 interfaces.
    *   *Design check:* Ensure HTTP endpoints (method, path) or gRPC names are correctly declared in the method bindings.
*   [ ] **Define Egress Portals (Clients / Publishers):**
    *   *AI Action:* Declare any external event publishing or client communication Portals.

---

## Stage 4: Subsystem Core & Stereotypes (Level 2 & Level 3)

Flesh out the internal components that do the actual work.

*   [ ] **Orchestrators:** Handle transaction scripts and workflow coordination.
*   [ ] **Stores & Repositories:** Handle persistence.
*   [ ] **Adapters:** Call external third-party APIs (e.g. Stripe, SendGrid).
*   *AI Action:* Create components with `status: draft` and define their interfaces/signatures.

---

## Stage 5: Execution Flow Narratives (Level 4 & Level 5)

Map the behavior step-by-step.

*   [ ] **Write Narratives:** Write Level 5 narrative steps mapping methods to internal calls.
    *   *AI Action:* For each interface method, describe the sequential call stack (e.g. Call `payment_store.save`, then Call `stripe_adapter.charge`).
    *   *Verification:* Run `node "C:/Users/ShutYourWaffle/source/Waffle-AIron/dist/cli/index.js" status` to verify completeness, and `node "C:/Users/ShutYourWaffle/source/Waffle-AIron/dist/cli/index.js" validate` to ensure no circular loops or dependency leaks exist.

---

## Stage 6: Sandbox Implementation

Once the specs are clean and compiled, mark the components as `status: complete` to lock them, then generate the agents and write code!

*   [ ] **Validation Check:** Run `node "C:/Users/ShutYourWaffle/source/Waffle-AIron/dist/cli/index.js" validate` (must return 0 errors).
*   [ ] **Agent Generation:** Run `node "C:/Users/ShutYourWaffle/source/Waffle-AIron/dist/cli/index.js" generate` to instantiate agent sandboxes.
*   [ ] **Code Implementation:** Let the agent implement the component code matching the narrative.

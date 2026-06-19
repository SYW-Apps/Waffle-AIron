# SDD Phased Design Blueprint & Quest Log

This document serves as your living system-design workbook and project-level guide for AI Spec-Driven Development (SDD) in **gatekeeper-saas**. 
It aligns developer intent with structured, verified specifications under the `wairon` framework.

---

## Stage 1: The Constitution (Guardrails & Rules)

Define the non-negotiable architectural guardrails here. The AI agent must follow these constraints.

*   [x] **Primary Language & Runtime:** Rust (Async with Tokio/Axum)
*   [x] **Architectural Style:** Clean Architecture / Hexagonal / Wairon Stereotypes
*   [x] **Data Persistence Rules:** Postgres SQLx operations wrapped in Adapters/Stores. Redis counters wrapped in MeterStore.
*   [x] **Stereotype Dependencies:**
    *   `Store` components can only call other `Stores` or `Registries`.
    *   `Adapter` components cannot depend on `Orchestrators` or `Stores` directly.
    *   Only `Portal` components can accept external traffic.

---

## Stage 2: System Definition (Level 0 & Level 1)

*   [x] **System Vision (L0):** Define `.wai/specs/system.yaml`.
*   [x] **Subsystem Isolation (L1):** Define subsystems in `.wai/specs/<subsystem>/subsystem.yaml`.

---

## Stage 3: Ingress/Egress Portals (Level 2 & Level 3)

Portals are the boundaries of your subsystems. Define how requests enter and leave.

*   [x] **Define Ingress Portals (REST / gRPC / MessageBus):**
    *   [x] **gatekeeper:** `gatekeeper-portal` (complete)
    *   [x] **billing:** `stripe-webhook-portal` (complete)
*   [x] **Define Egress Portals (Clients / Publishers):**
    *   [x] All subsystems have completed Portals/Adapters for inbound/outbound.

---

## Stage 4: Subsystem Core & Stereotypes (Level 2 & Level 3)

Flesh out the internal components that do the actual work.

*   [x] **Orchestrators:**
    *   [x] **gatekeeper:** `gatekeeper-orchestrator` (complete)
    *   [x] **billing:** `billing-orchestrator` (complete)
    *   [x] **notification:** `notification-orchestrator` (complete)
*   [x] **Stores & Repositories:**
    *   [x] **gatekeeper:** `meter-repository`, `meter-store` (complete)
    *   [x] **billing:** `subscription-repository`, `subscription-store`, `customer-repository`, `customer-store` (complete)
*   [x] **Adapters:**
    *   [x] **gatekeeper:** `redis-adapter` (complete)
    *   [x] **billing:** `database-adapter`, `stripe-adapter` (complete)
    *   [x] **notification:** `email-adapter`, `push-adapter` (complete)

---

## Stage 5: Execution Flow Narratives (Level 4 & Level 5)

Map the behavior step-by-step.

*   [x] **Write Narratives:**
    *   [x] **gatekeeper:** All 5 component narratives written and validated (complete)
    *   [x] **billing:** All 9 component narratives written and validated (complete)
    *   [x] **notification:** All 3 component narratives written and validated (complete)

---

## Stage 6: Sandbox Implementation

Once the specs are clean and compiled, mark the components as `status: complete` to lock them, then generate the agents and write code!

*   [x] **Validation Check (AI):** Validated using `wairon validate` (0 errors)
*   [x] **Agent Generation (human/AI):** Generated using `wairon generate` (23 agents resolved)
*   [x] **Code Implementation:**
    *   [x] All components fully implemented and verified by tests (100% complete)

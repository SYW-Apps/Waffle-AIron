---
name: sdd-implement
description: Generate concrete source code implementing a specified L2 component strictly from its finalized specs, with hard gating checks. Use when implementing or writing code for a fully-spec'd component.
---

# Skill: sdd-implement

## Trigger
- `/sdd implement [component]`
- "Implement component [componentName]"
- "Write code for [componentName]"

## Role & Behavior
You are the **Spec-to-Code Compiler**. Your job is to generate concrete source code implementing a specified L2 Component.

**STRICT COMPILER CONSTRAINTS (NON-NEGOTIABLE)**: 
1. **Gating Check**: You must NOT start writing implementation code for any component unless:
   - The design has been fully completed and approved by the user.
   - The target component's status in the specification is set to `status: complete`.
   - The `sdd_validate_tree` MCP tool reports zero errors.
2. **AI-TDD (Test-First Loop)**: You must write or refine the component's unit/integration test suite *before* writing the implementation code. Your tests must mock all direct L2 dependencies (derived from their L3 interfaces) and cover 100% of the paths, explicitly verifying success paths, boundaries, and all error paths (like validation errors, database timeouts, network failures).
3. You must map the L5 Narrative steps exactly 1:1 to statements/functions in the code.
4. You may not invent new steps.
5. You may not omit any steps.
6. You may not change the method signatures defined in the L3 Interface contracts.
7. All code must match the declarative nature of the blueprints.
8. You must strictly follow the inlined **Core Architecture & Coding Standards** (see below).
9. **Escalate spec contradictions — never ship "spec-faithful but wrong".** "Spec is law"
   means the spec must be *correct*; an internally contradictory spec is a defect to fix
   **upstream**, not to implement literally. If, while implementing, you find that a 1:1
   mapping would be wrong — most often because an L5 narrative asserts a semantic property
   (e.g. *idempotent*, *atomic*, *exactly-once*, *transactional*) that the L3 contract it
   calls cannot deliver (e.g. an additive `increment`/`upsert_add` cannot realize an
   idempotent set/replace), or because a faithful implementation would **violate an L0
   `globalRequirement`** — you must **STOP and escalate for a spec revision**. Do NOT
   record it as a "known divergence" footnote and proceed. Surface the contradiction to
   the user, propose the contract/narrative change (e.g. add a set-style write to the
   interface), and resume only once the spec is fixed and re-validated. A divergence that
   breaks an L0 guarantee is a gate failure, not a note.

## Workflow Rules
1. **Verify Gate & Fetch Spec Tree**:
   - Query the MCP server for the target component spec, its interfaces, and its L5 narratives.
   - Confirm that the component's status is `complete`. If it is `draft` or `design`, stop immediately and instruct the user to complete the specification and design review.
2. **Setup Workspace & Align with Standards**:
   - Align with the inlined **Core Architecture & Coding Standards** (see below) to ensure naming, narrative coding, and stereotype conventions are respected. Do NOT read these standards from disk; they are already fully specified in your system context.
   - Locate the target implementation source file (mapped by `sourcePath` in L4).
3. **Write Tests First (TDD)**:
   - Create or update the companion test file (e.g. `<component>.test.ts` or similar).
   - Mock all direct L2 dependencies using the signatures defined in their respective L3 `interface.yaml` files.
   - Write test cases for every method covering success scenarios, boundary values, and simulated error returns.
   - Run the test suite and verify that the tests fail.
4. **Compile Code**:
   - Generate/update the implementation file.
   - **Narrative Coding Rule**: Write method bodies strictly as a sequence of the L5 Narrative steps. Put comments indicating the narrative step numbers (e.g. `// Step 1: Read database record`). Keep functions short (~25 lines max), use one level of abstraction per function, and extract helper methods instead of writing inline comments.
   - If dependencies are needed, import them using the component interface signatures.
5. **Validation Gate**:
   - Run the test suite and verify that all tests pass successfully.
   - Verify that the code compiles successfully (type-check, build).
   - Ensure the implementation enforces the strict stereotype boundaries.

## 📜 Core Architecture & Coding Standards
All implementation work must strictly adhere to these rules:
1. **Semantic Naming & Stereotypes**:
   - Use exact component roles:
     - `Portal` (external entrypoint orchestrator composed of standard building blocks; never does domain work directly).
     - `Orchestrator` (coordinates multi-step workflows; never does simple CUD directly).
     - `Supervisor` (oversees running processes).
     - `Store` (authoritative in-memory/backend state boundary; returns references/pointers directly without copying).
     - `Registry` (manages registration/CUD write paths).
     - `Index` (handles read-path lookups, optimized query maps).
     - `Actor` (asynchronous state execution task).
     - `Observer` (subscribes to events and forwards them).
     - `Specialist` (narrow, functional domain rules e.g., Scanner, Router, Evaluator, Compiler).
   - **Strict Layer Isolation & No Persistence Shortcuts**:
     - A `Portal` must **never** depend directly on a `Repository`, `Store`, `Registry`, `Index`, or `Adapter`. It must **always** route calls through an `Orchestrator`.
     - Every stored domain entity (even simple configs, permissions, or rules) **must** use a dedicated `Repository` pattern composed of `Store`, `Registry`, and `Index` blocks. Do **not** store state inside `Orchestrator` or `Specialist` blocks directly, and do **not** combine Store/Registry/Index functionality into a single helper/specialist.
2. **Narrative coding (Level 5)**:
   - Every function body must read top-to-bottom as a sequential list of named, readable steps (Narrative Composition).
   - Maintain one level of abstraction per function. Functions must remain short (~25 lines max).
3. **Passive Foundations**:
   - Infrastructure, databases, and filesystem models must remain passive context and should never trigger side-effects directly.
4. **Zero-Wait Concurrency (Write-Lock / Read-Swap Hybrid)**:
   - For shared mutable state (Stores, Indexes, Registries), use wait-free/lock-free reads (e.g. via atomic pointer swaps or copy-on-write pointers) and serialize updates via a standard mutex (preventing write-write race conditions and CPU spinning/thrashing from raw Compare-And-Swap loops).
   - For Actors, expose state to readers via atomic snapshot hotswaps without locks (no write lock is needed since the Actor's event loop/task is the sole writer).
5. **Zero-Copy Purity**:
   - Use shared data models directly (passing pointers/references) rather than serializing, deserializing, or cloning data unnecessarily between local components.

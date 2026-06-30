---
name: sdd-narrative
description: Draft the precise step-by-step execution narrative (L5) for a specific implementation method, updating .wai/phased_design.md Stage 5. Use when designing or writing the narrative/flow for a method or component.
---

# Skill: sdd-narrative

## Trigger
- `/sdd narrative [component]`
- "Let's design the [methodName] method"
- "Let's write a narrative for [methodName]"

## Role & Behavior
You are the **Method Designer**. Your job is to draft the precise step-by-step narrative for a specific implementation method. 

You must read, respect, and update `.wai/phased_design.md` (specifically Stage 5: Execution Flow Narratives).

**Strict Rule**: No code writing. Write only structured narratives (L5 specs) composed of sequential, named logical steps.

## Workflow Rules
1. **Identify Intent**:
   - Ask the user for the high-level intent, signature, and contract of the method.
2. **Draft Narrative Steps**:
   - Outline sequential steps (e.g. Step 1: Read config, Step 2: Call database repository).
   - For every step, classify it as:
     - `local`: Internal logic (e.g., calculations, state mapping).
     - `call`: Call to another component.
3. **Verify Contracts & Boundaries (MCP)**:
   - For every `call` step, query the MCP server to verify that the target component is declared in the calling component's dependencies and that the target method exists on its L3 interfaces.
   - Run `sdd_validate_tree` to ensure this narrative doesn't create circular dependencies or break component type boundaries.
   - **Verify asserted semantics against the contract.** If a step claims a semantic
     property — *idempotent*, *atomic*, *transactional*, *exactly-once* — the target L3
     method MUST declare it in its `guarantees` list, and its shape must actually deliver
     it. An **additive** write (`increment`, `upsert_add`, "add amount to…") cannot realize
     an *idempotent* update; a reconcile/rollup that must be idempotent needs a
     **set/replace** method declaring `guarantees: [idempotent]`. The gate enforces this
     *consistency* (a narrative claim with no matching contract guarantee is flagged
     `NARRATIVE_SEMANTIC_UNBACKED`) but cannot verify the guarantee is truly delivered —
     that is on you and the implementer. If the contract lacks the needed method or
     guarantee, revise the L3 interface first (mandatory when an L0 `globalRequirement`
     depends on it).
4. **Register & Promote**:
   - Present the drafted narrative content (the exact step-by-step YAML structure) and a concise summary of the key flow/design choices directly in the chat message to the user. Do NOT create temporary/intermediate markdown review files in the brain or workspace for this feedback loop.
   - Upon user approval, call `sdd_write_narrative` to save it in the spec tree.
   - Once the interface, narrative, and spec for this component compile without errors, recommend changing the component's status field to `status: complete`.
   - Update Stage 5 checkboxes in `.wai/phased_design.md`.
5. **Granular Updates & Delta Merging**:
   - For large portals or existing interface implementations, do NOT rewrite the entire implementation spec. Use the **`sdd_update_spec`** MCP tool with `kind: "implementation"`.
   - Present the granular update delta directly to the user for feedback.
   - Match narrative steps by `stepNumber` and use `action: "insert"` to insert a step (auto-shifting subsequent steps up) or `action: "delete"` to delete a step (auto-shifting subsequent steps down).

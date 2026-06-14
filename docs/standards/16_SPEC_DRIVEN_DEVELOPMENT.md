# 16_SPEC_DRIVEN_DEVELOPMENT

**Version:** 1.0 · **Date:** 2026-06-10

This document defines the Spec-Driven Development (SDD) framework for Waffler Core. It formalizes how we transition from prose-based architecture documents into machine-readable, mathematically sound specifications that AI agents (and human implementers) can unambiguously compile into code.

> **Why SDD?** Waffler demands "Architectural Perfection" (Rule 1: Narrative Composition, Rule 5: Blueprint-to-Code Symmetry). Natural language is inherently ambiguous. By treating Waffler Core services exactly like Waffler Blueprints, we eliminate "guessing" and ensure two different implementers generate the exact same code structure.

---

## 1. The 3-Layer Spec Framework

A complete Waffler service cannot be implemented until it is fully specified across three layers:

### L1: Structural Spec (The "Interface")
- **Role:** Defines the "Passive Foundations" (types, message bus commands, events, config).
- **Format:** `service.spec.yaml` (or `.wai` DSL).
- **Agent Rule:** Implementers generate struct definitions and bus payloads strictly from this layer. No fields may be added or assumed.

### L2: Behavioral Spec (The "Narrative")
- **Role:** Maps the "Narrative Composition." It defines the exact step-by-step logic for Orchestrators and Registries.
- **Format:** Component-specific YAML (e.g., `registry.spec.yaml`).
- **Agent Rule:** Every `step` in the spec's `narrative` array MUST map to exactly one function/action call in the resulting code. The names must match exactly.

### L3: Invariant Spec (The "Contract")
- **Role:** Defines the constraints required for "Architectural Perfection" (e.g., "Must not mutate NamespaceSegment directly", "Must use vfs:write_part").
- **Format:** Defined in `CANONICAL_DECISIONS.md` or embedded as `invariants` within the YAML.
- **Agent Rule:** Architecture and Security agents use these invariants to lint L2 specs *before* code is written.

---

## 2. Blueprint-to-Code Symmetry (Folder Layout)

Spec files must perfectly mirror the implementation folder structure. This ensures that implementing a service is simply a matter of traversing the spec tree and generating files 1:1.

Specs live in: `docs/waffler_core/specs/`

**Example Layout:**
```text
docs/waffler_core/specs/
└── blueprints/                    # The Service Name
    ├── service.spec.yaml          # L1: Bus commands, events, global dependencies
    ├── blueprint_registry/        # Maps to packages/blueprints/src/registry/
    │   ├── registry.spec.yaml     # L2: The orchestrator narrative steps
    │   └── actions/               # L2: The leaf nodes
    │       ├── validate_namespace.spec.yaml
    │       └── emit_lifecycle.spec.yaml
    └── blueprint_store/           # Maps to packages/blueprints/src/store.rs
        └── store.spec.yaml        # L1/L3: RAM-only constraints
```

---

## 3. The YAML Spec Schema (Template)

Below is the canonical format for a Behavioral (L2) Component Spec. All new components must draft a spec matching this schema before code generation begins.

```yaml
# docs/waffler_core/specs/<service_name>/<component_name>.spec.yaml
schema_version: "1.0"
component: <PascalCaseName>
role: <Store | Registry | Index | Action | Orchestrator | Portal | Observer>
description: "Brief description of the component's responsibility."

# For Orchestrators / Registries / Observers
narrative:
  <method_name>:
    description: "The story this method tells."
    input: <Expected Payload/Type>
    steps:
      - name: <snake_case_step_name>
        action: <Target Component or Action to call>
        description: "What this step does"
        failure: <Optional: Expected Error Type on failure>
      # ... subsequent steps ...
    output: <Expected Return Type or Event Emitted>

# For Stores / Indexes
data_structure:
  type: <HashMap | Vec>
  key: <Key Type>
  value: <Arc<Entity>>

invariants:
  - "Must never touch the filesystem directly."
  - "Must emit <event_name> on success."
```

---

## 4. The AI-Driven SDD Feedback Loop

Do not write code until the specs have passed the validation loop. We use specialized AI sub-agents to "compile and link" the specs in isolation.

### Step 1: Draft
The Software Architect drafts the YAML specs based on requirements and places them in `docs/waffler_core/specs/`.

### Step 2: The Architect Lint
**Agent:** `software-architect` or `code-reviewer`
**Task:** Lint the spec against `CANONICAL_DECISIONS.md`.
**Prompt:** *"Review this spec. Does it violate the Component Building Blocks? (e.g., does a Store specify disk writes? Does an Orchestrator contain complex logic instead of calling Actions?). Fail the spec if it violates Waffler architecture."*

### Step 3: The Linker Validation
**Agent:** `software-architect`
**Task:** Validate the interfaces between components.
**Prompt:** *"Review `service_A.spec.yaml` and `service_B/observer.spec.yaml`. Service A emits `x.created` with payload Y. Does Service B expect payload Y? Are there any missing capability registrations? Report gaps."*

### Step 4: The Security Audit
**Agent:** `security-auditor`
**Task:** Threat model the narrative sequence.
**Prompt:** *"Review the steps in `registry.spec.yaml`. Is there an authorization validation step prior to state mutation? Does this spec bypass `vfs:write_part`? Pass or Fail."*

### Step 5: Implementation
Once all agents PASS, the locked YAML spec is handed to the `implementer` agent.
**Constraint:** *"Generate Rust code for this component. Your functions MUST map exactly 1:1 with the `steps` defined in the spec. If you need a step not in the spec, STOP and report the spec as incomplete."*
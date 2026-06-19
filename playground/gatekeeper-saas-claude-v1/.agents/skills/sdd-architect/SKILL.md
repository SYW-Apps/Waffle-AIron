---
name: sdd-architect
description: Guide top-down architecture design of an SDD system through the spec tree (system → subsystems → components → interfaces), coordinating .wai/phased_design.md. Use when starting a new SDD project or structuring a system's architecture before writing code.
---

# Skill: sdd-architect

## Trigger
- `/sdd architect`
- "Start a new SDD project"
- "Let's design a new system"

## Role & Behavior
You are the **System Architect**. Your job is to guide the user interactively through defining the architecture of their system before any code is written. 

You must read, respect, and update the living quest log file: `.wai/phased_design.md` (which coordinates our design phases 1 to 6).

**STRICT ARCHITECT CONSTRAINTS (NON-NEGOTIABLE)**:
1. **Zero Implementation**: Under no circumstances should you generate or write implementation source code files (e.g. `.ts`, `.rs`, `.py` etc.) or start building code. You are restricted entirely to structural design and specification.
2. **Strict Spec File Isolation & Tree Structure**:
   - L0 (System): Declared ONLY in `.wai/specs/system.yaml`.
   - L1 (Subsystems): Declared in a directory named after the subsystem under `.wai/specs/`, using `subsystem.yaml` as the reserved file name. (E.g. `.wai/specs/billing/subsystem.yaml`). These must *never* contain internal component structures, methods, or details. They are strictly high-level isolation boundary specs.
   - L2 (Components): Declared in a subdirectory under their parent subsystem, named after the component, using `component.yaml` as the reserved file name. (E.g. `.wai/specs/billing/billing_store/component.yaml`).
   - L3 (Interfaces): Declared in the same subdirectory as their component, using `interface.yaml` as the reserved file name. (E.g. `.wai/specs/billing/billing_store/interface.yaml`).
   - L4 (Implementations) & L5 (Narratives): Declared in the same subdirectory as their component, using `implementation.yaml` as the reserved file name. (E.g. `.wai/specs/billing/billing_store/implementation.yaml`).
   *(Note: If legacy flat folders like `.wai/specs/subsystems/` exist and are already populated in the project, respect them and continue placing new specs flat within those legacy folders. Otherwise, always default to the nested tree structure.)*
3. **Mandatory Iterative Feedback Loop**:
   - We do not trust the agent to write specs without user supervision. You must run a continuous, iterative feedback loop with the user.
   - For every subsystem, component, or interface you define:
     1. Write/draft the spec file.
     2. Present the drafted spec file content (YAML format) and a concise summary of the key design choices directly in the chat message to the user. Do NOT create temporary/intermediate markdown review files in the brain or workspace for this feedback loop.
     3. Ask: "Does this match your expectations? Is this correct, or is it off-track?"
     4. Wait for explicit user validation and approval before proceeding.
   - Do NOT work ahead across different layers or phases without feedback.
   - Batching is only allowed for components at the *same* layer/phase (e.g. drafting 2 related stores). However, you must present the entire batch (including contents and design summaries) directly in the chat for feedback and get approval before moving to the next design stage.

## Workflow Rules
1. **Align with Standards & Check Phased Design Workbook**:
   - Align with the inlined **Core Architecture & Coding Standards** (see below) to ensure naming, narrative coding, and stereotype conventions are respected. Do NOT read these standards from disk; they are already fully specified in your system context.
   - Read `.wai/phased_design.md` to understand current design decisions, active phases, and checkboxes.
2. **Synthesize Project Context (Stage 1)**:
   - Synthesize the user's system concept and requirements into a clear, professional project overview, stack details, and key conventions.
   - Edit `.wai/context/project.md` directly to write this synthesized context. Do NOT run or recommend any non-existent context commands (e.g. `wairon context init`).
3. **L0/L1 System & Subsystems (Stage 2)**:
   - Run `sdd_initialize_system` and `sdd_add_subsystem` to define parent structures.
   - Ask for user approval on L0/L1 before continuing.
4. **L2 Components & L3 Interfaces (Subsystem-by-Subsystem Focus)**:
   - Do NOT design components or interfaces for the entire system all at once. Proceed **one subsystem at a time** to ensure focused, manageable design reviews.
   - For the active subsystem:
     1. Design and add all L2 Components (Portals, Orchestrators, Stores, etc.) using `sdd_add_component` (defaulting to `status: draft`).
     2. Verify component boundaries: ensure Portals never depend directly on Stores, Repositories, or Adapters.
     3. Present the subsystem's component list to the user and request approval.
     4. Once approved, define the L3 Interfaces (`interface.yaml`) for each component in this subsystem.
     5. Present the interface signatures and signatures/returns to the user and request approval.
   - Only after the current subsystem is fully approved and validated should you move to the next subsystem.
5. **Track & Validate Progress**:
   - Check completeness by calling the MCP tool `sdd_get_status`.
   - Run the MCP tool `sdd_validate_tree` to check for circular dependencies or component stereotype violations early.
   - Check off the completed stages in `.wai/phased_design.md`.

## Guidelines
- Walk the user down the tree level-by-level.
- Always use the strict architectural vocabulary. Building blocks: Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist. Patterns (compositions of blocks): Repository, Gateway. Never use generic suffixes like "Manager", "Helper", or "Utils".
- Keep components in `status: draft` or `status: design` until their interfaces and narratives are fully outlined. Then update them to `status: complete` before unlocking Stage 6 (Implementation).
- Maintain constant communication. If you are unsure of the domain logic, stop and ask the user for clarification.
- **Explain your reasoning to the user.** When you make an architectural choice, be ready to explain *why* — e.g. why single-responsibility blocks instead of one "manager" class, why a Repository (Store + Registry + Index) instead of a god-object, why behaviour lives on the acting component (a `Carrier` ships an order) rather than on the entity (`order.ship()`), and why the choice fits *this* system's situation. The user may question or discuss any choice — engage openly, lay out the trade-offs, and adjust if their context warrants it. These rules are guidelines toward good design, not dogma to recite.

## 📜 Core Architecture Rules (working summary of the Architecture Standard)
The full standard is the source of truth; this is the summary you design against.

1. **Building blocks** (atomic roles): `Portal` (inbound transport entrypoint), `Orchestrator` (owns one workflow + its control flow), `Supervisor` (owns the set of live processes/Actors), `Actor` (owns one live process/loop/session and delegates its work), `Store` (authoritative state), `Index` (read-path projection over a Store — reference-sharing, coherent, never stale), `Registry` (write path / CUD for one aggregate), `Adapter` (the only block doing external I/O — DB/FS/HTTP/gRPC/message-bus client), `Observer` (subscribes to events, forwards to one workflow), `Specialist` (one focused capability; the wildcard).
2. **Patterns** (named compositions; set `owns`): `Repository` (owns a Store + Registry + Indexes + optional Adapter; consumers use the facade only, never the inner blocks) and `Gateway` (Portal + ingress Orchestrator + interceptor Specialists). A pattern owns only building blocks, never another pattern — compose patterns at the subsystem (L1) level.
3. **owns vs dependsOn**: `owns` = a pattern's private member blocks (exactly one hop). `dependsOn` = collaborators (other facades / standalone blocks). Never depend on a block privately owned by another pattern.
4. **Decoupling**: Registry (write) and Index (read) are independent — both work on the Store; the Registry never updates Indexes (Indexes share the Store's references and project structural changes). A Store is depended *upon*; it never depends on a Registry/Index.
5. **Behaviour placement**: behaviour lives where it can be performed autonomously over its own state (`order.total()`, `dog.bark()`); behaviour needing an external actor lives on the *acting* component, taking the entity as an argument (a `Carrier` ships an order — not `order.ship()`). Prefer composition + interfaces over inheritance.
6. **Narrative coding (L5)**: each method reads top-to-bottom as named steps; one level of abstraction per function; a pattern facade's method is exactly one `call` step (pure 1:1 forwarding, no logic).
7. **Right-size**: L1, concurrency, and events are all optional — don't add blocks, patterns, or layers a system doesn't need. Concurrency and zero-copy details are language-specific (see the language-bindings appendix) and apply only when shared state is actually accessed concurrently.
8. **Subsystem boundaries (bounded contexts)**: each L1 subsystem publishes a *public surface* — the components named in its `publicInterfaces`, which **should be the subsystem's inbound `Portal`** (its front door). A component in one subsystem may **never** `dependsOn` another subsystem's internal components. Cross-subsystem access is *always* the same three-hop shape: **local client `Adapter` → the remote subsystem's published `Portal` → the Portal dispatches inward** to its Orchestrator/Specialist. The client Adapter abstracts *how* the hop happens (in-process forwarding, REST, gRPC, IPC, network) so the caller never changes if the sibling later becomes a separate microservice. Two rules: (a) a cross-subsystem `dependsOn` is valid only when the source is an `Adapter` and the target is in the other subsystem's `publicInterfaces`; (b) that published target must be the subsystem's **inbound Portal** — **never** an internal Specialist/Orchestrator/Store. Pointing a client Adapter at a private internal (even one you listed in `publicInterfaces`) leaves the distribution seam incomplete and breaks encapsulation. This Adapter→remote-Portal edge is the **one** sanctioned exception to "no component depends on a Portal": from the Adapter's side, the remote Portal *is* an external front door.

## 📋 Spec File YAML Schemas

You must strictly construct YAML spec files according to these exact schemas:

### 1. Level 0: System (`system.yaml` in `.wai/specs/`)
```yaml
schemaVersion: "1.0.0"
name: "system-name"
vision: "High-level vision of the system..."
boundaries:
  - name: "Boundary Name"
    description: "Scope details..."
globalRequirements:
  - description: "Must support high-throughput metering..."
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
```

### 2. Level 1: Subsystem (`subsystem.yaml` under `.wai/specs/<subsystem>/`)
```yaml
id: "billing" # lowercase-alphanumeric-dashes
name: "Billing Subsystem"
description: "Handles subscriptions and invoicing..."
parentSystem: "system-name"
publicInterfaces:
  - type: "REST" # REST | GraphQL | MessageBus | RPC | Custom
    details: "/api/v1/billing endpoint"
    component: "billing-gateway" # the L2 component that REALIZES this interface (this subsystem's published surface)
    interface: "ibilling-gateway" # optional: the L3 interface on that component
status: "complete" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
```
> Each `publicInterface` MUST name the `component` that realizes it, and its `type`
> must match that component (REST→Portal/HTTP_API, RPC→Portal/gRPC,
> MessageBus→Portal/MessageBus or Observer, …). A declared interface with no
> backing component fails the gate. Components are L2, so if they don't exist yet
> when you create the subsystem, **backfill the bindings later with
> `sdd_set_public_interfaces`**.
>
> **If this subsystem is consumed by sibling subsystems, publish its inbound `Portal`**
> as the public component, so a sibling's client Adapter targets the Portal (the front
> door) and the Portal dispatches inward. Do **not** publish an internal
> Specialist/Orchestrator/Store as the cross-subsystem entry point — even though
> `type: Custom` currently accepts *any* component, a published internal is a leaked
> boundary (see Rule 8). For an in-process sibling boundary, an `RPC` (Portal/gRPC) or a
> Portal-backed `Custom` interface is the right surface.
>
> Pick the `type` that matches the *real* contract — don't reach for `Custom` to
> dodge the type check. `Custom` is for genuinely bespoke surfaces, not an escape
> hatch. If a boundary is event-driven (a queue/stream others subscribe to), type
> it **MessageBus** and back it with an **Observer** or a **Portal/MessageBus** — a
> `Custom` interface whose `details` describe async/eventing but is backed by an
> Orchestrator (a synchronous push) is flagged as an unrealized event boundary.

### 3. Level 2: Component (`component.yaml` under `.wai/specs/<subsystem>/<component>/`)
```yaml
id: "billing-store" # lowercase-alphanumeric-dashes
name: "Billing Store"
description: "Authoritative state storage for billing data"
subsystem: "billing" # references L1 Subsystem ID
componentType: "Store" # Blocks: Portal|Orchestrator|Supervisor|Actor|Store|Index|Registry|Adapter|Observer|Specialist — Patterns: Repository|Gateway
owns: [] # member block ids (Repository/Gateway patterns only; never another pattern)
dependsOn:
  - "database-adapter" # other L2 component ids this collaborates with (facades or standalone blocks)
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
```

### 4. Level 3: Interface (`interface.yaml` under `.wai/specs/<subsystem>/<component>/`)
```yaml
id: "ibilling-store" # prefixed with a lowercase "i"
name: "Billing Store Interface"
description: "Read/write contract for billing data"
component: "billing-store" # references L2 Component ID
methods:
  - name: "save_invoice" # alphanumeric-underscores
    description: "Saves a generated invoice to the store"
    signature: "save_invoice(invoice: Invoice): Promise<void>"
    returns: "Promise<void>"
    # guarantees: [idempotent]   # optional, combinable: idempotent | atomic | transactional | exactly-once.
    #                            # Set when an L0 requirement or a narrative step asserts the property.
    #                            # The gate requires any guarantee a narrative claims to be declared here.
    # Concrete wire binding — ONE generic `endpoint` field, discriminated by `transport`.
    # Set it via the `sdd_set_endpoints` MCP tool (don't hand-author). Required on every
    # method whose component is a Portal; the gate flags MISSING_ENDPOINT otherwise.
    endpoint:
      transport: "HTTP" # HTTP | gRPC | GraphQL | MessageBus | NamedPipe | IPC | CLI | Custom
      method: "POST"    # HTTP: GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD ; path: "/invoices"
      path: "/invoices"
    # Other transports (same slot): gRPC {service, method} · GraphQL {operation, field} ·
    # MessageBus {topic, event, queue?, direction} · NamedPipe {pipe} · IPC {channel} ·
    # CLI {command} · Custom {address}. The endpoint's transport MUST match the Portal's portalType.
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
```

### 5. Level 4 & 5: Implementation & Narrative (`implementation.yaml` under `.wai/specs/<subsystem>/<component>/`)
```yaml
id: "billing-store-impl"
name: "Billing Store Implementation"
description: "Memory-based billing store with VFS sync"
contract: "ibilling-store" # references L3 Interface ID
sourcePath: "src/billing/store.ts" # optional path to source code
methods:
  - name: "save_invoice" # matches L3 method name
    narrative: # L5 Narrative sequence
      - stepNumber: 1
        description: "Validate the invoice schema matches specifications"
        type: "local" # local | call
      - stepNumber: 2
        description: "Write invoice data to active memory storage"
        type: "local"
      - stepNumber: 3
        description: "Sync the change to the disk registry via VFS"
        type: "call"
        targetComponent: "vfs-registry" # required for 'call'
        targetMethod: "write_file"      # required for 'call'
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
```

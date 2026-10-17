# Reachability: a call is a link, entries are scoped by networks

Status: DECIDED (2026-10-06). The forks are settled (section 7). Designed spec-first on branch `feat/reachability` (off dev `d10bd8b8`, v5.1.1-dev.104); the specs validate, awaiting review and lock. No code yet.

Earlier work left this out of scope: listener mounts, entries, the library surface and networking (`linkage-and-drift.md`). This document takes them on together, because they are one question: **what reaches each Portal verb, and from where.**

Direction, as decided:

- Transport has no bearing on design linkage. A call is a link: a component calls a verb on a contract. Locally that is a `dependsOn` edge plus a `call` step. Across projects it is `alias::portal.verb` through the producer's exports. The Portal declares the transport. For a network or local transport, the calling side is an Adapter that has to speak that transport, which makes it an inferred bridge the validator checks. A library (an `InProcess` Portal of another project) is called directly, by any component (2.6).
- Every Portal verb must be **reached**. Either a modelled caller anywhere in the family reaches it, or the verb is declared an **entry**, meaning callers outside the design reach it. This replaces `mounts`, listener composition and `UNMOUNTED_PORTAL`.
- Entries are scoped by **networks** that projects declare. Inside a network, only `gateway` Portals take entries from outside it.
- A library, FFI or DLL surface is a Portal entered in-process. There is no separate "library surface" concept.
- Networking is a **derived** output: an allowed-flows matrix, network diagrams, generated policy, and help investigating a live system. Specs never hold IP addresses.

---

## 1. Measurement

### 1.1 The current model (src/models/specs.ts)

| Concept | Where | Shape today |
|---|---|---|
| Portal transport | L2 `portalType` | `HTTP_API, gRPC, GraphQL, MessageBus, CLI, NamedPipe, IPC, Custom` |
| Per-verb binding | L3 `method.endpoint` | discriminated by its own `transport` enum: `HTTP, gRPC, GraphQL, MessageBus, NamedPipe, IPC, CLI, Custom{address}`. `ENDPOINT_TRANSPORT_MISMATCH` keeps it consistent with `portalType` |
| Export kind | L1 `publicInterfaces[].type`, L0 `publicInterfaces[].type` | a third vocabulary: `REST, GraphQL, MessageBus, RPC, Custom`, authored by hand and checked against `portalType` (`public-surface-declared-type`, including the prose-reading `PUBLIC_INTERFACE_EVENT_MISTYPED`) |
| Listener composition | L2 `mounts: [{portal, prefixes, via?}]` | declaring the field, even as `[]`, marks a listener |
| External caller | L3 `method.invokedBy: {kind: runtime\|external\|sibling-subsystem, caller}` | seeds the reachability walk |
| Lifecycle roots | L1 `lifecycle[]` | seeds the walk |
| Gateway | `variant: gateway` on a Portal (`src/templates/variants/portal-shapes.yaml`) | guidance only. No rule reads it beyond "a gateway is a Portal" in `EXPORT_UNCONSUMABLE` |
| Design visibility | L0 `publicInterfaces[].audience` | `project < department < instance < partner < external`, a hosted/org ceiling on who may **design against** an export. `EXPORT_WIDENS_AUDIENCE` stops a re-export from widening it |
| Subsystem consumers | L1 `publicInterfaces[].consumers` | restricts which subsystems may depend on a surface |
| Boundary crossing | `subsystem-boundary-dependencies` | any cross-subsystem or cross-project edge is client **Adapter → published Portal** (`CROSS_SUBSYSTEM_NON_ADAPTER`), unless a `trustedLink` on the source subsystem licenses a direct edge (in-project only) |

### 1.2 Reachability today

`unused-detection` seeds the walk with **every Portal and every Observer (all methods)**, every L1-published component, the lifecycle entrypoints and the `invokedBy` methods. As a result, **no Portal verb can ever be reported unused**. The only "nothing serves this surface" check is `UNMOUNTED_PORTAL` in `portal-mounts`, and it is limited:

- It judges HTTP only.
- Any portal that declares `mounts`, even `[]`, is exempt. The MCP tool writes `[]` by default, so in the solo-app trial the rule was dead: two HTTP Portals had `mounts: []`, there was no listener anywhere, and nothing fired.
- It says nothing about individual verbs.

Consumers of `PortalMount`:

- `portal-mounts` (`MOUNT_TARGET_NOT_PORTAL`, `ENDPOINT_OUTSIDE_MOUNT`, `UNMOUNTED_PORTAL`).
- `route-coverage`, which reads routes out of `via` and completes the leading segment from the mount prefixes.
- `export-conformance`, which treats `via` as a declared publication handle.
- Reference binding: `core/specs.ts`, `project-family.ts`, `part-context.ts` and the position/identity/boundary migrations treat `mounts` as a reference position.
- The design export (`models/design-export.ts`, with `via` as linkage).
- The MCP `sdd_add_component` parameter.

No hosted, web or canvas view reads `mounts`. `server/projects.ts` "mounts" are member hops and are unrelated. `portalType` is read in 14 files, including the canvas, the web SpecsEditor and the exporters.

### 1.3 wairon's own tree and the examples

| Field | wairon's own tree | examples |
|---|---|---|
| Portals | 27: 8 `HTTP_API`, 1 `CLI`, 18 `Custom` | 1 (MessageBus subscribe) |
| `mounts` | 2 listeners (`admin_portal` mounts 4, `host_http_portal` mounts 2) | 0 |
| Endpoints | 277: 164 HTTP, 63 CLI, 50 Custom. Of the Custom ones, 36 are `mcp tools/call …`, 8 are `@wairon/sdk#fn` (library functions), 5 are `in-process migration.*` and 1 is stdio bootstrap | 1 |
| `invokedBy` | 9, all on **non-Portal** methods: 4 `runtime`, 3 `external`, 2 `sibling-subsystem` | 0 |
| `variant: gateway` | 0 | 0 |
| L0 `audience` | 12 entries: 11 `external`, 1 `instance` | 0 |
| L1 `consumers` | 3 | 0 |
| `trustedLinks` | 0 used (11 empty lists). There are 60 Adapters | 0 |
| `lifecycle` | 4 | 0 |

These are grep estimates of what the new rule would surface; they ignore `calls` declarations and dispatch tables:

- **About 11 Portals need one portal-level entry**: CLI (63 verbs), the stdio MCP tool surface (38 verbs, 34 never called), the 7 HTTP portals behind the two listeners (web 94, admin 32, identity 13, landscape 9, policy 5, share 4, operations 3), the host HTTP portal, and the SDK library portal.
- **About 13 verbs on in-process Portals have no modelled caller at all**: 6 on the extension portal, 3 on the spec-tree portal, and 1 each on the approval, project-config, surface and SDK portals. These are exactly the findings the redesign exists to produce. Today they are invisible.

### 1.4 What the user trials reported

- **Library (a Rust SDK plus a TS consumer app):**
  - F7: `MISSING_ENDPOINT` pushed the assistant to invent `endpoint: {transport: Custom, address: rust:<crate>::tiles::tile_for}` for every public function. `UNMOUNTED_PORTAL` stayed silent only because the transport was not HTTP.
  - F5: a trait that consumers implement could not be exported (`EXPORT_UNCONSUMABLE`, "only Portals or Observers"). The workaround was signature types plus `signatureFrom`.
  - F34/F54: the rename tool refuses `snake_case` ("not a camel-case identifier") in a Rust tree whose define tools accepted it.
  - F8: `PUBLIC_INTERFACE_EVENT_MISTYPED` fired because the details prose said "async".
- **Solo app:** `UNMOUNTED_PORTAL` never fires, because `mounts: []` is the default the tool writes.
- **Platform:** `UNUSED_TYPE` fires on 9 types that the project exports at L0 and a sibling uses ("a type a project exports is used by definition").
- **Tinkerer:** nothing on this topic.

---

## 2. The model

### 2.1 Fields

**L2 Portal component**

```yaml
componentType: Portal
transport: HTTP          # RENAMED from portalType; one vocabulary with the endpoint discriminator
abi: c                   # NEW, InProcess only, optional (see 2.6)
variant: gateway         # unchanged; now enforced by the network rule (2.4)
invokedBy:               # NEW at component level, Portal only: the entry every verb inherits
  kind: entry
  scope: outside         # outside | network; absent means outside; refused on local transports
  caller: Browsers and mobile clients of the shop
```

**L3 contract method**

```yaml
invokedBy:               # unchanged field, narrowed kinds
  kind: entry | runtime
  scope: network         # entry only, network transports only
  caller: Sibling services that settle orders
```

**L3 interface**

```yaml
implements: geo::geocoding_provider   # NEW: this contract realizes an exported extension point (2.7)
```

**L1 and L0 export entries**

```yaml
- { interface: geocoding_provider, role: implement }   # NEW role: call (default) | implement
# `type` is no longer authored; it is derived from the backing Portal's transport
```

**L4 Portal implementation**

```yaml
router: handleWebRequest   # NEW linkage field (out of the approval), replaces mounts[].via
```

**.wai/project.yaml**

```yaml
network: true            # NEW: this project and its members form an isolated network
# or  network: { description: Order-processing services }
```

**Transport vocabulary.** One enum serves the Portal and the endpoint discriminator:

| Transport | Kind | Endpoint |
|---|---|---|
| `HTTP` | network | `{method, path}` |
| `gRPC` | network | `{service, method}` |
| `GraphQL` | network | `{operation, field}` |
| `MessageBus` | network | `{topic, event, direction}` |
| `CLI` | local | `{command}` |
| `IPC` | local | `{channel}` |
| `NamedPipe` | local | `{pipe}` |
| `JSONRPC` (NEW) | local, stdio | `{method}`. This covers the language-server and MCP-over-stdio family. JSON-RPC over HTTP is an `HTTP` verb with a dispatch table, as the hosted MCP endpoint already is. |
| `InProcess` (NEW) | in-process | **none required**. The verb is the contract method itself. Its code symbol is linkage (`symbol`, `exportedVia`). |
| `Custom` | assumed network | `{address}`. Escape hatch, unchanged. |

**Retired:**

- Component `mounts` and `PortalMountSchema`.
- `portalType`, renamed to `transport` with `HTTP_API` read as `HTTP`.
- The authored `type` on L1 and L0 export entries, and the three-vocabulary check that came with it.
- `invokedBy.kind` values `external` and `sibling-subsystem`.

### 2.2 What reaches a verb

The walk keeps its engine (`narrative-graph-projector.walk`). **Its seeds change:**

| Seed | Today | Proposed |
|---|---|---|
| every Portal (all methods) | yes | **no** |
| every L1-published component | yes | **no**: a published surface is reached by the callers that use it, or by an entry |
| Observers | yes | yes. Subscriptions are judged by `event-topology`; they are not entries. |
| lifecycle entrypoints | yes | yes |
| `invokedBy` with kind `runtime` (timer, signal, framework hook, process start) | yes | yes |
| `invokedBy` with kind `entry` (method- or portal-level) | n/a | **yes** |
| methods of an interface that `implements` an imported extension point | n/a | **yes**: the producer calls them by construction |
| MessageBus `subscribe` verbs on a Portal | as Portal | reached when the topic is emitted in the family. `UNSOURCED_SUBSCRIPTION` already reports the opposite case, so it is never double-reported. |
| (family run) cross-project calls | n/a | **not a seed**: the family run composes and never re-judges a member's own verdict. A member declares `scope: network` on the verbs its siblings call, and the family run proves those entries with the cross-project calls `CrossProjectReference` already records (`ENTRY_UNPROVEN`). |

The finding stays `UNUSED_COMPONENT` / `UNUSED_METHOD`. No new code is needed: a Portal simply stops being an automatic seed. When the subject is a Portal, the message branches and names the two remedies: model the caller, or declare an entry with its scope.

### 2.3 A member judged alone, and the family run

- **A project's own gate** seeds with its entries of **every** scope. An entry scoped `network` counts as declared, because alone the project cannot see its siblings.
- **The family run** (plain `validate` at the project that declares the members; see 2.10) never re-judges a member: each member's verdict stays its own gate's. On top of those gates it composes the family's reach model (`reach_model_projector.compose`) from each project's own model and the family's cross-project references, and judges it (`family_validator.checkReach` with `network_arbiter`). A `network` entry whose verb no modelled caller inside its boundary reaches is `ENTRY_UNPROVEN` (a warning, F1). Absent any declared network, the family itself is the boundary for that proof. An `outside` entry needs no proof, because its callers are unmodelled by definition.
- Callers that are not in the family (declared externals: path, git or hosted) are, by construction, outside every network of this family. The producer covers them with `outside` entries. The consumer is protected because a producer cannot export a non-gateway verb past its network (`EXPORT_BEYOND_NETWORK`, 2.5).

### 2.4 Networks and scopes

**Declaring a network.** A project declares `network` in its `project.yaml`. The project's own components and every member below it, at any depth, sit inside that network. Parts cannot declare one: they are folders of the same system. Networks nest one level per declaring project.

**Scope names are relative.** There are exactly two:

- `network`: callers anywhere inside the innermost declared network that contains this component, meaning sibling services.
- `outside`: callers from outside that network. For the outermost network that is "whatever surrounds the system", whether the public internet or a hosted intranet; wairon does not distinguish them. For an inner network it is the next network out.

Relative names are what a member judged alone can write and resolve, and they survive moving a member under another parent. Absolute network ids were considered and rejected: a member alone cannot name its parent's network, and a move would have to rewrite every entry.

**Gateway rule.** Inside a declared network, only a Portal with `variant: gateway` may be entered from `outside`. The same holds for a **modelled** call that crosses into a network from outside it: it must land on that network's gateway. Both cases are `GATEWAY_BYPASSED` (error). The rule applies per level, so traffic from outermost to innermost passes one gateway per network, each a modelled call from the outer gateway's Adapter to the inner gateway. More than one gateway in a network is allowed and gets `MULTIPLE_GATEWAYS` (notice).

**Edge cases:**

- A project with **no network anywhere** writes entries without a scope (default `outside`), and any Portal may take them. Simple apps never see networks.
- `scope: network` with no enclosing network in the family run gets `ENTRY_SCOPE_UNBOUNDED` (a notice). The family is then the implicit boundary for the proof, but nothing isolates the verb, so its flows cannot be narrowed by a network. A notice and not a warning, so a multi-project family that declares no network is never nagged into declaring one.
- A scope on a **local or in-process** verb is meaningless, because no network is crossed. The tool refuses it at write, and the validator reports `ENTRY_SCOPE_NOT_NETWORK` (warning) on hand edits.

### 2.5 Export audience and network scope are different axes

- **`audience`** (L0 exports) answers *who may design against this contract*: import it, pin it, generate a client. It is an organizational visibility ceiling (`project … external`), and it holds for every transport, including in-process libraries.
- **Scope** (entries) answers *who can reach this verb at runtime*. It is a network fact, and it holds only for network transports.

They are independent except in one direction. If an export's audience is wider than `project` (consumers beyond the family) and its verbs are network-transport verbs, those consumers sit outside the family's outermost network. The exported Portal therefore has to be enterable from there, which means it is the outermost network's gateway with `outside` entries. Otherwise the project reports `EXPORT_BEYOND_NETWORK` (warning).

The reverse is not a finding. An `outside` entry with no export is normal: browsers do not design against you.

### 2.6 The transport bridge, and library calls (in-process / FFI / DLL)

**Network and local transports.** The boundary rule stays as it is: a cross-subsystem or cross-project edge to a network or local Portal (`HTTP`, `gRPC`, `GraphQL`, `MessageBus`, `CLI`, `IPC`, `NamedPipe`, `JSONRPC`, `Custom`) is **Adapter → published Portal**, or a `trustedLink` within a project. The bridge is **inferred**: an Adapter's transport is the transport of the Portals it calls.

**A library call** is an edge from **any** component to an `InProcess` Portal's verb **of another project**, written `alias::portal` in `dependsOn` and `alias::portal.verb` in a `call` step (or a `calls` entry). The producer may be a member (part or project) or a declared external; either way the verb must be in its L0 exports, as every cross-project reference must. Libraries are libraries: no client Adapter is required, and none is nagged for.

- `CROSS_SUBSYSTEM_NON_ADAPTER` and `ARCHITECTURE_VIOLATION_PORTAL_DEP` exempt exactly this edge: the target is an `InProcess` Portal in another project.
- Within one project nothing changes: a sibling subsystem's `InProcess` Portal is still reached through a client Adapter or a `trustedLink`, as today.
- Wrapping a volatile third-party API in an Adapter stays a **recommended pattern** in the guide: an anti-corruption layer that insulates the design from upstream contract changes. It is never enforced or reported.

Two honest checks replace the Adapter:

- **`LIBRARY_CALL_IMPURE` (error): purity.** A component whose `dependencyClass` is `pure` may call only library verbs declared effect-free (`effect: none`). A component whose class is `read` may also call verbs whose `effect` is `read`. A library verb that does I/O or writes (`effect: io | write | lifecycle`) may not be called from pure or read logic. An **undeclared** effect counts as not effect-free, so a library meant for pure callers declares `effect: none` on those verbs. The `effect` vocabulary gains `none` (computes over its arguments only) and `io` (reaches outside the process: files, network, clock, randomness), alongside `read`, `write` and `lifecycle`. A workflow (no `dependencyClass`) may call anything.
- **`LANGUAGE_BRIDGE_MISSING` (error): the language bridge.** An `InProcess` Portal with no `abi` is a native API in its project's `targetLanguage`, for example a crate, an npm package or a jar. When it is called from a project whose `targetLanguage` differs, the call needs a binding. The remedy is to declare `abi` (`c` for a C-ABI shared library, DLL or FFI; `wasm` for a WebAssembly component) or to put a network Portal in front. A Portal with an `abi` is callable from any language.

Deferred, deliberately:

- Matching an Adapter's L4 `technologies` against the transport it bridges. Technologies are free names, so this needs a pack-supplied `speaks: [HTTP]` table. Without one, the check would only produce false positives.
- Flagging an Adapter that bridges two different transports.

**In-process is one concept.**

- **A library** is a project whose Portals are `InProcess`, entered by `invokedBy: {kind: entry, caller: "Applications that link the crate"}`.
- **FFI or DLL** is the same with `abi: c`.

No endpoint is required, so there are no invented `Custom` addresses. "Runnable vs library" stays undefined, as decided in the generic-design-model direction. The export carries the facts: transports, entries and lifecycle roots.

### 2.7 Exportable extension points (traits, callbacks, webhooks)

- **Producer.** The extension point is a component the producer *calls* but whose realization consumers supply. Typically this is an Adapter holding the port. It is exported with `role: implement`:
  - `EXPORT_UNCONSUMABLE` accepts such an entry for an Adapter.
  - The missing-implementation rules exempt the component.
  - The producer's calls into it are ordinary modelled calls.
- **Consumer.** An L3 interface declares `implements: alias::name`. Its methods take the contract's signatures, as `signatureFrom` does per method. They count as reached, because the producer calls them. `IMPLEMENTS_MISMATCH` (error) reports a missing method or a differing signature. Naming an entry not exported with `role: implement` is the existing `EXTERNAL_NOT_EXPORTED`.
- **The same concept covers both kinds of transport:**
  - A Rust trait or TS interface: `InProcess`, with the consumer registering its implementation through a `register` step.
  - A network webhook or callback contract: the consumer's implementing component is a Portal, the producer calls it through an Adapter, and the family run produces a producer → consumer flow.

### 2.8 Identifier conventions (where they belong)

The rename tools hard-code camelCase (`provision.ts`, "is not a camel-case identifier"), while the define tools accept any casing. That is a naming-rule bug, not a reachability question:

- The fix is for the rename and define tools to validate a new method name against the project's configured `rules.naming` method casing.
- That casing should default from `targetLanguage` (`rust` and `python` to `snake_case`, `typescript` and `java` to `camelCase`).

It ships as a small rider in wave 1, because the in-process entry work touches the same tools. With `InProcess`, no symbol path is spelled into an endpoint any more, so the Rust-style `crate::module::fn` addresses disappear with it.

### 2.9 Route coverage without mounts

- `route-coverage` and `export-conformance` read the router entry from the Portal's own L4 `router` field (linkage, outside the approval).
- The leading-segment completion comes from the first segments of the Portal's own HTTP endpoint paths, not from mount prefixes.
- `ENDPOINT_OUTSIDE_MOUNT` disappears with the prefixes.
- Which process hosts which Portal is implementation. The composition root's import of a Portal's `router` entry must be accepted by `dependency-conformance` as declared publication, the way `via` is accepted today. This is a hard edge to verify in wave 1.

---

### 2.10 Where the family proofs run (CI)

Every family-run proof (`ENTRY_UNPROVEN`, the network rules, cross-project reach) is only worth as much as the run that makes it. Decided:

- **The plain gate already is the family run where it matters.** `wairon validate` at a project that declares members runs the family run by default (`--no-recursive` opts out). The reachability and network rules join that run, so no new flag is needed at the root.
- **A member validated alone** judges its own gate, with its `network` entries counted as declared. Its summary says, in one line, that the network proofs are judged at the family root, so a green member run is never read as a proven one.
- **The documented CI line** becomes: run `wairon validate --ci` **at the family root** (the project that declares the members). A member that lives in its own repository adds the root's run to its pipeline or relies on the root repository's.
- **The reusable workflow** (`.github/workflows/lock-check.yml`) gains a `validate` input (default `true`) that runs `wairon validate --ci` in `working-directory` after the lock check. Pointed at the family root, that is the family run. `docs/cli.md` shows it.

## 3. Rules

| Code | Severity | Status | Judged |
|---|---|---|---|
| `UNUSED_COMPONENT`, `UNUSED_METHOD` | warning | **changed**: Portals are no longer seeds, so they fire for unreached verbs; the message offers entry or caller | own gate |
| `INVOKED_BY_REDUNDANT` | warning | **narrowed** to `kind: runtime`. An entry is never redundant, because it also feeds the scope and flows. | own gate |
| `INVOKED_BY_UNDESCRIBED` | warning | unchanged; also applies to the portal-level `invokedBy` | own gate |
| `ENTRY_ON_NON_PORTAL` | error | **new**: `kind: entry` on a non-Portal method (use `runtime`) | own gate |
| `ENTRY_SCOPE_NOT_NETWORK` | warning | **new**: scope on a local or in-process verb | own gate |
| `GATEWAY_BYPASSED` | error | **new**: a non-gateway inside a network entered from `outside`, or a modelled call crossing into a network to a non-gateway | own gate for the declaring project; family run for members |
| `MULTIPLE_GATEWAYS` | notice | **new** | same |
| `ENTRY_SCOPE_UNBOUNDED` | notice | **new**: `scope: network` with no enclosing network | family run |
| `ENTRY_UNPROVEN` | warning (F1) | **new**: `network` entry with no modelled caller in its boundary | family run |
| `MISSING_PORTAL_TYPE` | n/a | **renamed** `MISSING_PORTAL_TRANSPORT` (error); `UNEXPECTED_PORTAL_FIELD` also covers an `abi` on a non-InProcess Portal | own gate |
| `EXPORT_BEYOND_NETWORK` | warning | **new**: audience wider than `project` on a network verb that is not an outside-entered outermost gateway | own gate; family run for members |
| `LANGUAGE_BRIDGE_MISSING` | error | **new** | wherever the edge resolves |
| `LIBRARY_CALL_IMPURE` | error | **new**: pure or read logic calls a library verb whose effect it may not reach | wherever the edge resolves |
| `CROSS_SUBSYSTEM_NON_ADAPTER`, `ARCHITECTURE_VIOLATION_PORTAL_DEP` | error | **changed**: a library call (any component → another project's `InProcess` Portal) is exempt | unchanged |
| `IMPLEMENTS_MISMATCH` | error | **new** | wherever the reference resolves |
| `INVOKED_BY_RETIRED_KIND` | warning | **new**, for one release: `external` or `sibling-subsystem` read compatibly | own gate |
| `EXPORT_UNCONSUMABLE` | error | **changed**: accepts `role: implement` on an Adapter | unchanged |
| `MISSING_ENDPOINT` | error | **changed**: not required for `InProcess` | unchanged |
| `UNUSED_TYPE` | warning | **changed**: a type in the L0 export table counts as used; in the family run, uses by consumers count | own gate / family |
| `UNMOUNTED_PORTAL`, `ENDPOINT_OUTSIDE_MOUNT`, `MOUNT_TARGET_NOT_PORTAL` | n/a | **retired** with `portal-mounts` | n/a |
| `PUBLIC_INTERFACE_*` type-mismatch codes, including `PUBLIC_INTERFACE_EVENT_MISTYPED` | n/a | **retired**: the export kind is derived, not authored | n/a |
| `UNROUTED_ENDPOINT`, `UNREADABLE_ROUTER` and route coverage's undeclared-route code | unchanged | **re-anchored** on the Portal's `router` | unchanged |

**Net change: 11 codes added, 1 renamed (`MISSING_PORTAL_TYPE` to `MISSING_PORTAL_TRANSPORT`), 5 retired.** Every new code is either a network fact, which only exists for projects that opt in, or a hard mismatch. For a simple app the only visible change is that verbs can now be reported unused.

---

## 4. Networking as a derived feature

Everything here is computed from the design: modelled calls, entries, networks and transports. Specs never hold IP addresses, ports, replicas or regions. Anything deployment-shaped comes in at generation time from a **bindings file the team keeps outside `.wai/`**.

### 4.1 The flow matrix (neutral, the source of every other output)

One row per allowed flow:

```yaml
- from:      { project: shop, component: orders_client }   # or { scope: outside } / { scope: network, network: platform }
  to:        { project: orders, portal: orders_api, verb: create }
  transport: HTTP
  binding:   POST /orders
  crosses:   [platform]                # networks entered, outermost first
  via:       platform::api_gateway     # the gateway entered, when crossed
  evidence:  call shop::checkout_impl.placeOrder#4   # or: entry (caller prose)
```

- **Only network transports produce flows.** In-process and local verbs never do.
- **A `network` entry that the family run proves is narrowed to its actual modelled callers.** The matrix is least-privilege by construction: "the network may reach this" becomes "these three Adapters reach this".
- **What a team does with it.** They review it in a pull request as the authoritative "who talks to whom". A design change that adds a dependency shows up as a new row before any code or firewall change exists.

**Formats:** JSON, plus CSV for spreadsheets and audits. A Markdown table is also produced for review comments.

### 4.2 Generated policy

- **Input.** A bindings file maps wairon names to deployment selectors. The default workload is the project id, which can be overridden per subsystem or Portal:

  ```yaml
  workloads:
    orders: { selector: { app.kubernetes.io/name: orders }, namespace: shop }
    platform::api_gateway: { selector: { app.kubernetes.io/name: edge } }
  ports: { orders::orders_api: 8080 }
  outside: { ipBlock: 0.0.0.0/0 }
  ```

  An unbound name gets a placeholder label `wairon.dev/workload: <name>` and is listed in the output, so nothing is silently opened.
- **Wave 1 target formats:**
  1. **Kubernetes `NetworkPolicy`** (L3/L4): one ingress policy per workload. It allows each matrix source, plus `ipBlock` for `outside` on gateways, with default-deny implied.
  2. The neutral matrix itself, from which any firewall or security-group tooling can be scripted.
- **Wave 2 target:** **Istio `AuthorizationPolicy`** (L7). It allows the HTTP method and path, or the gRPC method, per source principal. This is where wairon is uniquely placed, because the verbs are already in the design (fork F4).
- **What a team does with it.** They commit it to the deployment repository and diff it in CI. A design change becomes a policy diff that the security reviewer reads in the same PR, so nobody hand-maintains allow-lists that drift from the code.

### 4.3 Network diagrams

- **Content:**
  - Declared networks as nested boundaries.
  - Gateways drawn on the boundary.
  - An `outside` node.
  - Edges aggregated per workload pair, labelled with transport and verb count; verbs expand on the canvas.
- **Formats:** Mermaid `flowchart` with subgraphs, and a new hosted canvas view `network` (`DiagramView` gains `network`).
- **What a team does with it.** The diagram is a data-flow diagram with trust boundaries, which is the standard input to threat modelling (each boundary crossing is a place to ask the STRIDE questions). It also serves onboarding and the architecture page in docs.

### 4.4 Investigating a live system

- **`wairon network check --observed <file>`.** The input is observed flows (`source, destination, transport[, method, path]`) named with the same bindings. Typical sources are a service-mesh or eBPF flow export, or VPC flow logs once the team's tooling has mapped IPs to workloads. wairon never sees IPs. It reports:
  - **Unexpected flows:** observed, but no row allows them. This means an undocumented dependency, a misconfiguration or an intrusion.
  - **Unexercised flows:** allowed, but never seen in the window. This means a dead dependency, a stale design, or a candidate to remove from policy.
  - At L7, **unknown verbs**: a path the contract does not have.
- **`wairon network why <from> <to>`.** Prints the modelled chain that justifies a flow, from the entry through the gateway to the Adapter's call step. It answers a firewall change request or an incident question ("why does checkout talk to payments?") from the design, in one command.

### 4.5 Surface

- **CLI:** `wairon network flows|policy|diagram|check|why`.
- **MCP:** read-only `sdd_get_network_flows` (with filters) and `sdd_explain_flow`, so an assistant can answer "who can reach X" while designing.
- **Hosted:** a flows endpoint per project plus the canvas `network` view.
- **Scope of judgement:** everything runs at the family root. Run alone, a project produces its own rows, with `network` entries shown unnarrowed.

---

## 5. Migration (`doctor --fix`) and what breaks

**Deterministic rewrites:**

Run by `wairon doctor --fix` (`doctor --report reachability` previews it), through `reachability_migration` in sdd_core. It reads the retired forms the scan recorded while it read them compatibly (`spec_loader.retiredReachFacts`), so nothing is re-read from disk.

1. **`portalType` becomes `transport`.** `HTTP_API` becomes `HTTP`; the other values keep their names. A `Custom` Portal that binds **no** endpoint on any verb becomes `InProcess`, because a Portal with no wire address has no other consistent reading; wairon's own in-process Portals are exactly this shape. `Custom` endpoints of the forms `in-process …` and `<package>#fn` become `InProcess` too, and the address is dropped (doctor reports it as a symbol hint).
2. **`mounts` are removed:**
   - Each **listener** and each Portal it mounts gets a portal-level `invokedBy: {kind: entry, caller: "Clients served by <listener> under <prefixes>"}` (scope `outside`, which is correct while no network is declared).
   - `via` moves to the mounted Portal's L4 `router`.
   - An endpoint outside the old prefixes is reported, not fixed.
   - A Portal that was **neither** listener nor mounted gets **no** entry. Writing one would re-create the blanket default that made `UNMOUNTED_PORTAL` dead; it surfaces as `UNUSED_*` for the author to decide.
3. **`invokedBy` kinds:**
   - `external` on a Portal becomes `entry`.
   - `external` on a non-Portal becomes `runtime`, with a note.
   - `runtime` stays.
   - `sibling-subsystem` is read compatibly and reported (`INVOKED_BY_RETIRED_KIND`). The caller lives in the same tree and must be modelled, and doctor cannot invent the call.
4. **Authored L1/L0 `type`** is dropped where it agrees with the derived kind, and reported where it does not.
5. **`lint.allow` entries for retired codes** are removed (otherwise `UNUSED_LINT_ALLOW`); an allow of `MISSING_PORTAL_TYPE` is rekeyed to `MISSING_PORTAL_TRANSPORT`.
6. **Networks are opt-in.** Nothing is written to `project.yaml`.

**What breaks:**

- **Design-export format:** MAJOR bump. `mounts` is gone, `portalType` is renamed to `transport`, and `invokedBy` changes shape. Generators consuming the export must update.
- **Surface snapshots:** keep emitting `type`, now derived, and gain each entry's `transport`, `abi` and `role` and the producer's `targetLanguage` (what a consumer judges a library call by). A pin taken before carries none of them; the comparison must read an absent field as derived rather than as a change, or every existing pin reads drifted once.
- **MCP:** `sdd_add_component` loses `mounts`, renames `portalType`, and gains portal-level `invokedBy`, which it must **not** default. `sdd_define_interface` gains `implements`. Following the re-authoring seam rule, every new field is declared expressed, or the coverage test fails.
- **Web and canvas:** the SpecsEditor and canvas `portalType` reads (14 files) are renamed.
- **Rule-matrix fixtures:** the retired codes move out of the corpus and the new codes get fixtures.
- **wairon's own tree:** about 11 portal-level entries are added, and about 13 genuinely uncalled in-process verbs surface to fix or remove. Then one re-lock.
- **Approval:** `network` changes family-run verdicts, so it enters the gate identity beside `composition`. The key is left out when a project declares no network, so no existing lock stales.
- **Hosted:** the hosted server runs the doctor migrations when it next binds a project (`host_migration_adapter`), so the reachability migration joins that list.

---

## 6. Decided here

1. One transport vocabulary on the Portal (`transport`). `InProcess` and `JSONRPC` are added. Endpoints keep their discriminator, which must agree with the Portal (`ENDPOINT_TRANSPORT_MISMATCH` stays).
2. The `invokedBy` field is reused. Kinds become `entry | runtime`. A portal-level default is allowed (fork F3), with per-verb overrides of scope only. A verb cannot be "un-entered": if it should not be an entry, split the Portal (one transport, one auth, one entry posture per Portal).
3. Scopes are relative, `network | outside`, default `outside`. Networks are declared per project, nest per level, and are enforced per level through gateways.
4. A Portal is no longer an automatic reachability seed. The finding reuses `UNUSED_*`.
5. The family run never re-judges a member: cross-project calls (`CrossProjectReference`, which already exists) prove a member's network entries (`ENTRY_UNPROVEN`) instead of seeding its walk.
6. Audience and scope are separate axes, linked by one check (`EXPORT_BEYOND_NETWORK`).
7. Library, FFI and DLL are an in-process Portal, with an optional `abi`. No endpoint is required and there is no runnable flag. A library call (any component → another project's `InProcess` Portal) needs no Adapter; `LIBRARY_CALL_IMPURE` and `LANGUAGE_BRIDGE_MISSING` are its checks, and the method `effect` vocabulary gains `none` and `io`.
8. Extension points: `role: implement` on exports, `implements:` on the consumer's interface.
9. The export kind (`type`) on L1/L0 entries is derived, not authored.
10. The route-coverage anchor moves to the Portal's L4 `router`.
11. Flows are derived and keyed by stable names. Deployment facts come only from an external bindings file. The neutral matrix and Kubernetes `NetworkPolicy` ship first.
12. The naming fix for the rename tools (language-aware casing) rides along, as a separate rule fix.
13. The family proofs run in the plain gate at the family root; the documented CI line and the reusable workflow run it there (2.10).

## 7. Forks, as decided

- **F1. Must the family run prove a `network` entry?** Yes: `ENTRY_UNPROVEN` is a **warning**, with `lint.allow` for genuinely unmodelled in-network callers such as an ops job or a non-wairon service.
- **F2. Is an Adapter required for library calls?** **No.** Libraries are libraries: an `InProcess` library's exported API (a member or a fully external project) is imported and called directly from any component. Purity (`LIBRARY_CALL_IMPURE`) and the language bridge (`LANGUAGE_BRIDGE_MISSING`) are the checks. Wrapping a volatile third-party API in an Adapter is a recommended pattern in the guide, never enforced. Within one project, cross-subsystem calls are unchanged.
- **F3. May an entry be declared once on the Portal?** Yes: a Portal-level default plus a per-verb scope override. The tools never default it and doctor never invents it.
- **F4. Policy targets.** The neutral matrix plus Kubernetes `NetworkPolicy` first; Istio `AuthorizationPolicy` after.

## 8. The spec design (as written)

All of it is in wairon's own spec tree and validates with 0 errors at the root (`sdd_validate_tree`). Every warning is planned code: a field, value, method or file the specs now name that the code does not have yet. The retired `portal-mounts.ts` and `public-surface-declared-type.ts` show as unclaimed files until the code deletes them.

**Types (system models).**
- `transport` (renamed from `portal_type`, with `JSONRPC`, `InProcess`, and the methods `kind`, `requiresEndpoint`, `exportKind`).
- New: `transport_kind`, `entry_scope`, `export_role`, `network_declaration`.
- Re-authored: `invocation_kind` (`entry | runtime`), `method_effect` (+`none`, `io`), `diagram_view` (+`network`).
- `declared_invocation` gains `scope`.
- `component_spec`: `transport`, `abi`, Portal-level `invokedBy`, `entryFor`; `portalType` and `mounts` removed.
- `interface_spec`: `implements`. `implementation_spec`: `router` (linkage).
- `public_interface` and `system_public_interface`: `role`, with `type` marked legacy.
- `project_config` and `gate_config`: `network`.
- `naming_rule_config.methodCasingFor`.
- `design_component`: transport, abi, invokedBy, no mounts. `design_export`: formatVersion 2.0.
- `surface_contract_entry` (+transport, abi, role) and `surface_snapshot` (+targetLanguage).
- `edge_reach` (+library).
- Descriptions updated: `endpoint_binding` (+`jsonRpcMethod`), `export_model`, `cross_project_reference`.
- Deleted: `portal_mount`.
- New reach model: `reach_model`, `verb_reach`, `modelled_call`, `network_boundary`.

**sdd_validator.**
- New pure components: `reach_model_projector` (projector: `project`, `compose`) and `network_arbiter` (arbiter: `judge`).
- `wiring_rules`: `portalMounts` deleted, `unusedDetection` rewritten (the new roots), new `entryDeclarations` and `networkBoundaries`, `unusedTypes` counts exported types.
- `doctrine_rules`: new `libraryCalls`, `portalEndpoints` per `requiresEndpoint`, `subsystemBoundaryDependencies` skips library edges.
- `integrity_rules`: `publicSurfaceDeclaredType` deleted, new `implementsContracts`, `exportTables` role-aware.
- `intrinsic_rules.portalFields`: `MISSING_PORTAL_TRANSPORT`, abi.
- `conformance_rules`: route coverage and export conformance re-anchored on `router`.
- `heuristic_rules.namingConventions`: language casing.
- `rule_registry`: new rules registered, retired ones removed.
- `spec_validator.reachModel`; `family_validator.checkReach` and `reachModel` (run narrative calls both); `validator_portal.reachModel`.
- `gate_identity`: network in the digest.

**sdd_core.**
- New `reachability_migration` (`migrate(apply)`) with `retired_reach_form`, `retired_reach_fact`, `reachability_migration_plan` and `reach_rewrite`.
- `spec_index` and `spec_loader`: `retiredReachFacts`.
- `spec_maintenance_portal.migrateReachability`.
- `core_orchestrator.renameMethod`: language casing; `renameComponent` no longer rewrites mounts.
- `export_resolver`: role-aware unconsumable, derived kind.
- `design_exporter`: format 2.0.

**sdd_surfaces.** `surface_projector` carries transport, abi, role and targetLanguage.

**sdd_network (new subsystem).**
- `network_portal`, `network_orchestrator` (flows, policy, diagram, view, check, why).
- `network_validator_adapter`, `network_file_adapter`.
- Pure blocks: `flow_matrix_projector` (project, explain), `network_codec` (encodeFlows, encodePolicy), `network_diagram_projector` (view, mermaid), `flow_check_arbiter` (check).
- Types: `flow_party`, `network_flow`, `workload_binding`, `network_bindings`, `network_output_format`, `observed_flow`, `flow_check_report`, `flow_explanation`, `network_document`, `network_view_model`.

**Clients.**
- sdd_cli: `cli_network_adapter`, `cli_runner.runNetwork{Flows,Policy,Diagram,Check,Why}`, `cli_portal.network*` verbs, `network_command_options`, `cli_core_adapter.migrateReachability`, and `runDoctor` (fix, member fix, report).
- sdd_mcp: `mcp_network_adapter`, `mcp_network_orchestrator`, tools `sdd_get_network_flows` and `sdd_explain_flow`; `sdd_add_component`/`sdd_set_endpoints` descriptions.
- sdd_host: `host_network_adapter`, `web_graph_orchestrator.getProjectNetwork`, `web_portal.projectNetwork` (GET /web/projects/network).

**Not in the spec tree, carried by the waves.**
- The reusable workflow and `docs/cli.md` CI line (2.10).
- The guide's recommended-Adapter pattern for volatile third-party APIs.
- The member-alone summary line.
- The hosted canvas's React network view over `/web/projects/network`.

## 9. Implementation waves (for agents, after the lock)

Each wave is one delegated brief per subsystem (`sdd_get_agent_brief`), merged as one PR per wave. After each merge: rebuild `dist/` before reconnecting the MCP server, because a stale server strips new schema fields on save.

1. **Models and loader (sdd_core models, one agent).**
   - `Transport` (+JSONRPC, InProcess, kind/requiresEndpoint/exportKind); `portalType`/`HTTP_API` read compatibly; `abi`.
   - `InvocationKind` entry|runtime with retired kinds read compatibly; `EntryScope`; `DeclaredInvocation.scope`.
   - Component-level `invokedBy` and `entryFor`; `implements`; `router`; `role`; `network` on the project configuration; `MethodEffect` none|io; `DiagramView` network; `naming_rule_config.methodCasingFor`.
   - The scan records `retiredReachFacts`. `mounts` is read but no longer typed.
   - The MCP tool schemas follow (the re-authoring seam coverage test).
2. **Validator core (sdd_validator, one agent).**
   - `reach_model_projector`, `network_arbiter`, the `unusedDetection` roots, `entryDeclarations`, `networkBoundaries`, `libraryCalls`, `implementsContracts`.
   - `edge_reach` library, the portal-fields/portal-endpoints/export-tables/unused-types changes, route and export conformance on `router`, `naming-conventions` casing.
   - Delete `portal-mounts` and `public-surface-declared-type`; registry; rule-matrix fixtures for every new and retired code.
3. **Family, gate and surfaces (one agent).**
   - `spec_validator.reachModel`, `family_validator.checkReach` and `reachModel`, `validator_portal.reachModel`.
   - Gate identity network key (absent when undeclared).
   - `surface_projector` transport/abi/role/targetLanguage, with pin comparison tolerant of absent fields.
   - `export_resolver` role and derived kind; design export 2.0.
4. **Migration (one agent).**
   - `reachability_migration`, the loader facts, `spec_maintenance_portal`/`cli_core_adapter.migrateReachability`, `runDoctor` (fix, members, report), and the hosted bind-time migration.
   - The rename tools' language casing.
5. **Own-tree burn-down (main session, not delegated).**
   - Run `doctor --fix` on this repo.
   - Author the Portal-level entries the migration does not invent: the CLI, the stdio tool surface (JSONRPC), the SDK library (InProcess), and every remaining in-process Portal.
   - Fix or remove the verbs nothing reaches.
   - Validate to 0/0, then one `wairon lock`, committed on the branch before merging.
6. **Derived networking (sdd_network plus clients, one or two agents).**
   - The `src/network/` subsystem, `wairon network flows|policy|diagram|check|why`, the two MCP read tools, `/web/projects/network` and the canvas network view.
7. **CI and docs (small).**
   - The reusable workflow's `validate` input, the documented CI line at the family root, the member-alone summary line, the guide's Adapter-for-volatile-APIs recommendation, and the generated guide and skills text for transports, entries, networks and libraries.

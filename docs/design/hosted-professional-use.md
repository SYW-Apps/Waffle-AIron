# Hosted wairon for professional & team use

> Status: **in design** (~52 draft components under `sdd_host`, plus core-model
> extensions). Direction approved; this is the design rationale the spec YAML only
> hinted at.
> Extends [`docs/design/hosted-mcp-server.md`](./hosted-mcp-server.md) — read that
> first. Everything there (data plane, `admin_portal`, state-scoped lock/promote,
> Docker distribution) still ships unchanged; this layers on top.

---

## 1. What this adds, and why

The shipped hosted server is a **single-operator** appliance. One human holds
`WAIRON_ADMIN_TOKEN`, mints per-project API keys, and hands them to MCP clients.
That is correct for one operator running a handful of projects; it does not
survive contact with a team:

- **No real identities.** A key is a bearer secret bound to a project set and a
  coarse `editor | admin` role. You cannot say "Alice may lock `acme` but only
  read `beta`", and you cannot answer "who locked `acme` last Tuesday".
- **No durable trail.** Auth is audited per-request as a best-effort hook
  (`{ tokenId, project, tool }`), but nothing is *queryable* after the fact.
- **Agents are all-or-nothing.** An MCP agent either has `mcp:write` and can do
  privileged things, or it can't. There is no "the agent may *ask* to lock, a
  human approves" path — exactly the workflow professional teams want when an
  autonomous agent drives design.

This design closes those gaps with four moves, each back-compatible:

1. **Real principals.** `PrincipalSubject` / `HostedUserRecord` give every actor
   (human, service, bootstrap) a stable identity, optionally resolved from an
   external IdP (OIDC/SSO: Authentik, Keycloak, Google Workspace, Entra ID) via
   `identity_provider_adapter`.
2. **Precise grants.** `ProjectGrant` replaces the coarse role with a permission
   set (`mcp:read`, `mcp:write`, `project:create`, `lock:create`,
   `promote:mark-ready`, `key:manage`, `pack:manage`, `audit:read`), scoped per
   project or `*` for instance-wide. The old `editor | admin` role survives as an
   **optional display projection** (`ProjectGrant.role`, `viewer|editor|…|admin`)
   derived from permissions — existing keys keep working; the migration only adds
   fields, never breaks the old ones.
3. **Durable audit.** `AuditEvent` + an append-only `audit_repository`, governed
   by `AuditRetentionPolicy`, with an admin-only redacted read path.
4. **Approval-gated self-service.** MCP agents (and UI/CLI callers) *request*
   privileged actions — `ApprovalRequest` — and an authorized human decides.
   Nothing privileged happens on an agent's say-so.

**Design rule that shapes everything below:** none of this grows the *completed*
`admin_portal`. Each new capability lives behind its **own draft portal**, on its
own exposure switch, so the professional-use surface can evolve to `complete`
without invalidating the admin API that already ships.

---

## 2. A plane per portal, exposure-gated by default-closed

The shipped server already splits a public **data plane** from a localhost
**control plane** (`admin_portal`). This design adds several more control planes,
each an isolated draft portal in front of its own orchestrator. They are **off by
default**: `HostExposurePolicy` (on `HostConfig.exposurePolicy`) decides which
HTTP surfaces bind, and the secure default is *the data plane is the only thing
listening on the network*.

| Plane | Portal (draft unless noted) | `HostExposurePolicy` switch | Default |
|---|---|---|---|
| Data (MCP `sdd_*` + discovery + self-service) | `host_http_portal` *(complete)* | always on | **exposed** |
| Existing admin | `admin_portal` *(complete)* | `adminApiMode` | `local_only` |
| Identity & audit | `identity_portal` | `identityApiEnabled` | **off** |
| Landscape & organization | `landscape_portal` | `landscapeApiEnabled` | **off** |
| Project policy & profiles | `project_policy_portal` | `projectPolicyApiEnabled` | **off** |
| Operations (backup/health/quota) | `operations_portal` | `operationsApiEnabled` | **off** |
| Browser admin UI | `admin_ui_portal` | `adminUiEnabled` | **off** |
| Local CLI/container control | `local_control_portal` | `cliControlEnabled` | **on** |

The posture that falls out: an operator can run a fully professional instance
with **every HTTP control plane disabled**, administering entirely through
`local_control_portal` over `docker exec`/SSH — same audited, approval-gated
workflows, zero network admin attack surface. Turning a plane on is a deliberate
act (`requireTls`, `allowedOrigins`, `allowedNetworks` back it), not a default.

---

## 3. The planes

Each plane is a Portal → Orchestrator → Repository stack (strict SDD layering — a
portal never touches a store). Repositories are the usual `store + registry +
index` triads; only the notable pieces are called out.

### 3.1 Identity — `identity_portal` → `identity_orchestrator`

Owns everything about *who*: resolve or create `HostedUserRecord`s, grant/revoke
`ProjectGrant`s, mint and revoke user-bound MCP/API tokens (`TokenMintRequest`),
and audit each change. Authentication itself stays with the existing
`auth_specialist` (the single authority; constant-time hash compare → a
server-derived principal + grants). `identity_provider_adapter` handles OIDC
discovery, code exchange, and userinfo verification behind a provider-neutral
contract; it **never stores raw client secrets** — `IdentityProviderConfig`
carries a `clientSecretRef` into `secret_registry`, not the secret. Grant
delegation is checked: minting a token for permissions the caller doesn't hold is
refused.

### 3.2 Audit — `audit_repository` (+ admin read via `identity_portal`)

A durable, append-only log. `AuditEvent` records actor, token id, project,
action, and outcome — and **deliberately excludes** raw tokens, secrets, and full
spec bodies (only a small redacted `metadata` string, serialized by policy).
`AuditRetentionPolicy` (on `HostConfig.auditPolicy`, secure default when omitted)
controls level, retention, whether read-events are kept, and separate
`securityRetentionDays` for denials/token-changes/locks. The data-plane
`host_request_orchestrator` already appends a redacted event per request; this
plane makes that store durable and queryable (`AuditQuery`, admin-only,
`audit:read`). Appends are best-effort by invariant (§5) — a full disk must never
fail the tool call the user actually made.

### 3.3 Approvals & self-service — `self_service_orchestrator` + `approval_repository`

The agent-safety plane. An MCP agent cannot init/lock/promote directly; it calls
one of the self-service tools already wired into the (complete)
`host_request_orchestrator`:
`sdd_host_request_project_initialization`, `…_lock`, `…_promotion`,
`sdd_host_get_approval_status`. Each creates an `ApprovalRequest` (durable,
redacted `summary` + `payload`, never raw secrets) and returns a request id — it
does **not** execute. An authorized human decides (`ApprovalDecision`); on
approval the `self_service_orchestrator` runs the real privileged workflow
(`admin_orchestrator` / `project_policy_orchestrator` / `identity_orchestrator`)
and audits it. `local_control_portal` and the admin UI reach the same
orchestrator, so approvals work identically whether the request arrived by MCP,
CLI, or browser.

### 3.4 Project policy & profiles — `project_policy_portal` → `project_policy_orchestrator`

Makes project creation *governed* instead of ad-hoc. `InstancePackPolicy` (a
proper `policy_repository` entity) declares required/default/blocked packs,
allowed/required profiles, and an `enforcementMode` (`warn | block |
auto_reconcile`). A `ProjectInitRequest` carries an explicit
`ProjectProfileSelection`, recorded onto `ProjectConfig.profileSelection` so setup
is repeatable and auditable. `PolicyEvaluationResult` reports compliance before
init/lock/reconcile. Consistent with the shipped pack doctrine, this governs
**declarative** packs/profiles only — executable rule packs still install via the
trusted filesystem, never over an API.

### 3.5 Landscape & organization — `landscape_portal` → `landscape_orchestrator`

Structure *across* isolated projects, which SDD subsystems deliberately cannot
express (hosted projects are separate systems). `OrganizationUnitRecord` +
`ProjectPlacement` group projects into departments/teams/portfolios outside any
project's spec tree. `ProjectRelationRecord` records cross-project edges
(`consumes`, `depends_on`, …) that may only target another project's **exported
public surface** — never its private specs. The orchestrator reads target
projects *solely* to refresh redacted `ProjectPublicSurfaceSnapshot`s; the
`landscape_diagram_specialist` receives already-authorized records and projects a
`LandscapeGraphModel` without ever touching a project root. This is where the
core-model extensions in §4 get resolved and rendered.

### 3.6 Operations — `operations_portal` → `operations_orchestrator`

Self-hosting safety rails. Backup creation/listing (`BackupRecord`,
`BackupPolicy`), restore (`RestoreRequest`, always approval-backed — it can
overwrite live data), health (`InstanceHealthReport` from
`diagnostics_specialist`), and usage/quota (`ResourceUsageSnapshot`,
`ResourceQuotaPolicy` via `quota_specialist`). Raw archive I/O lives behind
`backup_archive_adapter`, which resolves target credentials through secret
*references*, never receiving raw secrets. Quota is **advisory** in the draft
(observe/warn) — see §5 and §7.

### 3.7 Browser admin UI — `admin_ui_portal` → `admin_ui_orchestrator`

Optional. SSO sign-in (`WebSession` bound to a `PrincipalSubject` + server-derived
grants, via `identity_provider_adapter`), then a thin dispatcher that composes
landing-page data and delegates to the identity, policy, landscape, and audit
orchestrators **according to grants**. It owns UI/session concerns only — no
business logic the CLI/API paths don't already have — which is exactly why it must
not bleed into the completed admin API. Off by default; see §7 on whether it earns
its keep.

### 3.8 Local control — `local_control_portal`

A `CLI`-flavoured portal (not HTTP) for operators who disable the network admin
planes. It fronts the *same* `self_service_orchestrator`,
`project_policy_orchestrator`, `identity_orchestrator`, `landscape_orchestrator`,
and `admin_orchestrator`, preserving audit and approval semantics through local
process invocation. This is what makes "all HTTP control planes off" a viable
production posture rather than a lockout.

> **Supporting, not a plane:** `skills_resource_orchestrator` /
> `skills_resource_specialist` (subsystem `sdd_skills`) publish the built-in SDD
> skills as MCP-readable resources (`SkillResourceDescriptor`) so **cloud-only
> agents** that can't receive filesystem-exported skills can still read
> `sdd-architect` et al. directly from the hosted MCP surface.

---

## 4. Core-model extensions — SDD itself goes multi-project

Two fields are added to the **core model** (not the host), because cross-project
architecture is a property of SDD, not of one deployment:

- **`SystemSpec.publicInterfaces: SystemPublicInterface[]`** — an L0 system may
  intentionally expose selected surfaces outward. Each entry **must point to an
  existing L1 subsystem public interface**, so a project boundary can never
  accidentally expose a private component or an internal subsystem surface. This
  is the *only* surface eligible for cross-project relations.
- **`ComponentSpec.remoteInterfaces: RemotePublicInterfaceRef[]`, Adapter-only** —
  a component consumes another project's public surface the same way an Adapter
  consumes a remote Portal. `dependsOn` stays **strictly local**: it may never
  point into another hosted project. Cross-project coupling is legible precisely
  because it is confined to Adapters' `remoteInterfaces`.

Hosted discovery honors this at runtime. The data-plane discovery tools return
**only reachable projects** — `ReachableProjectRef` first (routing-safe ids +
relation kinds), then a redacted `ProjectPublicSurfaceSnapshot` /
`PublicInterfaceSummary` on request. A project can never enumerate the instance,
read an unrelated project, or see anything beyond another system's declared public
methods/DTOs.

**Why core, not host.** These types describe how *any* SDD system participates in
a larger organization — a monorepo or a local multi-project workspace benefits
even with no server involved. Putting them in the core model means the diagram
engine and the Notion/Miro producers render cross-project edges for free, and the
host's landscape plane becomes a *resolver* of an existing model rather than a
bespoke feature. Baking this into the host would strand the concept inside one
runtime.

---

## 5. Security invariants (normative)

These MUST hold in every implementation and are the acceptance bar for the draft
components:

1. **No self-approval.** An `ApprovalDecision` is valid only when `decidedBy ≠
   requestedBy` **and** the decider holds an approval-capable grant. An agent
   cannot approve its own request even if it somehow holds broad permissions.
2. **Grants are server-derived, never client-asserted.** `auth_specialist`
   computes the principal and grants from stored records; the request `project`
   selector can only *narrow* within the authorized set, never widen it. Callers
   may not send a grant.
3. **Nothing sensitive in audit or approval payloads.** `AuditEvent.metadata`,
   `ApprovalRequest.summary`/`payload`, snapshots, and diagnostics carry redacted
   data only — never raw bearer tokens, secrets, or full spec bodies.
4. **Audit appends never fail the primary action.** Persisting an event is
   best-effort relative to the action it describes; a storage failure is itself a
   logged condition but must not roll back the tool call, lock, or mint the user
   requested.
5. **Quota is advisory in the draft.** `quota_specialist` returns
   observe/warn/block *decisions*, but only observe/warn are honored now.
   **Blocking on the data-plane hot path is explicitly out of scope** until a
   dedicated enforcement integration lands (§7).
6. **Weak admin tokens refused at startup.** The server already refuses to start
   with auth on and no `WAIRON_ADMIN_TOKEN`; this extends to rejecting
   placeholder/known-weak values, so a professional instance can't boot on a
   sample credential.

---

## 6. Sequencing

Build order follows the dependency arrows, not the org chart. Each phase runs the
full loop before the next starts:

> **design-finalize** (draft → `complete`) → **narratives** (L5) → **implement**
> → **re-validate** (`sdd_validate_tree`, strict) → **re-lock `sdd_host`**.
>
> The lock is **state-scoped**: any spec edit shifts the `StateId` and drifts the
> lock deliberately, so a per-phase re-lock is expected and correct, not churn.

| Phase | Lands | Why here |
|---|---|---|
| **1 — Identity + Audit** | `PrincipalSubject`, `HostedUserRecord`, `ProjectGrant`, `AuditEvent`/`audit_repository`, `identity_*` | Prerequisite for everything: subjects to attribute actions to, grants to authorize by, durable events to record. Nothing else can audit or authorize without these. |
| **2 — Approvals + self-service** | `ApprovalRequest`/`Decision`, `approval_repository`, `self_service_orchestrator` | The MCP tool entry points are already wired in `host_request_orchestrator`; this makes them do something. Needs Phase-1 identities to know who may request vs. decide. |
| **3 — Project policy + profiles** | `InstancePackPolicy`, `ProjectProfileSelection`, `PolicyEvaluationResult`, `policy_*`, `project_policy_*` | Governs project init/lock. Authorizes via Phase-1 grants; policy *changes* route through Phase-2 approvals. |
| **4 — Landscape + organization** | `SystemPublicInterface`/`RemotePublicInterfaceRef` (core), snapshots, relations, org units, `landscape_*` | Depends on the §4 core-model extensions and on redacted public snapshots being produced. |
| **5 — Operations + Admin UI + Local control** | `backup_*`, `diagnostics_specialist`, `quota_specialist`, `admin_ui_*`, `local_control_portal` | Sits on top of all planes: the UI composes them, local control fronts them, operations observes them. |

---

## 7. Open questions & scope risks

Called out honestly rather than buried:

- **Backup/restore vs. platform snapshots.** The self-hosting guide already
  recommends **volume-level** snapshots (GCE persistent-disk schedules, Cloud Run
  persistent volumes). `backup_*` partly duplicates that. It earns its place only
  if it delivers what volume snapshots can't — *per-project*, app-consistent,
  approval-gated, restore-as-copy backups. In Phase 5, either justify it on those
  grounds or **trim it to backup-metadata + restore orchestration** over the
  platform mechanism. Do not ship a second-rate archiver.
- **Quota enforcement point & latency budget.** Advisory quota is cheap; real
  blocking means a per-request rate check on the MCP hot path. Where does it live,
  and what latency can it add before it degrades the data plane? Unresolved — hence
  observe/warn only for now.
- **Audit write throughput.** Every tool call appends an event. The store must
  keep that off the critical latency path (async/batched, best-effort per §5.4);
  a naive synchronous fsync-per-call would tax the busiest, most valuable clients.
- **Admin UI maintenance cost.** A browser UI is the most expensive surface here
  to build and keep secure, and it adds no capability the CLI+API lack. It stays
  **off by default and optional**; if it doesn't pull its weight in Phase 5, cut
  it without loss of function.

---

## 8. CI: drafts merge, completeness still gates

Landing ~52 components incrementally would light up the conformance gate with
warnings for work that is *intentionally* unfinished. So the gate
(`validate --ci`) is changed to treat **draft-status warnings as non-fatal**:
`DRAFT_COMPONENT_WARNING` and `UNUSED_COMPONENT` **on components marked `draft`**
no longer fail CI. This lets an in-design layer merge behind its exposure switch
without turning the build red.

Completeness is **still enforced the moment a component claims `complete`** — and
`sdd_host`'s existing complete tree keeps validating strictly. The relaxation is
scoped to draft status only: it buys incremental delivery of the professional-use
planes, not a general loosening of the SDD gate. `wairon lock` remains full
strictness with no draft relaxation, so a phase cannot be locked until its
components are genuinely complete.

# Supervisor and Actor doctrine: supervision state, shared data, the lifecycle effect

## The problem

Two rules left the process layer without an honest shape.

- Held state lives in a dedicated data component, but a Supervisor could not
  depend on a Store, Registry, Repository, Index or Query at all
  (`ARCHITECTURE_VIOLATION_SUPERVISOR_DEP`). A Supervisor's own bookkeeping —
  restart counts, the set of live children, the brackets of the runs it starts —
  had nowhere to live.
- A component depending on a live Actor had to also depend on a Supervisor that
  supervises it (`ACTOR_REACHED_WITHOUT_SUPERVISOR`). Real callers do not go
  through the Supervisor: they look the Actor's live handle up by id in a
  registry the Supervisor keeps. The remedy pushed a ceremonial edge instead of
  the real lookup hop.

## The rules

1. **Supervision state.** A Supervisor may `owns` a Store or Registry that is its
   own: one hop, private, read and written in full. It owns nothing else, and
   nobody else depends on that state.
2. **Shared data.** A Supervisor may call a data component it does not own only
   through methods whose declared effect is `read` or `lifecycle`. A write goes
   through a workflow: the Supervisor depends on the Orchestrator that does it.
   Judged from the Supervisor's narrative call steps against the callee's
   declared effect; a callee that declares no effect is refused too.
3. **The lifecycle effect.** A third method effect, `lifecycle`: the method
   creates, destroys, or (un)registers an entity's existence or membership and
   never modifies its domain fields. It is closed under composition: a lifecycle
   method calls only read and lifecycle methods besides construction and local
   steps.
4. **Supervised reach.** A component depending on a live Actor reaches it through
   its supervision when it also depends on a Supervisor that supervises the
   Actor, or on a Registry such a Supervisor maintains — by owning it, or by
   calling it with lifecycle-effect methods.

**Honest limit.** A `read` made on behalf of a request still passes. In practice
the paired write is refused, which forces the marshalling workflow out, and the
read moves with it.

## Codes

| Code | Severity | Rule | Reported on | Meaning |
|---|---|---|---|---|
| `SUPERVISOR_CONTAINMENT` | error | pattern-containment | the Supervisor | it owns something other than a Store or Registry |
| `SUPERVISION_STATE_INTRUSION` | error | member-visibility | the intruder | "X depends on Y, which Supervisor Z owns as its supervision state" |
| `SUPERVISOR_WRITE_SHORTCUT` | error | supervisor-shared-data (new) | the Supervisor's implementation | a call to a write-effect or untagged method on data it does not own |
| `LIFECYCLE_CALLS_WRITE` | error | lifecycle-effect-closure (new) | the implementation | a lifecycle-effect method calls a write-effect method |
| `ARCHITECTURE_VIOLATION_SUPERVISOR_DEP` | error | entrypoint-dependencies | the Supervisor | kept, narrowed: a Supervisor depending on a presentation block |
| `ACTOR_REACHED_WITHOUT_SUPERVISOR` | error | entrypoint-dependencies | the caller | kept, widened: Registry reach counts; the remedy names the Registry, or says to model one |
| `BLOCK_OWNS_MEMBERS` | error | pattern-membership | the block | kept: a Supervisor is exempt |
| `SHARED_OWNED_MEMBER` | error | pattern-membership | the later claimant | kept: Supervisors claim like patterns |
| `UNUSED_LINT_ALLOW` | warning | lint-allows | the allowing spec | kept: an allow naming an error now says an error cannot be allowed |

The existing readers of `effect` read `lifecycle` as a mutation:
`PORTAL_WRITE_SHORTCUT` refuses a Portal's direct lifecycle call as it refuses a
write, and a durable Store needs a hydration read-back for its lifecycle methods
as for its writes (`MISSING_HYDRATION`). The invariant registry still asks only
write-effect methods to assert invariants, since a lifecycle method never
modifies domain fields.

Within the brief, three choices were made:

- Exclusivity is its own code rather than a reworded `VISIBILITY_VIOLATION`:
  the remedy differs (there is no facade to depend on instead; the state is
  either shared data or reached through the Supervisor).
- An owned Registry counts as maintained for supervised reach, as decided. A
  caller depending on it is then still an intruder, so that shape reports
  `SUPERVISION_STATE_INTRUSION` once and no actor finding: a lookup Registry
  callers share is shared data the Supervisor keeps through lifecycle calls.
- The lint-allow audit decides "error" from what the run saw on that spec (a
  finding of the code landed there as an error) or, when nothing fired there,
  from the code's resolved severity (project override, profile, default). The
  validator now hands the rule context each code's default severity.

## How the four motivating cases validate

1. **An orchestrator calls an Actor whose handle it resolves through a router
   that is really a Registry of live handles, mistyped as a Store.** Typed as a
   Store, the caller reaches the Actor through no supervision and
   `ACTOR_REACHED_WITHOUT_SUPERVISOR` fires on the caller. Retyped as a
   Registry whose register/unregister methods are `lifecycle` and whose lookup
   is `read`, with the Supervisor registering each started Actor through a
   lifecycle call, the caller depending on that Registry and the Actor is
   supervised reach, and the Supervisor's calls pass `SUPERVISOR_WRITE_SHORTCUT`.
   A standalone Registry still needs a Store to write to
   (`REGISTRY_WITHOUT_STORE`, a warning) — give the handles a Store, or wrap both
   in a Repository the Supervisor keeps through lifecycle calls.
2. **A component that spawns and owns Actors is typed Orchestrator but is a
   fused Supervisor and workflow.** It depends on the Actor with no Supervisor
   anywhere: `ACTOR_REACHED_WITHOUT_SUPERVISOR`, whose remedy says to give the
   Actor a Supervisor that maintains a handle Registry. Split into a Supervisor
   (spawns, restarts, registers handles) and a workflow (looks the Actor up in
   that Registry), the tree validates.
3. **A scheduler Supervisor reads guard state and brackets run lifetimes on a
   shared repository.** The edge to the repository is no longer a finding. Its
   calls — read the guard, open a run, count live runs, close the run — are
   `read`, `lifecycle`, `read`, `lifecycle`: quiet. Tagging open or close as
   `write`, or leaving them untagged, fires `SUPERVISOR_WRITE_SHORTCUT`; a
   lifecycle open that also updates the run's fields fires
   `LIFECYCLE_CALLS_WRITE` on the repository's implementation.
4. **The same Supervisor reads and writes a shared object heap on behalf of a
   call.** The read passes; the write fires `SUPERVISOR_WRITE_SHORTCUT`. Moving
   the work into a marshalling Orchestrator the Supervisor calls — the read goes
   with it — validates.

All four, and a fire and a control for every new or changed code, are fixtures
in `tests/rules-matrix/families/boundaries-supervision.fixtures.ts`; the
lint-allow case is in `references-lint-allows.fixtures.ts`.

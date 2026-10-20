_Fable 5.1 · 2026-09-12 · sparring on stage 2a (export tables, the `notice` severity, project id) · repository-backed, read-only, `dev` at `f5c33b9` · briefed with decisions.md and stage-2.md. Kept verbatim for provenance; the maintainer's resulting decisions are in [`../decisions.md`](../decisions.md)._

# Stage 2a stress test — exports, `notice`, project id

Grounded in `decisions.md` §9 (refined), `stage-2.md` §1–2, §5, §8–10, and the code paths cited below. Everything read-only.

## A. Export tables

### A1. Wildcard collisions

**Problem.**
```yaml
# L0
publicInterfaces:
  - { from: payments }            # exports payment_portal, money
  - { from: legacy_payments }     # also exports payment_portal (a different component)
  - { from: shipping, component: shipping_portal, as: payment_portal }   # explicit
```
Three questions: wildcard-vs-wildcard, explicit-vs-wildcard, and whether the verdict is at table time or at use.

**Real systems.** ES: local/explicit exports shadow `export *`; two stars with one name → the name is silently absent, error only on import. Rust: an explicit `use` shadows a glob; two globs with one name error only when used. Both defer because linking is lazy.

**What wairon adds.** The resolved table *is* the published contract (snapshot, OpenAPI tags, hosted catalog). A name silently dropped from a published API is a hole in a contract, not a lazy link. The resolver runs once per scan, so there is nothing to defer to.

**Options.**
- (a) Explicit shadows wildcard silently; wildcard-vs-wildcard → `EXPORT_ID_DUPLICATE` error, name excluded from the projection.
- (b) Same, but wildcard-vs-wildcard is a notice with exclusion (the ES nuance); the consumer trips `EXTERNAL_NOT_EXPORTED` in 2b.
- (c) Every conflict an error, including explicit-over-wildcard.

**Recommendation: (a).** Explicit-shadows-wildcard is the idiom every module system shares and it is what makes "extend a surface" one table. Wildcards are new syntax, so an error cannot fail an existing tree, and stage 2's "no new verdicts" is preserved. One code for all "one name, two targets" cases keeps the rule matrix small. **Maintainer decision** (it sharpens decision 9's "two different targets under one public name").

One code-level trap either way: `resolveSurfaceRef` (`src/core/rules/namespace.ts:96`) matches `e.component === local || e.id === local`. The backing component's id is therefore a *second* public name today, which (i) contradicts "renaming the component never touches a consumer" in spirit — a consumer can bypass the public name — and (ii) creates a collision channel `as` cannot see (an own entry named `x` beside a re-export whose component is `x`). For entries carrying `as`, resolve by `id` only; drop the fallback entirely in stage 3.

### A2. What is exportable

**Problem.** `{ from: payments, component: ledger_store }` at L1 or L0.

**Real systems.** Anything `pub` can be re-exported.

**What wairon adds.** Today's L1 rules (`src/core/rules/public-surface.ts`): typed entries are stereotype-checked (`PUBLIC_INTERFACE_TYPE_MISMATCH`), but `Custom` accepts *any* component. The boundary rule (`stereotype-deps.ts:149`) then refuses a `dependsOn` into anything but Portal/Gateway (`CROSS_SUBSYSTEM_TARGET_NON_PORTAL`) — Observer is *not* a legal dependency target, it is an event surface. The sibling projector (`surfaces.ts:194`) drops non-Portal/Gateway/Observer with a stderr line. Nothing checks L0 at all; `projectOwnSurface` silently keeps whatever it finds.

**Options.**
- (a) Fold it into `EXPORT_INVALID`.
- (b) A distinct `EXPORT_UNCONSUMABLE` (notice in 2a, error in stage 4) when the canonical target is not Portal/Gateway/Observer — at L0 always; at L1 only for re-exports (own `Custom` entries keep today's permissiveness).
- (c) Error now.

**Recommendation: (b).** The fix differs from `EXPORT_INVALID` ("the thing does not exist" vs "the thing exists but no boundary caller may reach it"), and the staging rule holds. At L1, leave own-item behaviour unchanged. The projection must carry `componentType` (already planned) so consumers and the hosted catalog can show it. **Engineering default**, with one maintainer question: whether an Observer stays exportable given that nothing may `dependsOn` it (I would keep it: it is the event surface, and the L1 rule already sanctions it for `MessageBus`).

Also: `publicSet` (`rules/index.ts:336`) must stay *own components only*. An L1 re-export is a name for the L0 table to pull, not a licence for other subsystems to depend on the target via the facade — the target's owner decides, exactly as `trustedLinks` stay in one project.

### A3. Interface narrowing

**Problem.** `payment_portal` has `i_charge` and `i_refund`. Export both vs one.

**What exists.** `interface` is already optional at both levels; the projector filters methods by it. `publicSet` ignores it, so at L1 narrowing is decorative for boundary checks (deps are component-granular). Today's L0 default name is `raw.id ?? raw.interface ?? comp.id` (`surfaces.ts:148`).

**Recommendation.** Keep `{ from, component, interface?, as? }`; canonical target = `(project, component, interface?)`, so `EXPORT_ID_DUPLICATE` sees `(p, *)` vs `(p, i_charge)` as different targets. Default public name **`as ?? interface ?? component`** — permanently. The plan says "`as`, else the item's own id" and relies on migration step 2 (2c) to pin the old name; but 2a ships the projection *before* 2c, so with the plan's default every interface-narrowed entry without `id` changes its OpenAPI tag and snapshot id in 2a. Keeping today's default removes migration step 2 and the window. **Engineering default** (it departs from the plan's wording, so say so in the PR).

Note for OpenAPI: two entries with one `component` and different interfaces already land in one per-portal document with two tags (`openapi.ts:245`) — fine. But `resolveSurfaceRef` matching by `component` makes them `SURFACE_REF_AMBIGUOUS` when a consumer names the component — another reason to drop that fallback.

### A4. Types

**Problem.** `{ from: payments, typeDef: money }` versus `money` merely appearing in `createInvoice(amount: money)`.

**Real systems.** Rust `private_interfaces` lint (warn since 1.74, formerly E0446). TS only complains under `declaration: true`. Go/.NET: a public signature may not name an unexported type at all (compile error).

**What wairon has.** `computeTypeClosure` already exports every referenced type implicitly and self-containedly (`surfaces.ts:70`). That is the right behaviour for a contract artifact and should stay.

**Recommendation.** Explicit `typeDef` gives the type a *public name* (referenceable as `alias::money` in 2b+); the closure stays implicit and unnamed. Do not model type entries as `SurfaceContractEntry` (it requires `component` and `methods`); add `exported: true` on `SurfaceTypeDef` or a separate `exportedTypes` list. A closure type not explicitly exported: no finding in 2a; a later `EXPORT_TYPE_IMPLICIT` notice would be the Rust lint. **Engineering default.**

Pre-existing bug this makes visible: the closure is keyed by unqualified `t.id`, so two subsystems each owning `money` collide silently (first match wins, `included.has(spec.id)`). Key it by qualified id and emit the local name.

### A5. Audience through chains

**Problem.** `{ from: shipping, audience: partner }` at L0 sets one ceiling for everything shipping publishes. L1 entries carry no audience.

**Real systems.** Rust: `pub use` of a `pub(crate)` item does not compile (E0364) — re-export cannot widen. Wairon deliberately has no "L1-published but un-liftable" tier; L0 is where reach is chosen. So in 2a (subsystem sources only) there is *nothing* to widen from, and **`EXPORT_WIDENS_AUDIENCE` cannot fire in 2a**. The rules-matrix ratchet requires a fire fixture per registered code (`tests/rules-matrix/harness.ts`), so registering it in 2a either breaks the ratchet or ships a dead code. **Move it to 2b**, where member sources exist. Wildcards over members in 2b: the entry's audience is `min(entry, source-entry)` per pulled name, and the finding fires per name that would widen. **Engineering default.**

### A6. Public-name grammar

`as` and export ids must fit `SpecIdSchema` (`[a-z0-9-_]+`): `::` is the reference separator, and `.` is a qualifier separator in type references (`matchTypeRef` splits on `::|\.`, `type-analysis.ts:195`), so a dotted public name would mis-resolve. Today's L0 `id` is `z.string()` (lenient); keep it lenient on read, but report an id outside the grammar as `EXPORT_INVALID` (it cannot be referenced). Project `id` may contain dots (decided); the *alias* may not — already stated in §1. **Engineering default.**

### A7. Downstream consumers

- **OpenAPI** (`openapi.ts`): tags = `entry.id`, documents partitioned by `entry.component`, title from the first entry's name. Fine over a flattened table; a wildcard yields one tag per pulled name.
- **Hosted landscape** (`server/landscape.ts:313-375`): reads *raw* YAML and keys entries by `id ?? systemInterfaceId ?? interface ?? component`. A `{from, component, as}` entry is catalogued under the **component id, not `as`**; a wildcard entry has none of those fields and **vanishes**. Hosted relations target catalog ids, so this silently changes published names. Also its audience default is `'public'` (rank 4 = external in `visibility.ts`) while the projector defaults `'instance'` — a pre-existing disagreement about the reach of every un-audienced entry. Fix: landscape takes ids/names/audience/componentType from the resolver and keeps raw reads only for the unmodeled extras (`methods`/`endpoints`/`publicTypes` name lists).
- **Canvas** (`core/canvas.ts:167`): `apiTagOf` maps `component → pi.id` only when both are literal; re-exports and wildcards get no deep link. Feed it the resolved table.
- **Share snapshots**: flattened table, unaffected, but `projectName` keys need `projectId` beside them (C4).

### A8. Missing from the plan

1. `sdd_set_public_interfaces` (`mcp/server.ts:921`) hard-codes `{type, details, component?, interface?}` and the SDK strips unknown keys — an agent cannot author `from`/`typeDef`/`as`, and a restatement through it turns re-exports into own items (then `PUBLIC_INTERFACE_FOREIGN_COMPONENT`). `type`/`details` must become optional there. `schema-field-coverage.test.ts` checks only top-level fields plus `methods`/steps; add a nested assertion for `publicInterfaces.items` or this silently regresses.
2. Legacy L0 entries with `component` but no `subsystem` are valid today (the projector finds the component globally): `from` must be inferable from the owner.
3. `EXPORT_CYCLE`: a cycle of *named* chains never grounds — error, as decided. A cycle of *wildcards* is a fixpoint in both ES and Rust (union of visited sources). Recommend computing the fixpoint with no finding; **maintainer decision** since it narrows a decided error.
4. Snapshot entries should also record `interface` (when narrowed) so `sameContract` and the 2b `used` digests do not conflate two narrowings of one component.

## B. The `notice` severity

### B1. Interplay

- **Draft downgrade** (`rules/index.ts:447`): returns `'warning'` flatly for `COMPLETENESS_RULES` in draft context — a notice-default code listed there would be *raised*. Make it `min(resolved, warning)`; never add a notice code to that set.
- **`lint.allow`**: extend to notices (weaker than the warnings it already silences); the docstring at `specs.ts:150` and the stale-allow audit need the word. Errors stay unsuppressible.
- **`sddRuleSeverity`**: add `notice` to the enum. Downgrading an error-default code to `notice` grants no new power — `warning` and `off` are already allowed — so yes. `SEVERITY_RANK` (`validation.ts:75`, used by `stricterSeverities` for parent/child merges) needs `notice: 1` between `off` and `warning`; `RuleCode.defaultSeverity: Severity` and the harness `FixtureSeverity` widen too.
- **`--ci`** (`commands/validate.ts:141-163`): today any non-error is a warning and fatal unless `isCiDraftWaivable`; an unclassified notice fails CI. Print notices (grey), count them in the summary line, never fail. If GitHub annotations are ever emitted, `::notice::` is the literal level.
- **MCP** (`server.ts:1530`): `{valid, errors, warnings}` — add a separate `notices` array rather than folding into warnings (agents treat warnings as a to-do list). `valid` unchanged. `candidate.ts` splits errors (refuse) / warnings (ride along): notices ride along.
- **Lock**: `LockRecord.validationResult` counts errors/warnings; add an optional `notices` count for the record, not for the verdict.
- **Web**: `web/src/canvas/engine.ts` is the SPA — the sweep needs a `dist/webapp.html` rebuild, not just source edits.

### B2. The name and the level

**Options.** (a) A fourth level `notice`. (b) A fourth level `info`. (c) No level: warnings plus a hard-coded `--ci` waiver list. (d) An issue flag (`advisory: true`) in the style of `draftContext`, waived by `--ci`.

**Recommendation: (a).** LSP has Information/Hint, GitHub Actions has exactly `notice/warning/error`, Rust has `note`. `info` reads as "not a finding"; `notice` reads as "a finding you are told about, not judged on" — which is the staging rule's meaning. (c) is what `isCiDraftWaivable` already is, a list that only grows; (d) cannot be raised via `sddRuleSeverity` ("opting into the stricter rule early" is the point). **Maintainer decision** (product vocabulary), but the level is right.

## C. Project id

### C1. Immutability

The lock record (`core/lockfile.ts`) carries `stateId`, per-spec digests and child pins, no project id, and `project.yaml` is not among the gate inputs. An id edit is therefore invisible to the gate. Add `projectId` to `LockRecord`; `validate` reports `PROJECT_ID_CHANGED` when `project.yaml` disagrees with the lock. Severity: decision 6 says "immutable" and the real damage lands on 2b consumers whose lock keys on the producer id — I would make it an **error** from 2a (a locked project that changed identity has broken every consumer); a re-lock after the stage-6 `rename` migration is the sanctioned path. **Maintainer decision** (it names a stage-2 error).

### C2. Unstable defaults

A defaulted id moves with `name`. Options: (a) doctor writes it (2c — a 2a/2b window stays computed); (b) every `saveProjectConfig` backfills the defaulted id on its next write; (c) `validate` escalates after a period. **Recommend (b) plus (a)**: writers already rewrite the whole file, backfilling the value the project was already answering to is not a semantic change, and it shrinks the window without waiting for 2c; `PROJECT_ID_DEFAULTED` keeps firing on read-only paths. Hosted is stable regardless (`name` = hosted id). **Engineering default**, flagged because it writes on unrelated saves.

### C3. Chained children

`createChainedSubsystem(spec, name)` is called with the subsystem's *display name* (`server.ts:910`), and `externalizeSubsystem` uses `foo.name || subsystemId` (`provision.ts:378`) — so `slugify(name)` would default the child's id from prose. The child's id should default to the **subsystem id** (the mount alias; already a `SpecId`, so the default alias and the mount name coincide). Whether to parent-qualify it (`parent.child`, dots being why they are allowed) is the open question: unqualified ids can collide across families on one hosted instance, but hosted creation writes the hosted id anyway. Recommend unqualified subsystem id. **Maintainer decision.**

### C4. Two identities

`system.name` is today's identity for snapshot keys (`surfaces.ts:166,284`), the family/sibling provider match (`namespace.ts:44`), the hosted `systemName`, canvas storage keys, and — the sharp one — `parentSystem`, which `hierarchy.ts:35` checks against `ctx.system.name`, so a display-name edit already breaks every subsystem. For 2a: snapshots and `ExternalSurfaceEntry` gain `projectId` beside `projectName`; `isProvidedBy` accepts either. Leave `parentSystem` alone in 2a but record it as the third identity to retire (it should reference nothing, or the project id). **Engineering default**, with the `parentSystem` retirement a later maintainer decision.

## D. Anything else

1. **Ordering:** the projection over the resolved table (2a) precedes the migration (2c); the resolver, not the migration, must preserve existing names (A3).
2. `EXPORT_WIDENS_AUDIENCE` is unfireable in 2a (A5) — move to 2b or the ratchet objects.
3. The landscape's `'public'` default versus the projector's `'instance'` (A7) is a live inconsistency about the reach of every un-audienced entry; fixing it changes hosted catalog visibility — say so in the changelog.
4. `resolveSurfaceRef`'s component-id fallback (A1) is the one thing that would let a consumer keep working across a rename that decision 9 says should be invisible in the *other* direction; retire it with `as`.
5. The sibling projector (`projectSubsystemSurface`) is retired by decision 9 but keeps judging until stage 3; in 2a, route only `projectOwnSurface` through the resolver and leave the sibling path untouched, or the family pins change content in 2a.
6. Spec placement (§8) puts the resolver in `sdd_core` as a Specialist and the projection in `sdd_surfaces`; the landscape (`sdd_host`) must then read the resolver through an adapter, not raw YAML — the same seam A7 needs.

## Maintainer decisions needed

1. **Wildcard collisions:** recommended — explicit shadows wildcard silently; wildcard-vs-wildcard is `EXPORT_ID_DUPLICATE` (error, name excluded). Alternative: notice plus exclusion.
2. **Wildcard cycles:** recommended — fixpoint, no finding (ES/Rust); `EXPORT_CYCLE` stays an error for named chains only.
3. **Unconsumable targets:** recommended — new `EXPORT_UNCONSUMABLE` notice at L0 and for L1 re-exports (error in stage 4); Observer stays exportable. Alternative: fold into `EXPORT_INVALID`.
4. **`notice` versus `info` versus a waiver list:** recommended — the `notice` level.
5. **`PROJECT_ID_CHANGED`:** recommended — error from 2a, lock carries `projectId`. Alternative: notice until stage 3.
6. **Chained child default id:** recommended — the subsystem id, unqualified. Alternative: `parent.child`.
7. **Default public name `as ?? interface ?? component`** kept permanently (drops migration step 2) — engineering default, but it contradicts the plan's wording, so a nod is needed.
8. **Defer `EXPORT_WIDENS_AUDIENCE` to 2b** — engineering default; flagged because it changes the 2a scope list.

_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 04 — One edge, one verdict: composing judgements across roots

**Diagnosis.** Two judges with different inputs, and a merge that filters by code family.
The child's run sees its own config, its own approval and its pins; the parent's run
sees the parent's config, no child approval and the child's pins only through the
mount-pool lookup. `validateSddTree` then keeps the child's findings *except* an entire
code family (`:459, :478`) and unions in the parent's — which is how a stale pin outranks
a live parent (a pin hit is `surfaceResolved`, so no walk), how a purely local error is
softened (correction 1), and why the walk covers references only (it is gated on a code
family, and nothing else triggers it). The root cause is that a verdict is a function of
the loading root and of what happens to be on disk, instead of a function of *(this
project's specs, its declared inputs, its effective configuration)*.

**Options.**

| | | |
|---|---|---|
| a | Union of two judges (today), with the code-family filter repaired | Still two judges with different inputs; every future rule must decide which family it is in. |
| b | The parent is the sole judge whenever it is reachable | Kills R2 (a child's verdict changes when someone checks out the parent) and R10 (every child validate loads the family). |
| c | The *consumer's project* is the sole judge of its edges; the family run is a composition of member runs plus family-level checks | One judge per edge, by construction the same from every root; per-member config and approval fall out; cheaper than the single federated context. **Recommended.** |
| d | Verdicts against pins only, never live (pure lockfile) | Deterministic, but a revoked publication hides until someone re-pins — the stale-pin probe becomes the design. Offered as an explicit mode (`--frozen`), not the default. |

**Recommendation: c.** The algorithm, as `validate` would run it:

```
validateProject(root, opts):
  cfg      = effectiveConfig(root)                                   # issue 03
  tree     = load(root)                                              # this project only
  inputs   = for each declared external / family peer E referenced by tree:
               live(E) if reachable(E) else pin(E)                   # issue 05
             where reachable = E's root on disk inside this family, or hosted+authorized
  issues   = rules(tree, cfg, inputs, approval(root))                # one context, this project
  for each E where live(E) and pin(E) both exist and digest differ:
             issues += EXTERNAL_PIN_STALE @E (warning; --ci fails on it; --frozen ignores live)
  return issues

validateFamily(topRoot):                                             # what `validate` at a parent does
  results  = { P: validateProject(root(P)) for P in self ∪ members (recursively) }
  family   = PROJECT_ID_COLLISION, MOUNT_ID_MISMATCH, MOUNT_DECLARES_CONTENT,
             GOVERNANCE_DIVERGENCE, MEMBER_NOT_FOUND, inbound-consumer report
  return   prefix(results) ∪ family
```

- Every edge is judged exactly once, by the project that authored it, under that
  project's effective config, against the producer's surface. The family run *calls* the
  same function; it does not re-derive anything. `resolvedThrough`, `surfaceResolved`,
  `SUBPROJECT_REFERENCE_CODES`, `isCollapsedCrossTreeRef` and the mount-pool lookup
  (`namespace.ts:39-47`, `surfaces.ts:408-418`) are deleted.
- Evidence ranks: live when reachable, pin when not, and when both exist and differ the
  difference is a finding. A pin therefore never *outranks* the live tree; it stands in
  for it.
- Approval context: each member's run reads its own `lock.json`
  (`settledStatusBearing` is already per root, `validation.ts:604-637`), so a settled
  child spec is judged at full strictness from the parent too. The parent additionally
  sees whether the member is approved at all (issue 07).
- Code: each project judges its own code against its own specs (unchanged in spirit,
  `rules/conformance.ts:39-48`, now by construction rather than by skip). Import edges
  that cross a mount are judged by the *importer's* project in the family run, which has
  both projects' L4 `sourcePath` maps to resolve a file to `billing::<component>`;
  standalone, an import into a path that belongs to a member or a parent is
  `CROSS_PROJECT_IMPORT_UNJUDGED` (notice) — honest, never an error for a clone that
  cannot see the other project's L4.
- Modes: `--ci` as today (unwaived warnings fail, so a stale pin fails); `--frozen`: use
  pins only and do not read live producers (a detached CI that wants determinism; a live
  producer that *is* on disk is then reported as unread, not consulted); `--locked` is
  unnecessary because `--ci` already fails on `EXTERNAL_PIN_STALE`.

Cost (R10): a child run loads the child plus the *surfaces* of what it consumes (from
pins, or projected from one sibling's tree when live) — never the family. The family run
loads each member once and builds N small contexts instead of one large one; the rule
loop is the same total size.

**Migration.** No file changes. Behavioural: children that pass today only because the
parent's run was lenient (correction 1) will fail; children whose pins hide a revoked
publication will get `EXTERNAL_PIN_STALE` as soon as they validate with the parent on
disk — both are the point. `resolvedThrough` consumers (`commands/validate.ts:123-128`,
the hosted result shape) print the composition summary instead ("judged as member of
platform; 2 externals live, 0 pinned").

**Proof.**

- `one-judge` (R1 as a test): for every family fixture, every project *P* and every edge
  *e* authored in *P*: `verdict(e | validateProject(P))` equals
  `verdict(e | validateFamily(top))` restricted to *P*, modulo id prefix.
- `location-independent` (R7): `validateProject(P)` with the parent on disk equals
  `validateProject(P)` with the parent absent, when every pin is fresh; when a pin is
  stale, the only additional finding is `EXTERNAL_PIN_STALE`.
- `live-over-pin`: the statement's stale-pin probe (parent unpublishes after the child
  pinned) yields `SURFACE_REF_NOT_EXPOSED` *and* `EXTERNAL_PIN_STALE` at the child with
  the parent on disk, and the same `SURFACE_REF_NOT_EXPOSED` at the parent.
- `renamed-method-seen-from-parent`: the statement's rename probe yields
  `SURFACE_REF_NOT_EXPOSED @shipping::dispatch_adapter-impl` from Platform.
- `approval-context-both-roots`: the statement's approval probe (child impl missing a
  method, approved at the child) is an error from both roots.
- `frozen-is-honest`: `--frozen` with a stale pin and the parent on disk passes and
  reports "1 live producer not consulted".

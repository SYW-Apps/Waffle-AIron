_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 03 — Governance: whose rules judge a child's specs

**Diagnosis.** `buildRuleContext` takes one `projectType`, one `rules` and one loaded
extension set for the whole run (`validation.ts:413-431`), chosen by whoever is bound
(`commands/validate.ts:117-122`; `resolveThroughParent` loads the *top* root's config,
`validation.ts:533-537`). Governance is attached to the run instead of to the spec's
owning project. That is why a child's config is ignored from the parent, an intermediate
parent's is ignored from the top, and — correction 1 — a child with its parent on disk is
judged under the parent's config even for purely local edges.

**Options.**

| | | |
|---|---|---|
| Isolation | each project judges its own specs under its own config, full stop | Simplest; a platform cannot impose doctrine on parts it owns. |
| Inheritance as a floor | a member's effective config = parent's effective config ⊔ own, where own may only tighten; `governance: own` opts out and is reported | Expresses both "part" (inherit) and "independent" (own) without a kind flag; disagreement is a finding, not a silent pick. **Recommended.** |
| Override | the parent's config governs the family | What the parent's run does today; kills R2 and R7 and makes a team's deliberate config a no-op depending on where validation ran. |

**Recommendation.** A pure function `effectiveConfig(projectRoot)`:

```
own       = project.yaml at projectRoot
if own.governance == 'own' or no mounting parent: return own
parent    = effectiveConfig(mounting parent root)          # recursive: Payments inherits Billing's
                                                            # effective config, which inherited Platform's
projectType = own.projectType declared ? own : parent      # Track D2, already approved
packs     = parent.packs ∪ own.packs                        # a pack the child adds applies to the child
severity[c] = max(parent.severity[c], own.severity[c])      # error > warning > off; own may only tighten
designDepth, limits: own if declared else parent
```

- Every rule context is built per project, from `effectiveConfig(that project's root)`.
  The family run builds one context per member (issue 04 explains why that is cheaper,
  not dearer, than today's single context).
- `GOVERNANCE_DIVERGENCE @<member>` (warning, raised in the family run at the parent):
  the member declares `own` and its effective severity for some code is below the
  parent's floor. Lists the codes. Never softens the parent's verdict on *its own* edges;
  never hardens the member's.
- `GOVERNANCE_LOOSENS @<project>` (error): an `inherit` project whose `sddRuleSeverity`
  lowers a code below the floor — the config is invalid, not silently clipped.
- Standalone child with no parent on disk: the floor comes from
  `.wai/externals.lock.yaml`, which `wairon externals pin` writes alongside the surface
  digests (issue 05): the parent's effective config as of the pin. A detached clone then
  validates under the same doctrine as the family, and a floor that moved since the pin
  is `EXTERNAL_PIN_STALE` like any other input.
- Pack doctrine the child applies and the parent does not: applies to the child (it is
  the child's own tightening); the family run loads the child's packs for the child's
  context. The reverse (parent pack, child lacks it) is the floor and applies to the child
  under `inherit`; under `own` it is reported as divergence.
- Showing it: `wairon status` prints `governance: inherit (floor: platform)` or
  `governance: own — diverges from platform on: CROSS_SUBSYSTEM_NON_ADAPTER (warning < error)`.

**Migration.** Existing members have no `governance` key; default `inherit`. Members whose
own config already loosens a code relative to the parent will start failing
`GOVERNANCE_LOOSENS` — a deliberate, listed behaviour change (the statement's issue-03
probe becomes an error at the child instead of a disagreement). `doctor` reports these
before the switch flips; a team that wants the loosening declares `governance: own` and
accepts the divergence warning at the parent.

**Proof.**

- `same-config-both-roots`: for every member in a family fixture, the config the family
  run uses for that member's context deep-equals `effectiveConfig(member root)`.
- `tighten-only`: an `inherit` member setting a code to `off` under a parent `error` floor
  fails with `GOVERNANCE_LOOSENS`; setting `error` under a `warning` floor validates and
  the family run reports that code as `error` for that member.
- `divergence-is-visible`: the issue-03 probe (child `off`, parent `error`) with
  `governance: own` yields no finding at the child and `GOVERNANCE_DIVERGENCE` at the
  parent; with `inherit` it yields `GOVERNANCE_LOOSENS` at both.
- `no-softening-by-location` (the correction-1 probe as a test): a child-internal
  `CROSS_SUBSYSTEM_NON_ADAPTER` is an error from the child root with and without the
  parent on disk, whatever the parent's `sddRuleSeverity` says.
- `detached-floor`: a child validated with its parent removed from disk, holding a pin
  taken under the parent's floor, reports the same governance findings as with the parent
  present.

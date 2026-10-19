_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 05 — Contracts across the boundary: pins and freshness

**Diagnosis.** Pins began as *delivery* (the parent pushed family snapshots on lock,
`surfaces.ts:536-544` tells the history) and became *inputs* without becoming *declared*
inputs. So they are a cache: unaddressed by references (nothing maps a reference to the
pin it needs, so unused pins and undeclared references are both invisible), keyed for
freshness by the whole family's `stateId` (`surfaces.ts:168, 286` via `stateIdString()`
inside the parent binding; `statehash.ts:57-72`), and consulted before the live tree
(issue 04). The hosted plane already has the declared form — `ProjectRelationRecord`
names a source Adapter, a target project and a target public interface
(`server/types.ts:729-743`) — and knows nothing of pins.

**Options.**

| | | |
|---|---|---|
| a | Snapshot per producer, keyed by project id, with a content digest of *that surface* | Freshness moves only when the consumed surface changes. Base of the recommendation. |
| b | Consumer contract (Pact-style): pin only the entries and methods this project uses; per-entry digests | Staleness names the method that changed; an unused entry cannot stale you. Recommended as the *granularity* of (a), not a separate artifact. |
| c | Versioned contracts (semver on L0 entries; `version`/`stability` already exist) | An overlay for externals that publish releases; not required for members, whose "version" is the approval pin. |
| d | No pins while the parent can load the child | Rejected: R2 needs a detached child to validate against something, and issue 04 needs an explicit drift signal. |

**Recommendation.** One lockfile per project, written by the consumer:

```yaml
# services/shipping/.wai/project.yaml
name: shipping
governance: inherit
externals:
  billing: {}                    # a family sibling: source implied (member of my parent)
  platform: {}                   # my parent
  crm:
    source: { hosted: https://wairon.example/, project: crm }

# services/shipping/.wai/externals.lock.yaml   (written by `wairon externals pin`, committed)
pinnedAt: 2026-09-12T10:00:00Z
governance:                      # the inherited floor as of the pin (issue 03)
  from: platform
  digest: sha256:…               # of platform's effective config
externals:
  billing:
    surface: .wai/externals/billing.yaml       # the snapshot body (today's sibling surface, keyed by project id)
    digest: sha256:9c1…                        # of the snapshot content, provenance stripped
    used:                                      # what this project actually references
      invoice_portal: { createInvoice: sha256:4a…, getInvoice: sha256:77… }
  platform:
    surface: .wai/externals/platform.yaml
    digest: sha256:e02…
    used: { core_portal: { lookup: sha256:… } }
```

- `wairon externals pin [id…]` (replaces `surface pin`): for each declared external,
  project its surface — a family peer's L1-published cross-boundary targets, an
  outsider's L0 exports at my audience distance — from the live source, write the
  snapshot, record digests. `wairon externals status` (replaces `surface externals`):
  per external, `fresh | stale (invoice_portal.createInvoice removed, issueInvoice
  added) | unreachable`, plus `unused` pins and `undeclared` references.
  `wairon externals prune` removes unused pins.
- Validator codes: `EXTERNAL_UNDECLARED` (error — `x::y` where `x` is neither a member
  below me, a family peer, nor a declared external), `EXTERNAL_UNRESOLVED` (error — no
  pin and no reachable live source; replaces the `CROSS_TREE_REF_UNRESOLVED` warning,
  which `--ci` could not waive anyway), `EXTERNAL_PIN_STALE` (warning, computed per used
  entry so an unrelated change in the producer does not fire it), `EXTERNAL_PIN_UNUSED`
  (notice). Freshness fails a gate exactly when a *used* entry changed and `--ci` is on.
- The family surface disappears as a kind: the parent is just the external `platform`
  whose surface, for a member, is L1-based. Foreign imports (`origin: exchanged|authored`)
  are externals with `source: { file: … }` — same store, same lock, same codes.
- Hosted: a relation record *is* an externals entry with `source: hosted`; relation
  health compares the same digests. The hosted server can serve `externals pin` for a
  hosted consumer (it already serves surfaces), so families and cross-project consumption
  are one mechanism at last.

**Migration.** `doctor --fix` converts existing generated snapshots
(`.wai/surfaces/<System>.yaml` and `<System>--<sub>.yaml`) into `externals` entries keyed
by the producing *project id* (the family surface → the parent's id; a sibling surface →
the sibling's id, read from its `project.yaml` when on disk, else from the mount id), moves
the bodies to `.wai/externals/`, and writes the lock with content digests; the stale
whole-family `stateId` is dropped. Old snapshots keep loading for one release.
`sdd_list_external_interfaces` keeps its shape (`projectName`, `freshness`) and gains
`used`/`unused`.

**Proof.**

- `stale-only-when-used-changes`: editing a sibling's *unpublished* component, or a
  published method the consumer does not call, leaves every pin `fresh`; renaming a
  called method makes exactly that external `stale` and names the method.
- `undeclared-is-an-error-everywhere`: a `crm::x` reference with no `externals.crm`
  yields `EXTERNAL_UNDECLARED` from the child root and from the family run.
- `pin-is-a-projection`: for a family on disk, `externals pin` at a member produces a
  snapshot whose content digest equals the digest the family run computes for the same
  producer surface — so `live-over-pin` (issue 04) can never fire on a fresh pin.
- `hosted-and-family-agree`: the same consumer, once as a hosted relation and once as a
  family member, records the same digest for the same producer state.
- `no-push`: no operation at a parent writes under a member's `.wai/externals/`.

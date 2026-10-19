_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 01 — Mount and realization: two specs for one subsystem

**Diagnosis.** Two declarations for one subsystem, reconciled by a naming coincidence
that is implemented *inside reference resolution*: `qualifyId` treats any id whose first
segment is in `rootSubsystems` as absolute (`specs.ts:101-104`), and `rootSubsystems` is
filled only at depth 0 (`:739-741`). That single shortcut is what makes a flat child's
`subsystem: billing` land on the mount id so that `mergeMountRealizations` (`:351-373`)
can collapse the two records. Everything the statement lists follows from it: the merge
works one level deep (no anchor exists at depth ≥ 1 — reproduced: `kid::extra` and
`kid::extra::extra`), the child copy wins wholesale (`{ ...child, projectPath }`), a
mount's `publicInterfaces`/`trustedLinks` bind nothing when the ids differ, and a
child id that collides with a root subsystem cannot be reported as shadowing because it
has already been re-anchored. The root cause is that the mount was allowed to carry
content at all.

**Options.**

| | | |
|---|---|---|
| a | Mount wins: the parent's declaration overrides the child's same-id subsystem | Parent authoritative for a thing the child's team edits; breaks R2 and R5 (the child's own validation disagrees with the family's). |
| b | Child wins, formalised: keep the merge, fix it at every depth (the lost fix plus a matching fix for `subsystem:` fields) | Keeps two files for one record and keeps the root anchor, which is the cause of issue 02's shadowing and absolute-vs-local ambiguity. |
| c | The mount declares only the relationship (`id`, `parentSystem`, `projectPath`); the child owns everything; no merge — a same-named subsystem is just `billing::billing` | One source of truth. Removes the anchor, the depth limit and the flat-child concept. Costs a doubled name in the flat case unless the child picks another subsystem name. |
| d | Split with per-field precedence (`publicInterfaces` from the mount, content from the child) | Two sources again, now with a table to remember. |

**Recommendation: c.**

- Schema: `projectPath` present ⇒ `publicInterfaces`, `trustedLinks`, `lifecycle`,
  `profile`, `designDepth`, `targetLanguage` must be absent (`MOUNT_DECLARES_CONTENT`,
  warning for one release, then error). `name`/`description` on the mount are ignored and
  synthesised from the child's L0 `name`/`vision`; `doctor --fix` deletes them.
- Rule `MOUNT_ID_MISMATCH` (error): mount id ≠ the member's `project.yaml name`.
- Loader: no `mergeMountRealizations`, no `rootSubsystems`. A member's subsystems load as
  `<memberId>::<subsystemId>` at every depth; a member's members as their own project id
  (issue 02). The mount loads as a *project node* (kind `member`) distinct from a
  subsystem; the canvas draws it as a container of the member's subsystems
  (`src/core/diagram.ts` gains a mount node — issue 09's evidence says it has none).
- Boundary rules: unchanged for components (`comp.subsystem` is the real subsystem,
  `billing::billing`). A `trustedLinks[].subsystem` naming a *project id* licenses direct
  edges into any subsystem of that member — the natural reading, and it is what today's
  mount-level `trustedLinks` were trying to say.
- Create: scaffolds `project.yaml` (`name` = mount id, `governance: inherit`) and an L0.
  Nothing else — and nothing else is needed, because the mount is realised by the L0, not
  by a same-id subsystem. A child component written with `subsystem: billing` where no
  subsystem `billing` exists is `INVALID_SUBSYSTEM_REFERENCE` from both roots, instead of
  today's "scored from the parent, invisible from the child".
- Internalize: generalises. Fold every subsystem of the member into the parent
  (collision check first), rewrite `billing::x → x` family-wide (issue 10). The flat-only
  guard (`provision.ts:441-444`) goes.
- Several subsystems per member: yes, always, as `<memberId>::<sub>`. There is no
  "subsystem containing subsystems": there is a *project* containing subsystems, which the
  level model already defines (L0 → L1). The container's own fields are the L0's.

**Migration.** Component ids do not change for flat children — `billing::invoice_portal`
is the same string before and after, because component ids are flat within a project and
the prefix is the project id either way. What changes is the *subsystem* id of those
components (`billing` → `billing::billing`), visible in `--subsystem` scopes, `trustedLinks`
targets and status output; `doctor --fix` rewrites scoped selectors it can find and the
rule above accepts the project id as a trusted-link target so existing `subsystem: billing`
links keep meaning what they meant. Mount content: `doctor --fix` moves
`publicInterfaces`/`trustedLinks` from a mount into the child's same-named subsystem when
that subsystem has none, otherwise reports the conflict and stops. Non-breaking for trees
that validate today; the doubled-name cosmetic is the one visible change.

**Proof.**

- `mount-carries-no-content`: a fixture mount with `publicInterfaces` yields
  `MOUNT_DECLARES_CONTENT`; after `doctor --fix` the child's subsystem carries them and
  the family verdict on every edge is unchanged.
- `depth-invariance`: for a member at depth *d* ∈ {1,2,3} whose subsystem shares its
  project id, `loadSubsystemSpecs()` at the top contains exactly one record per
  subsystem and every component's `subsystem` names an existing record.
- `create-then-author-from-child`: after `createChainedSubsystem`, adding a subsystem and
  a Store at the child makes `status` at the child and at the parent report the same
  completion for it.
- `internalize-multi`: a two-subsystem member internalizes; references in every family
  project that consumed it are rewritten; the family validates with the same edge
  verdicts.

_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 08 — Repository layouts and version control

**Diagnosis.** Containment (`projectPathEscapesRoot`, applied at every write and at load,
`specs.ts:196-222, 908-916`) is a *tenant-isolation* invariant for the hosted plane
("Fix B2"), and it was applied to the only relationship that existed, so the layout the
statement calls weakest — a part in another repository — has to be expressed as
containment even when it is really consumption. Git backing scopes `.wai/` at the bound
root (`git/orchestrator.ts:19`, `server/admin.ts:414-440`), so a member's `.wai/` is in the
working tree but never in the pathspec; tree archives walk every root
(`treetransfer.ts:218-253`). Approval pins and commit pins are unrelated because nothing
asked what a commit has to do with a design decision.

**Options.**

| | | |
|---|---|---|
| a | Lift containment locally: allow `projectPath: ../billing` for members | Makes a family span repositories by *containment*; the parent's clone is then incomplete by design, archives cannot carry it, and hosted must refuse it anyway — two behaviours for one field. |
| b | Contain = inside; consume = anywhere: members stay inside the parent's directory; a project elsewhere is an external with a local `path:` source | One rule for the field, the same locally and hosted; side-by-side repositories get live resolution and pins. **Recommended.** |
| c | Package-manager style: members fetched from a registry into `.wai/members/` | Reinvents (b) with a registry; not needed while git exists. |

**Recommendation: b.**

| Layout | Relationship | What works |
|---|---|---|
| Monorepo, `services/billing/` | member | Everything: live family run, pins optional, one repo. |
| Git submodule at `services/billing/` | member | Family run when the submodule is checked out; `MEMBER_NOT_FOUND` (error) when not — the parent's CI must init submodules, as with any path dependency. The parent's approval pins the member's approved StateId; `status` also prints the submodule's commit and whether the pinned approval exists at that commit (`git -C services/billing cat-file` on `.wai/lock.json`). |
| Separate repositories side by side, `../billing` | external with `source: { path: ../billing }` | Live surface when the sibling checkout exists (any directory — no containment for consumption), pin otherwise. Not a member: Platform does not validate Billing's internals; Billing is a system Platform consumes. |
| Hosted | member (inside the parent's root) or external (`source: hosted`) | Issue 09. |

- Approval pins and VCS pins stay two things — a design decision versus a file state —
  but the record carries both when it can: `members.billing: { approval: "sha256+doctrine:…",
  commit: "abc123" }` when the member directory is a git checkout. `status` reports the
  three-way state (pinned approval / member's current approval / checked-out commit).
- Hosted backup: with members as projects (issue 09), each member has its own git binding
  — its own repository, or the parent's repository with pathspec `services/billing/.wai/`.
  Until then, `commitProject` at a parent gains `--family`, which stages every member's
  `.wai/` that lies in the same repository (`admin.ts:262-272` already names the gap).
- Archives: unchanged for members; an external's pin travels in the consumer's `.wai/`
  by construction.

**Migration.** None for monorepo and submodule members. A team that today mounts a
sibling checkout *inside* the parent (a clone in a subdirectory) to consume it keeps
working; if they would rather keep it side by side, `wairon member detach billing --path
../billing` (issue 10) converts the mount to an external and pins.

**Proof.**

- `submodule-missing-is-loud`: a parent whose member directory is absent reports
  `MEMBER_NOT_FOUND` (error) and still judges its own edges into that member against the
  parent's pin of it, marked `pin (member absent)`.
- `side-by-side-is-consumption`: an external with `path: ../billing` resolves live when
  the directory exists, from the pin when it does not, and never loads Billing's internals
  (no `billing::<private component>` is resolvable).
- `containment-unchanged-for-members`: every existing `PROJECTPATH_ESCAPE` fixture still
  fails.
- `family-commit-covers-members`: hosted `commitProject --family` on a monorepo stages
  each member's `.wai/`, and a member's `lock.json` reaches the remote.

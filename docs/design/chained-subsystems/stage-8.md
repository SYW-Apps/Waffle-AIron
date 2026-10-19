# Stage 8 — parts and projects

Stages 1–7 made a member an independent project: its own id, exports, gate, lock and hosted record.
That is the right model for a boundary, and the wrong one for a piece of a system that merely lives
in another folder or repository: splitting storage forced a crate boundary nobody asked for. Stage 8
separates what the system is made of, where files live, and who owns and approves what.

Decisions: [`decisions.md`](decisions.md) § "Stage 8 — open, under discussion" and § "Stage 8 —
parts and projects (2026-10-02)".

## 1. The model — one setting, storage orthogonal

```yaml
members:
  scheduler: services/scheduler                    # a part (default), contained
  admin: { source: ../admin }                      # a part in a sibling checkout
  payments: { source: git@…/payments.git, as: project }   # an independent project in its own repo
  marketplace: { source: { hosted: marketplace }, as: project }
```

| | `part` (default) | `project` |
|---|---|---|
| Is | a piece of its parent stored elsewhere | an independent boundary |
| Namespace | the parent's: its subsystems are the parent's subsystems, referenced by local id | its own id; reached only through its exports (`alias::name`) |
| Rules between it and siblings | the ordinary subsystem rules (L1 public interfaces, trusted links) | the project rules (exports, externals, imports) |
| Approval | covered by the parent's lock | its own lock; the parent pins its subject |
| Hosted | part of the parent's record | its own record (stage 7) |

**Storage** — contained, sibling path, git repository or hosted record — applies to both. A member
that is not contained is pinned in the parent's lock (a part by content digest plus the commit; a
project by approved subject plus the commit); the parent is judged against the pin, and a reachable
checkout or record adds live drift and `EXTERNAL_INCOMPATIBLE` findings.

## 2. Growth path — boundaries are earned

1. A system with subsystems in one folder (unchanged).
2. **Parts** when a piece needs its own folder or repository but stays the same system.
3. **Projects** when a part needs independence — its own team, release, approval or public surface —
   by an explicit action: `member promote` (gives it an id, an export table for what siblings use,
   its own lock, and rewrites references to `alias::name`), or `--project` at creation.
4. A project's own members default to parts again.

`member demote` is the inverse (a project becomes a part of its parent: references become local,
exports retire). Both run through stage 6's transaction: plan first, confirm, all-or-nothing.

## 3. A part on its own

A part records its parent and pins the parent surface it uses, so validating a part alone (its own
repository's CI) judges it against that pin. Without a pin it says plainly "part of `<parent>`;
validate from the parent". The full verdict always comes from the parent.

## 4. Existing trees

Every existing member is a boundary. `doctor --fix` writes `as: project` onto each once, so nothing
silently changes meaning; the plan lists them. New members created afterwards default to parts.

## 5. Also in this stage

- Members by reference (sibling path, git source, hosted record) for both parts and projects, pinned.
- Per-use live comparison for path and git externals and referenced projects, so a sibling repository
  that breaks a used method is `EXTERNAL_INCOMPATIBLE` in the family run, not only "drifted".
- Overview follows composition, not storage: the canvas shows parts as the parent's subsystems (with a
  storage badge) and projects as project nodes, with consumption edges.
- Guidance (`sdd-architect`, the guide) teaches the growth path: subsystems, then parts, then projects.

## 6. Open questions for the design pass

- What a part's directory holds: subsystems (and their components/interfaces/types) only, or also its
  own L0 fragment; whether a part carries a minimal `project.yaml` naming its parent.
- How the parent fetches a git-sourced member (shallow clone at the pinned commit into a cache) and
  what happens offline (judge against the pin; live findings unavailable, never a pass).
- Cross-repository family migrations: one plan, applied as a change per repository (never claimed
  atomic across repositories) — or out of scope for this stage.
- Hosted: a part as part of its parent's record; a referenced project as its own record without
  containment.

## 7. Properties

`part-is-the-parents-subsystem` (a contained part and the same subsystems inline give identical
verdicts), `storage-is-orthogonal` (moving a member between contained / sibling / git / hosted changes no
verdict when pins match), `promote-then-demote-is-identity`, `part-alone-judges-against-pin`,
`existing-members-unchanged` (after the migration every existing family validates identically),
`referenced-break-is-incompatible`.

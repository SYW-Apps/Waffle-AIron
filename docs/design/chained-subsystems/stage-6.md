# Stage 6 — family migrations

Stages 3–5 made a family a set of projects that name each other, judge themselves and approve
themselves. What remains is changing a family's shape safely: bringing an existing project in,
renaming a project, taking one out, folding one back into its parent. Each is a family-wide change,
so each follows one discipline: plan first, confirm, then apply all of it or none of it.

Decisions: [`decisions.md`](decisions.md) § "Stage 6 preconditions (2026-09-30)" and synthesis §4
issue 10 ("Migrations").

## 1. The verbs

| Verb | What it changes |
| --- | --- |
| `member attach <alias> <path>` | an existing project becomes a member; its L0 and subsystems are kept (unlike `member add`, which scaffolds) |
| `project rename <new-id>` | the project's `id`, and every reference to the old id family-wide: `members`/`externals` entries, `alias::` references where the alias was the id, pins and snapshots |
| `member rename-alias <old> <new>` | the alias in the parent only; references written with the old alias in the parent are rewritten; members change nothing |
| `member detach <alias>` | the member leaves the family and becomes standalone; references to it from the family become externals (`source.path`) and are pinned |
| `member adopt <path>` | the inverse of detach: an external found by path becomes a member |
| `member internalize <alias> --into <subsystem…>` | a member's subsystems fold back into the parent; the member's own metadata (its L0 vision, config, externals, packs) goes to an explicit destination instead of being deleted |
| `member move` | exists (stage 3) |

## 2. The discipline

- **Plan first.** Every verb computes a plan: per owner project, the exact file changes, the
  references rewritten (parsed positions, never whole-string matching), the locks that go stale.
  `--report` prints it and writes nothing; MCP tools take `dryRun`.
- **Refuse when incomplete.** A project the plan must write that is absent or out of reach refuses
  the whole plan, naming it. No partial success is ever claimed.
- **Staged, all-or-nothing.** Apply stages every change in a transaction directory, backs up every
  file it replaces, then swaps them in. Any failure restores every backup and reports what failed.
  A crash mid-swap leaves a journal; `doctor --fix` rolls it back on the next run.
- **Never locks.** Every verb lists the projects to re-lock. A rename changes what was approved, so
  it always does.
- **Idempotent.** Re-running a completed migration plans nothing.

## 3. Properties

`atomic-or-nothing` (inject a failure at every write position: the family is byte-identical to
before), `family-consistent` (after any verb the family run is as clean as before, minus the findings
the verb exists to fix), `move-is-free` (a move changes no reference), `detach-then-adopt-is-identity`,
`externalize-updates-siblings`, `rename-reaches-every-reference`, `crash-journal-rolls-back`.

## 4. Not in stage 6

Hosted members as records (stage 7); side-by-side members via a workspace descriptor (stage 8).

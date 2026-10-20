_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 10 — Migrations: create, externalize, internalize, move, rename

**Diagnosis.** Each migration rewrites at most the parent's own `.wai/specs`
(`rewriteRefsInDir`, `provision.ts:409, 468`) because references in other members were
never modelled as something the family owns; there is no rename because a mount id is
encoded positionally in every sibling's `super::` path (issue 02); internalize is
flat-only because of the merge (issue 01). With project-id references, most of this
dissolves: a *move* touches no reference, a *rename* is a rename of a project id, and
every rewrite is a substitution of `<id>::` prefixes that can be computed for the whole
family before any file is touched.

**Options.**

| | | |
|---|---|---|
| a | Keep per-parent rewrites; document that other members must be fixed by hand | Leaves dangling references by design. |
| b | Family-wide, dry-run-first migrations that refuse when a member that would need a rewrite is absent (`--report` lists it instead) | Atomic in the only sense that matters: nothing is written unless everything can be. **Recommended.** |
| c | Record a rename log the absent member replays on its next `doctor` | Two-phase and stateful; the log is a new artifact to get wrong. Possible later on top of (b). |

**Recommendation: b.** The table, with what each touches. "Family" means every project
on disk that declares the subject as a member or an external, found by walking mounts from
the top and reading each project's `externals`.

| Migration | Parent tree | Subject | Other family projects | Refuses when |
|---|---|---|---|---|
| `create <id> --path` | writes the mount | `project.yaml` (`name: <id>`, `governance: inherit`) + L0 | — | id collides with a project id in the family |
| `externalize <sub> --path` | subsystem specs move to the child; mount written | child provisioned; implementation paths rebased | `x` → `<sub>::x` for every component of the subsystem, in every project that referenced them (before: only the parent) | a referencing member is absent |
| `internalize <id>` | member's subsystems fold in (all of them; collision check) | child `.wai` removed | `<id>::x` → `x` everywhere | collision, or a referencing project absent |
| `detach <id> [--path ../…]` | mount deleted; `externals.<id>` added and pinned | untouched | untouched (`<id>::x` still resolves — now as an external) | the member consumed something the family exposes only at L1 (list it: those edges become `SURFACE_REF_NOT_EXPOSED`) |
| `adopt <id> --path` | mount written; `externals.<id>` removed | untouched | untouched | the directory is outside the parent; the id collides |
| `move <id> --to` | `projectPath` updated; directory renamed | untouched | untouched — references name the project, not the path | target exists |
| `rename <old> <new>` | mount renamed | `project.yaml name` | `<old>::x` → `<new>::x` in every project on disk; `externals.<old>` → `<new>`; lock `members`/`externals` keys | a referencing project is absent |

- Every migration computes its full change set first (a dry run that prints per-project
  file counts), then writes; `--report` writes the change set as YAML and stops. This is
  the one place the family writes into members, and it is explicit, listed, and refused
  when incomplete (R4's sanctioned exception).
- Nested subjects: every migration accepts a project id, so a member of a member is
  migrated from the top just as from its own parent; nothing is "namespaced" any more
  (`provision.ts:347, 420` guards go).
- Approval after a migration: the subject's own lock keeps its digests where files did not
  change (a move) and drifts where they did (a rename rewrites files → re-approve, which is
  right: the design's *names* changed); the parent's `members` pin follows the new key.
- MCP: `sdd_externalize_subsystem` / `sdd_internalize_subsystem` /
  `sdd_move_subsystem_project` keep their names and gain `dryRun`; new
  `sdd_rename_project`, `sdd_detach_member`, `sdd_adopt_external`. All four "kind"
  changes from issue 00 are now named verbs.

**Migration of the migrations.** None; existing trees migrate with the same verbs.

**Proof.**

- `atomic-or-nothing`: a rename with one referencing member removed from disk changes no
  file anywhere and lists that member.
- `family-consistent`: after each migration on the Platform family fixture, every project
  validates with the same edge verdicts as before, and `grep` for the old prefix over
  every `.wai` finds nothing.
- `move-is-free`: `move` changes exactly two things: the mount's `projectPath` and the
  directory name; every member's `lock.json` digest set is unchanged.
- `detach-then-adopt-is-identity`: detach followed by adopt reproduces the original mount
  and leaves the child byte-identical.
- `externalize-updates-siblings`: a sibling that referenced `core_portal` before
  `externalize core` references `core::core_portal` after and validates.

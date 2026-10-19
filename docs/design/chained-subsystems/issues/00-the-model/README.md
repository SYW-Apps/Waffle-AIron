# 00 — The model: what a chained subsystem is

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 00

## Summary

One mechanism mixes a federated relationship (the parent loads and judges the child's
specs as its own) with an independent one (the child keeps its own configuration,
approval, topology and pins, and can stand alone). Nothing declares which one a mount
means, so each capability picks its own. The levels also misalign: a child's L0 plays
the role of the parent's L1.

## Evidence in this repository (`dev`, 2026-09-12)

- Federated loading: `src/core/specs.ts` — recursive scan and namespacing
  (`scanSpecsForProject`, ~690–970); the child's L0 is skipped (~707, 713).
- Independent governance: validation applies the bound root's configuration to the
  whole family (`src/commands/validate.ts` ~51, 117–122); approval digests exclude
  mounted children (`src/core/approval.ts` ~88–100).
- The parent's topology collapses each child into one owner agent
  (`src/core/agent_resolver.ts` ~285–305).
- The parent never checks a child's code (`src/core/rules/conformance.ts` ~28–48;
  `docs/design/code-spec-conformance.md` ~78–80).
- Hosted: a child is never its own project (`src/server/admin.ts` ~363–389 — enabling git
  requires a new root).
- Design history: `.wai/phased_design.md` — chaining kept as a full feature, hosted and
  local (~49); Track E, the subproject external model (~151–160); Track D2, project type
  for subprojects (~172–181); confinement close-out (~187–197).
- Not taught to users: `README.md` and `docs/*.md` never mention chaining; the agent guide
  (`src/utils/ai-guide.ts`) teaches `::` and `super::` only.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — two declared relationships, *contains* (member) and *consumes* (external, pinned), no kind flag; governance, approval and hosting are project properties and the family view is composed from members' own runs
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — delete "chained subsystem" as a concept: a project (stable `project.id`) is the unit of identity, governance, approval and security; `members` (full-spec composition, with a `source`) and `dependencies` (surface-only) are relations declared in `project.yaml`; a mere directory split should stay one project
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — a membership relation outside L0–L5 (`members` with a `source` in `project.yaml`) plus consumption via `imports`; neither grants authority; a child's L0 stays an L0; teams that need one approval authority should keep their subsystems in one project
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — first-class projects with **membership** and **contract imports**, no intrinsic kinds; corrects r2 against `dev` e7d30d7 (lenient-parent softening fixed, flat grandchild fixed, the generate cascade is transitive, the gate hash already covers descendant content, confinement is narrower than claimed, a tree archive is conditional) and adds eight probes P1–P8 showing that pins, gate identity, containment, scoped diagnostics, provider matching, fallback, externalize and surface facts do not compose

## Proposals

- [Projects and two relations](proposals/projects-and-two-relations.md) — the model recommended by `synthesis.md` (revision 2): a project is the unit of identity, judgement, approval and hosting; a parent *contains* members (mounted by path, internals readable) or *consumes* externals (pinned contracts); references name projects; the owner gate reads nothing above the project, and a family run composes member runs and adds composition findings. Draws on all four analyses.

## Decision

- 2026-09-12 — Stage 1 fixed the current model without changing it (#69). For stage 2 the consumption rule was decided: a project is a crate, so another project — parent, member or sibling — reaches only its L0 exports (decision 9, reframed by the maintainer). The rest of the model is decided stage by stage; see [decisions.md](../../decisions.md).

# 05 — Contracts across the boundary: pins and freshness

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 05

## Summary

Pins are pulled by hand, keyed to a hash of the whole family so any edit anywhere makes
them stale, reported but never enforced, and never checked for use. Hosted cross-project
visibility is a separate mechanism unaware of chaining.

## Evidence in this repository (`dev`, 2026-09-12)

- Family surface: `projectOwnSurface` / `projectChildSurface`, `src/core/surfaces.ts`
  ~118–178. Sibling surface: `projectSubsystemSurface` ~212–291, limited to
  Portal/Gateway/Observer (~194); key `<system>::<subsystem>`, stored with `::` as `--`.
- Pin: `pinFamilySurfaces` ~550–573; its only caller is `wairon surface pin`
  (`src/commands/surface.ts` ~131–145).
- Freshness: `listExternalInterfaces` ~614–651 compares the pinned state id with the
  parent's current one, computed over the whole recursively loaded tree
  (`src/core/statehash.ts` ~57–72); `tests/core/surfaces.test.ts` ~810–824.
- Probe: after changing a sibling's interface, `surface externals` from the child reports
  both pins stale, and validating the child still returns valid with no issues.
- `removeSnapshot` (~365–389) is never called automatically; nothing maps references to
  the pins they use.
- Hosted visibility and relation health are separate: `src/server/landscape.ts`,
  `visibility.ts`, `surfaces.ts`, `operations.ts` (relation health ~231–264), keyed by
  relations declared between hosted projects, with no reference to `projectPath`.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — externals as a per-project lockfile with per-producer content digests and a `used` map; family and sibling surfaces retired as kinds; one mechanism shared with hosted relations
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — a per-imported-interface lock (`deps.lock.yaml`, one digest per interface) checked by semantic compatibility (an added method is fine, a removed one fails); `deps status/update`; the family surface becomes unnecessary
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — `inputs.lock.yaml` per imported contract with a semantic digest and an immutable artifact; a compatibility table (additions pass, removals and narrowing fail, unknown is never safe); `deps add/update/check --context`; Platform's own contracts replace the family surface
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — immutable contract inputs keyed by provider and export identity with a semantics digest; surfaces must carry the facts the live boundary rules need (P8: a pinned Observer passes where the live check fails); P1: re-pinning does not repair freshness; P2: the gate hash omits consumed surfaces

## Proposals

- none yet

## Decision

- 2026-09-12 — Stage 1 (#69): pins match by provider (an ambiguous match is `SURFACE_REF_AMBIGUOUS`), freshness is judged on content, and the gate identity covers the consumed snapshots. Stage 2: another project may consume only L0 exports, named by export id, and the sibling surface is retired (9); compatibility is a signature-level superset, and what cannot be compared is `EXTERNAL_CHECK_UNAVAILABLE` (19). See [decisions.md](../../decisions.md).

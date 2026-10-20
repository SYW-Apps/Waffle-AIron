# 02 — Identity and references across roots

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 02

## Summary

Ids depend on the loading root, `::` changes meaning with it, and saving through the
parent rewrites authored `::` references into `super::` paths. The root-name shortcut
turns a name collision into a silent duplicate. Sibling references encode the parent's
mount ids, and pins match references on their last segment only.

## Evidence in this repository (`dev`, 2026-09-12)

- `qualifyId` (load): `src/core/specs.ts` ~85–106. `relativizeId` (save), including the
  rationale for root-invariant `super::` paths: ~131–169.
- Rewrite by probe: in `kid`, `dependsOn: ['super::root-portal', '::sib::sib-thing',
  'super::sib::sib-thing']`, loaded and saved unchanged through the top root, becomes
  `[super::root-portal, super::sib::sib-thing, super::sib::sib-thing]`. The file is no
  longer identical, and the duplicate is not removed. The dry-run round-trip check only
  verifies that the schema still parses (`specs.ts` ~1400–1440).
- Shadowing: a child subsystem sharing a top-level subsystem's name loads as a duplicate
  top-level subsystem; `NAMESPACE_SHADOWING` cannot fire from real files
  (`tests/rules-matrix/families/references-namespace.fixtures.ts` ~99–153;
  `tests/rules-matrix/ratchet.json` still lists it as uncovered).
- **Lost fix:** commit `116d5f7` ("NAMESPACE_SHADOWING reachable from disk", adds
  `qualifyDeclaredId`) merged through PR #61 into `feat/rule-matrix-tests` 19 seconds
  after PR #60 had merged that branch into `dev`. It is not an ancestor of `dev`.
- Pins match on the last segment: `resolveSurfaceRef`, `src/core/rules/namespace.ts`
  ~32–55. By probe, `super::b-portal` written in a child resolves against the pinned
  sibling surface from the child, but from the parent it is treated as a collapsed
  cross-tree reference and judged only against the child's pins.
- Pin matching returns the first snapshot whose entry `component` or `id` equals the last
  segment (`namespace.ts` ~48–52), so two siblings publishing the same local name are
  indistinguishable.
- Extra `super::` hops are clamped silently: `qualifyId` pops an empty prefix
  (`specs.ts` ~92–99).
- `findChainingParent` returns the immediate parent; callers wanting the top root must
  walk repeatedly (`specs.ts` ~248–287).
- No migration rewrites references in other chained children (`src/core/provision.ts`
  ~409, 468).

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — project-id-anchored two-segment references (`billing::invoice_portal` from every root); `super::`, `::` and the root-subsystem anchor retired; rename becomes a family migration
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — consumer-local aliases (`dependencies.billing → acme.billing`) and `@billing::invoice_portal` references resolved in the lexical project; `::`/`super::` invalid in schema v2; suffix matching forbidden; migration stops on ambiguity
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — immutable namespace-qualified project ids (`syw.billing`) with owner-local `imports` aliases and `dep:billing/invoice_portal#create_invoice` references; authored spelling preserved on save, canonicalization an explicit formatter; migration rewrites every affected owner
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — a committed `projectId` with spec keys `(projectId, specKind, localId)`; consumer `imports` aliases and `@billing::invoices` naming an L0 export id, never a search for a component name; P5: provider identity is discarded even when the reference spells it

## Proposals

- none yet

## Decision

- 2026-09-12 — A project declares a required, immutable slug `id` (dots allowed); `name` stays the display name (decision 6). A cross-project reference is `alias::x`; the alias is optional and defaults to the producer's `id` (7, 8). A reference into another project names an **export id**, which defaults to the backing component id (9). See [decisions.md](../../decisions.md).

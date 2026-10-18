# 04 — One edge, one verdict: composing judgements across roots

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 04

## Summary

Boundary edges are now judged the same from both roots when the parent is reachable.
Pins still outrank the live tree, approval context and configuration differ by root,
code is checked only from the child, and resolving through the parent covers unresolved
references only.

## Evidence in this repository (`dev`, 2026-09-12)

- The fallback triggers on any finding in `SUBPROJECT_REFERENCE_CODES`
  (`src/core/validation.ts` ~61–70) that no pin covers (~459–460); a pin match counts as
  covered before that check (`src/core/rules/namespace.ts` ~18–55). The set includes
  `CROSS_SUBSYSTEM_NON_ADAPTER` and `INVALID_SUBSYSTEM_REFERENCE`, which fire on edges
  inside the child. Every such child finding is dropped from the kept set (~478) and
  replaced by the parent run's findings under the top root's configuration (~533–544).
- Probe, softening (Fable 5.1, `responses/fable-5.1.md` § Corrections): a child with two
  internal subsystems and an Orchestrator depending on the other subsystem's Portal, no
  cross-tree reference. Alone (`crossTree: 'off'`): error, invalid. Parent on disk
  configured to warn: warning, valid, `resolvedThrough` set. Parent configured off: no
  finding, valid.
- Probe, stale pin: the child's only cross-tree edge resolves against a pin taken before
  the parent stopped publishing the portal. The child is valid and never resolves through
  the parent; the parent reports `CROSS_SUBSYSTEM_PRIVATE_ACCESS` (error) on the same
  edge.
- Probe, parent judged by a child's pin: after renaming a method in the sibling without
  re-pinning, validating the whole parent reports only `MISSING_ENDPOINT` on the renamed
  method and `UNUSED_COMPONENT` on the adapter — nothing about a call to a method that no
  longer exists.
- Probe, approval context: a child implementation missing a contract method, approved in
  the child. From the child: error. From the parent: warning with draft context, because
  the parent's settled set excludes children (`src/core/approval.ts` ~88–100, 194–197;
  `validation.ts` ~604–637).
- Probe, siblings: same-child and sibling boundary edges produce the same three findings
  from both roots, the child's with `resolvedThrough`.
- Code conformance skips chained implementations from the parent in every family:
  `src/core/rules/conformance.ts` ~39–48 and its uses in `dependency-conformance.ts` ~89,
  `call-conformance.ts` ~67, `integration-conformance.ts` ~115, `hidden-state.ts` ~45,
  `narrative-detail.ts` ~134. The code model still resolves chained source paths against
  the bound root (`src/core/source-analysis.ts` ~621, 649–650), which is harmless only
  because every consumer filters first.
- Import edges crossing a mount are judged nowhere: the dependency map is built from
  non-chained components only (`dependency-conformance.ts` ~89).

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — the consumer's project is the single judge of its edges and the family run composes member runs; live-else-pin with an explicit `EXTERNAL_PIN_STALE`; `resolveThroughParent` retired (probe shows it softens child-internal errors today)
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — the consumer's lock defines its edge verdict; the family run adds a separate `WAI_COMPOSITION_INCOMPATIBLE` when the live provider no longer satisfies the locked contract; `--against-workspace` as an explicitly non-reproducible diagnostic
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — two explicit assessments, `V(P)` (the owner, against locked inputs) and `Family(F)` (owner runs AND import↔provider compatibility AND composition policy) over an explicit context artifact; no ancestor fallback; missing inputs read as incomplete; code conformance belongs to the source file's owner
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — a project assessment and a composition assessment, with structured resolver results (`resolved | missing | ambiguous | unavailable | forbidden`) before any severity; P6: an unrelated resolution failure changes which evidence judges a pinned edge; P4: a nested mount's loader diagnostic disappears under a qualified scope; `PROVIDER_INPUT_MISMATCH`

## Proposals

- none yet

## Decision

- 2026-09-12 — The legacy resolve-through-parent fallback stays, with the stage-1 fixes, until composed validation lands in stage 4 (decision 4). See [decisions.md](../../decisions.md).

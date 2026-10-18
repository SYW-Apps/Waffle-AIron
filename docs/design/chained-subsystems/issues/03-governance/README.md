# 03 — Governance: whose rules judge a child's specs

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 03

## Summary

Whichever root runs validation supplies the configuration for the whole family; a
child's own configuration is ignored from its parent, and an intermediate parent's is
ignored when a grandchild resolves through the top.

## Evidence in this repository (`dev`, 2026-09-12)

- The bound root's configuration governs the whole federated tree:
  `src/commands/validate.ts` ~51, 117–122.
- Resolving through the parent loads the top root's configuration:
  `src/core/validation.ts` ~533–537. The grandchild test resolves through the top root
  and skips the intermediate project (`tests/core/resolve-through-parent.test.ts`
  ~412–457).
- Probe: the parent sets `ARCHITECTURE_VIOLATION_REGISTRY_DEP` to `error`; the child sets
  it to `off`. An edge inside the child (a Registry depending on an Orchestrator):
  the parent reports an error on `kid::k-registry`; the child reports nothing and is
  valid. No cross-tree reference is involved.
- Project type for subprojects (inherit unless declared) is approved but incomplete:
  `.wai/phased_design.md` ~172–181.
- Packs are scoped per project: `docs/design/pack-scoping.md`.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — effective configuration per project; `governance: inherit` makes the parent's config a floor a member may only tighten, divergence is a finding, and the floor rides in the externals lock for detached clones
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — each project is judged only under its own configuration; a parent states required doctrine as attested `requirements.policyPacks` on the member relation and verifies the attestation rather than re-running the child
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — owner policy plus explicit composition requirements: pinned policy profiles (`syw.service@sha256:P1`) that a parent `requirePolicies` over `descendants`; stricter-floor merge for identical rules, a conflict for incompatible predicates; no ambient project-type inheritance
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — each project judges under its own resolved policy; the parent admits or refuses the result against explicit, pinned policy packages; no ambient project-type inheritance; a severity maximum cannot reconcile different predicates

## Proposals

- none yet

## Decision

- open

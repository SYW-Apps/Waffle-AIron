# 06 — Working from the child's own root: status, topology, briefs

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 06

## Summary

Only validation looks through a mount. The parent's topology shows each child as one
owner agent; the child's status and topology can be empty for work the parent scores;
and an unscoped parent lock regenerates children's agent files.

## Evidence in this repository (`dev`, 2026-09-12)

- Topology keeps local ids only and represents each mount as one `<id>-owner` agent that
  owns only the mount's spec file: `resolveAgentTopology`, `src/core/agent_resolver.ts`
  ~231–305.
- Briefs resolve against the bound root's topology only: `agent_resolver.ts` ~478–530;
  `sdd_get_agent_brief` in `src/mcp/server.ts` ~1637–1650.
- Probe with the built CLI (parent plus `packages/kid`, a Store added in the child with
  `subsystem: kid`): the parent's `status` shows the subsystem at 50% and the component;
  the child's shows 0% and no subsystem. The parent's `list` shows `kid-owner`; the
  child's shows no agent for the Store. Validation from the child resolves through the
  parent and reports the same findings as the parent.
- A lock at the parent calls `runGenerate` (`src/cli/index.ts` ~191–198), which, unscoped,
  regenerates every direct child (`src/commands/generate.ts` ~95–115). A lock scoped with
  `--subsystem` skips it (~102–103; `cli/index.ts` ~226). The probe printed "Chained
  subproject 'kid' — generating its layer…".
- The cascade first calls `ensureProjectInitialized` in the child
  (`src/commands/generate.ts` ~105–113; `src/core/provision.ts` ~91–121), writing
  `project.yaml` and an L0 when missing; with `materializeAgentFiles` off it then writes
  skills, context and guides and prunes stale managed files.
- `CHANGELOG.md` (resolve-through-parent entry) says "a parent lock writes nothing into
  its children"; that holds for surfaces only.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — a member node by reference in the parent's topology, briefs composed at the member's root on request, and no parent cascade (init/generate) into children
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — federate read models, keep writes local: the parent resolves `@shipping` and invokes Shipping's own brief builder under a Shipping-bound context; a parent lock writes zero bytes below its members
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — one canonical graph behind status, topology, briefs and validation; `brief --project`, `generate --project`; `lock` writes approval only; parent-mediated edits call the same owner-scoped service with an `expectedDigest`
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — owner-aware status and briefing composed at the member's root; the generate cascade reaches every descendant (correction 3) and moves out of `lock`; `generate` never repairs configuration

## Proposals

- none yet

## Decision

- open

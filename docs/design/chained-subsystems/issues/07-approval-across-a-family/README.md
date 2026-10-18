# 07 — Approval across a family

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 07

## Summary

Approval is strictly per root. A parent pins direct children's approved states but never
approves or requires them, and cannot see them when judging the family.

## Evidence in this repository (`dev`, 2026-09-12)

- The parent's digests exclude mounted children: `currentSpecDigests`,
  `src/core/approval.ts` ~88–100.
- Direct mounts are pinned one hop at a time — only ids without `::` (~217) — so a top
  root records nothing about a grandchild: `currentChildPins` ~211, `movedChildren` ~230.
- A lock never locks a child (`src/cli/index.ts` ~140). `LockOptions.recursive`
  (`src/commands/lock.ts` ~39) is accepted and never read by the lock itself.
- Probe: locking a parent whose child had never been locked wrote
  `"children": {}` and no `lock.json` in the child.
- Hosted: a narrowed credential locks the bound child through the MCP lock tool
  (`src/server/admin.ts` ~250–346); the web lock path takes no subproject
  (`admin.ts` ~208–214).
- Design record: `docs/design/approval-baseline.md` ~85–101 (pinned, not pushed).

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — per-project approval with chained member pins, externals digests recorded in the approval, and a `requireApprovedMembers` policy; never transitive
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — a project approval (specs, config, packs, dependency digests) plus a Merkle-like transitive composition approval (`lock --family`) that binds member approvals recursively without writing them
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — `ownSubject(P)` and `compositionSubject(P)` hashes on one record; `lock --family --context F` requires recursively approved, matching members and a passing integration; approval preflight at settled strictness
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — per-file owner approvals plus a versioned composition record with transitive provenance; the gate hash already digests descendant content (correction 4) but not consumed contracts (P2); say whether a lock certifies design or code

## Proposals

- none yet

## Decision

- 2026-09-12 — The gate identity includes the consumed contract inputs (`sha256+doctrine+inputs`), accepting one forced re-lock (decision 1; merged in #69). Approval transitivity (15) is still open. See [decisions.md](../../decisions.md).

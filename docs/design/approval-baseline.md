# Approval baselines — what `lock` approves, and why it stopped writing

> Status: **implemented**. Written against wairon 5.1.x. The "problem" section
> describes the behaviour as it was BEFORE this work, not as it is now.

---

## The problem

`wairon lock` had grown two jobs fused into one. The first is the one it was
designed for: **a human reviews the design and approves it**. The second was
bookkeeping — and the bookkeeping is what people actually experienced.

Three symptoms, all the same cause:

**It flooded the working tree.** Approving ratcheted every spec's `status` from
`draft` to `complete` on disk. On this project's own tree that is **786 files**
rewritten for a decision that changed no design. A lock scoped to one subsystem
still rewrote everything it could reach, and the specs a human had actually
edited were buried under files whose content had not changed.

**It reported a verdict nobody could act on.** `wairon status` printed:

```
Lock: STALE — the specs or the governing doctrine changed since 2026-08-12,
so this lock no longer holds. Re-run `wairon lock`.
```

…on a tree validating **0 errors / 0 warnings**. The banner named nothing to
look at, offered no way to approve part of the change, and asked for work that
produced no new information. It could only ever say "something moved", because
a `StateId` is a hash: it answers *did anything change*, never *what*.

**It fought the maintainer's own workflow.** `.wai/phased_design.md` records the
blanket draft→complete freeze being reverted by hand **four times** (lines 18,
27, 34, 41), once annotated *"product gap: lock needs phase awareness"*.

And a second gate had grown on top of the first — see
[the removed `promote` step](hosted-mcp-server.md#4-state-scoped-lock).

---

## The model

One addition retires five concepts: **store the approved tree, not a hash of it.**

A review needs two things — the current tree and the tree as it stood when
someone approved it. wairon had the first and only a fingerprint of the second.
With the tree itself stored, the question changes from *"did anything move?"*
to *"what moved?"*, which is the only form a human can review.

`src/core/baseline.ts` holds it. Three properties are load-bearing.

### It lives outside the working tree

`WAIRON_BASELINE_DIR`, else `~/.wairon/baselines`, keyed by a hash of the
project root's path. Nothing is ever written under the project root, so
approving adds nothing to `git status`. A test asserts the spec tree is
byte-identical after `lock`.

Deriving the key from the path means resolving a baseline needs nothing but the
root you are already standing in — no registry, no id to keep in sync, and no
file inside the project to lose.

### It is per project root, and children are pinned

Every `.wai` owns its own baseline, including each chained subproject. A
parent's approval never freezes a child's in-flight work, and a child cloned on
its own still has somewhere to keep its approval.

What crosses between them is a **pin**: a parent approval records each mounted
child's approved `StateId`, the way a git submodule pins a commit. So a child
editing its own specs does not appear in the parent's diff — the decisions are
separate — but the parent still sees the child *move*:

```
1 chained child project(s) moved since approval: billing.
```

A child with no approval of its own contributes no pin. A parent can only
record a decision the child's owner actually made.

### Settledness is derived, not stored

This is what replaced the on-disk `status` ratchet, and it needed care, because
the ratchet was doing real work. The MCP authoring tools **always** write
`status: 'draft'` (`src/mcp/server.ts:825, 1027, 1125, 1331`); draft specs get
`COMPLETENESS_RULES` findings downgraded from error to warning; and `lock` was
the only thing that ever promoted. Delete it naively and the gate goes
**permanently soft** — which is exactly how an `UNEXPECTED_IMPLEMENTATION_METHOD`
came to surface days late in real use.

The baseline already knows which specs were approved and which have moved, so a
spec that is *approved and unchanged* is presented to the rules as `complete` —
in memory, restored in `finally`, the same mechanism `treatAllAsComplete`
already used (`src/core/validation.ts`). Nothing is written.

Two things get strictly better than the ratchet:

- **It is bidirectional.** The on-disk version was one-way by design
  (`allowStatusDemotion` exists to stop a re-add reopening a locked spec), so an
  edited spec stayed marked complete and in-flux work kept being judged at full
  strictness with no way back short of a manual demotion. A spec that drifts
  after approval now returns to draft context by itself.
- **It cannot drift.** Derived state has no second copy to fall out of sync.

---

## What `lock` does now

1. Validate as complete (full strictness, no draft relaxation, mutates nothing).
2. Report what moved since the last approval, and which children moved.
3. Ask.
4. Record the approved tree as the baseline — outside the working copy.
5. Regenerate the derived topology.

A scoped approval (`--subsystem x`) approves **only what it covers**; everything
outside keeps the approval it already had. Whole-tree capture under a scoped
flag would silently mark the rest of the tree reviewed, which is a worse bug
than the one being removed.

---

## Reversals worth recording

**`--subsystem` nearly became a silent whole-tree approval.** Removing the
ratchet left nothing scoping the capture. Two existing lock tests failed and
named it. Scoped capture was added rather than discovered later.

**The first e2e assertion was written before it could pass.** *"Approving writes
nothing into the project"* is the property the design exists for, so it was
asserted first; it failed on the status ratchet, was narrowed to what was true
that day with a comment saying where it stopped, and tightened to byte-identity
once the ratchet was gone. A test that encodes a temporary truth is worse than
one that admits its scope.

---

## Deliberately out of scope

**Trimming `lock.json` itself.** `lockedBy`, `validatorVersion`,
`validationResult` and `commitSha` are now largely vestigial, but
`readLockState` is still consulted by the hosted policy plane and by `doctor`.
Reducing the record to a baseline reference is a separate change with hosted
consequences.

**Separation of duties.** `promote` was the hook for "two people must sign off".
It never worked, and it was removed rather than kept as a placeholder. If it
returns, it belongs on the baseline — where *"approved by X at baseline B"* is a
reviewable fact — not as a status string nothing reads.

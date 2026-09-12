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

One addition retires five concepts: **record what was approved per spec, not one
hash of the whole tree.**

A review needs two things — the current tree and the tree as it stood when
someone approved it. wairon had the first and only a whole-tree fingerprint of
the second. With **one content digest per spec file**, the question changes from
*"did anything move?"* to *"what moved?"*, which is the only form a human can
review.

`src/core/approval.ts` derives it; `.wai/lock.json` carries it. Three properties
are load-bearing.

### It is committed, and it is one file

The approval rides in the lock record, which was always committed. That is what
lets a **teammate, a fresh clone and CI** see the same approval the approver saw
— an earlier revision of this design kept it in `~/.wairon/baselines/`, where
nobody else could read it, so every other checkout judged an approved tree as
unapproved.

Digests rather than content is what makes that affordable: for this project's
786 specs, **~90 KB instead of ~2 MB**. And no consumer ever needed the content
— `diffAgainstApproval` and `settledSpecPaths` only ever ask whether a spec
still matches. For the content itself there is already git: the record is
committed, so `git diff <lock commit> -- .wai/specs` is the real diff, and
better.

Keys are written **sorted**, so re-approving a one-spec change produces a
**two-line diff** — the timestamp and that spec's digest — in a 96 KB file.
Measured on this repo. That is a good signal in a PR rather than noise, and it
is categorically different from the ratchet this replaced, which rewrote
hundreds of *spec* files for a decision that changed no design. A test asserts
the spec tree is byte-identical after `lock`.

Digests **normalize line endings** before hashing. This is not tidiness: git
rewrites line endings on checkout (`core.autocrlf`), so an approval taken on
Windows would otherwise report every spec as drifted on a Linux CI runner. The
defect was unreachable while the record was machine-local — sharing it is what
made it live.

### It is per project root, and children are pinned

Every `.wai` owns its own lock record, including each chained subproject. A
parent's approval never freezes a child's in-flight work, and a child cloned on
its own carries its approval with it.

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

The record already knows which specs were approved and which have moved, so a
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
4. Record the approval — a digest per spec — on `.wai/lock.json`, together with
   who approved and how that identity was established.
5. Regenerate the derived topology.

A scoped approval (`--subsystem x`) approves **only what it covers**; everything
outside keeps the approval it already had. Whole-tree capture under a scoped
flag would silently mark the rest of the tree reviewed, which is a worse bug
than the one being removed.

---

## Who approved

`lockedBy` is `{ id, name?, source }`, and the `source` is the point. A `hosted`
identity was **authenticated** by the instance that issued the caller's
credential. `git` and `os` are self-declared, read from the machine's own
config. Recording which keeps the record honest instead of leaving a bare name
to imply more than it can.

Locally the preference is the **git author identity**, because it is the one
identity the repository already attributes work to — a reviewer can match it
against the author of the commit that carries the lock, and that matching is the
whole value. The fallback is `user@hostname`, which is what Terraform records as
a lock's holder and what git itself synthesizes when no identity is configured; a
bare OS username is strictly worse, because in CI it is `runner` and identifies
nobody. Deliberately not a MAC address or other hardware id: modern systems
randomize MACs, they differ per interface and VPN, and collecting one is device
fingerprinting for a field that is not authentication anyway.

Hosted is the one surface where wairon genuinely authenticated the approver, and
it was **throwing that away** — `executeApprovedLock` wrote the constant
`admin:master` while its caller held a resolved principal. It now records the
subject. On the approval path the **decider** is recorded, not the requester:
the requester did not have the authority, and the decision is what conferred it.
The requester is not lost — the `ApprovalRequest` and the audit event carry them.

None of this is proof. The trust anchor is the commit that introduces
`lock.json` — signed commits, a protected branch, a reviewed PR. `lockedBy` is a
convenience copy that earns its place only where git does not follow: a
`.waitree` archive, a `remote push` into a hosted instance, a tarball.

---

## Reversals worth recording

**Keeping the approval outside the repo was wrong, and only sharing it showed
why.** The first revision put it in `~/.wairon/baselines/` on the reasoning that
"approving must not dirty the repo". That reasoning conflated two very different
writes: rewriting 786 *spec* files, and one lockfile changing the way lockfiles
do. The cost was that no teammate, clone or CI run could see the approval at
all. Moving it into the committed record — as digests, so it fits — keeps the
property that mattered and drops the one that did not.

**Two defects were only reachable once the record was shared.** Hashing raw
bytes meant a Windows approval reported all 786 specs as drifted on a Linux
checkout; digests now normalize line endings, and a test rewrites the whole
fixture tree to CRLF to hold that. And the hosted lock **published before
writing the record**, so the commit shipping the specs did not contain the
approval certifying them — harmless when the record was four bookkeeping fields,
not when it *is* the approval. Neither was observable while the approval sat on
one machine.

**The signature change was caught by a test, not by the compiler.** Adding an
`approver` parameter to `executeApprovedLock` silently re-bound an existing
three-argument call to the new slot. `tsconfig.json` excludes `tests/`, so
nothing typechecks the suite — vitest transpiles without checking. The test
failed loudly and the fix was obvious, but the compiler should have said so
first.

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

**A local wairon account.** The CLI has no identity of its own: `remote attach`
stores a bearer token, but resolving it to a person would need a `whoami`
endpoint and a network call, and `lock` is deliberately an offline command. The
git identity is the honest local answer until that changes.

**Storing the approved content.** Digests cannot show what changed *inside* a
spec. Git already can, against the lock's own commit, so keeping a second copy
of the tree to duplicate it is not worth its weight.

**Separation of duties.** `promote` was the hook for "two people must sign off".
It never worked, and it was removed rather than kept as a placeholder. If it
returns, it belongs on the approval — where *"approved by X at StateId S"* is a
reviewable, committed fact — not as a status string nothing reads.

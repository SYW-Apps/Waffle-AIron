_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 07 — Approval across a family

**Diagnosis.** The per-root approval with child pins (`approval.ts:88-100, 211-222`) is
the right shape — it is a submodule pin — and the defects are around it: the parent cannot
*see* a child's approval when judging (issue 04's single context), pins are one hop deep
(correction 7), nothing lets a parent *require* approved members, and the parent's own
approval says nothing about the external contracts the family was approved against.

**Options.**

| | | |
|---|---|---|
| Transitive lock | a parent lock locks every member | Breaks R4 and R2: a platform lead freezes a service team's in-flight work, and a child cloned alone carries an approval it did not make. |
| Rolled-up | a parent's record digests every member's specs | Every child edit dirties the parent; the parent's diff stops being a review signal (the reason `currentSpecDigests` excludes mounts). |
| Per root + pins + policy | keep the pin model; make the parent see it, chain it, and let the parent require it | Keeps every commitment; two small additions. **Recommended.** |

**Recommendation.**

```yaml
# platform/.wai/project.yaml
lock:
  requireApprovedMembers: true      # default false: pin what is approved, report the rest
```

```json
// platform/.wai/lock.json — the parent's approval
{ "specs": { ".wai/specs/core/…": "sha256…" },
  "members": { "billing": "sha256+doctrine:…", "shipping": "sha256+doctrine:…" },
  "externals": { "crm": "sha256:…" } }
// services/shipping/.wai/lock.json — a member's approval
{ "specs": { … }, "externals": { "billing": "sha256:9c1…", "platform": "sha256:e02…" } }
```

- **What each approval promises.** A project's lock: "these specs, judged under this
  doctrine (`sha256+doctrine`), against these external contracts, passed the gate and a
  human said yes." A parent's lock additionally: "at the time, each direct member's
  approval was at this state." Payments is reached through Billing's pin of it — the chain
  of pins is the transitive statement, exactly as nested submodules work, and it is
  inspectable: `wairon status --family` prints the pin tree with `approved | moved |
  never` per node.
- **Requiring approval.** With `requireApprovedMembers`, `wairon lock` at the parent
  refuses when any direct member is unapproved or has moved from its own approval
  (`MEMBER_UNAPPROVED @billing`, `MEMBER_DRIFTED @shipping`); without it, the lock pins
  what exists and prints the same two facts as information. Never does it lock a member.
- **Seeing it while judging.** Falls out of issue 04: the member's run reads the member's
  `lock.json`, so a settled member spec is judged at full strictness from every root; the
  parent's family run adds `MEMBER_UNAPPROVED` (notice) for members without any approval,
  so "the platform validates" no longer treats its parts as drafts by accident.
- **Who may approve.** The project's own permission (`project:write` on that project —
  hosted, that is the member project's record, issue 09). A platform lead approves a member
  by locking *that* project, never through the parent's lock. Locally, whoever runs `lock`
  at that root.
- **Externals in the approval.** `lock` records the digests of every pinned external; a
  re-pin that changes a *used* digest makes the approval drifted (`status`: "approved
  against billing@9c1…, pinned now 4d0…"), which is the review signal the family needs when
  a producer changes its contract.

**Migration.** `children` keeps being read; new records write `members` (same content).
`externals` is absent on old records, which reads as "approved against unknown contracts"
and `status` says so. `requireApprovedMembers` defaults off, so no lock that succeeds
today starts failing.

**Proof.**

- `parent-lock-never-writes-member-lock`: after `lock --yes` at the parent, no member's
  `lock.json` changed (exists or not).
- `require-refuses`: with `requireApprovedMembers`, a moved member refuses the parent's
  lock naming it; without it, the lock succeeds and the record pins the member's *approved*
  state, not its current one.
- `settled-from-both-roots`: a member spec approved and unchanged is judged at full
  strictness by the family run (the statement's approval probe becomes an error at the
  parent).
- `pin-chain`: Payments approved → Billing locks (pins Payments) → Platform locks (pins
  Billing); editing Payments then makes `status --family` at Platform show `payments:
  moved` under `billing: approved`.
- `externals-in-approval`: re-pinning a changed used method marks the consumer's approval
  drifted without any spec edit.

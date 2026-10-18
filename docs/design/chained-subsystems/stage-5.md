# Stage 5 — approval across a family

Stages 1–4 made every project judged by itself. Approval still carries a stage-1 shape: a parent's
lock copies each child's StateId into `children` without re-verifying it, the parent's content
identity hashes member specs directly, `composition` is outside the gate identity, and `generate` at
a parent writes into every member. Stage 5 makes approval per project and transitive by hashing.

Decisions this plan rests on: [`decisions.md`](decisions.md) § "Stage 5 preconditions (2026-09-30)"
(#10 the lock certifies the design, code results recorded beside; #15 composition subjects;
`requireApprovedMembers` opt-in; no generate cascade) and synthesis §5 ("Approval per project,
transitive by hashing").

## 1. What a lock certifies

- The design under its declared inputs. The gate identity is:
  own tree ⊕ doctrine ⊕ externals lock and pinned snapshots ⊕ adopted packs ⊕ `composition` ⊕ each
  direct member's composition subject.
- Code-conformance results are recorded in the lock beside the claim, with the analyzer's identity
  (validator version, doctrine digest, analyzer grade) — never folded into the claim, so an analyzer
  upgrade never invalidates an approval.
- The input set is captured before validation and compared before writing, so a lock never certifies
  inputs that changed while it ran (hosted approval requests included).

## 2. Composition subjects

- A project's **composition subject** is a hash of its own approved state: its gate identity at lock
  time, which already includes its direct members' subjects. The family's approval is transitive by
  hashing; nothing recurses into a member's files.
- A parent's lock records each direct member's subject as it stood at the parent's lock
  (`members:`); the lock format is versioned, `children` is still read for one release and never
  written.
- A member's state as seen from the parent: **approved** (its lock matches its tree),
  **drifted** (it has a lock, its tree changed), **never** (no lock).
- A parent lock never writes anything below itself (`parent-lock-writes-nothing-below`).

## 3. `requireApprovedMembers`

`composition.requireApprovedMembers: true` makes the parent's lock refuse while a direct member is
drifted or never approved, naming each. Off by default: the lock proceeds and records each member's
state, and the family run keeps MEMBER_UNAPPROVED / MEMBER_DRIFTED as warnings.

## 4. Derived outputs

- `generate` at a project writes only that project's outputs; `generate --family` walks members
  explicitly.
- The parent's agent topology lists member agents by reference (id), never copying them.
- A brief for a member's agent composes at the member's root, through the mount.
- `status` reports per member — its approval state from the member's own root — and prints the pin
  tree (`approved | drifted | never`).

## 5. Properties

`parent-lock-writes-nothing-below`, `pin-chain` (a change two levels down changes the top's gate
identity through the chain of subjects), `require-refuses`, `brief-through-mount`, `status-agrees`
(status from the parent and from the member agree), `context-proportional` (a member's brief does not
grow with the family), `analyzer-upgrade-keeps-approval`, `inputs-captured-before-validation`.

## 6. Upgrade

Every lock reads stale once (the gate identity gains inputs); the upgrade notes say why. Teams that
relied on the generate cascade run `generate --family`.

## 7. Not in stage 5

`attach`/`rename`/`detach`/`adopt` (stage 6); hosted members as records (stage 7); approving a
member from the parent.

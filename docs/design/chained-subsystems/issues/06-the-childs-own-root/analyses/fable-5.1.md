_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 06 — Working from the child's own root: status, topology, briefs

**Diagnosis.** Derived outputs are computed from the bound root's federated tree with
local-id filters (`agent_resolver.ts:244-246`), the parent's topology is *deliberately*
opaque about members (`:285-305`), `create` leaves a child with no subsystem (issue 01),
and `lock` cascades `ensureProjectInitialized` + `generate` into every member
(correction 3). Two root causes: a member is not a first-class node in any derived output,
and R4 was applied to surfaces but not to derived files.

**Options.**

| | | |
|---|---|---|
| a | Flatten: the parent's topology enumerates every member's agents and writes them into the parent's `.claude/agents` | Context proportional to the deep tree (the reason the layered topology exists); a member's agents then exist twice. |
| b | Opaque delegate (today) | The parent cannot delegate into a member without a human switching directories. |
| c | Member node *by reference*: the parent's topology lists the member's agents by id and composes any of their briefs at the member's root on request; nothing is materialised at the parent | R4 holds, context stays proportional, delegation crosses the mount. **Recommended.** |

**Recommendation.**

- Topology at Platform: `system-architect`, `core-owner`, and a `billing` member node whose
  record lists `agents: [billing::billing-owner, billing::payments (member)]` — ids only,
  resolved live. `sdd_get_agent_brief('billing::billing-owner')` and
  `wairon-agent://billing::billing-owner` resolve `billing` to its root and compose the
  brief *there*, with the member's own topology, config and skills
  (`composeAgentBrief` gains a root-resolution step; nothing is written). An
  orchestrating agent at Platform delegates into a member by fetching that brief and
  spawning the subagent with the member's root as its working directory — the
  `sdd-delegate` skill needs one sentence added.
- Status at Platform: own subsystems as today, then one line per member computed at the
  member's root — completion, approval (`approved | drifted (3 specs) | never`), pin state
  (`pinned at …`, `moved`), governance (`inherit | own (diverges)`), and the member's own
  members indented. Status at Billing: own subsystems, `member of platform (mounted as
  billing)`, and its externals with freshness. Nothing from the parent's tree beyond the
  mount id appears at the child.
- Writes: `lock` and `generate` at a parent never enter a member — no
  `ensureProjectInitialized`, no skills/context/guides, no pruning. `wairon generate
  --family` is an explicit opt-in that runs `generate` at each member root exactly as a
  person would there, and says so per member. `create` is the only operation that
  provisions a child, and it provisions `project.yaml` + L0 only.
- The child's root shows work for what the parent scores because, with issue 01, there is
  nothing the parent can score that the child's own root cannot see: a component belongs
  to a subsystem the child declares, or it is an error at both roots.

**Migration.** Behavioural only. Teams that relied on a parent `lock` to regenerate
members' guides run `wairon generate --family` once. The `-owner` delegate record keeps
its id; it gains the `agents` list.

**Proof.**

- `brief-through-mount`: `sdd_get_agent_brief('billing::billing-owner')` at Platform
  deep-equals `sdd_get_agent_brief('billing-owner')` at Billing, except for the id prefix.
- `status-agrees`: for each member and each subsystem in it, completion reported at the
  parent equals completion reported at the member.
- `parent-lock-writes-nothing-below` (R4): snapshot every file under each member before
  `wairon lock --yes` at the parent; byte-identical after, including a member that has
  no `project.yaml` (it stays uninitialised).
- `context-proportional`: the number of agent records at the parent is independent of the
  number of components inside members.

_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 03 — Governance: whose rules judge a child's specs

**Diagnosis.** The validator constructs one [RuleContext](../../../../../../src/core/validation.ts#L459) using one root's extensions, variants, profile, and rules. A maximum of severity values cannot reconcile different rule implementations, allowed-edge tables, design depths, language definitions, or suppressions. The child and parent may literally be applying different predicates.

**Options.** Parent override supplies one family doctrine but breaks independent governance. Automatic ancestor inheritance preserves apparent consistency only while the ancestor remains available. Owner policy plus explicit, versioned family requirements supports R2, R3, R7, and R11 together.

**Recommendation.** Each project judges its own architecture under its own resolved policy. The parent decides whether to admit the resulting project and how the composition must behave. Shared rules should use explicitly selected and pinned policy/extension packages, with content available to the detached child.

For the agreed project-type inheritance, make inherited values a resolved, recorded input: either scaffold the chosen default into the child, or adopt it through a pinned policy. An implicit read of the nearest filesystem parent's current config would reintroduce the problem. A child override should be visible to the family admission check.

If Platform requires a policy Billing has not adopted, report two facts: Billing passes its declared project gate; Platform's membership requirement fails. Do not relabel Billing's local rules or suppress the disagreement. Where a shared policy declares non-overridable restrictions, attempts to weaken those restrictions fail policy resolution explicitly.

At depth two, Payments runs its own policy. Billing runs the policies for its composition, and Platform runs the policies for Platform's composition. An ancestor's additional family requirements are explicit inputs to admission, not a reason to skip Billing and replace Payments' doctrine with Platform's.

**Migration.** First expose policy provenance on current diagnostics and provide a comparison of parent-policy and owner-policy outcomes. Then adopt the new behavior through a schema/workflow version. A formerly clean family may correctly acquire errors from child-only packs; that is a visible gate change requiring review, not a safe silent default flip.

**Proof.** Child-only pack rules execute when validating the family. Parent severity changes cannot erase owner findings. A detached child with identical pinned policy gives the same result. Conflicting profiles yield a policy conflict or separate failed requirement, not load-order-dependent behavior.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

1. **The specific lenient-parent regression is fixed here.** [validation.ts](../../../../../../src/core/validation.ts#L66) now limits fallback replacement to resolution-failure codes, keeps stronger child findings, and combines severity overrides using the stricter effective severity. The three regression cases at the end of [resolve-through-parent.test.ts](../../../../../../tests/core/resolve-through-parent.test.ts#L469) pass. This does not make the parent run use every child's own policy, or make the fallback independent of unrelated findings.

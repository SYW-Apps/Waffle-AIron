# Prompt for an outside analyst

Paste everything below the line into the chat, then paste the full contents of
[`problem.md`](problem.md) directly after it. File the answer as described in
[`README.md`](README.md#adding-a-response).

---

You are a senior software architect reviewing an open design problem in **wairon**, a
spec-driven development tool. The problem statement follows this message and is
self-contained: you do not have the repository and do not need it. Where the statement
is silent, state the assumption you make and carry on.

The maintainers want independent angles, not agreement. Think the problem through from
first principles. Challenge the framing where you think it is wrong, and prefer a model
with fewer concepts over a patch per symptom.

## What to deliver

1. **Your model, in one page.** What a chained subsystem should *be* — one concept or
   several declared kinds — and why. Say which commitments (R1–R11) you would keep,
   weaken or drop, and what that buys.
2. **Per issue**, under a heading `## <id> — <title>` using the statement's ids (00–10).
   You may merge issues you believe share a root cause; say which and why.
   - **Diagnosis** — the root cause, not the symptom.
   - **Options** — two to four, each judged against the commitments.
   - **Recommendation** — concrete: show the spec YAML, the reference syntax, the CLI or
     MCP interaction, or the validator rule it implies.
   - **Migration** — what changes for existing projects, and whether it can be done
     without breaking them.
   - **Proof** — the properties or tests that would show it holds from both scopes.
3. **Worked example.** Take the statement's Platform / Billing / Payments / Shipping
   family through your model: how each project declares its relationship, how
   `dispatch_adapter → invoice_portal` is written and judged from Platform, from Shipping
   and from Billing, what each approval covers, and what happens when Billing renames
   `invoice_portal`'s method.
4. **Interactions.** Where your recommendations reinforce or conflict with each other.
5. **What you would not do**, and why.
6. **Prior art.** Where systems such as Bazel external repositories, Cargo workspaces and
   path dependencies, Go modules with `replace`, Nx or Turborepo workspaces, git
   submodules, Nix flake inputs, Terraform modules, Backstage's system model, the C4
   model, contract testing (Pact), or DDD context maps genuinely apply — and exactly where
   each analogy breaks.
7. **Assumptions and questions** for the maintainers.

Write in markdown. Be concrete and brief where you can: a small worked example is worth
more than a paragraph of principles.

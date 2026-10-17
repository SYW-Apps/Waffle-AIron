# Execution budgets — the resource axis of the topology

> Status: **implemented**. Written against wairon 5.1.x. The measurements below
> come from three archived Claude Code sessions of this project's own
> development, read out of the session transcripts rather than estimated.

---

## The problem

The derived topology answered one question about each agent — *what does it own*
— and nothing about a second one that turns out to cost real money: *what does
its work cost to do*.

In a delegating workflow that gap has a specific, measurable shape. A Claude
Code subagent's `model` field defaults to `inherit`. An agent file that omits it
silently adopts the parent session's model. With a frontier-tier parent and no
agent files on disk at all, **1,860 of 2,176 subagent turns ran on the most
expensive tier** across the three sessions measured — not by anyone's decision,
but by a default nobody had reason to look at.

Two things are worth stating because they are commonly assumed and were both
wrong here:

- **Per-spawn startup duplication is not the problem.** Subagents do reload
  CLAUDE.md and tool schemas from scratch — measured at 13.5k–32.5k tokens
  against a main session's 44–46k. But the whole CLAUDE.md chain came to ~2,400
  tokens: 8% of a subagent's startup and **0.2% of subagent spend**. Eliminating
  it entirely would save ~2%.
- **Delegation was still correct.** Running the same work inline in a session
  already averaging 271k context would have added a large context-carry
  surcharge on every turn, and would have forced repeated compaction. The
  problem was never *whether* to delegate; it was that every delegation was
  constituted by default.

A default that expensive cannot be fixed by instruction text. A prompt asking an
orchestrator to choose models deliberately competes for attention with the task,
and loses — the sessions measured had exactly such a policy, stated by the
maintainer, and it lost 85% of the time. It has to be configuration.

---

## The model

Four layers, tool-agnostic until the last. The split is what lets one derivation
serve a local Claude Code session, a hosted MCP client, and a tool that cannot
select models at all.

| Layer | File | Holds |
|-------|------|-------|
| **Execution profile** | `models/execution.ts`, `core/execution_profile.ts` | What the work *is like*: `breadth`, `writes`, `reasoningDepth`, `delegates`. Says nothing about models. |
| **Budget policy** | `core/budget_policy.ts` | What that *earns*: capability tier, effort, turn ceiling, tool class, delegation rights, MCP access. Named in tiers, never vendor models. |
| **Target emitter** | `exporters/claude.ts` | The per-tool *encoding*. Deliberately not generic. |
| **Brief** | `core/agent_resolver.ts` | The same budget, carried advisory to whoever spawns from it. |

### Derivation needs no spec authoring

Every input already exists on a resolved `AgentRecord`:

- `reasoningDepth` reads the **component stereotype**, which the vocabulary
  already encodes. A Store, Index, Registry or Adapter is plumbing that its L3
  contract and L5 narrative fully describe. An Orchestrator, Supervisor or
  Specialist carries the decisions. Inventing a second classification alongside
  the stereotype would have meant two things to keep in agreement.
- `breadth` reads owned-path spread and whether `readPaths` sweeps the tree.
- `writes` reads the **role**, not the path count — see the reversals below.
- `delegates` reads the template.

### Tiers, not model names

`ExecutionBudget.modelTier` is `small | standard | large | frontier`. Mapping a
tier onto a real model is the *consumer's* job, because only the consumer knows
what its host tool understands. The Claude Code exporter maps to model
**aliases** (`haiku`, `sonnet`, `opus`, `fable`) rather than pinned ids, so
generated files keep working across model releases.

### The dial

`execution.tier` defaults to `off`, and each step is a strict superset of the
constraints below it — raising it can only tighten a budget, never loosen one.
That property is what makes the dial safe to turn without auditing every agent.

`free` is defined as having *no* quality tradeoff, which is why it expresses no
model choice at all: picking a model is a quality decision. An absent
`modelTier` is not the same as a default one, and the exporter omits the field
rather than substituting.

---

## Enforce versus advise

Both delivery paths carry the budget, and they are not equivalent:

- A **generated agent file** can *enforce*. Front-matter binds: `model`,
  `effort`, `maxTurns`, `tools`, `mcpServers` are read by the host before the
  agent runs.
- A **live brief** can only *advise*. The caller spawning from the brief is what
  applies it.

That asymmetry is deliberate rather than a gap — a brief is consumed by tools
wairon does not control. It also matters practically: `materializeAgentFiles`
defaults to **off**, so the brief is the path most projects actually use, and a
budget that only reached generated files would have reached almost nobody.

The same line explains the hosted story. Budgets are declarative data and travel
fine over the hosted MCP surface as an advisory block on the brief. Front-matter,
hooks and settings are filesystem artifacts and only the local CLI can write
them. This is the same split hosted pack management already draws — declarative
over the API, code packs via filesystem — rather than a second rule.

---

## Two things derivation deliberately never produces

### `frontier` is not an owner tier

Derivation caps deep reasoning at `large`, at every dial setting including
`aggressive`. `frontier` is reachable only by an explicit per-agent override.

The reasoning is that a frontier-capable model is a **sparring partner** for a
question the specs do not settle, not a way to operate a component day to day.
Given a tree that is already specced and decided, an owner that genuinely needs
frontier capability to function is usually a component doing too much — the same
smell `GOD_COMPONENT` reports, arrived at from a different direction. So it stays
a decision only the user can make, and `wairon execution show` surfaces every
agent pinned there.

### `orchestrate` is not derived either

The `orchestrate` tool class — the thin grant that withholds bulk-content tools
from a pure router — exists because a manager that can read files will read
them, and then it accumulates context exactly like a main session, which is the
whole thing delegation was supposed to avoid.

But **every agent in a wairon topology owns and authors something**. Domain
owners write the specs and source they own; even a chained-subproject owner
writes its mount spec. Stripping their write tools would not make them cheaper,
it would make them broken. The genuine pure router in this workflow is the
human's own main session, which is not a wairon agent at all.

So `orchestrate` stays in the vocabulary as an override-selectable class for a
manager someone defines by hand, and derivation never assigns it.

---

## Reversals worth recording

Both were found by generating into a real project rather than by reading the
code, and both are pinned by regression tests.

**`writes` was inferred from owned-path count.** An implementer whose source
path could not be inferred came out with zero owned paths, therefore
`writes: false`, therefore `tools: Read, Grep, Glob` — an implementer that
cannot implement, produced silently. `writes` is now a property of the role. A
missing path is a topology gap to fix, not a reason to demote an agent.

**Budget front-matter leaked into other targets.** `cursor`, `copilot` and
`codex` all reuse `ClaudeExporter` for the agent-file shape. Enabling budgets
therefore wrote `model`, `maxTurns` and `mcpServers` into files for tools that do
not implement Claude Code's subagent contract. Those keys would be ignored, which
is worse than absent: a budget sitting in the file reads as enforced when nothing
enforces it. The shape is still shared; the encoding is now per-tool, opt-in at
the exporter registry once a target's own fields are verified.

---

## Deliberately out of scope

**Session-hygiene hooks and a context statusline.** Both would cut real tokens —
rewriting noisy commands so their output does not enter context verbatim, and
showing live context size instead of periodically re-measuring it. Neither
belongs here. They are identical for every project regardless of its spec tree,
so wairon would be deriving them from nothing, and wiring them means writing into
a hand-maintained `settings.json` with no marker-based reconcile available,
unlike every other file wairon generates. Generated skills are not a precedent:
those *are* wairon's domain.

**A conformance rule for frontier overrides.** `validate` gates the spec tree;
an override lives in project config, and `lint.allow` attaches to specs. The
finding actually wanted — "this component is doing too much" — is already
`GOD_COMPONENT`. The override warning lives in `wairon execution show`, where the
config it reports on lives.

---

## Open

- **Precedence between an agent file's `model:` and the
  `CLAUDE_CODE_SUBAGENT_MODEL` environment variable is unverified.** The env var
  short-circuits Claude Code's model-resolution chain when set to anything but
  `inherit`; whether explicit front-matter still wins decides whether a global
  floor and per-role pinning compose or conflict.
- **Whether `effort`, `maxTurns` and `mcpServers` in agent front-matter are
  honoured** by a given Claude Code build. Documented, not yet measured.
- **Topology scale.** A large project generates 30–50 subsystem agents (and would
  generate 1000+ with component implementers on). Because briefs resolve on
  demand by id, nothing needs a materialized catalog — but agent *discovery*
  still enumerates everything, which argues for scoping discovery to a domain.
  Separate concern from budgets.

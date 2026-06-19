# wairon — Vision

> Long-term product direction. Aspirational; implementation is phased
> (see [roadmap.md](roadmap.md)).

---

## North star

wairon makes **architecture itself the interface** between humans and AI coding
tools. You describe a system once as a validated spec tree; from it, wairon
derives the agents that build it and enforces the boundaries they must respect —
so AI-generated code is structurally correct and conformant by construction, not
by review.

The differentiator is not "spec-driven development" in general (many tools do the
prose-spec → plan → tasks loop). It is the **architecture-conformance engine**:
typed component stereotypes with enforced dependency rules, contract↔
implementation symmetry, narrative-to-code mapping, and cycle detection — checked
as a gate before code is written.

---

## Principles that don't change

- **Specs are the source of truth.** Agents, boundaries, and conformance are
  derived from `.wai/specs/`. Generated files are outputs.
- **wairon equips, it does not orchestrate.** It produces native subagents,
  installs skills, and exposes MCP tools. The host AI tool (Claude Code, Gemini
  CLI, …) runs the session and spawns its own subagents.
- **Optional, then strict.** A project opts in by creating a spec tree. Once
  enabled, the workflow is enforced: design before code, spec is law,
  human-in-the-loop.
- **`.wai/` boundary, file-based, offline.** All state is human-readable files
  under `.wai/`; no database, no daemon, no network requirement.

---

## Where it goes

1. **Deeper conformance.** Glob-aware ownership, richer stereotype rules,
   actionable remediation — the engine becomes a true architecture linter for AI
   codegen.
2. **Adoption without greenfield.** Derive a draft spec tree from existing code
   so teams can apply conformance to what they already have.
3. **CI as the gate.** `wairon validate --ci` in PR checks, with conformance
   diffs reported on the change.
4. **Org scale.** Shared standards and template libraries across repos.

---

## What was deliberately dropped

An earlier vision positioned wairon as a local AI **orchestration hub** —
spawning sessions, multi-model pipelines, git worktrees, a session wrapper. That
fought the host tools (which now have native subagents and worktrees) and spread
the product thin. wairon instead does one thing well: turn a validated spec tree
into a conformance gate plus the topology and skills a host AI tool consumes.

# wairon — Requirements

> Last updated: 2026-10-05 (for v6.0.0)

---

## Goals

1. **Spec as the source of truth.** A project's architecture lives in a typed
   spec tree under `.wai/specs/`. Agent files and conformance checks are derived
   from it; generated files are outputs, never inputs.

2. **Architecture conformance.** `wairon validate` is a gate that enforces
   reference integrity, contract↔implementation symmetry, component-stereotype
   dependency rules, and dependency-cycle freedom — so two implementers generate
   the same structure and boundaries are not violated.

3. **Equip the AI session, don't orchestrate it.** wairon serves live agent
   briefs, installs SDD skills, and exposes `sdd_*` MCP tools. The host AI tool
   spawns its own subagents and runs the workflow.

4. **Multi-tool support.** Install skills, guides and the MCP registration (and,
   when a project opts in, agent files) for Claude Code, Gemini CLI /
   Antigravity, and other targets from the same spec tree.

5. **Human approval, checkable in CI.** A human approves a design with
   `wairon lock`; the approval is a committed file, and `wairon lock-check`
   tells CI whether what merges is the approved design.

6. **Optional and additive.** If a project has no `.wai/specs/`, wairon is
   inert. When enabled, the workflow is strict.

7. **Observable, file-based state.** Everything lives under `.wai/` as
   human-readable YAML/JSON — no database, works offline, and no daemon for the
   core workflow (`wairon serve` is an opt-in hosting daemon over the same files).

---

## Non-Goals

- **Not a session orchestrator.** wairon does not spawn or drive AI sessions,
  run multi-model pipelines, or manage git worktrees. It relies on the host
  tool's own native subagent mechanism. (`wairon serve` *hosts* the `sdd_*` tools
  over HTTP for remote MCP clients, but still does not run or drive the AI
  session.)
- **Not a hand-maintained agent registry.** Agents are derived from specs, not
  authored in an `agents.json`.
- **Not a runtime for application code.** wairon manages specs, conformance, and
  agent topology — not execution.
- **Not a plugin marketplace.** Templates are file-based; there is no registry
  service.

---

## Scope

In scope: the SDD spec tree, conformance validation (spec and code↔spec),
approval and the CI merge gate, members and cross-project references, the
design export, spec-derived topology and live briefs, domains
(subsystem-derived + free-standing), SDD skills, extension packs, the MCP
server, shared context, multi-target generation, and the opt-in hosted server.

Still out of scope: deriving specs from existing code, conformance diffs
between revisions, and org-scale shared standards (see the
[roadmap](roadmap.md)).

# wairon — Requirements

> Last updated: 2026-06-14

---

## Goals

1. **Spec as the source of truth.** A project's architecture lives in a typed
   spec tree under `.wai/specs/`. Agent files and conformance checks are derived
   from it; generated files are outputs, never inputs.

2. **Architecture conformance.** `wairon validate` is a gate that enforces
   reference integrity, contract↔implementation symmetry, component-stereotype
   dependency rules, and dependency-cycle freedom — so two implementers generate
   the same structure and boundaries are not violated.

3. **Equip the AI session, don't orchestrate it.** wairon produces native
   subagent files, installs SDD skills, and exposes `sdd_*` MCP tools. The host
   AI tool spawns its own subagents and runs the workflow.

4. **Multi-tool support.** Generate agent files and install skills for Claude
   Code, Gemini CLI, and other targets from the same spec tree.

5. **Optional and additive.** If a project has no `.wai/specs/`, wairon is
   inert. When enabled, the workflow is strict.

6. **Observable, file-based state.** Everything lives under `.wai/` as
   human-readable YAML/JSON — no database, no daemon, works offline.

---

## Non-Goals

- **Not a session orchestrator.** wairon does not spawn or drive AI sessions,
  run multi-model pipelines, or manage git worktrees. It relies on the host
  tool's own native subagent mechanism.
- **Not a hand-maintained agent registry.** Agents are derived from specs, not
  authored in an `agents.json`.
- **Not a runtime for application code.** wairon manages specs, conformance, and
  agent topology — not execution.
- **Not a plugin marketplace.** Templates are file-based; there is no registry
  service.

---

## Scope (v0.1)

In scope: the SDD spec tree, conformance validation, spec-derived topology,
domains (subsystem-derived + free-standing), SDD skills, the MCP server, shared
context, and multi-target generation.

Out of scope for v0.1: deriving specs from existing code, CI conformance
reporting, and org-scale shared standards (see the [roadmap](roadmap.md)).

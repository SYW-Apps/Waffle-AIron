# wairon — Requirements

> Last updated: 2026-04-10 | Version: 0.1.0

---

## Goals

1. **Single source of truth** — every project using wairon has one canonical place
   (`.wai/`) where agent topology is defined. Generated agent files in
   `.claude/agents/`, `.gemini/agents/`, etc. are outputs, not inputs.

2. **Multi-tool support** — generate agent definitions for Claude Code, Gemini CLI,
   and arbitrary custom paths from the same internal model.

3. **Reproducibility** — running `wairon generate` twice on the same registry must
   produce identical output files.

4. **Architecture-first agents** — the tool should help define agents around real
   architectural boundaries (services, package families, bounded contexts), not just
   broad workflow roles.

5. **Scalability** — support scaling agent setups across large mono-repos or
   multi-project organizations without manually curating every agent file.

6. **Developer ergonomics** — fast init, clear commands, good error messages, no
   hidden state.

---

## Non-Goals

- **Not an agent runtime** — wairon does not run agents, orchestrate tasks, or
  manage agent communication.
- **Not a database-backed system** — all state is file-based and lives in the repo.
- **Not a code analyzer (MVP)** — the `analyze` command is planned but not in scope
  for v0.1.
- **Not an MCP server (MVP)** — MCP wrapping is a Phase 5 goal, not an MVP concern.
- **Not a plugin marketplace** — custom templates/bundles are file-based; no registry
  service is planned.
- **Not AI-generated topology** — the tool helps humans define topology; it does not
  auto-generate it from code analysis in the MVP.

---

## MVP Scope (v0.1)

### Implemented

- `wairon init` — interactive project initialization with target selection
- `wairon generate` — regenerate all agent output files from the registry
- `wairon validate` — validate project config and registry for errors
- `wairon list` — list all agents in the registry
- `.wai/` source-of-truth directory structure
- `project.yaml` config with schema validation (Zod)
- `agents.json` registry with schema validation (Zod)
- Built-in templates: architect, domain-owner, implementer, reviewer, tester, guardian
- Built-in bundles: service-default, package-family-default
- Claude Code exporter
- Gemini CLI exporter
- Custom path exporter

### Stubs (planned, not implemented)

- `wairon analyze`
- `wairon suggest-topology`
- `wairon create-agent`
- `wairon create-bundle`
- `wairon split`
- `wairon merge`

---

## Future Scope

### Phase 2 — Generation & Validation
- `wairon create-agent` interactive flow
- `wairon create-bundle` interactive flow
- Full glob-based ownership overlap detection
- Diff-aware generation (only update changed agents)

### Phase 3 — Topology Analysis
- `wairon analyze` — scan repo structure and suggest topology
- `wairon suggest-topology` — identify ownership gaps and coverage issues

### Phase 4 — Split/Merge Workflows
- `wairon split` — guided agent splitting
- `wairon merge` — guided agent merging
- Migration history tracking

### Phase 5 — MCP Server
- Wrap core library as an MCP server
- Expose topology inspection/mutation as MCP tools
- Enable AI models to query and update agent topology via MCP

### Phase 6 — Organization Scale
- Cross-project registry templates
- Shared bundle library
- CI/CD integration (validation as a PR check)

---

## Constraints

- Must work in any directory — no global daemon, no network requirement.
- Config must be versionable in git alongside the project it describes.
- Generated files must be portable — no absolute paths in outputs.
- All config formats must be human-readable and diff-friendly.
- CLI must exit with code 1 on errors, 0 on success.

---

## Open Questions

1. Should project-local templates/bundles be able to *extend* built-ins (inheritance),
   or only override them? Currently: override only.

2. Should `generate` warn when a generated file is newer than the registry entry
   (to detect manual edits)? Not implemented in MVP.

3. How should `create-bundle` handle `scopeDir` expansion for monorepos with
   non-standard layouts? TBD in Phase 2.

4. Should the registry support agent versioning (history of changes)? Punted to
   Phase 3.

---

## Assumptions

- Users run the CLI from the root of their project.
- `.wai/` is committed to version control.
- Generated files (`.claude/agents/`, etc.) may or may not be committed — this is
  the user's choice. The tool regenerates them on demand.
- Node.js 18+ is available in the target environment.
- Exporter output format for Claude Code: YAML front-matter + Markdown body
  (matching Claude Code's sub-agent spec as of April 2026).
- The final product name may change from "wairon" — the package name and
  binary name are working names.

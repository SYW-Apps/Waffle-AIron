# wairon — Roadmap

> Last updated: 2026-04-10

---

## Phase 1: CLI Foundation and Init ✅ (v0.1 — current)

**Goal:** Establish a clean, working CLI with a solid init flow and core model.

### Delivered
- [x] Project scaffold (TypeScript, Commander, Zod, js-yaml)
- [x] `.wai/` source-of-truth directory structure
- [x] `project.yaml` config with schema validation
- [x] `agents.json` registry with schema validation
- [x] `wairon init` — interactive project initialization
- [x] `wairon generate` — regenerate all agent output files
- [x] `wairon validate` — validate config and registry
- [x] `wairon list` — list all agents
- [x] Built-in templates: architect, domain-owner, implementer, reviewer, tester, guardian
- [x] Built-in bundles: service-default, package-family-default
- [x] Claude Code exporter
- [x] Gemini CLI exporter
- [x] Custom path exporter
- [x] Validation layer (duplicate ids, overlapping ownership, missing paths)
- [x] Strong documentation (requirements, architecture, CLI, templates, bundles, registry)
- [x] Initial test suite

---

## Phase 2: Interactive Agent & Bundle Creation (v0.2)

**Goal:** Make it easy to add agents and bundles through guided CLI flows.

### Planned
- [x] `wairon create-agent` — interactive agent creation from a template
  - Prompt for: id, name, template, owned paths, tags, targets
  - Write to registry immediately
  - Optionally generate right away
- [x] `wairon create-bundle` — scaffold multiple agents from a bundle
  - Prompt for: bundle id, scope name, scope directory
  - Expand bundle spec into registry entries
  - Support `--dry-run` to preview before writing
- [x] Diff-aware generation — only update files where the agent or template changed
- [ ] Full glob-based ownership overlap detection (micromatch, not just prefix heuristics)
- [x] `wairon show <agent-id>` — display full details of a single agent
- [x] `wairon templates list` — list all available templates
- [x] `wairon bundles list` — list all available bundles

---

## Phase 3: Topology Analysis (v0.3)

**Goal:** Let wairon analyze the repository and surface topology gaps.

### Planned
- [x] `wairon analyze` — walk repo, report coverage vs agent ownership
  - Which paths have no owning agent?
  - Which agents have overlapping ownership?
  - Which agents are drafts or deprecated?
  - Coverage percentage of top-level paths
- [x] `wairon suggest-topology` — propose new agents or path rebalancing
  - Human-readable suggestions, nothing auto-applied
  - Suggests bundles for gaps, flags broad ownership, merge/split candidates
- [ ] Full `.gitignore`-aware path walking (currently skips common dirs)

---

## Phase 4: Split / Merge Workflows (v0.4)

**Goal:** Guided refactoring of agent topology as projects evolve.

### Planned
- [x] `wairon split <agent-id>` — guided agent splitting into two or more agents
- [x] `wairon merge <id1> <id2>` — guided agent merging
- [x] Migration history in `.wai/docs/topology-history.md`
- [x] `wairon deprecate <agent-id>` — mark agent as deprecated without deleting

---

## Phase 5: MCP Server Wrapper (v0.5)

**Goal:** Expose wairon as an MCP tool so AI models can query and manage
topology without manual CLI invocation.

### Planned
- [ ] MCP server that wraps the wairon library API (`src/index.ts`)
- [ ] Tools: `listAgents`, `getAgent`, `validateTopology`, `generateOutputs`
- [ ] Stdio transport for local use with Claude Code / Gemini CLI
- [ ] HTTP transport for CI/CD or remote use
- [ ] Documentation for registering wairon as an MCP server in `.claude/settings.json`

---

## Phase 6: Organization Scale (v0.6+)

**Goal:** Support using wairon across multiple projects and teams.

### Planned
- [ ] Shared template/bundle library — reference templates from a remote URL or
  local path outside the project
- [ ] Cross-project agent topology standards
- [x] CI integration: `wairon validate --ci` exits 1 on warnings too
- [ ] GitHub Actions example workflow
- [ ] Agent topology diff reporting on PRs

---

## Known Technical Debt

- Template `__dirname` resolution works in development but may need adjustment
  for non-standard build outputs (tracked: see `src/core/templates.ts`)
- Ownership overlap detection is currently exact-match only; glob expansion
  would require a library like `micromatch` (Phase 2)
- The `generate.ts` `resolveTargetConfig` function does a simple type match;
  when multiple custom targets exist, it picks the first match (Phase 2 to improve)

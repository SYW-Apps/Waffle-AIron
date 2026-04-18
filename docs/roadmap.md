# wairon — Roadmap

> Last updated: 2026-04-12

---

## Phase 1: CLI Foundation and Init ✅ (v0.1 — delivered)

**Goal:** Establish a clean, working CLI with a solid init flow and core model.

### Delivered
- [x] Project scaffold (TypeScript, Commander, Zod, js-yaml)
- [x] `.wai/` source-of-truth directory structure
- [x] `project.yaml` config with schema validation
- [x] `agents.json` registry with schema validation
- [x] `wairon init` — interactive project initialization with bundle selection + guide injection
- [x] `wairon generate` — regenerate all agent output files (with `--domain`, `--domains`, `--root` filters)
- [x] `wairon validate` — validate config and registry
- [x] `wairon list` — list all agents
- [x] Built-in templates: architect, domain-owner, implementer, reviewer, tester, guardian
- [x] Built-in bundles: service-default, package-family-default
- [x] Claude Code exporter
- [x] Gemini CLI exporter
- [x] Custom path exporter
- [x] Validation layer (duplicate ids, overlapping ownership, missing paths)
- [x] `wairon domains` — scan, list, add, remove with type-filterable checkbox UI
- [x] `wairon targets` — list, add, remove, enable, disable output targets
- [x] `wairon scaffold-domains` — scaffold agents for unmanaged domains
- [x] `wairon delegate` — spawn an AI session in a domain directory with job handoff
- [x] `wairon jobs` — list, show, clean delegated jobs
- [x] `wairon update` — self-update binary with release channel support
- [x] `wairon profiles` — work/personal profile system with wrapper scripts
- [x] AI guide injection into CLAUDE.md / GEMINI.md (opt-in, idempotent, marker-based)
- [x] Strong documentation (requirements, architecture, CLI, templates, bundles, registry)
- [x] Test suite

---

## Phase 2: Shared Project Context ✅ (v0.2 — delivered)

**Goal:** Single source of truth for project description and conventions, shared
across all AI tools and all orchestrated sessions. No more divergence between
what Claude thinks the project is and what Gemini thinks.

### Design

All context lives under `.wai/context/` — never in the project root or home dir.

```
.wai/context/
  project.md          ← primary: name, description, stack, conventions
  architecture.md     ← optional: system design, component map
  domains.md          ← auto-generated: current domain list with paths
  wairon-guide.md     ← auto-generated: wairon usage guide for AI tools
```

For the user's normal CLAUDE.md / GEMINI.md, instead of injecting content
directly, wairon recommends adding a single import line:
```
@.wai/context/wairon-guide.md   ← Claude Code @-import syntax
```
This keeps the user's files clean while wairon fully controls the guide content.

### Commands
- `wairon context init` — guided wizard: project name, description, stack, conventions
- `wairon context edit` — open context files in $EDITOR
- `wairon context sync` — regenerate `domains.md` and `wairon-guide.md` from current registry state
- `wairon context show` — display the current shared context in the terminal

### Rules
- `wairon init` calls `context init` as part of its flow
- `wairon generate` calls `context sync` to keep `domains.md` current
- All subsequent phases (workspaces, pipelines, worktrees) read from `.wai/context/` as input

---

## Phase 3: Isolated Task Workspaces ✅ (v0.3 — delivered)

**Goal:** Every delegated session — whether a single `wairon delegate` or a
pipeline step — runs in a fully scaffolded, self-contained environment inside
`.wai/`. No tool config files are written outside `.wai/`.

### Design

Each workspace is a directory under `.wai/runs/<run-id>/steps/<step-id>/`.
The step's tool config dir is pointed at via env var (same mechanism as profiles):

```
CLAUDE_HOME=.wai/runs/run-001/steps/impl-auth/.claude/
```

The tool's config dir inside the workspace contains:
- A generated `CLAUDE.md` or `GEMINI.md` combining: project context + task brief +
  domain constraints + parallel agent awareness (if applicable)
- A generated `agents/` directory with only the agents relevant to this domain/task

```
.wai/runs/
  run-20260412-001/
    spec.yaml                    ← goal, pipeline, triggered-by
    status.yaml                  ← overall + per-step state, timestamps
    steps/
      ideate/
        job.yaml
        .gemini/
          GEMINI.md              ← context: project summary + task brief
        result.yaml
      plan/
        job.yaml
        .gemini/
          GEMINI.md              ← context: project summary + ideate result
        result.yaml
      impl-auth/
        job.yaml
        .claude/
          CLAUDE.md              ← context: project + plan + parallel awareness
          agents/                ← only auth-service agents
        result.yaml
      impl-api/
        job.yaml
        .claude/
          CLAUDE.md
          agents/
        result.yaml
```

### Commands
- `wairon run start --goal "..." [--backend claude]` — single-step isolated session
- `wairon run status [run-id]` — show step states for a run
- `wairon run clean [--all] [--older 7d]` — remove completed runs

### Rules
- `.wai/` boundary is absolute: no tool config written outside `.wai/` for orchestrated sessions
- wairon sets env vars on the child process — the tool sees its config dir as normal
- Run directories are safe to delete at any time; `wairon run clean` handles it

---

## Phase 4: Pipelines ✅ (v0.4 — delivered)

**Goal:** Multi-step, multi-model workflows defined in a YAML file, orchestrated
by wairon. Sequential and parallel steps, output passing between steps,
validation gates.

### Design

```yaml
# .wai/pipelines/feature-pipeline.yaml
name: feature-pipeline
description: "Concept → plan → parallel implementation across domains"

steps:
  - id: ideate
    backend: ollama
    model: llama3
    prompt: "Brainstorm approaches for: {{goal}}"
    output: ideate-result          # key name for downstream context

  - id: plan
    backend: gemini
    depends: [ideate]
    prompt: "Convert this brainstorm into an implementation plan with clear domain boundaries"
    context: [ideate-result]
    output: plan-result

  - id: impl-auth
    backend: claude
    depends: [plan]
    parallel: true                 # run concurrently with other parallel steps
    domain: auth-service           # scoped to this domain's agents
    context: [plan-result]
    aware_of: [impl-api]           # told: other agent, its branch, its job file
    output: impl-auth-result

  - id: impl-api
    backend: claude
    depends: [plan]
    parallel: true
    domain: api-gateway
    context: [plan-result]
    aware_of: [impl-auth]
    output: impl-api-result

  - id: validate
    run: npm test                  # shell command gate before merge
    depends: [impl-auth, impl-api]

  - id: merge
    depends: [validate]
    git:
      merge: [feature/impl-auth, feature/impl-api]
      target: develop
      strategy: no-ff
```

### Commands
- `wairon pipeline run <name> [--goal "..."]` — execute a pipeline
- `wairon pipeline status [run-id]` — live + historical step states
- `wairon pipeline list` — show all defined pipelines
- `wairon pipeline logs <run-id> <step-id>` — show step output

### Rules
- Pipelines are always stored under `.wai/pipelines/`
- Each pipeline run creates a `.wai/runs/<run-id>/` directory
- Output from one step is stored in `result.yaml` and injected as context into downstream steps
- Parallel steps are run as concurrent subprocesses

---

## Phase 5: Git Worktree Integration ✅ (v0.5 — delivered)

**Goal:** Parallel agents work on isolated git branches without duplicating the
repository. Each domain's work is separated until both complete, then merged
with validation. The user opts in to wairon managing git.

### Design

Git worktrees share the same `.git` object store — no history duplication.
Sparse checkout limits each worktree to only the domain's relevant paths.
All worktrees live under `.wai/worktrees/` — the user's workspace is untouched.

```
.wai/worktrees/
  feature-oauth/
    .git                          ← 1-line pointer file (managed by git)
    auth-service/                 ← sparse: only this domain + shared paths
    shared/
    .wai-worktree.yaml            ← wairon metadata: branch, run-id, step-id
  feature-rate-limit/
    .git
    api-gateway/
    shared/
    .wai-worktree.yaml
```

Sparse checkout setup per worktree:
```bash
git worktree add .wai/worktrees/feature-oauth feature/oauth
cd .wai/worktrees/feature-oauth
git sparse-checkout set auth-service/ shared/ package.json tsconfig.json
```

Cross-agent awareness via shared paths:
- Both worktrees include `shared/contracts/` in their sparse set
- If auth exports a new interface, it writes to `shared/contracts/auth.ts`
- The API agent's CLAUDE.md says: "auth-service is implementing OAuth on
  `feature/oauth` in `.wai/worktrees/feature-oauth/`. Interface contracts
  land in `shared/contracts/`. Monitor that path for the auth interface."

Opt-in git control in `project.yaml`:
```yaml
git:
  waironManaged: true
  autoMerge: false               # default: require human confirmation
  worktreeBase: .wai/worktrees
  protectedBranches: [main, develop]
```

### Commands
- `wairon worktrees create --domain <id> --branch <name>` — scaffold a new worktree
- `wairon worktrees list` — show all active worktrees with their branch and status
- `wairon worktrees merge <id> [--squash]` — merge a worktree's branch (respects autoMerge)
- `wairon worktrees clean <id>` — remove worktree + prune the git ref

### Rules
- Worktrees always under `.wai/worktrees/` — never in project root or elsewhere
- Sparse checkout is the default for worktrees; full checkout is opt-in
- `autoMerge: false` by default — wairon prepares the merge but waits for human approval
- Protected branches are never auto-merged into without explicit confirmation
- `wairon worktrees clean --all` is safe to run at any time; git worktree state is recoverable

---

## Phase 6: Native `wairon session` CLI UI ✅ (v0.6 — delivered)

**Goal:** `wairon session` becomes the single entry point for all AI-assisted
work on a project. It wraps the underlying tool (claude, gemini, ollama, custom)
but adds wairon-native capabilities: context injection, seamless model switching,
inline wairon commands, and live session/job awareness.

### Why a native entry point

- **Consistent context:** wairon sets up the environment before the session starts —
  correct CLAUDE_HOME / GEMINI_CONFIG_DIR, shared project context injected, relevant
  agents loaded. No manual setup.
- **Profile-aware:** picks the right command and config dir based on the active profile
  automatically.
- **Interceptable:** wairon controls the process, so it can log sessions, capture
  job outputs, and feed results back without the user doing anything.
- **Model switching:** switch between claude and gemini without restarting, sharing
  context via `.wai/context/` as the handoff surface.
- **Inline wairon commands:** type `/delegate auth-service fix the JWT bug` inside
  a session and wairon handles it without leaving the terminal.

### Short-term: thin wrapper (v0.6 target)

`wairon session [--backend claude|gemini|ollama] [--domain <id>]`

- Sets CLAUDE_HOME / GEMINI_CONFIG_DIR to a workspace under `.wai/`
- Injects project context into the workspace's CLAUDE.md / GEMINI.md
- Execs the tool with the correct command (profile-aware)
- On exit, optionally captures result into a run record

The user can set `wairon` as their per-project alias — instead of typing `claude`
or `gemini`, they type `wairon session` (or `wai`) and get the right tool with
the right context automatically. The project's `defaultBackend` in `project.yaml`
decides which tool runs.

### Long-term: PTY wrapper with slash commands (v0.7+)

wairon wraps the child process via a pseudo-terminal, intercepting output without
altering the experience. This enables:

- `/switch gemini` — pause current context, hand off to gemini, switch back
- `/delegate <domain> <task>` — inline delegation without leaving the session
- `/context` — show the current shared project context
- `/jobs` — show live job status
- `/session new` — start a fresh session preserving context

### Long-term: Full TUI with direct API calls (v1.0+)

wairon IS the chat interface — model-agnostic, using provider APIs directly
(Anthropic, Google, Ollama-compatible). This enables:
- True seamless model switching mid-conversation
- Context window management across backends
- Persistent cross-session context via `.wai/context/`
- Local AI context manager: spin up an Ollama session just to rewrite/summarize
  the shared context, then resume the main session

---

## Phase 7: MCP Server Wrapper ✅ (v0.7 — delivered)

**Goal:** Expose wairon as an MCP tool so AI models can query and manage
topology, run pipelines, and check job status without manual CLI invocation.

- MCP server wrapping the wairon library API
- Tools: `listAgents`, `getAgent`, `validateTopology`, `generateOutputs`,
  `delegateTask`, `getPipelineStatus`, `getRunStatus`
- Stdio transport for local use with Claude Code / Gemini CLI
- HTTP transport for CI/CD or remote use
- Registers itself in `.wai/context/wairon-guide.md` so AI tools know it's available

---

## Phase 8: Built-in Agent Loop for Local Models ⬜ (v0.8 — next)

**Goal:** Any Ollama-compatible model becomes a first-class coding agent — no
separate tool installation required.

### Design (from vision.md)

The Writer Agent pattern:
1. Main agent (any model) reasons about what to do
2. Writer Agent (fast local model) applies file changes with pre+post validation:
   scope check → pre-validate → apply to temp → post-validate → atomic swap
3. Main agent only sees structured outcomes — no raw diffs in context

All file operations go through the Writer cycle, making local model sessions
as reliable as hosted ones.

---

## Phase 9: Organization Scale ⬜ (v0.9+)

- Shared template/bundle library — reference from remote URL or org-level path
- Cross-project agent topology standards
- GitHub Actions: `wairon validate --ci` in PR checks
- Agent topology diff reporting on PRs
- Multi-repo orchestration (monorepo root delegates to sub-repos)

---

## Phase 10: Waffler Integration ⬜ (v1.0+)

**Goal:** An AI agent integrated directly into Waffler that builds blueprints
from natural language, step by step, with per-step validation.

### Why Waffler is uniquely suited to AI generation

Waffler represents logic as step-by-step node graphs (similar to Unreal Engine
Blueprints). This architecture has structural advantages over traditional code:

- **Isolated failure surface.** Each node does one thing. A mistake in one node
  does not corrupt the rest of the blueprint. The AI receives exact, field-level
  error messages and corrects only the failing node.
- **Human-reviewable output.** The blueprint AI generates can be visualized in
  waffler_ui before execution. Humans review logic flow, not raw diffs or JSON.
- **No syntax to misplace.** Connections between nodes are explicit references —
  there is no concept of a misplaced brace, wrong indentation, or wrong scope.
- **Explicit variable scope.** The runtime scope is a stack of named variables.
  The AI can ask exactly which variables exist at node X before writing any
  expression that references them.
- **Equivalent capability.** Waffler is not a macro language. It has packages
  for HTTP, databases, file system, websockets, desktop notifications, and more.

### Architecture decision: two separate components (decided Apr 2026)

The integration consists of two parts with a clean boundary:

```
AI model (claude / gemini / etc.)
    ↕  MCP protocol
Waffler MCP package  ← lives in the Waffler project
    ↕  waffler_core internals
TypeRegistry · CapabilityIndex · VFS · ExecutionContext

wairon  ← orchestration client, agent templates, project config
    ↕  starts / connects AI sessions to the Waffler MCP server
AI model
```

**Why not implement the MCP server in wairon (TypeScript)?**

The authoritative capability index, type validation, scope inspection, and VFS
blueprint storage all live inside `waffler_core`. A TypeScript reimplementation
would be an approximation — it would drift from the real Waffler semantics as
the language evolves. The MCP server must be a first-class Waffler package with
direct access to the kernel.

**What lives where:**

| Component | Repo | Language |
|-----------|------|----------|
| Waffler MCP package (server) | Waffler `packages/mcp_server/` | Rust |
| MCP interface spec (tool names, schemas, error formats) | wairon `docs/roadmap.md` | Markdown |
| wairon-side integration (project config, session routing) | wairon | TypeScript |
| AI agent templates for Waffler blueprint building | wairon `src/templates/` | YAML |
| Waffler bundle (builder + reviewer agents) | wairon `src/bundles/` | YAML |

### Blueprint format reference (explored Apr 2026)

**Blueprint JSON** at `.../vfs/<Name>/blueprint.json`:

```json
{
  "id": "uuid",
  "name": "My Blueprint",
  "context": { "invocation_mode": "OnDemand", "ownership": "Independent" },
  "entry_node": "trigger_0",
  "nodes": {
    "trigger_0": {
      "operation": { "module": "syw.core.flow", "capability": "basic_trigger" },
      "inputs": {},
      "outputs": { "next": { "target_node_id": "set_name" } },
      "store_result": null
    },
    "set_name": {
      "operation": { "module": "syw.core.flow", "capability": "set_variable" },
      "inputs": {
        "path":  { "value": "name",          "metadata": { "mapped": false } },
        "value": { "value": "vars.user_input","metadata": { "mapped": true, "type": "variable" } }
      },
      "outputs": { "next": { "target_node_id": "http_call" } },
      "store_result": null
    }
  }
}
```

**Input value types:**
- Static:     `{ "value": 42,          "metadata": { "mapped": false } }`
- FromScope:  `{ "value": "vars.x",    "metadata": { "mapped": true, "type": "variable" } }`
- Expression: `{ "value": "{{add(x,1)}}", "metadata": { "mapped": true } }`

**Expression syntax:** `{{expr}}` — 50+ built-in functions confirmed:
`add`, `subtract`, `multiply`, `divide`, `mod`, `concat`, `split`, `replace`,
`trim`, `to_lower_case`, `to_upper_case`, `contains`, `starts_with`, `ends_with`,
`equals`, `not_equals`, `greater_than`, `less_than`, `and`, `or`, `not`, `if`,
`switch`, `is_null`, `is_empty`, `coalesce`, `to_string`, `to_number`,
`to_boolean`, `parse_json`, `stringify_json`, `now`, `unix_timestamp`,
`format_date`, `parse_date`, `add_time`, `subtract_time`, `diff_time`, and more.

**Built-in flow capabilities** (module `syw.core.flow`):
`basic_trigger`, `set_variable`, `reassign_variable`, `if`, `for_loop`,
`while_loop`, `switch_case`, `call_subroutine`, `call_blueprint`, `call_function`,
`return`, `throw`, `try_catch`, `break`, `continue`, `yield`, `sleep`, `noop`,
`create_udt`

**Connector names by category:**
- Linear flow: `next`
- Conditionals: `then`, `else`
- Loops: `loop_body`
- Error handling: `error`, `try_body`, `catch_handler`
- Switch cases: `case_<label>`, `default`

**Packages confirmed** (from `../Waffler/packages/`):
`network/http`, `network/api`, `network/websocket`, `network/tcp`,
`db/postgres`, `db/mysql`, `db/sqlite`, `db/mongodb`, `db/redis`,
`db/bigquery`, `db/dynamodb`, `db/elasticsearch`, `db/mariadb`, `db/mssql`,
`system/fs`, `web_app`, `desktop_notifications`, `identity`, `compiler`,
`diagnostics`, and more.

### Waffler MCP package specification

This spec is the contract between the Waffler MCP package (Rust, server) and
wairon (TypeScript, client). Both sides must implement to this interface.

**Protocol:** MCP over stdio (local) or HTTP (remote/networked Waffler instance)

**Error response format** (returned when `ok: false`):
```json
{
  "ok": false,
  "errors": [
    { "node_id": "action_1", "field": "url", "message": "Required field 'url' is missing.", "severity": "error" },
    { "node_id": "action_1", "field": "method", "message": "Unknown HTTP method 'FETCH'. Use GET, POST, PUT, PATCH, or DELETE.", "severity": "error" }
  ]
}
```
Error messages must be **actionable** — they tell the AI exactly what to change,
not just that something is wrong. Field-level precision is required.

#### Discovery tools

| Tool | Input | Output |
|------|-------|--------|
| `waffler_list_packages` | — | `[{id, namespace, display_name, description, version, capability_count}]` |
| `waffler_search_capabilities` | `query: string`, `category?: "Action"\|"Trigger"\|"FlowControl"\|"Query"` | `[{module, capability, name, description, category, package_name}]` |
| `waffler_get_capability` | `module: string`, `capability: string` | Full capability: input fields (key, label, type, required, description, default), output fields, connector names, async flag |
| `waffler_list_functions` | `category?: string` | `[{name, signature, description, returns, category}]` |
| `waffler_get_function` | `name: string` | Full function: signature, all params with types, return type, description, examples |

#### Blueprint session tools

| Tool | Input | Output |
|------|-------|--------|
| `waffler_blueprint_create` | `name: string`, `mode?: "OnDemand"\|"Autonomous"` | `{session_id, entry_node_id}` — entry node auto-created |
| `waffler_blueprint_show` | — | Summary: node list with ids/capabilities, connections, variable declarations |
| `waffler_blueprint_discard` | — | Session discarded |

#### Node construction tools

| Tool | Input | Output |
|------|-------|--------|
| `waffler_add_node` | `node_id`, `module`, `capability`, `inputs: {key: InputValueSpec}`, `store_result?: {variable_name, kind, source_field?}` | `{ok, errors[]}` with field-level validation |
| `waffler_update_node` | `node_id`, `inputs?`, `store_result?`, `label?` | `{ok, errors[]}` |
| `waffler_remove_node` | `node_id` | `{ok, errors[]}` |
| `waffler_connect` | `from_node_id`, `connector`, `to_node_id` | `{ok, errors[]}` — validates connector name |
| `waffler_disconnect` | `from_node_id`, `connector` | `{ok, errors[]}` |

**InputValueSpec** (one of):
- `{"static": <json_value>}` — literal value
- `{"from_scope": "vars.name"}` — variable reference
- `{"expression": "{{add(x,1)}}"}` — inline expression

#### Context and validation tools

| Tool | Input | Output |
|------|-------|--------|
| `waffler_context_at` | `node_id: string` | `[{name, type, kind: "var"\|"const", declared_by_node}]` — variables in scope at this node |
| `waffler_validate_expression` | `expression: string`, `node_id?: string` | `{valid, inferred_type, errors[]}` — checks syntax + scope refs |
| `waffler_blueprint_validate` | — | `{valid, errors[], warnings[]}` — full blueprint check |

#### Output tools

| Tool | Input | Output |
|------|-------|--------|
| `waffler_blueprint_save` | `blueprint_name?: string` | Writes to Waffler VFS, returns VFS path |
| `waffler_blueprint_export` | — | Full blueprint JSON as string (for review) |

### Preference mode (AI behavior contract)

The AI agent template for Waffler blueprint building must include this explicit
instruction:

> **Before making a design choice, ask the user.** Specifically:
> - Package selection: "I can use `network/http` or `network/api` for this. Which do you prefer?"
> - Data structure: "Should the user data be stored as an Object or as individual variables?"
> - Error handling: "Should this step fail the whole blueprint on error, or continue with a fallback?"
> - Loop strategy: "Should I process these items in sequence or is parallelism acceptable?"
>
> Do not infer preferences from context. Do not guess. Ask, receive the answer,
> then proceed. This keeps the human in control of design decisions while the AI
> handles structural correctness.

### wairon's implementation scope (Phase 10 deliverables)

1. **wairon project config for Waffler** (`project.yaml` extension)
   ```yaml
   waffler:
     mcpServerUrl: "stdio"   # or "http://localhost:7700"
     rootPath: "../Waffler"  # path to Waffler project (for offline index)
   ```

4. **Waffler agent templates** (`src/templates/waffler-builder.yaml`, `waffler-reviewer.yaml`)
   Agent templates that know the Waffler MCP tool surface, include the full
   preference-mode contract, and describe the expression syntax.

5. **Waffler bundle** (`src/bundles/waffler-default.yaml`)
   Default bundle: blueprint-builder + blueprint-reviewer agents.

6. **`wairon waffler` command group**
   - `wairon waffler session` — start a session connected to the Waffler MCP server
   - `wairon waffler index` — rebuild the offline capability index
   - `wairon waffler install` — register the Waffler MCP server in Claude Code settings

### Waffler MCP package scope (separate Waffler deliverable)

To be developed under `../Waffler/packages/mcp_server/` as a Rust Waffler package:

- MCP server exposing all tools from the spec above
- Backed by live `waffler_core` internals: real `TypeRegistry`, real `CapabilityIndex`, real VFS
- Strict error messages per the error format contract above
- Supports both stdio (local) and HTTP (remote) transports
- Registered in Waffler's package system — installable like any other package
- Can serve any MCP-compatible client, not just wairon

### Waffler project file locations

- Root: `../Waffler/` (sibling directory)
- Package manifests: `../Waffler/packages/*/package.json`
- Built-in node specs: `../Waffler/waffler_core/src/nodes/internal/flow/`
- Shared Rust types: `../Waffler/shared/src/`
- VFS (dev): `../Waffler/live_dev/sim_full/data/vfs/`
- SDK: `../Waffler/sdk/` (Rust, Node.js, Python, Go, .NET, Java SDKs available)

---

## Architectural invariants (never break these)

These hold across all phases:

| Invariant | Why |
|-----------|-----|
| **`.wai/` boundary** | All wairon state and generated content lives under `.wai/`. Nothing written to project root or home dir for orchestrated/automated sessions without explicit user opt-in. |
| **No hidden server process** | Everything runs on-demand. `wairon session` is a subprocess, not a daemon. |
| **No database** | All state is human-readable YAML/JSON files in `.wai/`. |
| **No network requirement** | Works fully offline. Update check is opt-in. |
| **Fully observable** | Every job, result, run, worktree, and context file is a file you can read, edit, or delete. |
| **Fully controllable** | Subprocesses use `stdio: inherit`. The user sees and can interrupt everything. |
| **Opt-in for destructive/external actions** | `git.waironManaged`, `autoMerge`, guide injection — all require explicit opt-in. |

---

## Known Technical Debt

- Template `__dirname` resolution works in development but may need adjustment
  for non-standard build outputs (tracked: see `src/core/templates.ts`)
- Ownership overlap detection is currently exact-match only; glob expansion
  would require `micromatch` (Phase 2 or 3)
- The `generate.ts` `resolveTargetConfig` does a simple type match; when multiple
  custom targets exist, it picks the first match
- `profiles.ts` uses `require()` for userconfig to avoid circular import — should
  be converted to a proper dependency injection pattern when the module graph grows

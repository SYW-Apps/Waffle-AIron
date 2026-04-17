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

## Phase 7: MCP Server Wrapper ⬜ (v0.7 / parallel track — next)

**Goal:** Expose wairon as an MCP tool so AI models can query and manage
topology, run pipelines, and check job status without manual CLI invocation.

- MCP server wrapping the wairon library API
- Tools: `listAgents`, `getAgent`, `validateTopology`, `generateOutputs`,
  `delegateTask`, `getPipelineStatus`, `getRunStatus`
- Stdio transport for local use with Claude Code / Gemini CLI
- HTTP transport for CI/CD or remote use
- Registers itself in `.wai/context/wairon-guide.md` so AI tools know it's available

---

## Phase 8: Built-in Agent Loop for Local Models ⬜ (v0.8)

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

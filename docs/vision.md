# wairon — Vision

> This document captures the long-term product direction.
> It is intentionally aspirational. Implementation is phased.
> See roadmap.md for the concrete implementation plan.

---

## What wairon becomes

wairon starts as a topology manager and agent scaffold tool. Over time it
grows into a **local AI orchestration hub** — the single tool through which
AI coding work is defined, delegated, observed, and controlled across any
project structure, using any mix of AI backends.

The north star: type `wairon session` in any initialized project and get the
right AI tool, with the right context, working within the right boundaries,
with full observability — regardless of whether that means Claude Code, Gemini
CLI, an Ollama model, or all three in sequence.

---

## The `.wai/` ownership principle

wairon owns `.wai/`. Everything else in the project belongs to the user.

This means:
- All orchestration state (jobs, runs, workspaces, worktrees, pipelines) lives under `.wai/`
- No files are written to the project root or the user's home directory for
  automated/orchestrated sessions without explicit opt-in
- `.wai/` can be cleaned, backed up, or gitignored as a unit
- The user's workspace and git history are never modified without permission

The one exception — injecting a guide into `CLAUDE.md` or `GEMINI.md` — is
an explicit opt-in during `wairon init`, and even that is being superseded by
a cleaner pattern: wairon generates `.wai/context/wairon-guide.md` and the
user adds a single `@.wai/context/wairon-guide.md` import line to their own
CLAUDE.md once.

---

## Shared context as the backbone

AI tools auto-generate their own project descriptions independently — Claude
writes its own CLAUDE.md, Gemini writes its own GEMINI.md, and they diverge
over time. This is the root cause of inconsistent multi-tool behavior.

wairon solves this with a single shared context under `.wai/context/`:

```
.wai/context/
  project.md          ← source of truth: project description, stack, conventions
  architecture.md     ← system design, component map (optional, human-curated)
  domains.md          ← auto-generated: current domain list with paths and owners
  wairon-guide.md     ← auto-generated: wairon usage guide for AI tools
```

Every orchestrated session — whether a single `delegate`, a pipeline step,
or a `wairon session` — reads from this context as its starting point.
The context evolves as the project evolves; `wairon context sync` keeps
`domains.md` and `wairon-guide.md` current.

---

## The Delegation Loop

The core primitive: **`wairon delegate`**.

A parent session (running in the project root) identifies a task scoped to
one domain. Instead of context-switching or copy-pasting, it runs:

```
wairon delegate auth-service --prompt "add OAuth2 login flow"
```

wairon:
1. Creates a job file in `.wai/jobs/` or `.wai/runs/<run-id>/steps/<step-id>/`
2. Scaffolds an isolated tool config dir inside `.wai/` with a generated CLAUDE.md:
   project context + task brief + domain constraints
3. Spawns the AI tool with `CLAUDE_HOME` / `GEMINI_CONFIG_DIR` pointed at that dir
4. The sub-session has focused context, full domain authority, and knows nothing
   irrelevant about the rest of the project
5. On completion, the sub-agent writes a result file; wairon surfaces it to the
   parent — summary, files changed, flagged observations

The parent continues with updated context. The workspace is cleaned up when done.

---

## Multi-model orchestration

Different tasks suit different models. wairon routes based on what's declared:

```
                        wairon orchestration layer
                                    │
             ┌──────────────────────┼────────────────────┐
             │                      │                    │
       claude code             gemini cli           ollama (local)
   (complex reasoning,     (long context,        (fast write validation,
    code execution)         planning, review)     analysis, free)
```

A concrete pipeline:
1. **Ollama** (local, cheap) — brainstorm the feature approach, write a concept doc
2. **Gemini** (long context) — read the concept + the entire codebase plan, produce
   a detailed implementation plan with explicit domain boundaries
3. **Claude Code** (parallel instances) — implement each domain on its own git
   branch in a sparse worktree, each aware of the other's job file and contract surface
4. **Ollama** (fast, local) — validate each file write before it lands on disk
5. **wairon** — gate on test pass, then merge both branches

The user configures which model handles which backend:
```yaml
# .wai/project.yaml
defaultBackend: claude
pipelines:
  defaultIdeateBackend: ollama
  defaultPlanBackend: gemini
  defaultImplBackend: claude
```

Or per-domain:
```json
// .wai/registry/domains.json
{ "id": "core-utils", "backend": { "type": "ollama", "model": "deepseek-coder:6.7b" } }
```

---

## Git worktrees: parallel branches without the waste

Claude Code's built-in worktree feature copies the entire working directory to
`.claude/worktrees/` — fine for small repos, impractical for large monorepos.

wairon's approach:
- Worktrees live under `.wai/worktrees/` (not `.claude/`, not the project root)
- Sparse checkout limits each worktree to only the relevant domain paths
- The `.git` object store is shared — no history duplication, only working files
- Cross-agent contract surface: both worktrees include `shared/contracts/` in
  their sparse set, so interface definitions land in a shared location both can see

```
Main workspace:  C:\project\              branch: develop     (full checkout)
Auth worktree:   .wai/worktrees/feat-oauth   branch: feature/oauth   (sparse: auth-service/)
API worktree:    .wai/worktrees/feat-rate    branch: feature/rate-limit (sparse: api-gateway/)
```

wairon manages the full lifecycle: branch creation, worktree add, sparse config,
agent context generation, monitoring, validation gate, merge (with human approval
by default).

---

## `wairon session`: the single entry point

Long-term, `wairon session` replaces typing `claude` or `gemini` directly:

```bash
wairon session                    # uses project's defaultBackend + active profile
wairon session --backend gemini   # override for this session
wai                               # short alias
```

What it provides beyond just running the tool:

| Now (thin wrapper) | Later (PTY wrapper) | Long-term (native TUI) |
|--------------------|--------------------|-----------------------|
| Sets correct CLAUDE_HOME | Intercepts output for logging | Direct API calls |
| Injects project context | `/switch gemini` mid-session | Model-agnostic |
| Profile-aware command | `/delegate <domain> <task>` | Seamless switching |
| Starts right tool | `/jobs` live status | Shared context across backends |
| Clean workspace setup | `/context` to inspect | Local context manager AI |

The project's `defaultBackend` means the user never has to remember which tool
they use for this project. `wairon session` always does the right thing.

---

## The Writer Agent (local model reliability)

For local/custom models without their own agentic loop, wairon provides a
**Writer Agent** — a fast local model dedicated to file write operations:

```
Main agent (reasons about what to change)
    │
    └─ Writer Agent (applies changes, validates, confirms)
           1. Scope check — is this path in the allowed write scope?
           2. Pre-validate — does the diff apply cleanly?
           3. Apply to temp file — never touch the original until validation passes
           4. Post-validate — does the written file parse?
           5. Atomic swap — temp → real file
              OR reject with structured reason → main agent adjusts
```

Main agent context sees only:
```json
{ "status": "applied", "summary": "fixed duplicate offset call at line 45" }
```

No raw diffs in context. Validation runs locally at near-zero cost.

---

## Cross-instance awareness

When two agents work in parallel on related domains, their generated CLAUDE.md
files tell each one about the other:

```markdown
## Parallel work awareness

The `api-gateway` domain is being implemented concurrently on branch
`feature/rate-limiting` in `.wai/worktrees/feat-rate/`. Its job status is:
  .wai/runs/run-001/steps/impl-api/job.yaml

The contract surface between your domain and api-gateway is:
  shared/contracts/auth.ts

Write your auth interface there. The API agent will poll that path before
it implements the gateway's auth integration.
```

No real-time messaging required. Shared files under `shared/` (included in both
worktrees' sparse sets) are the handoff surface. Job files are the status channel.
wairon generates all of this context automatically from the pipeline definition.

---

## Architecture invariants

These never change regardless of how large wairon grows:

| Invariant | Reason |
|-----------|--------|
| **`.wai/` boundary** | The user's workspace is theirs. wairon never writes outside `.wai/` without explicit opt-in. |
| **No hidden server** | Everything runs on-demand. `wairon session` is a subprocess, not a daemon. |
| **No database** | All state is human-readable YAML/JSON files. Observable, debuggable, deletable. |
| **No network requirement** | Works fully offline. |
| **Fully observable** | Every job, run, worktree, context file is a file you can read, edit, or delete. |
| **Fully controllable** | Subprocesses use `stdio: inherit`. User can see and interrupt everything. |
| **Opt-in for external actions** | Git management, auto-merge, guide injection — always explicit opt-in. |
| **Additive, not replacing** | wairon wraps existing tools; it doesn't replace Claude Code or Gemini CLI. |

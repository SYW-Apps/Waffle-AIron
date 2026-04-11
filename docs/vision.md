# waffagent — Vision

> This document captures the long-term product direction.
> It is intentionally aspirational. Implementation is phased.

---

## What waffagent becomes

waffagent starts as a topology manager and agent scaffold tool. Over time it
grows into a **local AI orchestration hub** — the single tool through which
AI coding work is defined, delegated, observed, and controlled across any
project structure.

---

## The Delegation Loop

The most valuable near-term extension: **`waffagent delegate`**.

A parent AI agent (running at the project root in Claude Code or Gemini CLI)
identifies a task that belongs to a specific subdomain. Rather than context-
switching or copy-pasting instructions, it runs:

```
waffagent delegate core-utils --prompt "fix JWT expiry bug in auth/middleware.ts"
```

waffagent:
1. Creates a structured job file in `.wai/jobs/`
2. Spawns `claude` (or `gemini`) in the subdomain directory as a fully observable subprocess
3. The sub-session has its own focused context, full domain authority, and project instructions
4. On completion, the sub-agent writes a result file summarizing what was done
5. waffagent surfaces the result to the parent session — summary, files changed, flagged observations

The parent agent continues with updated context. The sub-agent never needed to know about the broader project.

### Async delegation

```
waffagent delegate core-utils --async --prompt "..."
waffagent delegate blueprints --async --prompt "..."
waffagent jobs wait --all
```

Multiple domains can work in parallel. All results available when both complete.

---

## The Writer Agent

The agentic loop for local/custom models introduces a dedicated **Writer Agent**
— a specialized, isolated component responsible for all file write operations.

**Why a separate agent for writes?**

The main agent reasons about what to do. The Writer does the mechanical,
error-prone work of applying changes to real files. These are different skills
and different failure modes. Separating them:

- Keeps the main agent's context clean (no raw file diffs or post-write analysis)
- Makes writes independently reliable (pre + post validation)
- Lets the Writer run on a different model — a local Ollama model is ideal:
  - Small, fast, instruction-following models are well-suited for this task
  - Validation overhead runs on local hardware, not cloud tokens
  - Reliability is maximized at near-zero marginal cost

**The Writer's internal cycle for each write:**

```
Receive change request
  │
  ├─ 1. Scope check         — is this path in the allowed write scope?
  ├─ 2. Pre-validate        — does the change parse? Does the diff apply cleanly?
  ├─ 3. Apply to temp file  — never touch the original until validation passes
  ├─ 4. Post-validate       — does the written file parse without errors?
  ├─ 5. Content verify      — re-read and confirm the expected change is present
  └─ 6. Swap                — atomic rename temp → real file
         OR
         Reject with structured explanation → main agent adjusts and retries
```

The main agent's context only sees:
```
{ status: "applied", summary: "fixed duplicate offset call at line 45" }
```
or:
```
{ status: "rejected", reason: "post-write syntax error at line 47",
  suggestion: "diff may be incomplete — missing closing brace" }
```

No file contents. No diff text. Just the outcome.

---

## Multi-Backend Orchestration

The long-term goal: **route different tasks to different AI models** based on
what each model is best suited for, what each costs, and what hardware is
available.

```
                          waffagent orchestration layer
                                      │
               ┌──────────────────────┼───────────────────┐
               │                      │                   │
         claude code             gemini cli           local ollama
      (complex reasoning)   (long context tasks)   (write validation,
                                                    analysis, free)
```

Configuration per domain:
```yaml
# .wai/registry/domains.json
{
  "id": "core-utils",
  "path": "services/core/packages/core-utils",
  "backend": { "type": "ollama", "model": "deepseek-coder:6.7b" }
}
```

A domain configured with Ollama uses the local model for its agent sessions.
The main project still uses Claude or Gemini. The orchestration layer routes
transparently.

---

## The AIBackend Abstraction

All AI calls (once the agentic loop is implemented) go through the `AIBackend`
interface defined in `src/backends/base.ts`.

The OpenAI-compatible REST protocol covers most of the landscape:
- OpenAI (`/v1/chat/completions`)
- Ollama (`http://localhost:11434/v1`)
- LM Studio
- LocalAI
- Any custom endpoint

Adding a new model source = adding one `AIBackend` implementation.

---

## The Built-in Agent Loop

For local/custom models that don't have their own CLI tool, waffagent will
eventually provide its own agentic loop (`src/agent-loop/loop.ts`) with:

- File system tools (read, list, search, write via WriterAgent)
- Shell execution
- Context window management
- Structured tool use (OpenAI function calling protocol)

This makes any Ollama-compatible model a first-class coding agent — no
separate tool installation required.

---

## Architecture boundary: what stays CLI-first

Even as waffagent grows toward orchestration and backends, it remains:

- **No hidden server process.** Everything runs on-demand.
- **No database.** All state is files in `.wai/`.
- **No network requirement.** Works fully offline.
- **Fully observable.** All jobs, all results, all agent definitions are
  human-readable files in the repo.
- **Fully controllable.** Every subprocess is inherited stdio — you see
  exactly what the sub-agent is doing and can intervene at any time.

The MCP server wrapping (Phase 5) is additive — it exposes the same library
API over a transport. It does not change any of the above.

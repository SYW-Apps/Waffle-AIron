<!-- wairon-generated — do not edit directly -->
<!-- source: .wai/context/project.md — run `wairon context sync` to rebuild -->

# Project Context — gatekeeper-saas

# gatekeeper-saas

## Overview
A new project initialized with Wairon.
(The AI agent should overwrite this description with a complete overview of the project concept and stack once the user specifies their choices)

## Tech Stack
- [Specify Language, Framework, and Databases here]

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon.
- Refrain from writing code implementation until specifications are approved.

---

# Domain Map (1 domain)

| ID | Path | Name |
|----|------|------|
| `root` | `.` | gatekeeper-saas |

---

# wairon MCP Tools

The **wairon MCP server** is active in this project. You can call these tools directly:

| Tool | Purpose |
|------|---------|
| `listAgents` | List all registered agents (optionally filter by domainId) |
| `getAgent` | Get full details of an agent by id |
| `listDomains` | List all project domains |
| `validateTopology` | Check for topology errors/warnings |
| `getProjectConfig` | Get the project configuration |
| `listRuns` | List orchestration run records |
| `getRunStatus` | Get status of a specific run |
| `getStepResult` | Get the result from a pipeline step |
| `listPipelines` | List all pipeline definitions |
| `getPipeline` | Get a pipeline definition |
| `getPipelineStatus` | Get status of recent pipeline runs |
| `listSessions` | List AI session workspaces |
| `listJobs` | List delegated jobs |
| `getJob` | Get details of a specific job |

Prefer MCP tools over running `wairon` CLI commands when querying project state.

---

## wairon — AI Agent Topology Manager

Projects you work in may use **wairon** to manage AI coding agent topology.
wairon keeps a registry of agents in `.wai/registry/agents.json`. Agent files
(like the ones in `.claude/agents/`) are generated from that registry —
**never edit them directly**.

### Domain & agent model

A **domain** is a scoped area of a repository — a package, service, library, or
sub-project — that has its own set of agents. Each domain has an `id` (e.g.
`auth-service`), a `path` (relative to project root), and a set of agents that
own paths within it.

An **agent** belongs to exactly one domain (via its `domainRoot` field) or to
the global root. Agents declare `ownedPaths` — glob patterns that describe
which files they are responsible for.

### When to delegate

Use `wairon delegate` when:
- A task is clearly bounded to a single domain (service, package, library)
- The work can proceed independently without coordinating with other domains
- You want a focused sub-agent context with only the relevant agent set loaded
- The task would benefit from isolation (tests, refactors, migrations)

Do **not** delegate when:
- The task spans multiple unrelated domains (handle it at the root level)
- The change requires coordinating cross-domain contracts first
- The domain doesn't exist or has no agents yet (run `wairon scaffold-domains`)

### Delegation workflow

1. Identify the target domain id: `wairon domains list`
2. Delegate the task:
   ```
   wairon delegate <domain-id> --prompt "description of the task"
   ```
   This creates a **job file** at `.wai/jobs/<job-id>.yaml` and spawns a new
   AI tool session in the domain directory with `stdio:inherit`.
3. The sub-agent session starts with the job context loaded automatically via
   environment variables (`WAIRON_JOB_ID`, `WAIRON_JOB_FILE`).
4. When the sub-agent finishes, it writes a result file at
   `.wai/jobs/<job-id>.result.yaml` and the parent session reads + displays it.

### Job lifecycle

| Status      | Meaning                                              |
|-------------|------------------------------------------------------|
| `pending`   | Job created, session not started yet                 |
| `running`   | Session is active                                    |
| `completed` | Sub-agent wrote a result file and exited cleanly     |
| `abandoned` | Session exited without writing a result              |
| `failed`    | Session exited with a non-zero code                  |

Inspect jobs: `wairon jobs list` / `wairon jobs show <job-id>`

### Sub-agent job pickup protocol

When a new session starts in a domain directory and `WAIRON_JOB_FILE` is set:

1. Read the job file: it contains the task, context files, and notes.
2. Acknowledge the job by checking its status (it should be `running`).
3. Work exclusively within the domain's `path` and `ownedPaths`.
4. When done, write a result file at `<job-file-path>.result.yaml`:
   ```yaml
   jobId: <id>
   summary: "What was done"
   filesChanged:
     - path/to/changed/file.ts
   flagged: "Anything out of scope or that needs parent attention"
   ```
5. Exit cleanly — the parent session will pick up the result automatically.

If no `WAIRON_JOB_FILE` env var is set, operate normally without job context.

### Key commands
```
wairon list                       list all agents in the registry
wairon generate                   regenerate all agent files
wairon generate --domain <id>     regenerate only a specific domain
wairon validate                   check for topology issues
wairon create-agent               add a new agent interactively
wairon create-bundle              scaffold a set of agents from a template
wairon scaffold-domains           scaffold agents for domains that have none
wairon domains list               list all project domains
wairon domains scan --add         detect and add new domains
wairon delegate <domain-id>       spawn a focused session for a domain
wairon analyze                    analyze coverage gaps
wairon targets list               show configured output targets
wairon jobs list                  view all delegated jobs
wairon profiles list              view configured profiles (work/personal/etc.)
wairon mcp install                register the wairon MCP server in Claude Code
```

To update an agent: edit `.wai/registry/agents.json` and run `wairon generate`.

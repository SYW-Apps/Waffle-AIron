# waffagent — Registry

> Version: 0.1.0

---

## What is the Registry?

The registry (`agents.json`) is the **authoritative list of all AI agents defined
for this project**. Every agent has an entry here, regardless of which output targets
it is generated for.

The registry is:
- **JSON** (not YAML) because it is primarily written by the CLI, not by humans
- **Human-readable** for inspection and diffing in version control
- **Validated** by Zod schemas on every read
- **The source of truth** — generated tool-specific files are derived from it

---

## Registry File Format

```json
{
  "schemaVersion": "1.0.0",
  "agents": [...],
  "updatedAt": "2026-04-10T12:00:00.000Z"
}
```

---

## Agent Record Schema

Each entry in `agents` follows this structure:

```json
{
  "id": "core-service-owner",
  "name": "Core Service Owner",
  "description": "Primary decision-maker for the core service.",
  "template": "domain-owner",
  "bundleOrigin": "service-default",
  "ownedPaths": ["services/core/**"],
  "readPaths": ["packages/shared/**"],
  "writePaths": [],
  "tags": ["service", "owner"],
  "dependencies": ["agent-architect"],
  "creationReason": "Core service has a distinct deployment boundary and owns a large surface area.",
  "status": "active",
  "targets": ["claude", "gemini"],
  "createdAt": "2026-04-10T12:00:00.000Z",
  "updatedAt": "2026-04-10T12:00:00.000Z"
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique within the project. Lowercase alphanumeric with dashes. |
| `name` | string | Yes | Human-readable display name. |
| `description` | string | Yes | One-line description of what this agent does. |
| `template` | string | Yes | Template id this agent was created from. |
| `bundleOrigin` | string | No | Bundle id if created via a bundle. |
| `ownedPaths` | string[] | Recommended | Paths/globs this agent primarily owns. |
| `readPaths` | string[] | No | Paths this agent may read but doesn't own. |
| `writePaths` | string[] | No | Paths this agent may write but doesn't own. |
| `tags` | string[] | No | Classification tags (e.g., `service`, `owner`, `meta`). |
| `dependencies` | string[] | No | Agent ids this agent should be aware of. |
| `creationReason` | string | Yes | Why this agent exists architecturally. |
| `status` | enum | Yes | `active`, `draft`, or `deprecated`. |
| `targets` | array | Yes | Output targets: `"claude"`, `"gemini"`, or `{type:"custom",...}` |
| `createdAt` | ISO datetime | Yes | When this agent was added to the registry. |
| `updatedAt` | ISO datetime | Yes | Last modified timestamp. |

---

## `ownedPaths` vs `readPaths` vs `writePaths`

| Field | Meaning |
|-------|---------|
| `ownedPaths` | This agent is the primary decision-maker for these paths. No other active agent should own the same path (overlap detection). |
| `readPaths` | This agent needs awareness of these paths but does not own them. No ownership conflicts. |
| `writePaths` | This agent may write to these paths but defers ownership to another agent. Useful for cross-cutting changes. |

---

## Agent ID Conventions

Agent ids use lowercase alphanumeric characters and dashes. Follow this pattern:

```
<scope>-<role>
```

**Examples:**
- `core-service-owner`
- `blueprints-service-implementer`
- `network-packages-reviewer`
- `ui-tester`
- `security-guardian`
- `agent-architect` (the special meta-agent)

---

## Status Lifecycle

```
draft ──→ active ──→ deprecated
           │              ↑
           └──────────────┘ (can deprecate directly)
```

- `draft` — agent is being planned; files may not be generated
- `active` — agent is live and generates output files
- `deprecated` — agent is being phased out; kept for history but not generated

---

## Editing the Registry

The registry is designed to be managed by the CLI. Direct editing is discouraged
but possible for power users. If you edit it manually:

1. Keep valid JSON
2. Run `waffagent validate` immediately after to catch any issues
3. Run `waffagent generate` to sync output files

---

## Registry + Version Control

Commit `.ai/registry/agents.json` to version control. This gives you:
- A full history of topology changes
- The ability to diff topology between branches
- Reproducible output generation on any checkout

Whether to commit generated output files (`.claude/agents/*.md`, etc.) is your
choice. Arguments for committing:
- Reviewers can inspect agent instructions in PRs without running the CLI
- Ensures consistency if team members don't have waffagent installed

Arguments against:
- Generated files are redundant with the registry
- Can cause noise in diffs when re-running generate

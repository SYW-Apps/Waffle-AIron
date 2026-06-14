# wairon — CLI Reference

> Version: 0.1.0

---

## Global Options

```
--verbose    Enable verbose output (shows file paths, debug info)
--silent     Suppress all output except errors
-v, --version  Print version and exit
-h, --help   Show help
```

---

## Commands

### `wairon init`

Initialize wairon in the current project directory.

**Creates:**
- `.wai/` — source-of-truth directory
- `.wai/project.yaml` — project config
- `.wai/registry/agents.json` — agent registry (initially contains only the architect agent)
- `.wai/rules/topology.yaml` — topology rules
- `.wai/docs/topology.md` — starter topology notes
- `<target>/agent-architect.md` — architect agent for each selected target

**Options:**

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip interactive prompts, use defaults (claude target, project name = cwd name) |

**Interactive prompts:**
1. Project name (default: current directory name)
2. Which AI coding tools to target (multi-select: Claude Code, Gemini CLI, Other)
3. If "Other" selected: output directory and label

**Example:**
```sh
cd my-project
wairon init
```

```sh
# Non-interactive, use defaults
wairon init --yes
```

---

### `wairon generate`

Regenerate all agent output files from the registry.

This command is **idempotent** — running it multiple times produces the same output.

**Options:**

| Flag | Description |
|------|-------------|
| `--target <type>` | Limit generation to one target: `claude`, `gemini`, or `custom` |
| `--dry-run` | Preview what would be generated without writing any files |

**Example:**
```sh
# Regenerate everything
wairon generate

# Only regenerate Claude outputs
wairon generate --target claude

# Preview without writing
wairon generate --dry-run
```

---

### `wairon validate`

Validate the project config and agent registry for errors and rule violations.

Exits with code `1` if there are errors. Exits with `0` if only warnings or clean.

**Checks performed:**
- Project config is valid and has at least one enabled target
- No duplicate agent ids in the registry
- No overlapping `ownedPaths` between agents (if rule enabled)
- All non-meta agents have `ownedPaths` (if rule enabled)
- All agents have at least one output target

**Example:**
```sh
wairon validate

# Use in CI:
wairon validate && echo "Topology is valid"
```

---

### `wairon list` / `wairon ls`

List all agents currently in the registry.

**Example output:**
```
Agents (3)
──────────

agent-architect [architect] active
  Responsible for managing the AI agent topology of this project.
  owns: .wai/**
  tags: meta, architect
  targets: claude

core-service-owner [domain-owner] active
  Primary decision-maker for the core service.
  owns: services/core/**
  tags: service, owner
  targets: claude, gemini
```

---

### `wairon analyze` _(planned — Phase 3)_

Analyze the repository structure and report coverage against agent ownership.

---

### `wairon suggest-topology` _(planned — Phase 3)_

Suggest topology improvements based on the current registry and repository structure.

---

### `wairon create-agent` _(planned — Phase 2)_

Interactively create a new agent from a template and add it to the registry.

---

### `wairon create-bundle` _(planned — Phase 2)_

Scaffold multiple related agents from a bundle definition.

---

### `wairon split` _(planned — Phase 4)_

Split an existing agent into two or more focused agents.

---

### `wairon merge` _(planned — Phase 4)_

Merge two agents into one.

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (validation failure, not initialized, invalid config, etc.) |

---

## Environment

wairon always runs in the **current working directory**. Run it from your
project root.

There are no environment variables, global config files, or daemon processes.
All state is in `.wai/` inside the project.

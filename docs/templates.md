# wairon — Templates

> Version: 0.1.0

---

## What is a Template?

A template defines the **shape and behavior** of an agent type. It is a reusable
pattern that captures:

- The agent's role and responsibilities (as Markdown instructions)
- Default tags
- Whether the agent requires owned paths
- Version information

Templates are the building blocks. The registry holds the instances.

---

## Template Resolution

Templates are resolved in this order (first match wins):

1. **Project-local override**: `.wai/templates/<id>.yaml`
2. **Built-in**: `<wairon package>/src/templates/<id>.yaml`

This means you can override any built-in template by placing a file with the
same id in `.wai/templates/`. Your override is only applied to this project — it
does not affect other projects using wairon.

---

## Template YAML Format

```yaml
id: my-template          # required: unique identifier
name: My Template        # required: display name
version: 1.0.0           # required: semver
description: |           # required: short description
  What this template is for.
requiresOwnedPaths: true  # whether agents using this template must have ownedPaths
defaultTags:             # tags applied to agents created from this template
  - my-tag

instructions: |          # required: Markdown instructions for the agent
  You are the **{{agentName}}** agent.
  ...
```

### Variable Interpolation

The `instructions` field supports `{{variable}}` placeholders. These are replaced
at generation time using values from the agent record:

| Variable | Source |
|----------|--------|
| `{{agentId}}` | `AgentRecord.id` |
| `{{agentName}}` | `AgentRecord.name` |
| `{{agentDescription}}` | `AgentRecord.description` |
| `{{ownedPaths}}` | `AgentRecord.ownedPaths` joined with newlines |
| `{{tags}}` | `AgentRecord.tags` joined with commas |

Unknown variables are left as `{{variable}}` in the output.

---

## Built-in Templates

### `architect`

The meta-agent responsible for managing agent topology. Created automatically
during `wairon init`. Should not be used as a basis for domain agents.

- `requiresOwnedPaths: false`
- Default tags: `meta`, `architect`

### `domain-owner`

Primary decision-maker for a specific architectural scope (service, package family,
bounded context).

- `requiresOwnedPaths: true`
- Default tags: `domain`, `owner`

### `implementer`

Implements features and fixes within a specific scope.

- `requiresOwnedPaths: true`
- Default tags: `implementer`

### `reviewer`

Reviews changes within a scope for quality, correctness, and consistency.

- `requiresOwnedPaths: true`
- Default tags: `reviewer`

### `tester`

Owns test coverage strategy and test implementation for a scope.

- `requiresOwnedPaths: true`
- Default tags: `tester`, `qa`

### `guardian`

A cross-cutting agent that enforces a specific concern across the project
(security, API contracts, performance, compliance, etc.).

- `requiresOwnedPaths: false` (reads everywhere, owns no single domain)
- Default tags: `guardian`, `meta`

---

## Creating a Project-Local Template

1. Create `.wai/templates/<your-id>.yaml`
2. Follow the YAML format above
3. Run `wairon validate` to check for issues

The template will automatically be available when creating agents.

---

## Template Design Principles

- **Stay focused.** A template should define one clear agent role.
- **Be specific about responsibilities.** Vague instructions produce vague agents.
- **Document escalation paths.** The agent should know when to defer to others.
- **Keep it concise.** An agent that tries to do everything does nothing well.
  Aim for instructions that fit on one screen.

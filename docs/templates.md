# wairon — Templates

A **template** is a reusable agent *shape*: a YAML file with metadata and an
`instructions` body that is rendered (with the agent's id, name, owned paths,
etc.) into the final agent file. Templates are rendering shapes only — they are
not a source of truth. The agent topology itself is derived from the spec tree.

Built-in templates live in `src/templates/*.yaml`. Project-local overrides can be
placed in `.wai/templates/`.

---

## Built-in templates

| Template | Used for |
|----------|----------|
| `architect` | The `system-architect` meta-agent (maintains the spec tree) |
| `domain-owner` | A `<subsystem>-owner` or free-standing domain owner |
| `implementer` | A `<component>-implementer` (writes code 1:1 from a spec) |
| `reviewer` | A review-focused agent shape |
| `tester` | A testing-focused agent shape |
| `guardian` | A meta/guardian agent shape |

`agent_resolver` picks the template for each derived agent (`architect`,
`domain-owner`, `implementer`).

---

## Template format

```yaml
id: domain-owner
name: Domain Owner
version: 1.0.0
description: Short description.
requiresOwnedPaths: true
defaultTags: []
instructions: |
  You are **{{agentName}}**.
  Owns: {{ownedPaths}}
```

### Available render variables

`{{agentId}}`, `{{agentName}}`, `{{agentDescription}}`, `{{ownedPaths}}`,
`{{tags}}`.

---

## SDD skills (not templates)

The SDD skill files in `src/templates/skills/` (`sdd-architect`, `sdd-narrative`,
`sdd-auditor`, `sdd-implement`) are different: they are copied verbatim (with the
CLI command substituted) into each target tool's `skills/` directory by
`wairon skills install` and `wairon generate`. They drive the spec-driven
workflow in-session rather than rendering an agent file.

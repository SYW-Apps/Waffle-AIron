# waffagent — Bundles

> Version: 0.1.0

---

## What is a Bundle?

A bundle is a **recipe for creating a family of related agents** for a given scope.
Where a template defines a single agent shape, a bundle defines how multiple agents
work together to cover a scope completely.

**Example:** the `service-default` bundle creates four agents for a backend service:
- `<scope>-owner` (from the `domain-owner` template)
- `<scope>-implementer` (from the `implementer` template)
- `<scope>-reviewer` (from the `reviewer` template)
- `<scope>-tester` (from the `tester` template)

---

## When to Use a Bundle

Use a bundle when:
- You are setting up a new architectural scope (service, package family, UI module)
- You want a consistent, balanced coverage pattern across scopes
- You don't want to manually create each agent one at a time

Use individual templates (via `create-agent`) when:
- The scope is unusual and doesn't fit a standard pattern
- You only need one specific role for a scope
- You are adding a cross-cutting guardian

---

## Bundle Resolution

Bundles resolve in the same order as templates:

1. **Project-local override**: `.ai/bundles/<id>.yaml`
2. **Built-in**: `<waffagent package>/src/bundles/<id>.yaml`

---

## Bundle YAML Format

```yaml
id: my-bundle            # unique identifier
name: My Bundle          # display name
version: 1.0.0
description: |
  When to use this bundle and what it creates.

agents:
  - idSuffix: owner          # appended to scope to form agent id
    template: domain-owner   # which template to use
    namePattern: "{{scope}} Owner"          # {{scope}} is replaced with scope name
    descriptionPattern: "Owns the {{scope}} module."
    ownedPathPatterns:
      - "{{scopeDir}}/**"    # {{scopeDir}} is replaced with the scope directory
    tags:
      - owner
```

### Pattern Variables

| Variable | Meaning |
|----------|---------|
| `{{scope}}` | The scope name provided at bundle creation time (e.g., `core-service`) |
| `{{scopeDir}}` | The scope directory provided at bundle creation time (e.g., `services/core`) |

---

## Built-in Bundles

### `service-default`

Standard four-agent set for a backend service.

**Creates:**
| Suffix | Template | Purpose |
|--------|----------|---------|
| `owner` | domain-owner | Architectural owner |
| `implementer` | implementer | Feature implementation |
| `reviewer` | reviewer | Code review |
| `tester` | tester | Test coverage |

**Use when:** you have a distinct service with its own source tree and deployment unit.

**Example:**
```sh
waffagent create-bundle \
  --bundle service-default \
  --scope core-service \
  --dir services/core
```

Creates: `core-service-owner`, `core-service-implementer`, `core-service-reviewer`,
`core-service-tester`

---

### `package-family-default`

Three-agent set for a package family (group of related packages).

**Creates:**
| Suffix | Template | Purpose |
|--------|----------|---------|
| `owner` | domain-owner | Family coordinator |
| `implementer` | implementer | Cross-package implementation |
| `reviewer` | reviewer | API and quality review |

**Use when:** you have a group of related packages (e.g., `packages/network/**`)
that share conventions but don't have a single runtime boundary.

---

## Creating a Project-Local Bundle

1. Create `.ai/bundles/<your-id>.yaml`
2. Follow the YAML format above
3. Run `waffagent create-bundle --bundle <your-id> ...` to use it _(Phase 2)_

---

## Bundle vs Direct Agent Creation

| | Bundle | Individual Agent |
|-|--------|-----------------|
| When | Establishing a new scope | One-off, non-standard role |
| Agents created | Multiple (family) | One |
| Path patterns | Inferred from scope dir | Specified explicitly |
| Consistency | Enforced by bundle definition | Manual |

Bundles are not mandatory — every agent in the registry was eventually created
individually, whether through a bundle or not. A bundle is a shortcut for the
common case.

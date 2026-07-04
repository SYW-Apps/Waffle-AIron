# Wairon Feature Request: Hosted, Multi-Tenant MCP Server

**Requested by:** Robbe Vrijenhoek (Appenser / wairon wrapper project)
**Date:** 2026-07-04
**Context:** Building Appenser, a Make.com doctrine wrapper on wairon. Working entirely from within Langdock (an enterprise AI platform) rather than a local Claude Code / Gemini CLI setup surfaced several gaps between wairon's current (local, CLI-first) execution model and a hosted, multi-tenant, MCP-only usage pattern. This document summarizes the capabilities we'd like wairon to support.

---

## 1. Hosted, multi-tenant MCP server mode

**Problem today:** `wairon mcp serve` is documented as a local process, `stdio`-attached to a single coding tool working against a single on-disk repo. There's no mode for running wairon as a standing service that multiple clients/projects can connect to remotely.

**Request:** A `wairon mcp serve --http` (or similar) mode that:
- Exposes the existing `sdd_*` tool surface over **streamable HTTP**, not just stdio, so it can be reached by remote MCP clients (e.g. a Langdock custom agent) rather than only a co-located CLI tool.
- Can be packaged as a **Docker image** for self-hosting (e.g. on GCP, or any container platform) — a self-contained binary with an HTTP wrapper, no external dependencies required for a basic deployment.
- Persists spec trees to a **local/mounted filesystem** (`/data/projects/<project-id>/.wai/...`) so wairon itself is the source of truth and durability layer — not dependent on any particular git host to function.

**Why:** Removes the need to run wairon inside a sandboxed AI-tool shell (fragile, non-persistent, no real network access in many AI platform sandboxes) and instead lets any MCP-capable client connect to a real, durable, always-on wairon instance.

---

## 2. Multi-project support behind a single MCP endpoint, scoped by authentication (not by client-supplied parameters)

**Problem today:** No multi-tenancy model exists. A hosted instance needs to serve many independent spec trees ("projects"/workspaces) without one client being able to access another's data.

**Request:**
- A single running wairon MCP endpoint should be able to serve **multiple projects**, each with its own isolated `.wai/` spec tree.
- **Project scope must be derived from the authenticated session/token, not from a client-supplied parameter.** I.e., an API key/OAuth token issued for Project A must be server-side bound to Project A; the server rejects or ignores any attempt by that token's calls to reach another project's tree. A `project` selector parameter is acceptable as a convenience for tokens explicitly authorized for multiple projects, but must never itself be the authorization mechanism.
- Explicitly **not requesting** a model where a new MCP server process is spawned per project — that adds operational complexity (process/port lifecycle, discovery) without a corresponding benefit, since MCP tool calls can be made stateless per-request against a shared service.

**Why:** This is the standard, defensible multi-tenant pattern (auth-derived scope) and avoids both the operational cost of per-project server spawning and the security risk of trusting client-declared scope.

---

## 3. Authentication layer for the hosted MCP server

**Problem today:** No auth story exists for a networked MCP server (local `stdio` mode has no need for one).

**Request:** Support at least one straightforward auth mechanism suitable for internal/company deployments as a v1 — e.g. static API keys mapped to authorized project ID(s) via a config file or injected secret — with a clear upgrade path to OIDC/OAuth for broader or external exposure later. Full enterprise identity federation is **not** a v1 requirement; a defensible internal-tool-grade auth model is sufficient to start.

---

## 4. Privileged, commit-scoped `sdd_init` and `sdd_lock` MCP tools, with re-validation enforced at merge time

**Problem today:** `wairon init` and `wairon lock` are CLI-only, unavailable via MCP. If exposed via MCP naively, a "lock" recorded once could be trusted even after the underlying branch/commit has since changed — a stale-approval / time-of-check-to-time-of-use gap.

**Request:**
- Expose `sdd_init` and `sdd_lock` as MCP tools, but treat them as **privileged** relative to the rest of the `sdd_*` surface (e.g. only callable by a specifically authorized identity/role, such as a hosting/orchestration layer rather than every ordinary editing session).
- `sdd_lock` must:
  1. Run `wairon validate` fresh, at the current state of the spec tree.
  2. Only if validation passes, write a **lock record scoped to the exact commit/state it validated** (e.g. `{ stateId/commitSha, lockedAt, validationResult }`), not a free-floating "this project is locked" flag.
  3. **Never perform a merge to any main/production branch or state itself.** At most, it should be able to open/update a pull request (if git-backed) or mark a change-set as "ready," leaving the actual promotion action to a separate, human-gated step.
- Whatever mechanism promotes locked changes to the canonical/production state (a git merge, or an equivalent "promote" action in wairon's own native storage) must **re-check that the lock record's scoped commit/state ID matches the current state exactly** before allowing promotion. Any change made after locking must invalidate the lock automatically (by the state ID no longer matching), forcing re-validation and re-locking — not by requiring anyone to remember to manually invalidate a stale lock.

**Why:** This closes a real correctness/safety gap: without commit-scoped lock validity plus a mandatory re-check at promotion time, it's possible to lock a valid spec tree, make further (possibly broken) changes, and still merge/promote on the strength of the earlier, now-stale lock.

---

## 5. (Lower priority / later) Pluggable persistence & sync backends

**Problem today:** If/when git-backed persistence is desired, wairon currently has no first-class model for it, and we don't want to hard-couple wairon's core storage model to one git host (GitHub) on day one — GitLab, other git hosts, or entirely non-git backends (e.g. Notion) may be desirable later.

**Request:** Treat wairon's own native on-disk (or hosted-instance-managed) storage as the primary source of truth, and treat git-host integration (GitHub, GitLab, etc.) or other external sync targets as **optional export/mirror/sync features** layered on top — e.g. a future `wairon sync --git <remote>` — rather than a required dependency for wairon to function at all.

**Why:** Keeps wairon host-agnostic and avoids picking a single vendor's collaboration model (PRs, branch protection, etc.) as the only supported workflow.

---

## Explicitly out of scope / not being requested

- Per-project MCP server process spawning (see #2).
- A `wairon generate --target <specific-AI-platform>` "subagent" template for platforms that don't support isolated subagent dispatch the way Claude Code/Gemini CLI do — this pattern is only valuable where the host tool provides genuine context isolation for spawned subagents; generating a redundant role-description file for a platform without that mechanism (which we already read the underlying specs directly) adds no value and was considered and rejected during our own design process.
- Full enterprise SSO/identity federation as a v1 requirement for the hosted MCP server.
- `sdd_lock` (or any MCP tool) performing an actual merge/promotion to a production branch/state — this must remain a separately gated action.

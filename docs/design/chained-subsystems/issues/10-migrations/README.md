# 10 — Migrations: create, externalize, internalize, move, rename

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 10

## Summary

Each migration updates the parent's own tree at most. References in other chained
children are left untouched, only flat children can be folded back, nested subsystems
cannot migrate, and mounts cannot be renamed.

## Evidence in this repository (`dev`, 2026-09-12)

- Create scaffolds `project.yaml` and L0 in the child, no subsystem:
  `createChainedSubsystem`, `src/core/provision.ts` ~249–279; `ensureProjectInitialized`
  ~91.
- Externalize and internalize rewrite references only under the parent's `.wai/specs`:
  `rewriteRefsInDir` ~503, called at ~409 and ~468. Implementation paths are rebased
  (`rebaseImplementationPaths` ~587).
- Internalize requires a flat child (~441–444); both refuse namespaced ids (~347, ~420).
- Move renames the directory and updates the mount only: `moveSubsystemProject`
  ~286–318.
- Tests cover siblings inside the same tree only: `tests/core/subsystem-migration.test.ts`.
- Mount tools: `src/mcp/server.ts` ~920–999. There is no rename tool.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — family-wide, dry-run-first migrations that refuse when a referencing member is absent; `detach`, `adopt` and `rename` added; `move` touches no reference
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — stable ids plus local aliases make move and alias-rename free; externalize emits a plan and patches for repositories it cannot edit; `relation convert --to dependency`; temporary `legacyReferences` redirects with an expiry
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — classify operations by semantic effect (a table from alias rename to id rename); plan/apply with expected digests, per-owner patches and a list of unavailable owners; one commit per repository, the composition manifest published last; member→consumption is a relation edit
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — every migration produces a before/after ownership plan; P7: externalize leaves a moved subsystem's outgoing reference dangling; internalize deletes the child's whole `.wai`; no atomicity claim across repositories

## Proposals

- none yet

## Decision

- 2026-09-12 — References that reach another project only at L1 are migrated by `doctor --fix` as a planned family migration: a dry run lists the exports each producer lacks and every reference rewrite; applying adds those exports and rewrites the consumers, and refuses when a producer is absent. See [decisions.md](../../decisions.md).

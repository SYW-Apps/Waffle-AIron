# 08 — Repository layouts and version control

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 08

## Summary

A child must live inside its parent's directory. Hosted git backup never covers a
child's `.wai/`, while tree archives do. Approval pins and version-control pins are
unrelated.

## Evidence in this repository (`dev`, 2026-09-12)

- Containment rejects absolute and escaping paths: `src/core/specs.ts` ~196–222, at every
  write site in `src/core/provision.ts` and at load (`PROJECTPATH_ESCAPE`).
- A missing child directory is a `SUBPROJECT_NOT_FOUND` error and the child is skipped:
  `specs.ts` ~928–936.
- Git scope `.wai/` at the bound root: `src/git/orchestrator.ts` ~19;
  `src/git/adapter.ts` ~71–77. Hosted commits and mirror sync are scoped the same way:
  `src/server/admin.ts` ~414–440; `src/server/gitbacking.ts` ~456, 476. The gap is
  acknowledged in a comment at `admin.ts` ~262–272.
- Tree archives include every chained root's `.wai`, lock record included:
  `src/core/treetransfer.ts` ~218–253.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — contain = inside the parent (monorepo, submodule); consume = anywhere via an external with a `path:` source; approval pins and commit pins both recorded, kept distinct
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — general source resolvers (`path`, `../path`, `git url+rev`, `hostedProject`) with `wairon sync`; VCS revision and approval digest bound side by side, never merged; hosted backup per project's own repository configuration
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — explicit source bindings (nested `path`, a `workspace` descriptor for side-by-side checkouts, immutable fetched sources); the escape restriction stays for nested paths; hosted backup commits `.wai` once per git repository plus a composition manifest linking revisions and approval subjects
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — explicit source and workspace bindings; hosted git enable adds `.wai/lock.json` to `.git/info/exclude`, contradicting a committed approval; archive completeness is conditional (correction 6); commits, contract digests and approval digests kept separate

## Proposals

- none yet

## Decision

- open

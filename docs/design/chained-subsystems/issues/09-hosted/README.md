# 09 — Hosted: a child as a project, a part, or both

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 09

## Summary

A hosted child exists only as a mount inside its parent's project plus, optionally, a
credential narrowed to it. Confinement is enforced tool by tool, the web UI has no child
scope, and connected agents are not told they are inside a chained subsystem.

## Evidence in this repository (`dev`, 2026-09-12)

- Binding a qualified selector and resolving each mount hop:
  `src/server/projects.ts` ~193–219, 257–259, 272–307. Minting a narrowed credential:
  ~228–242 and `web/src/views/Tokens.tsx` ~111–163.
- Request scope, top root and parent reach, with permission checks and audit on the top
  project: `src/server/request.ts` ~641–648, 691.
- Confinement lists and forwarding: `request.ts` ~180–205, 375–402, 457–461, 526–557.
- Web views gate on whole hosted projects before resolving a root:
  `src/server/web.ts` ~585–649. The web lock takes no subproject:
  `src/server/admin.ts` ~208–214.
- Mount tools act on the bound root's own tree, so a child cannot re-mount itself:
  `src/mcp/server.ts` ~920–999.
- The chaining announcement goes to the server's stderr: `src/mcp/server.ts` ~1660–1681.
  A server is created per request (`request.ts` ~699).
- The canvas has no mount node: `src/core/diagram.ts` ~74–102.
- Enabling git requires a new project root: `admin.ts` ~363–389.

Confinement details beyond the design question are tracked with the maintainers, not in
this folder.

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — stage 1: confinement as a property of the binding (tools declare `scope`); stage 2: members registered as hosted projects with `parentProjectId`, families a relation kind beside units
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — every logical project gets a hosted record; `ProjectRelation(member | dependency)`; a child credential is a `ProjectHandle` confined at resource access, so record-level tools need no prohibition list
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — every project registered once; every operation bound to `(principal, projectId, action, permitted artifacts)` in the common project service and filesystem gateway; family access by explicit member grants; audit records the initiating composition
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — one canonical registration per writable root, compositions reference it; every operation classified for scope, unclassified refused; parent discovery precedes the reach check on the validation path; containment depends on the loading root (filed at design level)

## Proposals

- none yet

## Decision

- 2026-09-12 — Hosted git backing commits `.wai/lock.json` (decision 2), and containment is decided against the owning root (3); discovery sits behind the reach gate and every hosted tool declares a scope, failing closed — all merged in #69. Members as hosted project records (stage 7) are still open. See [decisions.md](../../decisions.md).

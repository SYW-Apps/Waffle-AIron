# Seat 4: Hosted operator (conditional). Read fully before doing anything.

This seat runs only when the release changes the hosted server (see docs/release-qa.md, stage 3), or
when the maintainer marks hosted as in scope.

You are a REAL HUMAN engineer who runs internal tools for a small company. Your team wants to share one
wairon project (a spec-driven-development tool for AI coding agents) between several people through a
hosted server with a web UI, instead of everyone keeping a checkout. You are not a wairon developer and
you have not read its source. You learn it from `wairon --help`, `wairon serve --help`, `wairon host
--help`, the README and docs in the installed package, and your AI coding assistant.

## Your environment (mandatory)
Your task gives you these values (environment variables or pasted in):
- `QA_SEAT_DIR`: your own folder. Work ONLY inside it, including the server's data directory. Never
  write anywhere else, never touch a real user config, never touch a source checkout of wairon. Use
  loopback addresses and ports above 20000 so nothing else on the machine is affected.
- `QA_TOOLCHAIN`: the release candidate toolchain. Default on Windows: `C:\wairon-qa\toolchain-rc`. Docs:
  `$QA_TOOLCHAIN/node_modules/@wairon/cli/` (README.md, docs/).
- `QA_SCENARIO`: your scenario, from the bank below.
- `QA_FINDINGS_DIR`: where your `FINDINGS.md` goes.

Git Bash: before every shell command run `export PATH="$QA_TOOLCHAIN/bin:$PATH"`. The wrapper isolates
all user-level config. Never call any other wairon. Start the server in the background and stop it when
you finish.

Your AI assistant is Claude Code, driven headless through `$QA_TOOLCHAIN/bin/ask-claude <project-dir>
<prompt-file> [session-id]`. It runs on the model in `QA_MODEL` (Sonnet by default); do not change it.
Budget: at most about 12 assistant turns in total. Most of this seat is the CLI, the browser-facing
endpoints and HTTP calls you make yourself; use the assistant for the two users' design work.

## What we want from you

1. Set the server up from the docs alone: a data directory inside your folder, the web UI enabled, the
   admin plane on loopback. Run the hosted doctor if the docs say to.
2. Create two users with different roles, a shared project, and tokens for each user. Check from the
   docs how a person signs in to the web UI and how an AI tool connects with a token.
3. User A designs part of the system through the assistant against the hosted project (the assistant
   gets the hosted MCP entry from `wairon mcp install --hosted ...`). User B connects separately, sees
   A's work, and adds to it. Check each user sees only what their role allows, that a token narrowed to
   one subsystem stays inside it, and that a refused action says why.
4. Approve the design the way the docs describe for a hosted project, and check the approval is
   visible to both users.
5. Use the web UI (fetch its pages and API calls with curl, or any browser available): canvas, specs,
   the admin views for users and tokens. Check they load, match the CLI's view, and update after a
   change.
6. Stop and restart the server on the same data directory; check nothing was lost.

Record every friction in `FINDINGS.md` in `QA_FINDINGS_DIR` as you go:
- **BLOCKER**: you could not proceed, data was lost, access was wider or narrower than the docs say, or a
  wrong result was presented as right.
- **MAJOR**: confusing or misleading behaviour, a doc that does not match, a step a normal operator would
  get wrong, the assistant misusing wairon because the tool, skills or guide led it astray.
- **MINOR**: rough edges, wording, slowness.
- **GOOD**: things that worked well (short).

Classify every BLOCKER and MAJOR as **CORE** (the everyday loop of a hosted team: setup from the docs,
sign-in, shared design, roles, tokens, approval, restart) or **EDGE** (rare shapes, exotic migrations,
export-format details, deliberate tampering, concurrency). Do not inflate an edge into core and do not
hide a core problem as edge. Each finding: what you did, what you expected, what happened (exact
message or output excerpt), the command or request to reproduce, and whether the problem is in wairon
itself, its docs, or the assistant's behaviour. If you see an access problem, describe the symptom a
user would notice and the setup that shows it; do not write a step-by-step way to abuse it, because
these notes are read by people outside the team.

Finish with a short summary at the top of `FINDINGS.md`: counts split CORE and EDGE, top 3 issues, and
one line: **"Ready for release: yes / no, because ..."**. Return that summary.

## Scenario bank

The scenario is picked by the release version (see docs/release-qa.md), so the same release always gets
the same one. Do not choose another.

| # | Scenario | What the shared project is |
|---|---|---|
| 0 | Team knowledge base | Pages, tags and a search, an editing workflow with reviewers, an HTTP API. |
| 1 | Support desk | Tickets, queues and agents, an assignment workflow, an HTTP API. |
| 2 | Release board | Releases, checklists and sign-offs, a gating workflow, an HTTP API. |

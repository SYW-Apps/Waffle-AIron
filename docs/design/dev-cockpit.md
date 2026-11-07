# Design: `wairon dev` as the local cockpit

Status: design for the first cockpit PR. A second PR adds the family and externals panel (see the end).

## The goal

The developer has their IDE and an agent on one side and the `wairon dev` page on the other. The
page shows the design live as the agent changes it, and it is where the human approves: an agent
asks for a review or a lock, the page shows what changed and why, and the human locks it or sends
it back with comments. The agent hears the answer without the human typing "specs are locked".

## What already exists

- The hosted server already locks (`POST /web/projects/lock`) and runs approval requests
  (`sdd_host_lock_project`, `sdd_host_await_approval`, `Approvals` view), but an agent on the local
  stdio MCP server never reaches them, and in dev mode the one local principal approves everything
  directly.
- The page refreshes on realtime nudges, but only for writes through the dev server itself: spec
  writes from `wairon mcp serve`, a separate process, do not reach it until a manual refresh.
- The page's lock is the hosted lock, not `wairon lock`: no `--subsystem`, and the approver is the
  hosted principal rather than this machine's git identity.

## Decisions

1. **Live from any process.** The dev server watches the served project's `.wai/` folder and nudges
   the page on every change (specs, lock record, review requests), debounced.
2. **Review requests live in the project, ignored by git.** An agent calls `sdd_request_review`
   (`kind: review` for feedback only, `kind: lock` for approval) with a note. The request is written
   under `.wai/.local/reviews/`, which `.wai/.gitignore` keeps out of commits, and carries the design
   identity it was made against. It works whether or not a dev server runs: the tool answers where
   the request is shown (the dev page's URL when one announces itself in `.wai/.local/dev-server.json`,
   otherwise "ask the human to open `wairon dev` or run `wairon lock`").
3. **The agent waits with `sdd_await_review`.** It blocks until the request is decided, sending a
   progress notification every few minutes so a long wait never hits Claude Code's 30-minute idle
   limit; Claude Code moves a call past 2 minutes to the background, so the agent keeps working and
   receives the answer as a task notification. A lock request is answered by any lock that covers its
   design, the terminal's `wairon lock` included. A design that changed after the request supersedes
   it, and the answer says so.
4. **The human decides in the page.** A pending request pops up; its review screen shows the agent's
   note and every spec changed since the last approval. The human locks (a lock request) or approves
   (a review request), or sends it back with a comment and notes pinned to individual specs, which
   the agent receives in full.
5. **The page's commands are the CLI's own.** `wairon dev` hands the dev server the CLI's lock
   (whole design or one subsystem, this machine's git identity as approver), `generate` and
   `doctor --fix`; the page runs them and shows their output. The agent never locks: the request
   tools only ask.
6. **Hosted.** On the hosted data plane `sdd_request_review` (`kind: lock`) creates the existing
   pending approval request and `sdd_await_review` waits on it, so an agent uses the same two tools
   everywhere; the hosted approval rights decide who may approve. `kind: review` is local only.

## Revision after the first look: the whole page is the cockpit

The first build put the commands on their own tab. The human wants the page itself to be the
cockpit, and it was slow.

7. **No commands tab.** A floating action bar shows on every view while there is something to
   approve: a pending request, or a design that moved since the last lock. It offers Lock (or
   Review for a request). The specs view and the diagrams offer Lock in place, scoped to the
   subsystem in view when only that subsystem moved.
8. **Every lock is confirmed.** Lock opens a modal: what moved since the last lock, the current
   warnings, whole design or one subsystem. Confirm runs the CLI's lock and the modal shows it
   running, then its output.
9. **Generate and doctor in the settings panel.** The header cog opens the settings panel
   (appearance, Generate, Doctor --fix, each explained and showing its output).
10. **The approval state is served as data** (`GET /web/dev/approval`: the lock verdict with the
    moved specs, who locked and when), so the bar and the modal never parse status text.
11. **Validation is remembered.** On this repository the owner's gate takes about 25 seconds and the
    page ran it twice per view (the canvas's findings overlay and the validation rail), every view.
    A validation memo answers the last run with the same options while nothing the gate reads has
    changed: the `.wai/` files and the gate's source files, compared by path, size and modification
    time (as the code model cache already does). It sits behind the validator portal, so the dev
    page, the hosted server and an agent's repeated `sdd_validate_tree` all gain from it.

The SYW Design System adoption (every view, bundled at build) is a separate PR after this one.

## Second PR: family and externals panel

Externals status and pins, network declare and member migrations in the page, each explained in
plain language: what an external is and what its pin protects, drift as "the producer changed X
since you pinned", every member migration previewed with its dry-run plan before it is applied. It
also designs what can be automated (for example offering to re-pin compatible externals as part of a
lock), so most people never need to learn the mechanics.

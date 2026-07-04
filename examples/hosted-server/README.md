# Example: hosting server (`wairon serve`)

A self-contained, runnable demo of the wairon **hosting server** — wairon served
over HTTP for many fully-isolated projects, with an admin control plane and a
state-scoped lock/promote. See the
[hosted server guide](../../docs/design/hosted-mcp-server.md) for the full
architecture, Docker deployment, auth, and sizing.

## Run it (no Docker needed)

```sh
npm run build                       # once — the demo drives the built CLI
node examples/hosted-server/demo.mjs
```

[`demo.mjs`](demo.mjs) spins everything up against a throwaway temp data dir and
verifies each step (it exits non-zero if anything fails):

1. **Control plane (in-process):** `wairon host project create` provisions an
   isolated `.wai/` tree; `wairon host key mint` issues a project-scoped editor
   key (shown once). No server needed for admin — this is the `docker exec` / SSH
   path.
2. **Start the server:** `wairon serve` (data plane `:8987`, admin `:8988`).
3. **Data plane auth:** `POST /mcp` with no token / a bad token → `401`.
4. **Scoped tool call:** a valid key completes MCP `initialize`, then
   `sdd_get_status` returns `● System: demo` — proving the call was bound to the
   *demo* project's tree via per-request `AsyncLocalStorage`.
5. **State-scoped lock → promote:** `wairon host lock` validates as-complete and
   writes `.wai/lock.json` scoped to a deterministic `StateId`; `promote` matches
   → ready.
6. **TOCTOU guard:** editing a spec after locking makes `promote` refuse
   (`re-lock required`) until you re-lock.

Override ports with `DEMO_PORT` / `DEMO_ADMIN_PORT` if `8987`/`8988` are taken.

## The same flow by hand

```sh
export WAIRON_ADMIN_TOKEN=$(openssl rand -hex 32)
export WAIRON_DATA_DIR=/tmp/wairon-demo

wairon host project create --id acme
KEY=$(wairon host key mint --project acme --role editor | grep -o 'wk_[a-f0-9]*')

wairon serve --data-dir "$WAIRON_DATA_DIR" &        # data :8080, admin :8081

curl -s -XPOST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sdd_get_status","arguments":{}}}'

wairon host lock --project acme
wairon host promote --project acme
```

## Git-backed projects — repo as the source of truth

Instead of the container being canonical, point a project at a **git repo**: the
repo becomes the source of truth, teammates clone it and edit locally via their
own AI tools, and the container works on an isolated branch and opens PRs.

### 1. Give the container a git identity (once)

The container commits + pushes as a **bot**. Set these on the server (env / Docker
secret):

```sh
WAIRON_GIT_TOKEN=<a token with push access>   # GitHub PAT (repo scope) / GitLab token / …
WAIRON_GIT_NAME="wairon-bot"                   # committer name (optional)
WAIRON_GIT_EMAIL="wairon-bot@your.org"         # committer email (optional)
```

The token is injected into the clone URL for `https://` remotes and lives only in
the container-local `.git/config` — never in the repo. One identity serves all
git-backed projects, so give it access to the repos you host.

### 2. Enable git on a project (clones the repo)

```sh
# CLI (on the box / docker exec) — creates a fresh git-backed project by cloning
wairon host git enable --project acme --remote https://github.com/acme/specs.git --branch main

# …or the admin API
curl -XPOST https://<host>/admin/projects/acme/git \
  -H "Authorization: Bearer $WAIRON_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"remote":"https://github.com/acme/specs.git","branch":"main"}'
```

The container clones the repo and checks out an **isolated working branch**
(`wairon/work`); it never commits to `main`.

### 3. Edit → lock → PR

Edit the specs over the data plane as usual (the `sdd_*` MCP tools). When ready:

```sh
wairon host lock --project acme
#  → validates as-complete, promotes, commits + pushes wairon/work, prints a compare URL
```

Open the printed **compare URL** to raise the PR into `main` (push-only — wairon
doesn't call the GitHub/GitLab API). Use `wairon validate --ci` as the PR status
check. You merge it — wairon never merges.

### 4. Pull collaborators' merged work

```sh
wairon host git sync --project acme      # integrates main into the working branch
```

(`lock` auto-syncs first, so a lock is always based on the latest `main`.)

### 5. Collaborate locally

Because the repo is canonical, teammates just clone and work locally:

```sh
git clone https://github.com/acme/specs.git && cd specs
# edit specs with wairon locally (their AI tool + the sdd_* tools), commit, open a PR
```

The hosted container and every local clone are equal participants on the same repo.

### Disable

```sh
wairon host git disable --project acme   # stops git backing (leaves the checkout in place)
```

`.wai/lock.json` and `.wai/git.json` stay container-local (excluded from commits);
the Docker image already ships with `git`.

## Deploying for real (Docker)

```sh
echo "WAIRON_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build                        # from the repo root
docker compose exec wairon wairon host project create --id acme
docker compose exec wairon wairon host key mint --project acme --role editor
```

The data plane (`:8080/mcp`) is what a remote MCP client (e.g. a Langdock custom
agent) connects to with `Authorization: Bearer wk_…`; put TLS in front. The admin
plane stays on localhost — administer via `docker compose exec`.

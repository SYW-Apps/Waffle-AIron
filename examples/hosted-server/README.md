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

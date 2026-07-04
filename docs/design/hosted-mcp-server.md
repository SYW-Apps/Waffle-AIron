# Hosted wairon — the `sdd_host` server & self-hosting guide

> Status: **implemented** (`sdd_host` subsystem + `wairon serve` / `wairon host …`).
> Responds to [`docs/wairon-feature-requests-hosted-mcp.md`](../wairon-feature-requests-hosted-mcp.md).
> This is both the architecture-as-shipped and the operator's self-hosting guide.

---

## 1. What it is

`wairon serve` runs wairon as a long-running **HTTP server** that hosts **many
fully-isolated, independent wairon projects** behind one endpoint. Each project
is its own `wairon init` tree under a data root — they never interact; they
share only the process and the disk.

> **Not multi-tenant sub-structure, and not subsystem chaining.** A wairon
> *subsystem* (even an external one via `projectPath`) is part of *one* system.
> Hosted **projects** are separate systems entirely. Isolation is at the
> workspace-root level — the same `workspaceFor(rootDir)` model wairon already
> uses, now bound per HTTP request.

It exists so an MCP-capable client (e.g. a Langdock custom agent) can reach a
real, durable, always-on wairon over the network instead of running it inside a
fragile, non-persistent AI-tool sandbox.

---

## 2. Two planes

The server splits a public **data plane** from an admin **control plane**, on
**separately-bound listeners**:

| Plane | Bind (default) | Auth | Surface |
|---|---|---|---|
| **Data** | `0.0.0.0:8080` | project API key (bearer) | `POST /mcp` (the `sdd_*` tool surface), `GET /healthz`, `GET /readyz` |
| **Control** | `127.0.0.1:8081` | master credential (`WAIRON_ADMIN_TOKEN`) | `/admin/projects`, `/admin/keys`, `/admin/projects/{id}/lock`, `/admin/projects/{id}/promote` |

The data plane **reuses `sdd_mcp` unchanged** — `host_mcp_adapter` calls
`createMcpServer()` and runs it inside the request's bound project scope, so the
existing `sdd_*` tools resolve to the right `.wai/` tree with no changes to them.
The control plane owns **project & key lifecycle plus the state-scoped
lock/promote**, and is reachable two ways that hit the *same* logic: the HTTP
admin API, and the `wairon host …` CLI (in-process — no server needed).

### Request flow (data plane)

```
POST /mcp  ─▶ host_http_portal
           ─▶ host_request_orchestrator:
                1. authenticate bearer token → Principal        (401 if invalid)
                2. resolve authorized project (+ optional selector, never widening)
                   → isolated root                              (403 if not authorized)
                3. runWithProjectRoot(root):                    ← AsyncLocalStorage
                     createScopedServer() → StreamableHTTPServerTransport
                     → dispatch the sdd_* tool call, scoped to that project
```

The **request-scoped root** (`runWithProjectRoot`, `src/utils/fs.ts`) is the
linchpin: `getProjectRoot()` consults an `AsyncLocalStorage` first, so a single
process serves concurrent requests for different projects with no global-state
race and no changes to the ~20 `sdd_*` handlers.

---

### Diagrams over the API

The hosted server reuses the same diagram engine as `wairon diagram` (a
first-class `diagram_specialist`), generated on demand and scoped to the project:

- `POST /admin/projects/{id}/diagram` (body `{format}`) — generate; returns the
  artifact (`canvas` HTML · `mermaid` · `drawio` · `excalidraw`). *[bearer]*
- `GET  /admin/projects/{id}/diagram/{format}` — download (attachment). *[bearer]*
- `GET  /admin/projects/{id}/canvas-link` — mint a short-lived **signed** view
  link. *[bearer]*
- `GET  /view/diagram?token=…` — open the canvas in a browser; the HMAC-signed,
  expiring token *is* the capability, so **no bearer** is needed (browsers can't
  attach one to a navigation). Signed with `WAIRON_SIGNING_SECRET` (else
  `WAIRON_ADMIN_TOKEN`); TTL ~5 min.

## 3. Authentication & the bootstrap

Auth is **on by default** and **toggleable** (`--no-auth`, for a trusted/VPN-only
network — the operator owns that risk).

- **Master credential** — `WAIRON_ADMIN_TOKEN` (an injected env secret). It gates
  the entire control plane. This solves the bootstrap chicken-and-egg: you can
  create the first project and mint the first key **before any credential store
  exists**. The server *refuses to start* with auth on but no `WAIRON_ADMIN_TOKEN`
  (you'd be unable to administer).
- **Project API keys** — minted via the control plane, stored **hashed**
  (salted SHA-256, constant-time compared) in `<dataDir>/auth/credentials.json`.
  Each key is bound server-side to a role (`editor` | `admin`) and an authorized
  project set. The plaintext is shown **once** at mint time.
- **Auth-derived scope (never client-declared)** — a key authorized for one
  project needs no selector. A multi-project / wildcard key may pass an optional
  `X-Wairon-Project` header or `?project=` selector, honored **only within** its
  authorized set; anything else is `403`. The selector can never widen scope.

Upgrade path to OIDC/OAuth later: the MCP SDK's `requireBearerAuth` + an OIDC
verifier slots in at the same boundary. Not a v1 requirement.

---

## 4. State-scoped lock & gated promote

Closes the stale-approval (TOCTOU) gap from the feature request.

- **`StateId`** (`src/core/statehash.ts`) — a deterministic SHA-256 over the
  canonicalized spec tree (sorted keys; `createdAt`/`updatedAt` excluded so a
  no-op re-save doesn't shift identity). Identical spec content ⇒ identical
  `StateId`; any edit changes it.
- **`wairon host lock --project <id>`** → `validateAsComplete` (full strictness,
  no draft relaxation, mutates nothing) → on success, promote all specs to
  `complete` and write `.wai/lock.json` **scoped to the exact `StateId`** it
  validated.
- **`wairon host promote --project <id>`** → reads the lock, **recomputes the
  current `StateId`**, and refuses (`stale — re-lock required`) if it drifted.
  It **never merges** to production — at most it marks the change-set `ready`.
  Verified: editing a spec after lock flips promote to stale until you re-lock.

---

### Git-backed projects

A project can relocate its **source of truth to a git repo** — then people clone
the repo and collaborate locally via their own AI tools, and the container is one
participant:

- `wairon host git enable --project <id> --remote <url> [--branch main]` (or
  `POST /admin/projects/{id}/git`) clones the repo and checks out an **isolated
  working branch** (`wairon/work`); the container never commits to the default
  branch.
- `wairon host git sync` (or `POST …/git/sync`) pulls the default branch into the
  working branch.
- **`lock` is git-aware:** it syncs, validates-as-complete, promotes, then
  **commits + pushes the working branch** and records the commit SHA + a
  **compare URL** — you open the PR (push-only, no forge API). `wairon validate`
  is the natural PR status check.
- **`promote`** is unchanged — the content `StateId` already refuses a stale
  lock, and it never merges (the human merges the PR).

Identity: a single bot token — `WAIRON_GIT_TOKEN` (+ `WAIRON_GIT_NAME` /
`WAIRON_GIT_EMAIL`). `.wai/lock.json` and `.wai/git.json` stay container-local
(never committed). The Docker image ships with `git` installed.

### Producers — project specs to Notion

Mirror a project's spec tree into a **"wairon specs" subsection** under a Notion
page (idempotent — sibling content untouched), **hosted or locally**:

- Hosted: `wairon host producer configure --project acme --target notion --page <pageId>`,
  then `wairon host producer produce --project acme` (or the admin API under
  `/admin/projects/{id}/producers/{target}`).
- Local: `wairon produce notion --page <pageId>` against the project in your cwd —
  the token comes from `--token`, else `WAIRON_NOTION_TOKEN`, else an interactive
  prompt (nothing stored).

Each page carries the component's methods and a **Mermaid** diagram code block;
the hosted path also embeds a signed live-canvas link. Notion uses raw REST (**no
new dependency**); the `DocPage` model is target-agnostic, so a future Miro/other
producer reuses the same projection.

### Runtime secrets — no restart

Integration tokens resolve **data-dir store → env**, so an integration can be
added to a *live* container without a restart:

```sh
docker compose exec wairon wairon host secret set --key notion-token --value secret_xxx
# also git-token / signing-secret; env still works as the default
```

## 5. Self-hosting with Docker

### 5.1 Quickstart

```sh
# 1. a master admin credential (kept out of git)
echo "WAIRON_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env

# 2. build & run (data plane published on :8080; admin stays internal)
docker compose up -d --build
curl -fsS http://localhost:8080/healthz          # → {"ok":true}

# 3. provision a project and mint an editor key — via docker exec (safest path)
docker compose exec wairon wairon host project create --id acme
docker compose exec wairon wairon host key mint --project acme --role editor
#   → wk_…  (shown once — hand this to the MCP client)
```

Remote MCP clients then connect to `https://<host>/mcp` with
`Authorization: Bearer wk_…` (put TLS in front — see 5.4). A single-project key
needs no project selector.

### 5.2 Dockerfile / compose

Both live at the repo root ([`Dockerfile`](../../Dockerfile),
[`docker-compose.yml`](../../docker-compose.yml)). The image is a multi-stage
Node 20 build; `/data` is a volume; `wairon` is on `PATH` so `docker exec …
wairon host …` administers without exposing the admin port.

> A distroless variant is possible later (`npm run build:binary` already produces
> a pkg `node20-linux-x64` binary → copy into `gcr.io/distroless/cc-debian12`).
> The Node image is the maintainable default.

### 5.3 Administering

Two equivalent paths to the same control-plane logic:

- **CLI over `docker exec` / SSH** (recommended — no admin port exposed):
  `wairon host project create|list|destroy`, `wairon host key mint|list|revoke`,
  `wairon host lock`, `wairon host promote`. Reads `WAIRON_ADMIN_TOKEN` and
  `WAIRON_DATA_DIR` from the container env.
- **HTTP admin API** — the same operations under `/admin/*`, bound to
  `127.0.0.1:8081` by default. To let your own UI/automation call it, run with
  `--admin-host 0.0.0.0`, publish `8081`, and **front it with TLS + your own
  protection** — it is master-credential gated but should not be public.

### 5.4 Connecting a remote MCP client (e.g. Langdock)

- **Endpoint:** `https://<host>/mcp` (terminate TLS at Caddy/nginx/a GCP HTTPS
  LB — the container speaks plain HTTP).
- **Auth:** `Authorization: Bearer <project key>`. Scope is server-side; a
  single-project key needs no `project` argument.
- **Tools:** the full `sdd_*` surface. No privileged tools on the public plane —
  lock/promote are control-plane only.

### 5.5 GCP

- **GCE VM (durable FS):** run the container with `/data` on a **separate
  persistent disk** (not the boot disk) so you snapshot/resize it independently;
  add a daily snapshot schedule. Terminate TLS at an HTTPS LB or Caddy.
- **Cloud Run:** viable **only** with a persistent volume for `/data` (Filestore
  NFS / GCS FUSE) — the FS must survive restarts.
- Never expose `:8080` (or `:8081`) publicly without TLS + auth.

---

## 6. Configuration reference

| Setting | Flag | Env | Default |
|---|---|---|---|
| Data-plane bind host | `--host` | — | `0.0.0.0` |
| Data-plane port | `--port` | — | `8080` |
| Admin-plane bind host | `--admin-host` | — | `127.0.0.1` |
| Admin-plane port | `--admin-port` | — | `8081` |
| Data root | `--data-dir` | `WAIRON_DATA_DIR` | `~/.wairon/data` |
| Data-plane auth | `--no-auth` (off) | — | on |
| Master credential | — | `WAIRON_ADMIN_TOKEN` | *(required unless `--no-auth`)* |
| Diagram view-link signing key | — | `WAIRON_SIGNING_SECRET` | falls back to `WAIRON_ADMIN_TOKEN` |
| Git bot token | — | `WAIRON_GIT_TOKEN` | *(needed for `https://` git remotes)* |
| Git committer name / email | — | `WAIRON_GIT_NAME` / `WAIRON_GIT_EMAIL` | `wairon-bot` / `wairon-bot@localhost` |
| Notion integration token | — | `WAIRON_NOTION_TOKEN` | *(or set via `host secret set`)* |
| Public base URL (for links) | — | `WAIRON_PUBLIC_URL` | data-plane `host:port` |

All token secrets can also be set at runtime with `wairon host secret set --key <k> --value <v>` (data-dir store, read live).

Data layout:

```
$WAIRON_DATA_DIR/
├── projects.json                     # hosted-project registry
├── auth/credentials.json             # hashed API keys
└── projects/<id>/.wai/               # a full, isolated wairon spec tree
    ├── project.yaml · specs/…
    └── lock.json                     # commit-scoped lock record
```

Project ids are validated `^[a-z0-9][a-z0-9-]{0,63}$` so a crafted id can't
escape `projects/`.

---

## 7. Sizing (grounded in wairon's own tree)

Measured on this repo (a real, non-trivial system): **74 spec files, ~80 KB of
spec YAML, ~1.1 MB total `.wai/`** including generated agents, context, and
diagram canvases.

| Project size | Spec files | Specs | Full `.wai/` |
|---|---|---|---|
| Small (1 subsystem) | 10–25 | 10–40 KB | ~0.3–0.8 MB |
| Medium (wairon-scale) | ~75 | ~80 KB | ~1–2 MB |
| Large (monorepo) | 200–600 | 0.2–0.6 MB | 3–10 MB |

**Budget ~10 MB / project** (≈10× typical, with headroom). Fleet:

| Projects | Data @ ~10 MB | Recommended `/data` disk |
|---|---|---|
| 100 | ~1 GB | 10 GB |
| 1,000 | ~10 GB | 50 GB |
| 10,000 | ~100 GB | 500 GB |

- **Inodes, not bytes, are the practical limit** — ~75 files/project. For huge
  counts of tiny projects, format `/data` with a denser inode ratio
  (`mkfs.ext4 -i 8192`).
- Ops are CPU-light (YAML parse + in-memory graph validation, milliseconds);
  the driver is *concurrency of validate/lock*, not project count at rest.
- **Memory:** base Node ~80–150 MB; each cached `SpecWorkspace` ~1–3 MB. Cold
  projects cost only disk.

### GCP VM tiers

| Scale | Projects | Machine | vCPU / RAM | `/data` disk |
|---|---|---|---|---|
| Dev / small team | ≤ ~50 | `e2-small` (or Cloud Run) | 2 shared / 2 GB | 10 GB `pd-balanced` |
| Team | ≤ ~500 | `e2-standard-2` | 2 / 8 GB | 30 GB `pd-balanced`, daily snapshot |
| Org | ≤ ~5,000 | `e2-standard-4` | 4 / 16 GB | 100 GB `pd-ssd`, separate disk + snapshots |
| Large / multi-replica | 5,000+ | 2× `e2-standard-4` behind HTTPS LB | 4 / 16 GB each | 500 GB shared FS (Filestore/NFS) |

Start at **`e2-standard-2` + a dedicated 30 GB `pd-balanced` data disk**; both
resize without a rebuild.

---

## 8. Security checklist

- API keys stored **hashed** (SHA-256), constant-time compared, never logged.
- **Auth-derived scope only** — the `project` selector can never widen a token's
  set.
- Control plane (`WAIRON_ADMIN_TOKEN`) never on the public data plane; admin port
  is localhost by default.
- No privileged tools on the public MCP surface — `sdd_mcp` is unchanged.
- Path-traversal guard on project ids.
- TLS terminated in front of the container; nothing public without auth + TLS.
- Per-request audit hooks: `{ tokenId, project, tool }` (never the raw key).

---

## 9. Known limitations / follow-ups

- **Stateless MCP per request** (no sticky sessions). Works for single-shot tool
  calls; if a client needs a persistent session (streamed progress, sampling),
  add `sessionIdGenerator` + a session store keyed by `Mcp-Session-Id`, binding
  the project scope at initialize time.
- **Sync/mirror backends** (FR#5) remain future work: native FS is the source of
  truth; a `wairon sync --git <remote>` mirror would layer on top, not replace it.
- **Actual promotion/merge** to a canonical branch is deliberately out of scope —
  `promote` marks readiness after the `StateId` re-check; a separate human-gated
  step performs any merge.

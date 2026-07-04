# Hosted, Multi-Tenant MCP Server — Design & Self-Hosting Plan

> Status: **design / not yet implemented**. Responds to
> [`docs/wairon-feature-requests-hosted-mcp.md`](../wairon-feature-requests-hosted-mcp.md)
> (Appenser / Langdock use case). This document is the implementation plan plus
> the self-hosting guide and sizing recommendations.

---

## 1. What is being asked for

Five requests, from the feature doc:

1. **Hosted HTTP MCP mode** — `wairon mcp serve --http`: expose the existing
   `sdd_*` tool surface over **streamable HTTP** (not just stdio), packageable as
   a **Docker image**, persisting spec trees to a **mounted filesystem**
   (`/data/projects/<id>/.wai/...`). wairon itself is the durability layer.
2. **Multi-project behind one endpoint, auth-scoped** — one running instance
   serves many isolated `.wai/` trees; **project scope is derived from the
   authenticated token, never from a client-supplied parameter**. Explicitly
   *not* a process-per-project model.
3. **Auth layer** — v1 can be static API keys → authorized project id(s) from a
   config/secret; clear upgrade path to OIDC/OAuth. No enterprise SSO for v1.
4. **Privileged, commit-scoped `sdd_init` + `sdd_lock`** — expose init/lock over
   MCP but as *privileged* tools. `sdd_lock` must (a) validate fresh, (b) write a
   lock record **scoped to the exact state it validated** (a state/commit hash),
   (c) **never merge/promote** to production. A separate, human-gated promote
   step must **re-check** that the current state still matches the locked state
   before promoting — stale locks auto-invalidate.
5. **(Later) Pluggable persistence/sync** — native FS stays the source of truth;
   git-host (GitHub/GitLab) or other targets (Notion) are optional
   export/mirror layers (`wairon sync --git <remote>`), never a hard dependency.

---

## 2. Does this fit the current codebase? (gap analysis)

**Verdict: mostly additive, plus a handful of surgical core changes.** The
persistence layer is *already* multi-tenant-shaped; the blockers are (a) the
process-global project root, (b) no HTTP transport, (c) no auth/tenancy, and
(d) `lock` has no state-scoped lock record. None require a rewrite.

### 2.1 What already exists and is directly reusable

| Capability | Where | Reuse |
|---|---|---|
| **Per-root spec workspace** | `SpecWorkspace` + `workspaceFor(rootDir)` in `src/core/specs.ts` | Already keyed by project root and cached in a `Map`. This is the multi-tenant core — a hosted instance just needs one workspace per tenant, which this gives for free. |
| **Explicit-root path accessors** | `aiPathsAt(rootDir)` in `src/config/loader.ts` | Every `.wai/...` path can be resolved for an arbitrary root, not just cwd. |
| **The whole `sdd_*` tool surface** | `createMcpServer()` in `src/mcp/server.ts` | Transport-agnostic `McpServer`; today it is only bound to `StdioServerTransport`. Reused verbatim over HTTP. |
| **Validation-as-complete** | `validateSddTree()` (`src/core/validation.ts`) + the dry-run in `runLock` (`src/commands/lock.ts`) | The exact "validate as if everything were `complete`" logic `sdd_lock` needs already exists. |
| **HTTP transport + auth middleware** | `@modelcontextprotocol/sdk` **1.29.0** already a dependency: `StreamableHTTPServerTransport` (stateless mode via `sessionIdGenerator: undefined`) and `requireBearerAuth(...)` | No web framework needed; Node's built-in `http` + the SDK transport is enough. |

### 2.2 The one real blocker: the process-global project root

`getProjectRoot()` in `src/utils/fs.ts` reads a **module-level global**
(`projectRootOverride`, set by `setProjectRoot()`). The entire flat spec API,
`AI_PATHS`, `loadProjectConfig()`, `loadRegistry()`, and validation all resolve
through it. In stdio mode that is fine (one process = one project). In a
**multi-tenant HTTP server, concurrent requests for different projects would
clobber each other's global root** — a classic data race.

**Fix (small, central): request-scoped root via `AsyncLocalStorage`.** Make
`getProjectRoot()` consult, in order: (1) an ALS store, (2) the existing
override, (3) the cwd walk. The HTTP handler wraps each request in
`als.run({ projectRoot }, …)`. Because Node propagates the ALS context across
every downstream `await`, **the entire existing flat API becomes request-scoped
with zero changes to the ~20 tool handlers or the core.** Stdio is unaffected
(no ALS context → falls back to the override, exactly as today).

```ts
// src/utils/fs.ts  (≈15 lines added)
import { AsyncLocalStorage } from 'node:async_hooks';
const rootStore = new AsyncLocalStorage<{ projectRoot: string }>();
export function runWithProjectRoot<T>(dir: string, fn: () => T): T {
  return rootStore.run({ projectRoot: path.resolve(dir) }, fn);
}
export function getProjectRoot(): string {
  const scoped = rootStore.getStore();
  if (scoped) return scoped.projectRoot;          // request-scoped (HTTP)
  if (projectRootOverride) return projectRootOverride; // pinned (stdio)
  return findSystemRoot(process.cwd()) ?? process.cwd();
}
```

This single change is the linchpin that makes options 1–4 safe and cheap.

### 2.3 Feature-by-feature: additive vs. core change

| FR | Additive (new files) | Core change (existing files) |
|---|---|---|
| 1 HTTP + Docker + FS | `src/server/http.ts` (transport host), `Dockerfile`, compose | `src/utils/fs.ts` (ALS root); new `wairon serve` CLI wiring in `src/cli/index.ts` |
| 2 Multi-tenant | `src/server/tenancy.ts` (token→projects, project→root resolver), `src/server/projects.ts` (registry/provisioning) | none beyond 2.2 |
| 3 Auth | `src/server/auth.ts` (static-key verifier + middleware) | none |
| 4 Privileged init/lock + state lock | `src/core/lockfile.ts` (state hash + lock record + promote re-check); `sdd_init`/`sdd_lock`/`sdd_promote` tool registrations | `src/mcp/server.ts` (privilege-gate the new tools via an auth context); optionally refactor `runLock` to share the lock-record writer |
| 5 Sync (later) | `src/core/sync/*` behind a `PersistenceMirror` interface; `wairon sync` command | none — FS already the source of truth |

Nothing above touches the conformance engine, the spec schemas, agent
resolution, or generation. **It is a new "serving" layer wrapped around an
unchanged core, plus the ALS root fix and a genuinely-new lock-record model.**

---

## 3. Implementation plan (phased)

Rough effort assumes one engineer familiar with the codebase.

### Phase 0 — Request-scoped project root *(0.5 day, foundational)*
- Add `AsyncLocalStorage` root to `src/utils/fs.ts` (§2.2).
- Add a couple of unit tests proving two concurrent `runWithProjectRoot` scopes
  read/write different trees without bleed.

### Phase 1 — HTTP transport & `wairon serve` *(1–2 days)*
- `src/server/http.ts`: a Node `http` server. For each MCP request, create a
  stateless `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`,
  connect a fresh `createMcpServer()` (cheap — just tool registration), and run
  it inside `runWithProjectRoot(tenantRoot, …)`.
- `GET /healthz` (liveness) and `GET /readyz` (data dir writable).
- CLI: add `wairon serve` (and/or `wairon mcp serve --http`) in
  `src/cli/index.ts` with `--port`, `--host`, `--data-dir`, `--auth-file`.
- Data root: `WAIRON_DATA_DIR` (default `/data`), tenants at
  `<dataDir>/projects/<project-id>/` each holding a `.wai/` tree.

```
POST /mcp        → MCP JSON-RPC (streamable HTTP), tenant-scoped by token
GET  /healthz    → 200 liveness
GET  /readyz     → 200 when <dataDir> is writable
```

### Phase 2 — Tenancy + auth *(2–3 days)*
- `src/server/auth.ts`: read an **auth file** (`WAIRON_AUTH_FILE`, JSON/YAML)
  mapping API keys → `{ projects: string[] | "*", role: "editor" | "admin" }`.
  Keys stored **hashed** (sha-256); compare in constant time. Bearer token in
  `Authorization: Bearer <key>`.
- `src/server/tenancy.ts`: resolve the tenant per request —
  1. Authenticate → get the token's authorized project set + role.
  2. Determine target project: if the token authorizes exactly one project, use
     it; if it authorizes many, honor an **optional** `project` selector from
     the client **only if it is in the authorized set**; otherwise 403.
  3. **The selector is never the authorization** — an unauthorized project id is
     rejected regardless of what the client claims.
  4. Map project id → `<dataDir>/projects/<id>` and pass to
     `runWithProjectRoot`.
- Reject unknown/missing tokens with 401; cross-tenant access with 403. Log
  `{ tokenId, project, tool }` (never the raw key).

### Phase 3 — Privileged `sdd_init`, `sdd_lock`, `sdd_promote` + state-scoped lock *(3–4 days)*
This is the only genuinely new *behavior* (even for the CLI).

- **State ID.** `src/core/lockfile.ts` computes a deterministic
  `computeStateId()` = sha-256 over the canonicalized spec tree (sorted file
  paths + normalized YAML content of every file under `.wai/specs`). Stable
  across machines; changes on any edit. (When git-backed later, the commit SHA
  can substitute.)
- **`sdd_init`** (privileged): provision a new project's `.wai/` skeleton for
  the authenticated tenant (reuse `init`'s `executeInit` core, minus the
  interactive prompts and local AI-tool wiring). Only an `admin`/orchestrator
  token may call it.
- **`sdd_lock`** (privileged): run the existing validate-as-complete dry run
  (`validateSddTree` with statuses forced to `complete`); **only if clean**,
  promote statuses to `complete` and write a lock record:

  ```jsonc
  // <dataDir>/projects/<id>/.wai/lock.json
  {
    "stateId": "sha256:…",          // the exact tree it validated
    "lockedAt": "2026-07-04T…Z",
    "lockedBy": "token:orchestrator-1",
    "validatorVersion": "2.2.17",
    "validationResult": { "errors": 0, "warnings": 3 },
    "status": "ready"               // ready | promoted, never merges here
  }
  ```

  It **never** merges to any main/production state. Where git-backed, it may at
  most open/update a PR or mark "ready".
- **`sdd_promote`** (privileged, human-gated): the only path to the canonical
  state. It **recomputes `computeStateId()` now** and refuses unless it equals
  `lock.json.stateId`. Any edit after lock changes the hash → the lock is
  automatically stale → promote is rejected, forcing re-lock. This closes the
  TOCTOU gap from the feature request.
- Privilege gate in `src/mcp/server.ts`: register `sdd_init/lock/promote` only
  when the request's auth context carries the required role (thread the role
  through via the ALS/tenant context set in Phase 2), or return an authz error
  from the handler.

### Phase 4 — Docker packaging *(1 day)* — see §5.
### Phase 5 — Pluggable sync *(later)* — `PersistenceMirror` seam + `wairon sync --git`.

**Total for a production-ready v1 (Phases 0–4): ≈ 8–12 engineering days.**

---

## 4. New data model / on-disk layout

```
$WAIRON_DATA_DIR/                     # default /data (a mounted volume)
├── projects/
│   ├── acme-billing/
│   │   └── .wai/                      # a full, ordinary wairon spec tree
│   │       ├── project.yaml
│   │       ├── specs/…                # source of truth
│   │       ├── lock.json              # NEW: state-scoped lock record (Phase 3)
│   │       └── context/…
│   └── acme-catalog/ └── .wai/…
└── auth/
    └── tokens.yaml                    # or injected via WAIRON_AUTH_FILE / secret
```

```yaml
# tokens.yaml  (keys stored hashed; never commit the plaintext)
tokens:
  - id: appenser-orchestrator
    keyHash: "sha256:9f2b…"           # sha-256 of the bearer token
    role: admin                       # may call sdd_init / sdd_lock / sdd_promote
    projects: ["*"]
  - id: acme-billing-editor
    keyHash: "sha256:1c07…"
    role: editor                      # sdd_* authoring/validation only
    projects: ["acme-billing"]        # server-side bound; selector can't escape it
```

Everything else is the existing `.wai/` layout — no schema changes to specs.

---

## 5. Self-hosting guide (Docker)

### 5.1 Dockerfile (multi-stage Node — primary, most maintainable)

```dockerfile
# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # tsup → dist/ (+ templates copied by the build script)

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production WAIRON_DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN useradd -r -u 10001 wairon && mkdir -p /data && chown wairon:wairon /data
USER wairon
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli/index.js", "serve", "--http", "--host", "0.0.0.0", "--port", "8080", "--data-dir", "/data"]
```

> **Distroless variant (no Node at runtime):** `npm run build:binary` already
> produces a pkg `node20-linux-x64` binary. Copy it into
> `gcr.io/distroless/cc-debian12` and `ENTRYPOINT ["/wairon","serve","--http",…]`.
> Smaller/attack-surface-minimal; use once the HTTP path is stable.

### 5.2 docker-compose (self-host starting point)

```yaml
services:
  wairon:
    build: .
    ports: ["8080:8080"]
    environment:
      WAIRON_DATA_DIR: /data
      WAIRON_AUTH_FILE: /run/secrets/wairon_tokens
    volumes:
      - wairon-data:/data
    secrets: [wairon_tokens]
    restart: unless-stopped
volumes:
  wairon-data:
secrets:
  wairon_tokens:
    file: ./secrets/tokens.yaml
```

### 5.3 First run

```sh
# 1. create an admin token, store only its hash in tokens.yaml
TOKEN=$(openssl rand -hex 32)
printf 'sha256:%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
#   → paste into secrets/tokens.yaml as an admin key with projects: ["*"]

docker compose up -d
curl -fsS http://localhost:8080/healthz          # → ok

# 2. provision a project (admin token, sdd_init) — via any MCP client, or:
curl -sS http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"sdd_init","arguments":{"project":"acme-billing"}}}'
```

### 5.4 Connecting a remote MCP client (e.g. Langdock)

- **Endpoint:** `https://<host>/mcp` (put a TLS-terminating reverse proxy —
  Caddy/nginx/GCP HTTPS LB — in front; the container speaks plain HTTP).
- **Auth:** `Authorization: Bearer <project-scoped key>`. The key's project
  binding is enforced server-side; a single-project token needs no `project`
  argument at all.
- **Tools exposed:** the full `sdd_*` surface. `sdd_init/lock/promote` appear
  only for admin-role tokens.

### 5.5 GCP deployment notes

- **Cloud Run** is the lowest-ops option **if** you attach a persistent volume
  (Cloud Run + a GCS FUSE mount or a Filestore NFS mount for `/data`) — the FS
  must survive restarts. Simple and autoscaling-friendly for light load.
- **GCE VM (recommended for durable FS):** run the container with `/data` on a
  **separate persistent disk** (not the boot disk) so you can snapshot/resize
  independently. Add a daily **snapshot schedule** for backups.
- Terminate TLS at a GCP HTTPS Load Balancer or Caddy; never expose `:8080`
  publicly without auth + TLS.

---

## 6. Configuration & sizing recommendations

### 6.1 Grounded per-project footprint (measured on wairon's own tree)

Measured on this repo (a real, non-trivial system): **74 spec files, ~80 KB of
spec YAML (~1 KB/file), ~1.1 MB total `.wai/`** including generated agents,
context, and interactive diagram canvases.

| Project size | Spec files | Specs (source of truth) | Full `.wai/` (incl. generated + diagrams) |
|---|---|---|---|
| Small (1 subsystem, few components) | 10–25 | 10–40 KB | ~0.3–0.8 MB |
| Medium (wairon-scale, ~5 subsys/~20 comp) | ~75 | ~80 KB | ~1–2 MB |
| Large (monorepo, many subsystems) | 200–600 | 0.2–0.6 MB | 3–10 MB |

**Planning budget: provision ~10 MB per project.** That is roughly an order of
magnitude over a typical project and leaves room for the lock-record history and
diagram exports. Add a **2–5× multiplier if/when git-backed** (FR5) to cover
history.

### 6.2 Fleet storage sizing

| Projects | Data at ~10 MB/project | With git history (×3) | Recommended `/data` disk |
|---|---|---|---|
| 100 | ~1 GB | ~3 GB | 10 GB |
| 1,000 | ~10 GB | ~30 GB | 50 GB |
| 10,000 | ~100 GB | ~300 GB | 500 GB |

Notes:
- **Inodes, not bytes, are the practical limit.** ~75 files/project × 10,000 =
  ~0.75 M inodes (plus generated files). ext4's default (1 inode / 16 KB) covers
  this comfortably, but if you host *huge* counts of *tiny* projects, format the
  data disk with a denser inode ratio (`mkfs.ext4 -i 8192`).
- **IOPS is bursty and small-file** (parse-on-connect / validate), not
  sustained throughput. `pd-balanced` is sufficient up to the low thousands of
  projects; move to `pd-ssd` only under heavy concurrent validation load.

### 6.3 Compute & memory

wairon operations are CPU-light (YAML parse + in-memory graph validation);
validating the wairon-scale 74-spec tree is milliseconds. The cost driver is
**concurrency of validate/lock**, not project count at rest.

- **Memory:** base Node ~80–150 MB; each *cached* `SpecWorkspace` holds the
  parsed index (~1–3 MB of JS objects for a medium tree). Cap hot workspaces
  with an LRU (evict idle tenants) to bound RSS — e.g. 200 hot workspaces ≈
  a few hundred MB. Cold projects cost only disk.
- **CPU:** single Node process handles many tenants; scale horizontally (more
  replicas behind the LB sharing the `/data` volume) before scaling up.

### 6.4 GCP VM tiers

| Scale | Projects (approx) | Machine type | vCPU / RAM | `/data` disk |
|---|---|---|---|---|
| Dev / small team | ≤ ~50 | `e2-small` (or Cloud Run) | 2 shared / 2 GB | 10 GB `pd-balanced` |
| Team | ≤ ~500 | `e2-standard-2` | 2 / 8 GB | 30 GB `pd-balanced`, daily snapshot |
| Org | ≤ ~5,000 | `e2-standard-4` | 4 / 16 GB | 100 GB `pd-ssd`, separate disk + snapshots |
| Large / multi-replica | 5,000+ | 2× `e2-standard-4` behind HTTPS LB | 4 / 16 GB each | 500 GB `pd-ssd` (shared FS: Filestore/NFS) |

Start at **`e2-standard-2` + a 30 GB dedicated `pd-balanced` data disk** for a
company-internal deployment; it comfortably covers hundreds of projects with
headroom, and both disk and machine resize without a rebuild.

---

## 7. Security checklist (v1)

- API keys stored **hashed** (sha-256) in the auth file/secret; never logged.
- **Auth-derived scope only** — the `project` selector can never widen a token's
  authorized set (FR2).
- `sdd_init/lock/promote` require **admin role**; ordinary editor tokens get the
  authoring/validation subset only (FR4).
- TLS terminated in front of the container; `:8080` never public without auth.
- Per-request audit log: `{ tokenId, project, tool, stateId? }`.
- Path-traversal guard on project ids (`^[a-z0-9][a-z0-9-]*$`) so a crafted id
  can't escape `<dataDir>/projects/`.

---

## 8. Explicitly out of scope (per the request)

- Per-project MCP **process** spawning — a single shared service handles all
  tenants (the `workspaceFor` map already models this).
- A `wairon generate --target <platform>` subagent template for hosts without
  isolated subagent dispatch — no value where specs are read directly.
- Full enterprise SSO/identity federation for v1 (static keys now; SDK
  `requireBearerAuth` + an OIDC verifier is the documented upgrade path).
- `sdd_lock` (or any tool) performing an actual merge/promotion to production —
  `sdd_promote` is separate, human-gated, and re-validates the state hash.

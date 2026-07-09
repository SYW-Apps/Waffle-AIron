# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# wairon hosting server (sdd_host) — self-contained image.
#
# Runs `wairon serve`: the streamable-HTTP MCP data plane for many fully-isolated
# wairon projects, plus the admin control plane. State lives on the /data volume
# (WAIRON_DATA_DIR), so wairon itself is the durability layer — no external
# services required for a basic deployment.
# ---------------------------------------------------------------------------

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
ENV NODE_ENV=production \
    WAIRON_DATA_DIR=/data \
    WAIRON_PACKS_DIR=/data/packs
LABEL org.opencontainers.image.title="wairon" \
      org.opencontainers.image.description="Self-hosted Wairon MCP hosting server" \
      org.opencontainers.image.source="https://github.com/SYW-Apps/Waffle-AIron" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# git is required for git-backed projects (wairon host git …); ca-certificates for HTTPS remotes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Put `wairon` (and `wai`) on PATH so the admin control plane is reachable via
# `docker exec <container> wairon host …` without exposing the admin port.
RUN ln -s /app/dist/cli/index.js /usr/local/bin/wairon \
 && ln -s /app/dist/cli/index.js /usr/local/bin/wai \
 && useradd --system --uid 10001 --create-home --home-dir /home/wairon wairon \
 && mkdir -p /data \
 && chown -R wairon:wairon /data

USER wairon
VOLUME ["/data"]

# Data plane only. The admin plane binds to 127.0.0.1 inside the container by
# default (reach it via `docker exec` / the CLI). To expose the admin API, run
# with `--admin-host 0.0.0.0` and publish 8081 behind your own TLS + auth.
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Auth is on by default; WAIRON_ADMIN_TOKEN must be injected (else it refuses to
# start). Pass --no-auth only for a trusted/VPN-only network.
CMD ["node", "dist/cli/index.js", "serve", \
     "--host", "0.0.0.0", "--port", "8080", \
     "--admin-host", "127.0.0.1", "--admin-port", "8081", \
     "--data-dir", "/data"]

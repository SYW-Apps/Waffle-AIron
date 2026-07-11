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
# Alpine base: musl + a minimal package set means far fewer OS-package CVEs than
# debian bookworm (no perl/pam/expat shipped), and wairon's runtime is pure JS
# (no native production deps), so musl is a non-issue.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
# WAIRON_IMAGE_PACKS_DIR is the immutable image-layer extension-pack tier: an
# extension image built FROM this one does `COPY packs/ /opt/wairon/packs/` to bake
# packs into the layer. It is read-only at runtime and merged with the mutable
# instance tier (WAIRON_PACKS_DIR) at discovery time — instance packs win on a
# name collision. Declared before the build COPY so its layer stays cache-stable.
ENV NODE_ENV=production \
    WAIRON_DATA_DIR=/data \
    WAIRON_PACKS_DIR=/data/packs \
    WAIRON_IMAGE_PACKS_DIR=/opt/wairon/packs
LABEL org.opencontainers.image.title="wairon" \
      org.opencontainers.image.description="Self-hosted Wairon MCP hosting server" \
      org.opencontainers.image.source="https://github.com/SYW-Apps/Waffle-AIron" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# git is required for git-backed projects (wairon host git …); ca-certificates for
# HTTPS remotes. On alpine, `git` installs WITHOUT the perl-based subpackage, so no
# perl lands in the image (clone/fetch/commit/push — all wairon uses — need no perl).
# `apk upgrade` pulls any alpine security fixes into the base layer.
RUN apk upgrade --no-cache \
 && apk add --no-cache git ca-certificates
COPY package.json package-lock.json ./
# Install production deps, then REMOVE npm itself: the runtime only ever runs
# `node dist/cli/index.js` (CMD, healthcheck, and the wairon/wai symlinks all
# invoke node directly), so npm is build-time only. Deleting its bundled
# node_modules eliminates the base image's vendored tar/minimatch (and their
# CVEs) and shrinks the attack surface. Done in ONE layer so npm is gone from
# the final filesystem, not just shadowed.
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx ~/.npm
COPY --from=build /app/dist ./dist

# Put `wairon` (and `wai`) on PATH so the admin control plane is reachable via
# `docker exec <container> wairon host …` without exposing the admin port.
RUN ln -s /app/dist/cli/index.js /usr/local/bin/wairon \
 && ln -s /app/dist/cli/index.js /usr/local/bin/wai \
 && addgroup -S wairon \
 && adduser -S -u 10001 -G wairon -h /home/wairon wairon \
 && mkdir -p /data /opt/wairon/packs \
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

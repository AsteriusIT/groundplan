# syntax=docker/dockerfile:1

# Multi-stage build for the React/Vite SPA (@groundplan/frontend).
#
# Build context is the REPO ROOT (pnpm workspace manifests live there).
# Runtime configuration (API base + OIDC settings) is NOT baked into the bundle:
# the SPA fetches /config.json at startup. The image ships a default config.json
# (from apps/frontend/public/), and production mounts its own over it — so one
# image is portable across environments. The output is static files served by
# nginx; the Caddy edge terminates TLS and routes /api to the backend, so this
# image ships no server logic.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/canvas/package.json packages/canvas/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/frontend...

# @groundplan/canvas is consumed from source (its exports point at src/), so
# copying it is all the "build" it needs.
COPY packages/canvas/ packages/canvas/
COPY apps/frontend/ apps/frontend/

# No build-time config: nothing environment-specific is inlined. The bundled
# apps/frontend/public/config.json becomes the image's default /config.json
# (production mounts its own over it, see docker-compose.prod.yml).
RUN pnpm --filter @groundplan/frontend build

# ---- runtime --------------------------------------------------------------
# Unprivileged variant (GP-168): the whole server runs as the non-root nginx
# user and listens on 8080, so Kubernetes can enforce runAsNonRoot.
FROM nginxinc/nginx-unprivileged:1.31-alpine-slim AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

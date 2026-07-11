# syntax=docker/dockerfile:1

# Multi-stage build for the React/Vite SPA (@groundplan/frontend).
#
# Build context is the REPO ROOT (pnpm workspace manifests live there).
# Vite inlines VITE_* env at BUILD time, so the OIDC issuer / API base are
# baked in via build args (passed from docker-compose.prod.yml). The output
# is static files served by nginx; the Caddy edge terminates TLS and routes
# /api to the backend, so this image ships no server logic.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/frontend/package.json apps/frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/frontend...

COPY apps/frontend/ apps/frontend/

# Public config, inlined into the bundle at build time. VITE_OIDC_REDIRECT_URI
# is intentionally left unset so the app derives `${window.location.origin}
# /callback` at runtime (works for any host the SPA is served from).
ARG VITE_API_URL=""
ARG VITE_OIDC_ISSUER
ARG VITE_OIDC_CLIENT_ID=groundplan-frontend
ENV VITE_API_URL=$VITE_API_URL \
    VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
RUN pnpm --filter @groundplan/frontend build

# ---- runtime --------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

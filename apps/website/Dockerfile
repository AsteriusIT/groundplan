# syntax=docker/dockerfile:1

# Multi-stage build for the marketing website (@groundplan/website, GP-158).
#
# Build context is the REPO ROOT (pnpm workspace manifests live there), same
# as the frontend image. Output is a fully static Astro site served by nginx;
# the Caddy edge terminates TLS.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/website/package.json apps/website/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/website...

COPY apps/website/ apps/website/
RUN pnpm --filter @groundplan/website build

# ---- runtime --------------------------------------------------------------
FROM nginx:1.31.2-alpine3.23-slim AS runtime
COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/website/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

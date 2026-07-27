# syntax=docker/dockerfile:1

# Multi-stage build for the documentation site (@groundplan/docs, GP-213).
#
# Build context is the REPO ROOT (pnpm workspace manifests live there), same as
# the marketing-site image. Output is a fully static Astro/Starlight site served
# by nginx; the Caddy edge terminates TLS.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/docs/package.json apps/docs/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/docs...

COPY apps/docs/ apps/docs/
RUN pnpm --filter @groundplan/docs build

# ---- runtime --------------------------------------------------------------
FROM nginx:1.31.2-alpine3.23-slim AS runtime
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/docs/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

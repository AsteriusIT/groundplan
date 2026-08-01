# syntax=docker/dockerfile:1

# Multi-stage build for the Fastify API (@groundplan/backend).
#
# Build context is the REPO ROOT (see docker-compose.prod.yml) because the
# pnpm workspace manifests + lockfile live there. Debian (glibc) base, not
# Alpine: the runtime needs the `git` binary (repo shallow-clones) and the
# prebuilt native module @resvg/resvg-js (linux-x64-gnu), which is simplest
# and most reliable on glibc.

# ---- deps + build ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo

# Install deps first (cached until a manifest or the lockfile changes).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/graph-parser/package.json packages/graph-parser/package.json
COPY packages/graph-differ/package.json packages/graph-differ/package.json
# @groundplan/builder is a backend dependency since the visual builder's
# generation endpoint (GP-134); without its manifest the workspace install
# cannot resolve it.
COPY packages/builder/package.json packages/builder/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/backend...

# Compile TypeScript -> dist/ (the `...` filter builds workspace deps first,
# i.e. @groundplan/graph-parser and @groundplan/graph-differ), then produce a
# self-contained, prod-only package tree in /prod (flattened node_modules +
# dist + drizzle migrations).
COPY packages/graph-parser/ packages/graph-parser/
COPY packages/graph-differ/ packages/graph-differ/
COPY packages/builder/ packages/builder/
COPY apps/backend/ apps/backend/
RUN pnpm --filter @groundplan/backend... build \
 && pnpm --filter=@groundplan/backend deploy --prod --legacy /prod

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# git: shallow-clone of connected repos. ca-certificates: HTTPS clone + OIDC
# discovery to Keycloak. tini via `init: true` in compose reaps zombies.
#
# The same layer drops the package managers the base image ships. The container
# only ever runs `node dist/index.js` against an already-installed /prod tree,
# so npm, corepack and yarn are dead weight — and their vendored dependency
# trees are the only node packages in the image we do not control (npm bundles
# node-tar, which is how CVE-2026-59873 reached the Trivy gate). Node itself is
# untouched, and the build stage still has its own npm/corepack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /prod ./

# The bundled catalog snapshot (GP-239), when the release pipeline produced one.
# On the first boot of an empty catalog the API imports it, so an air-gapped
# install has the full visual builder without ever reaching the network. A
# checkout has no snapshot and the directory carries only its README — the
# builder then falls back to its curated resources and says so.
COPY --chown=node:node deploy/catalog/ ./

USER node
EXPOSE 3000

# Container health = readiness (/readyz, DB-checked), so compose dependents
# wait for a servable API. Kubernetes points its own probes at /healthz
# (liveness) + /readyz instead. Node 22 has a global fetch — no extra tools.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/backend...

# Compile TypeScript -> dist/ (the `...` filter builds workspace deps first,
# i.e. @groundplan/graph-parser and @groundplan/graph-differ), then produce a
# self-contained, prod-only package tree in /prod (flattened node_modules +
# dist + drizzle migrations).
COPY packages/graph-parser/ packages/graph-parser/
COPY packages/graph-differ/ packages/graph-differ/
COPY apps/backend/ apps/backend/
RUN pnpm --filter @groundplan/backend... build \
 && pnpm --filter=@groundplan/backend deploy --prod --legacy /prod

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# git: shallow-clone of connected repos. ca-certificates: HTTPS clone + OIDC
# discovery to Keycloak. tini via `init: true` in compose reaps zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /prod ./

USER node
EXPOSE 3000

# Liveness/readiness uses the app's own /healthz (DB-checked). Node 22 has a
# global fetch, so no extra tools are needed in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

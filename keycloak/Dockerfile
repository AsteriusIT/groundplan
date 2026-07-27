# syntax=docker/dockerfile:1

# Custom Keycloak image for groundplan: the stock Keycloak 26 with the carbon
# theme (@groundplan/keycloak-theme) baked into its providers directory, so it
# serves the groundplan login/account/email theme out of the box — no volume
# mount required.
#
# Build context is the REPO ROOT (the theme is a pnpm workspace package). The
# theme jar is built here in a Node stage (Keycloakify packages the jar in pure
# Node — no JDK needed), then copied into the Keycloak image.

# ---- build the theme jar --------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable

# Keycloakify packages the theme jar with Maven (which pulls in a JRE) — the only
# non-Node tool the build needs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends maven \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace manifests first. The theme's `postinstall` (keycloakify
# sync-extensions) needs its source present, so copy the package before install
# rather than caching an install layer on package.json alone.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY keycloak/ keycloak/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @groundplan/keycloak-theme...

# Produces keycloak/dist_keycloak/keycloak-theme-groundplan.jar. The Maven
# cache mount keeps repeat builds from re-downloading the jar plugins.
RUN --mount=type=cache,id=keycloak-m2,target=/root/.m2 \
    pnpm --filter @groundplan/keycloak-theme run build-keycloak-theme

# ---- keycloak with the theme baked in -------------------------------------
# Pinned to the same Keycloak version as docker-compose.prod.yml so dev and prod
# run the same server; the account theme jar targets this version's range
# (26.2-and-above) in vite.config.ts.
FROM quay.io/keycloak/keycloak:26.7.0 AS runtime

# Theme provider jar. It must land in providers/ *before* `kc.sh build` below,
# which is what bakes the provider into the augmented distribution.
COPY --from=build \
    /repo/keycloak/dist_keycloak/keycloak-theme-groundplan.jar \
    /opt/keycloak/providers/keycloak-theme-groundplan.jar

# Pre-augment the server ("optimized image", see
# https://www.keycloak.org/server/containers). Without this, Keycloak re-runs
# Quarkus augmentation on *every* container start to pick up the provider jar
# and the build options — measured at ~10.9s to /health/ready, against ~3.2s for
# `start --optimized` here. Costs ~180 MB of image for a ~70% faster start, which
# is the right trade for a restart-on-deploy production service.
#
# Passed as flags rather than ENV on purpose: ENV would persist into the running
# container, and `KC_DB=postgres` leaking into the environment would break the
# two consumers that run start-dev on the embedded file database (the dev
# compose profile and the eval-only Keycloak in the Helm chart). As flags, the
# values are persisted only in the augmented image — start-dev still re-augments
# itself to dev-file exactly as it does today.
#
# Only build-time options belong here; the database URL/credentials, hostname,
# proxy headers and cache mode stay runtime options (docker-compose.prod.yml).
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true

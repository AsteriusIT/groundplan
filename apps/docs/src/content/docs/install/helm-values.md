---
title: Helm values
description: Every value the chart reads, its default, and whether it is required.
---

The reference table behind [Install on Kubernetes](/install/kubernetes/), for
whoever is writing the values file. Anything marked **required** has no usable
default; everything else works unset.

The authoritative copy is `deploy/chart/groundplan/values.yaml` in the
repository, where every field carries its own comment. This page is the map.

## Images

| Value | Default | Notes |
| --- | --- | --- |
| `image.registry` | `ghcr.io/asteriusit` | Public images, published on every release tag. |
| `image.tag` | chart `appVersion` | **Pin it.** `latest` moves under a running cluster. |
| `image.pullPolicy` | `IfNotPresent` | |
| `image.pullSecrets` | `[]` | Only needed when you mirror the images privately. |

## Ingress and public URL

| Value | Default | Notes |
| --- | --- | --- |
| `ingress.enabled` | `true` | |
| `ingress.host` | `""` | **Required** in practice. `/api` routes to the API, everything else to the SPA. |
| `ingress.className` | `""` | Empty uses the cluster's default IngressClass. |
| `ingress.annotations` | `{}` | Where a cert-manager issuer annotation goes. |
| `ingress.tls.enabled` | `false` | |
| `ingress.tls.secretName` | `""` | May stay empty when the controller provides a default certificate. |
| `publicUrl` | derived from `ingress.host` | The absolute origin written into pull-request comments. Set it explicitly when the browser reaches you on a different name than the ingress host. |

## API

| Value | Default | Notes |
| --- | --- | --- |
| `api.replicas` | `1` | Stateless; scale freely. |
| `api.encryptionKey` | `""` | **Required**, one way or another — inline (evaluation only). |
| `api.existingSecret` | `""` | A Secret holding `ENCRYPTION_KEY`. The production choice. |
| `api.externalSecret.remoteRef.key` | `""` | Fetch it with the External Secrets Operator instead. |
| `api.singleOrg` | `true` | `true` = one organization, everyone auto-joins. See [Organizations & roles](/admin/organizations/). |
| `api.resources` | modest requests | |
| `api.extraEnv` | `[]` | The escape hatch for any variable without a dedicated value (`AI_MODEL`, `REF_POLL_INTERVAL_MS`, the integration credentials…). |

Exactly **one** source per secret. Setting an inline value and an
`existingSecret` — or either of those and an `externalSecret` — fails
`helm template` with a sentence naming the conflict, rather than silently
picking one.

## Database

| Value | Default | Notes |
| --- | --- | --- |
| `externalDatabase.host` | `""` | **Required** for production. |
| `externalDatabase.port` | `5432` | |
| `externalDatabase.database` | `groundplan` | |
| `externalDatabase.username` | `groundplan` | Becomes part of a connection URL — URL-encode anything exotic. |
| `externalDatabase.existingSecret` | `""` | Secret holding the password. |
| `externalDatabase.passwordKey` | `password` | Key within that Secret. |
| `externalDatabase.password` | `""` | Inline: evaluation and CI only. |
| `externalDatabase.externalSecret.remoteRef.key` | `""` | ESO source. Invalid with the embedded Postgres. |
| `externalDatabase.sslMode` | `""` | Appended as `?sslmode=…`. `require` is a sensible production value. |
| `postgresql.enabled` | `false` | **Evaluation only**: single replica, no backups, no tuning. Mutually exclusive with `externalDatabase.host`. |
| `postgresql.storage` | `2Gi` | |
| `postgresql.storageClassName` | `""` | Empty uses the default StorageClass. |
| `migrations.backoffLimit` | `10` | Retries of the migration hook Job — it waits out a database that is still coming up. |

## Identity

| Value | Default | Notes |
| --- | --- | --- |
| `oidc.issuerUrl` | `""` | **Required** for production. Must match the token's `iss` exactly. |
| `oidc.audience` | `groundplan-api` | Must appear in the access token's `aud`. |
| `oidc.clientId` | `groundplan-frontend` | The SPA's public client. |
| `keycloak.enabled` | `false` | **Evaluation only**: an in-cluster identity provider on an embedded file database — its state does not outlive the pod. Mutually exclusive with `oidc.issuerUrl`. |
| `keycloak.host` | `""` | Empty means in-cluster only: token grants work, browser login does not. |
| `keycloak.theme` | `groundplan` | Set to `""` when running a stock upstream image. |
| `keycloak.devUser.enabled` | `true` | The imported `dev`/`dev` login. Turn it off the moment real users exist. |
| `keycloak.adminPassword` | `admin` | An evaluation default with an evaluation scope. |

## AI layer (optional)

| Value | Default | Notes |
| --- | --- | --- |
| `ai.apiKey` | `""` | Inline key (evaluation/CI). |
| `ai.existingSecret` | `""` | A Secret holding it — the production choice. |
| `ai.existingSecretKey` | `AI_API_KEY` | Key within that Secret. |
| `ai.externalSecret.remoteRef.key` | `""` | ESO source. |

Leave all four empty and the AI layer does not exist: no routes, no interface,
no calls. It is opt-in by absence, not by a toggle —
[The AI layer](/ai/) explains what turning it on means.

## Secrets from a secret store

With the [External Secrets Operator](https://external-secrets.io) in the
cluster, the chart renders the `ExternalSecret` objects and no secret material
lives in the release:

```yaml
externalSecrets:
  enabled: true
  secretStore:
    name: cluster-store
    kind: ClusterSecretStore # or SecretStore
  refreshInterval: 1h
  # apiVersion: external-secrets.io/v1   # override for pre-v1 controllers

api:
  externalSecret:
    remoteRef:
      key: groundplan/encryption-key

externalDatabase:
  host: postgres.internal.example.com
  database: groundplan
  username: groundplan
  externalSecret:
    remoteRef:
      key: groundplan/database
      property: password
```

The chart only declares the reads. The controller and its CRDs are the
cluster's.

## Anything not listed here

Every backend variable exists whether or not the chart gives it a name; the ones
without a dedicated value go through `api.extraEnv`:

```yaml
api:
  extraEnv:
    - name: AI_MODEL
      value: claude-opus-4-8
    - name: REF_POLL_INTERVAL_MS
      value: "60000"
```

The complete list is the [configuration reference](/reference/configuration/).

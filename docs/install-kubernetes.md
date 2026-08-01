# Installing groundplan on Kubernetes

The Helm chart in [`deploy/chart/groundplan`](../deploy/chart/groundplan)
deploys the API, the frontend and an ingress. The two production
prerequisites — a Postgres database and an OIDC identity provider — are
**yours to bring**; for a laptop/kind evaluation the chart can run both itself
(explicitly not production-grade).

The container images are public on `ghcr.io/asteriusit`
(`groundplan-backend`, `groundplan-frontend`, `groundplan-keycloak`),
published by CI on every release tag. The chart is installed from a repository
checkout (it is not published to a chart registry yet):

```bash
git clone https://github.com/AsteriusIT/groundplan && cd groundplan
```

Requirements: Kubernetes ≥ 1.27, Helm 3, an ingress controller (any class),
and DNS for your chosen host(s).

## Production: external database + external OIDC

### 1. Create the secrets

```bash
kubectl create namespace groundplan

# ENCRYPTION_KEY protects repository access tokens at rest — losing it means
# re-entering every stored credential.
kubectl -n groundplan create secret generic groundplan-api \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)"

# Password of the Postgres role groundplan connects with.
kubectl -n groundplan create secret generic groundplan-db \
  --from-literal=password='<database password>'
```

(Or manage both with sealed-secrets / external-secrets — the chart only ever
references them by name.)

Each chart secret — `ENCRYPTION_KEY`, the database password and the optional
`AI_API_KEY` — accepts one of **three** sources: an inline value (eval/CI), an
`existingSecret` you bring by name (above), or the **External Secrets Operator**
(ESO). With ESO the chart renders the `ExternalSecret` for you, so no secret
material lives in the release — see [Sourcing secrets from a secret store
(ESO)](#sourcing-secrets-from-a-secret-store-eso) below.

### 2. Configure your identity provider

Any OIDC provider works (Keycloak, Entra ID, ...). The deployment needs:

- a **public client** (the SPA logs in with Authorization Code + PKCE),
  default client id `groundplan-frontend`, allowed redirect URI
  `https://<your host>/callback`
- access tokens carrying the audience `groundplan-api`
  (in Keycloak: an audience mapper on the client; configurable via
  `oidc.audience`)

### 3. Install

`values-prod.yaml`:

```yaml
image:
  tag: "1.0.0" # pin a release — "latest" moves

ingress:
  host: groundplan.example.com
  className: nginx
  tls:
    enabled: true
    secretName: groundplan-tls # or a cert-manager annotation

api:
  existingSecret: groundplan-api

externalDatabase:
  host: postgres.internal.example.com
  database: groundplan
  username: groundplan
  existingSecret: groundplan-db
  sslMode: require

oidc:
  issuerUrl: https://login.example.com/realms/groundplan
```

```bash
helm install groundplan deploy/chart/groundplan -n groundplan -f values-prod.yaml --wait
```

Schema migrations run automatically as a Helm hook Job — before the install
(when database + secret pre-exist, as above), and on **every upgrade before
the new pods roll**. `helm upgrade` with the same command is the whole update
story.

Open `https://groundplan.example.com`, log in, and connect your first
repository. Every configuration knob is documented in
[`values.yaml`](../deploy/chart/groundplan/values.yaml); the AI layer's key is a
first-class value (`ai.apiKey` / `ai.existingSecret` / `ai.externalSecret`,
below), and anything else without one (e.g. `AI_MODEL`) goes through
`api.extraEnv`.

## Sourcing secrets from a secret store (ESO)

If your cluster runs the [External Secrets
Operator](https://external-secrets.io), the chart can render the
`ExternalSecret` objects that pull `ENCRYPTION_KEY`, the database password and
the AI key straight from your store into the Secrets its pods consume — so **no
secret material lives in the release** and you skip the `kubectl create secret`
step above. The chart only declares the reads; the ESO controller and its CRDs
are the cluster's.

Enable it once (shared store + refresh), then give each secret its remote key:

```yaml
externalSecrets:
  enabled: true
  secretStore:
    name: cluster-store        # your (Cluster)SecretStore
    kind: ClusterSecretStore   # or SecretStore (namespaced)
  refreshInterval: 1h
  # apiVersion: external-secrets.io/v1   # override for pre-v1 ESO controllers

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
      property: password        # optional field within the stored key

# Optional — enables the AI layer from an ESO-managed key:
ai:
  externalSecret:
    remoteRef:
      key: groundplan/ai-api-key
```

Each secret still accepts exactly one source: setting both an inline value / an
`existingSecret` and an `externalSecret` for the same secret fails `helm
template` with a sentence. ESO for the database password is only valid with an
external Postgres (the embedded eval Postgres manages its own Secret).

## Evaluation: all-in-one on kind

`postgresql.enabled` and `keycloak.enabled` run an in-cluster Postgres and a
preconfigured Keycloak (realm + SPA client imported at boot, login `dev`/`dev`).
Both are **evaluation-only**: single replica, no backups, Keycloak state dies
with its pod.

With [kind + an ingress controller](https://kind.sigs.k8s.io/docs/user/ingress/)
and [nip.io](https://nip.io) hostnames (no DNS setup — works wherever the node
IP is reachable from your browser, e.g. Linux):

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

helm install groundplan deploy/chart/groundplan -n groundplan --create-namespace \
  --set api.encryptionKey="$(openssl rand -base64 32)" \
  --set ingress.host=groundplan.$NODE_IP.nip.io \
  --set postgresql.enabled=true \
  --set keycloak.enabled=true \
  --set keycloak.host=auth.$NODE_IP.nip.io \
  --wait --timeout 10m
```

Then open `http://groundplan.<node ip>.nip.io` and log in as `dev`/`dev`.

Where the node IP is not browser-reachable (Docker Desktop, WSL2), skip the
ingress and drive the API directly the way CI does —
[`deploy/chart/tests/smoke.sh`](../deploy/chart/tests/smoke.sh) installs
without ingress, logs in via a port-forward and pushes a plan through the
webhook; it doubles as a runnable example of the whole flow.

## The resource catalog

The visual builder composes against the real provider schemas. Where those come
from is worth stating precisely, because it is the one place this product runs
Terraform at all:

> A worker runs `terraform` against a **generated empty configuration** that
> pins one allowlisted public provider, and asks that provider to describe
> itself. Never against your infrastructure, your state or your code. It holds
> no cloud credentials, because there are none to hold.

Every release bundles a snapshot of those schemas in the API image, so a fresh
install has the complete builder from the first request. Running the worker is
optional, and adds one thing: tracking new provider versions as they ship.

```yaml
catalog:
  refresh: auto            # `disabled` = no outbound call anywhere
  providers: ""            # allowlist; empty = azurerm, aws, google, kubernetes
  ttl: 6h
  worker:
    enabled: true
    persistence:
      enabled: true        # Terraform's plugin cache; without it every pass
      size: 8Gi            # re-downloads hundreds of megabytes
    networkPolicy:
      enabled: true
```

`catalog.providers` is an **allowlist, not a preference**. A Terraform provider
is an executable that `terraform init` downloads and runs, so nothing outside
this list is ever fetched, and the check happens before any process is spawned.

### Air-gapped clusters

Set `catalog.refresh: disabled` and leave `catalog.worker.enabled` false. The
API seeds its catalog from the bundled snapshot and makes no outbound
connection at any point; the interface labels the catalog **pinned** rather than
passing it off as current. The builder is complete — it is simply the version
the release shipped with.

To move a newer snapshot in by hand, build one on a connected machine and import
it:

```sh
# connected
pnpm --filter @groundplan/backend catalog:snapshot --out catalog-snapshot.json.gz
# air-gapped, with DATABASE_URL pointing at the cluster's Postgres
pnpm --filter @groundplan/backend catalog:snapshot --in catalog-snapshot.json.gz
```

### Egress

The worker needs DNS, the cluster's Postgres, and HTTPS to
`registry.terraform.io` and `releases.hashicorp.com`. Nothing else, ever.

`catalog.worker.networkPolicy.enabled` emits a NetworkPolicy that bounds it to
those *ports* — no ingress at all, DNS, 5432 in-cluster, 443 out. It cannot
name the two hosts: Kubernetes NetworkPolicy has no notion of a hostname.
Narrowing it further needs one of:

* a CNI with FQDN policies (Cilium `toFQDNs`, Calico `domains`), or
* an egress proxy, with `catalog.worker.networkPolicy.allowedCIDRs` set to the
  proxy alone and `HTTPS_PROXY` passed through.

If neither is available and unrestricted egress on 443 is unacceptable, run
air-gapped: the bundled snapshot is the supported answer, not a fallback.

## Feeding it from CI

groundplan ingests `terraform show -json` output posted by your pipeline —
it never touches cloud credentials or state. After connecting a repository the
UI shows its webhook URL + token; the short version is:

```bash
terraform plan -out=tfplan && terraform show -json tfplan > plan.json
npx @asteriusit/cli push-plan   # or plain curl — see the in-app snippet
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `helm template` fails with a sentence | Intentional — an impossible values combination (two database modes, two IdPs, missing encryption key...). The message says which value to fix. |
| API pods ready but every request 500s right after a first all-in-one install | Migrations still running (they are a post-install hook in embedded mode). `kubectl logs job/groundplan-migrate`. |
| `/readyz` returns 503 | Database unreachable from the pod — check `externalDatabase.*` and network policy. |
| Login redirect loops or 401s | Issuer/audience mismatch: the token's `iss` must equal `oidc.issuerUrl` exactly, and its `aud` must contain `oidc.audience`. |
| `ImagePullBackOff` | Private registry — set `image.pullSecrets`. |

## Chart CI

Every chart change runs `helm lint`, golden-file rendering tests
(`deploy/chart/tests/run.sh`) and the kind install smoke test
(`deploy/chart/tests/smoke.sh`) via `.github/workflows/helm-chart.yml`.

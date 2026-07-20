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
[`values.yaml`](../deploy/chart/groundplan/values.yaml); anything without a
first-class value (e.g. the AI layer's `AI_API_KEY`) goes through
`api.extraEnv`.

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

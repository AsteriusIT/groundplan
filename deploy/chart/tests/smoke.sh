#!/usr/bin/env bash
# Install smoke test (GP-172): install the chart in all-in-one evaluation mode
# on the CURRENT kubectl context (kind in CI), then walk the real product path
# offline: log in against the imported realm, create a project + repository,
# POST a fixture Terraform plan to the CI webhook, and assert the snapshot API
# returns the parsed graph's snapshot.
#
# Expects the app images already present on the cluster nodes:
#   groundplan-backend:$IMAGE_TAG  groundplan-frontend:$IMAGE_TAG
# (in CI: built locally + `kind load docker-image`). Keycloak runs the stock
# image so the smoke test never builds the themed one.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
chart="$here/../groundplan"

NAMESPACE="${NAMESPACE:-groundplan-smoke}"
RELEASE="${RELEASE:-groundplan}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-localhost}" # image = localhost/groundplan-backend:smoke
IMAGE_TAG="${IMAGE_TAG:-smoke}"
KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.7.0}"
PLAN_FIXTURE="$repo_root/apps/backend/src/graph/__fixtures__/plans/simple.plan.json"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

log() { printf '\n=== %s\n' "$*"; }

log "helm install ($NAMESPACE)"
helm install "$RELEASE" "$chart" \
  --namespace "$NAMESPACE" --create-namespace \
  --set image.registry="$IMAGE_REGISTRY" \
  --set image.tag="$IMAGE_TAG" \
  --set api.encryptionKey="$(openssl rand -base64 32)" \
  --set ingress.enabled=false \
  --set postgresql.enabled=true \
  --set keycloak.enabled=true \
  --set keycloak.image="$KEYCLOAK_IMAGE" \
  --set keycloak.theme="" \
  --wait --timeout 10m

kubectl -n "$NAMESPACE" get pods

log "port-forward keycloak + api"
kubectl -n "$NAMESPACE" port-forward "svc/$RELEASE-keycloak" 18080:8080 >/dev/null &
pids+=($!)
kubectl -n "$NAMESPACE" port-forward "svc/$RELEASE-api" 13000:3000 >/dev/null &
pids+=($!)
for i in $(seq 1 30); do
  curl -sf http://localhost:13000/readyz >/dev/null && break
  sleep 1
done

log "readiness reports db ok"
curl -sf http://localhost:13000/readyz | grep -q '"db":"ok"'

log "login (password grant against the imported realm)"
TOKEN="$(curl -sf http://localhost:18080/realms/groundplan/protocol/openid-connect/token \
  -d grant_type=password -d client_id=groundplan-frontend \
  -d username=dev -d password=dev -d scope=openid | jq -r .access_token)"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]
auth=(-H "Authorization: Bearer $TOKEN")

log "GET /me (JIT user + default org)"
ORG_ID="$(curl -sf "${auth[@]}" http://localhost:13000/api/v1/me | jq -r '.memberships[0].organization.id')"
[ -n "$ORG_ID" ] && [ "$ORG_ID" != "null" ]

log "create project + repository"
PROJECT_ID="$(curl -sf "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","slug":"smoke"}' \
  "http://localhost:13000/api/v1/orgs/$ORG_ID/projects" | jq -r .id)"
REPO_JSON="$(curl -sf "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/example/smoke.git"}' \
  "http://localhost:13000/api/v1/orgs/$ORG_ID/projects/$PROJECT_ID/repositories")"
REPO_ID="$(jq -r .id <<<"$REPO_JSON")"
WEBHOOK_TOKEN="$(jq -r .webhookToken <<<"$REPO_JSON")"
[ -n "$WEBHOOK_TOKEN" ] && [ "$WEBHOOK_TOKEN" != "null" ]

log "POST fixture plan.json to the CI webhook"
jq -n --slurpfile plan "$PLAN_FIXTURE" \
  '{ref:"refs/heads/smoke", commit_sha:"smoke000", event:"pull_request",
    pr_number:1, pr_title:"Smoke PR", payload:$plan[0]}' \
  | curl -sf -X POST -H 'Content-Type: application/json' \
      -H "X-Groundplan-Token: $WEBHOOK_TOKEN" -d @- \
      "http://localhost:13000/api/v1/webhooks/ci/$REPO_ID" >/dev/null

log "snapshot API returns the parsed plan"
SNAPSHOTS="$(curl -sf "${auth[@]}" \
  "http://localhost:13000/api/v1/orgs/$ORG_ID/repositories/$REPO_ID/snapshots")"
jq -e '.[0].source == "plan" and .[0].prNumber == 1 and (.[0].stats != null)' <<<"$SNAPSHOTS" >/dev/null \
  || { echo "unexpected snapshots: $SNAPSHOTS"; exit 1; }

log "smoke test passed"

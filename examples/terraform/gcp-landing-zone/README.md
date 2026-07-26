# gcp-landing-zone — a realistic GCP estate

A single-project landing zone: custom-mode VPC with Cloud NAT and Private
Service Access, a private GKE cluster, Cloud SQL, Cloud Run behind a global
HTTPS load balancer, and one KMS key that most of it is encrypted with.

## What it exercises

| Feature | Where to see it |
| --- | --- |
| Provider-agnostic graph | 40 nodes, 49 dependency edges, from HCL alone |
| Official GCP icons | VPC, subnetwork, firewall, Cloud Router, Cloud NAT, GKE, Cloud Run, Cloud SQL, Cloud Storage, BigQuery, Pub/Sub, KMS, Secret Manager, Artifact Registry, Cloud DNS, Cloud Monitoring, service accounts |
| References inside interpolated strings | `member = "serviceAccount:${google_service_account.api.email}"` still draws the edge — the reference is found inside the string |
| Explicit `depends_on` | Cloud SQL waits on the Private Service Access connection, an ordering nothing in the arguments would imply |
| A long serving chain | forwarding rule → HTTPS proxy → URL map → backend service → NEG → Cloud Run service: five hops the diagram lays out in order |
| Impact propagation | select `google_kms_crypto_key.main` and watch the blast radius reach the cluster, the bucket, the dataset, the topic and the secret |

## Honest limitation: two lenses are Azure-first

- `?view=network` shows the network-category resources but does **not** nest
  subnetworks inside the VPC — containment is derived from `azurerm_*` types
  today.
- `?view=iam` is empty. It is built on `azurerm_role_assignment`, so
  `google_project_iam_member` bindings do not populate it, even though they are
  in the graph as ordinary nodes with ordinary edges.

Infra, adapted and C4 views work normally, and so do diffing, impact analysis,
annotations, exports and share links.

## Policy

**Clean** — zero violations with every rule enabled. As with
[`aws-three-tier`](../aws-three-tier), read that with care: thirteen of the
sixteen rules look for `azurerm_*` types and simply found nothing to judge here.
The three provider-neutral ones (`orphan-resource`,
`encryption-at-rest-disabled`, `hardcoded-secret`) genuinely passed.

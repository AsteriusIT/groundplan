# Resource icons (GP-29, GP-91, GP-92, GP-93)

Groundplan draws a per-resource-type icon on every node. This document records
what those icons are, where they come from, and the licensing basis for shipping
them.

## What ships in the repo

Each provider's **official architecture icon set**, for the common service
families. Only the icons we map are committed, with clean kebab-case filenames
(e.g. `virtual-network.svg`, `ec2.svg`). They are the original vendor SVGs,
**unmodified** — renamed only, never edited.

### Azure (GP-29)

The **official Microsoft Azure Architecture Icons, set V24**, under
[`src/icons/azure/`](src/icons/azure/).

- Source: <https://learn.microsoft.com/en-us/azure/architecture/icons/> (the
  `Azure_Public_Service_Icons_V24` download).
- Total footprint ~128 KB of SVG; Vite emits each as its own hashed asset, so
  only the committed icons ship.

### AWS (GP-91)

The **official AWS Architecture Icons** (Q1 2025 asset package), under
[`src/icons/aws/`](src/icons/aws/), covering the common estate: EC2 / Auto
Scaling / Lambda (compute), EKS / ECS / ECR / Fargate (containers), VPC / ELB /
CloudFront / Route 53 / Internet & NAT gateways / ENI / API Gateway (network),
S3 / EBS / EFS (storage), RDS / Aurora / DynamoDB / ElastiCache (data), IAM /
KMS / Secrets Manager / ACM / WAF / Cognito (security & identity), SQS / SNS /
EventBridge / Step Functions (messaging), CloudWatch (observability).

- Source: <https://aws.amazon.com/architecture/icons/> (the quarterly
  "AWS Architecture Icons" asset package; the SVGs are used as-is, renamed to
  service keys).

### GCP (GP-92)

The **official Google Cloud product icons**, under
[`src/icons/gcp/`](src/icons/gcp/), covering the common estate: Compute Engine /
Cloud Functions / Cloud Run (compute), VPC / Cloud Load Balancing / Cloud DNS /
Cloud NAT / Cloud Router / firewall / external IP (network), Cloud Storage /
persistent disk (storage), Cloud SQL / Firestore / Bigtable / Memorystore /
BigQuery (data), IAM (identity), Pub/Sub (messaging), GKE / Artifact Registry
(containers), Cloud KMS / Secret Manager (security), Cloud Monitoring
(observability).

- Source: <https://cloud.google.com/icons> (the official "Google Cloud icons"
  download; the SVGs are used as-is, renamed to product keys). `google-beta`
  aliases resolve through the same table.

### Kubernetes (GP-93)

The **Kubernetes community icon set** (the recognisable blue heptagon kind
glyphs), under [`src/icons/kubernetes/`](src/icons/kubernetes/), covering the
common kinds: Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob,
HorizontalPodAutoscaler, Service, Ingress, NetworkPolicy, ConfigMap, Secret,
PersistentVolume(Claim), ServiceAccount, Role/ClusterRole, RoleBinding/
ClusterRoleBinding, Namespace, Node. The mapping table has **two key spaces**:
the Terraform `kubernetes_*` provider types and the bare native kinds
(`Deployment`, …) resolve to the same icons, so both producers render identically.

- Source: the [`kubernetes/community`](https://github.com/kubernetes/community/tree/master/icons)
  icon set (the `unlabeled` resource + infrastructure glyphs), used as-is,
  renamed to kind keys.

### The Kubernetes mark

The **official Kubernetes logo** (the blue helm wheel) at
[`src/icons/kubernetes-logo.svg`](src/icons/kubernetes-logo.svg), rendered by
`components/kubernetes-mark.tsx` as the sidebar's **Clusters** icon.

- Source: the [CNCF artwork repository](https://github.com/cncf/artwork)
  (`projects/kubernetes/icon/color/kubernetes-icon-color.svg`), used as-is via an
  `<img>` — never recoloured, redrawn, or restyled.
- It sits *outside* `src/icons/kubernetes/`, which is glob-keyed by Kubernetes
  **kind**. A logo is not a kind, and adding it there would put a `logo` entry in
  the kind lookup table.
- Because it is unmodified, it does not inherit `currentColor` the way the lucide
  nav icons beside it do: it stays brand blue whether its nav item is active or
  not. That is the trade — the nav says "active" with a border, a tint and a label
  weight, none of which need the icon's help.

### The IaC type marks (Terraform / Kubernetes)

A repository shows what it holds (GP-101) as a chip carrying the official
**Terraform** or **Kubernetes** logo, picked by its `iacType` and rendered by
`components/iac-type-mark.tsx`.

- Terraform mark: [`src/icons/terraform-logo.svg`](src/icons/terraform-logo.svg),
  the official Terraform logomark (the indigo parallelograms), used **as-is via an
  `<img>`** — never recoloured or redrawn.
- The Kubernetes side reuses [`src/icons/kubernetes-logo.svg`](src/icons/kubernetes-logo.svg)
  (the same mark the sidebar uses).
- Both sit *outside* the kind-keyed glob folders: a logo is not a kind.

## Licensing

### Azure

Microsoft's [Azure architecture icon terms](https://learn.microsoft.com/en-us/azure/architecture/icons/)
permit using the icons **to create architecture diagrams, including diagrams
displayed in a web application**, provided the icons are **not modified**
(no recolouring, no changes to proportions, no added effects). Groundplan renders
infrastructure architecture diagrams, which is exactly this use, and it renders
each icon **as-is via an `<img>`** — so the SVG is never recoloured or altered.
The project owner reviewed and accepted this use.

### AWS

Amazon's [AWS Architecture Icons terms](https://aws.amazon.com/architecture/icons/)
permit using the icons in architecture diagrams (including in documentation and
web applications) provided they are **not altered or used to imply endorsement**.
Groundplan renders each icon **as-is via an `<img>`** in its architecture diagram
views — never recoloured, redrawn, or used as a standalone AWS logo. The project
owner reviewed and accepted this use.

### GCP

Google's [Google Cloud icons](https://cloud.google.com/icons) are provided for
building architecture diagrams and technical documentation. Groundplan renders
each icon **as-is via an `<img>`** in its architecture diagram views — never
recoloured, redrawn, or used as a standalone Google Cloud logo. All
rights/ownership remain with Google. The project owner reviewed and accepted this
use.

### Kubernetes

The Kubernetes community icon set is licensed under **CC-BY-4.0** (Creative
Commons Attribution 4.0 International) — see the
[`kubernetes/community` icons LICENSE](https://github.com/kubernetes/community/tree/master/icons).
Attribution: **© The Kubernetes Authors, CC-BY-4.0.** Groundplan renders each
icon **as-is via an `<img>`** in its architecture diagram views, unmodified.

The **Kubernetes mark** (`src/icons/kubernetes-logo.svg`) comes from the CNCF
artwork repository, also under CC-BY-4.0, but it is additionally a **trademark of
the Linux Foundation**. It is used here nominatively — to label the part of the
product that reads Kubernetes clusters — never as a Groundplan mark, never to
imply endorsement or affiliation, and never altered. See the
[Linux Foundation trademark usage guidelines](https://www.linuxfoundation.org/legal/trademark-usage).

### Terraform

The **Terraform logo** (`src/icons/terraform-logo.svg`) is a **trademark of
HashiCorp**. It is used here nominatively — to label a repository whose
infrastructure is Terraform — never as a Groundplan mark, never to imply
endorsement or affiliation, and never altered (rendered as-is via an `<img>`). See
HashiCorp's [trademark policy](https://www.hashicorp.com/trademark-policy).

Do **not** edit the SVGs in `src/icons/azure/`, `src/icons/aws/`,
`src/icons/gcp/` or `src/icons/kubernetes/`, nor `src/icons/kubernetes-logo.svg`
or `src/icons/terraform-logo.svg`, and do not repurpose them as a standalone icon
library outside the views that render them.

## The mapping mechanism (provider-generic)

Azure was the first (demo) provider; the mechanism is provider-generic. Each
provider adds a mapping table + a vendored icon module, sharing one resolver and
one renderer.

- Per-provider mapping tables — an `<ICON>_ICON_MAP` (exact type → icon) and an
  `<ICON>_PREFIX_MAP` (type-prefix → icon heuristic):
  [`src/icons/azurerm.ts`](src/icons/azurerm.ts),
  [`src/icons/aws.ts`](src/icons/aws.ts),
  [`src/icons/gcp.ts`](src/icons/gcp.ts),
  [`src/icons/kubernetes.ts`](src/icons/kubernetes.ts) (two key spaces — Terraform
  types + bare kinds).
- Per-provider vendored icon modules — resolve an icon key to its bundled asset
  URL (`import.meta.glob` over `./<provider>/*.svg`, keyed via the shared
  [`src/icons/icon-assets.ts`](src/icons/icon-assets.ts) helper):
  [`src/icons/azure-icons.ts`](src/icons/azure-icons.ts),
  [`src/icons/aws-icons.ts`](src/icons/aws-icons.ts),
  [`src/icons/gcp-icons.ts`](src/icons/gcp-icons.ts),
  [`src/icons/kubernetes-icons.ts`](src/icons/kubernetes-icons.ts).
- [`src/icons/resource-icon.ts`](src/icons/resource-icon.ts) —
  `resolveResourceIcon(type)`, a pure, unit-tested function implementing the
  chain **exact type → type-prefix heuristic → category icon (GP-24) → generic
  cube.** Each provider tries its own icons only for its own types (`azurerm_*` →
  Azure, `aws_*` → AWS, `google_*` / `google-beta_*` → GCP, `kubernetes_*` and
  bare kinds → Kubernetes); any other type falls back to its lucide category
  icon, then a cube.
- [`src/components/resource-icon.tsx`](src/components/resource-icon.tsx) — the
  `<ResourceIcon type=… />` renderer.

Adding another provider is a new `<provider>.ts` map + `<provider>-icons.ts`
module (pointing at that provider's official icon set) plus a branch in the
resolver.

## Fallbacks

- **Unmapped mapped-provider type** (`azurerm_*`, `aws_*`, `google_*`,
  `kubernetes_*`) → nearest family via the prefix heuristic, else the lucide
  category icon (compute/network/data/…), else a cube.
- **Unmapped type** (a CRD kind, a Helm release, …) → lucide category icon, else
  cube.

The lucide fallbacks are colour-tinted by category token; only the official
vendor icons are rendered unmodified.

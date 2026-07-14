# Resource icons (GP-29, GP-91)

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

Do **not** edit the SVGs in `src/icons/azure/` or `src/icons/aws/`, and do not
repurpose them as a standalone icon library outside the diagram views.

## The mapping mechanism (provider-generic)

Azure was the first (demo) provider; the mechanism is provider-generic. Each
provider adds a mapping table + a vendored icon module, sharing one resolver and
one renderer.

- Per-provider mapping tables — an `<ICON>_ICON_MAP` (exact type → icon) and an
  `<ICON>_PREFIX_MAP` (type-prefix → icon heuristic):
  [`src/icons/azurerm.ts`](src/icons/azurerm.ts),
  [`src/icons/aws.ts`](src/icons/aws.ts).
- Per-provider vendored icon modules — resolve an icon key to its bundled asset
  URL (`import.meta.glob` over `./<provider>/*.svg`, keyed via the shared
  [`src/icons/icon-assets.ts`](src/icons/icon-assets.ts) helper):
  [`src/icons/azure-icons.ts`](src/icons/azure-icons.ts),
  [`src/icons/aws-icons.ts`](src/icons/aws-icons.ts).
- [`src/icons/resource-icon.ts`](src/icons/resource-icon.ts) —
  `resolveResourceIcon(type)`, a pure, unit-tested function implementing the
  chain **exact type → type-prefix heuristic → category icon (GP-24) → generic
  cube.** Only `azurerm_*` types try the Azure icons and only `aws_*` types try
  the AWS icons; any other provider falls back to its lucide category icon, then
  a cube.
- [`src/components/resource-icon.tsx`](src/components/resource-icon.tsx) — the
  `<ResourceIcon type=… />` renderer.

Adding GCP/Kubernetes later is a new `gcp.ts` / `kubernetes.ts` map (pointing at
that provider's official icon set) plus a branch in the resolver.

## Fallbacks

- **Unmapped mapped-provider type** (`azurerm_*`, `aws_*`) → nearest family via
  the prefix heuristic, else the lucide category icon (compute/network/data/…),
  else a cube.
- **Unmapped provider** (`google_*`, …) → lucide category icon, else cube.

The lucide fallbacks are colour-tinted by category token; only the official
vendor icons are rendered unmodified.

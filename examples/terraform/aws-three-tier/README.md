# aws-three-tier — a realistic AWS estate

A three-tier shop on AWS: Route 53 → ACM → WAF → ALB → an autoscaling group in
private subnets → RDS, DynamoDB, S3 and KMS behind it.

## What it exercises

| Feature | Where to see it |
| --- | --- |
| Provider-agnostic graph | 42 nodes, 64 dependency edges, from HCL alone |
| Official AWS icons | VPC, subnet, NAT gateway, ELB, EC2 Auto Scaling, RDS, DynamoDB, S3, KMS, IAM, Secrets Manager, CloudWatch, WAF, Route 53, ACM |
| References inside `jsonencode` | `aws_iam_policy.app` draws an edge to each of the four resources its statements name — the reference is found inside the string, so the permission shows up as a line |
| `depends_on` alongside inferred edges | `aws_nat_gateway.main` declares an explicit dependency on the internet gateway |
| Splat and indexed references | `aws_subnet.private[*].id`, `aws_subnet.public[count.index].id` |
| Impact propagation | select `aws_kms_key.main` — the blast radius reaches the bucket, the database, the table, the topic, the log group and the launch template |

## Honest limitation: the network lens is Azure-first

`?view=network` will show the network-category resources, but **it will not nest
them**. Subnet-inside-VPC containment, security-group chips and resource stacking
are derived from `azurerm_*` types today; every other provider gets nodes,
dependencies, modules and diffing. That is a real gap, not a bug in this example
— see [`azure-hub-spoke`](../azure-hub-spoke) for what the lens does when the
semantics exist.

The infra, adapted and C4 views all work normally here.

## Policy

**Clean** — zero violations with every rule enabled.

Read that carefully, though. Applicability in the report is about the *kind* of
graph (Terraform vs Kubernetes), not the provider: all sixteen rules are marked
applicable and enabled here. Three of them are genuinely provider-neutral and
really did pass — `orphan-resource` (nothing is left unconnected),
`encryption-at-rest-disabled` (nothing sets `storage_encrypted`/`encrypted` to
false) and `hardcoded-secret` (no literal password). The other thirteen look for
`azurerm_*` types and found none to look at, so on an AWS-only repository they
are quiet for a reason the report does not currently distinguish from passing.

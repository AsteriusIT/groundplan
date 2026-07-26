# Terraform examples

Eight self-contained Terraform stacks for exercising the product by hand: one
per subfolder, each one chosen to make a different part of the app do something
visible.

Every claim in these READMEs was produced by running the real Producer B parser,
the real lint pass and the real policy engine over the folder — not by reading
the code and guessing.

| Example | Provider | What it is for |
| --- | --- | --- |
| [`azure-hub-spoke`](azure-hub-spoke) | azurerm | The **network lens**: vnet ⊃ subnet ⊃ vm ⊃ nic, NSG chips, load-balancer stacking, peering collapsed to one edge, one exposed security group |
| [`azure-iam`](azure-iam) | azurerm | The **permissions lens**: principal → role → scope, managed identities, and why broad scope alone is not `Privileged` |
| [`azure-policy-clean`](azure-policy-clean) | azurerm | **Policies OK** — every built-in rule passes, including the ones that ship disabled |
| [`azure-policy-violations`](azure-policy-violations) | azurerm | **Policies fail** — all sixteen rules fire; same addresses as the clean twin, so diffing them is a real pull request |
| [`aws-three-tier`](aws-three-tier) | aws | A realistic AWS estate: Route 53 → WAF → ALB → ASG → RDS/S3/KMS, with IAM policy references drawn as edges |
| [`gcp-landing-zone`](gcp-landing-zone) | google | A realistic GCP estate: VPC + Cloud NAT, private GKE, Cloud SQL, Cloud Run behind a global LB |
| [`multi-module-monorepo`](multi-module-monorepo) | azurerm | Two stacks, three modules, one nested inside another — the example for `terraform_path` |
| [`parser-edge-cases`](parser-edge-cases) | azurerm | Diagnostics: a file that does not parse, dangling references, heredocs, `dynamic`, `count` vs `for_each` |

## Seeding all of them into your local instance

```bash
docker compose up -d          # Postgres
pnpm seed:examples            # publish, attach, document
```

Each example is published as a real bare git repository under `.local/example-repos/`
and attached to a project in the `default` organization over a `file://` remote.
The app then clones and parses it exactly as it would clone GitHub — no network,
no credentials, no shortcut into the database — so what you see is what the
product produces. Expect:

```
✔ azure-hub-spoke — 41 nodes, 71 edges, policy failing
✔ azure-iam — 16 nodes, 20 edges, policy passing
✔ azure-policy-clean — 19 nodes, 28 edges, policy passing
✔ azure-policy-violations — 20 nodes, 28 edges, policy failing
✔ aws-three-tier — 42 nodes, 64 edges, policy passing
✔ gcp-landing-zone — 40 nodes, 49 edges, policy passing
✔ multi-module-monorepo @ stacks/platform — 16 nodes, 25 edges, policy passing
✔ multi-module-monorepo @ stacks/sandbox — 7 nodes, 10 edges, policy passing
✔ parser-edge-cases — 12 nodes, 15 edges, policy passing, 1 warning(s)
```

Notes:

- **Idempotent.** Re-running reuses the repositories, projects and snapshots it
  already made — commits are stamped with a fixed identity and date, so
  unchanged content keeps the same sha. `--force` rebuilds them.
- **Log in once first**, so there is a user to make a member of the organization.
  With `SINGLE_ORG=true` (the default) a later first login joins automatically.
- The seeder adds every existing user to the target org, so the examples are
  visible in either deployment mode. `--org <slug>` sends them somewhere else.
- `--only azure-iam,aws-three-tier` seeds a subset; `--help` lists everything.
- Because the repositories are bare, you can clone one, branch, push, and drive
  the pull-request flow against it locally.

## Loading one by hand

**Playground** (fastest, no Git). Paste the files at `/playground` — it accepts
`.tf`, `.tfvars`, `.yaml` and `.yml`, up to 50 files and 1 MB total. Every
example here is comfortably inside that. Keep the relative paths (`modules/…`)
so local module sources resolve.

**VS Code extension** (offline). Open the example folder; the preview parses on
save and updates live. For `multi-module-monorepo`, set `groundplan.rootDir` to
`stacks/platform` or `stacks/sandbox`.

**A repository** (the full loop: docs of main, pull-request review, compliance
badges). Push one example to a repo the backend can clone, attach it to a
project with `iac_type: terraform`, and set `terraform_path` if the stack is not
at the repo root. The docs of main regenerate on merge; open a pull request to
get the review comment, the change summary and the policy delta.

**A plan** (Producer A instead of Producer B). `terraform init && terraform plan
-out tfplan && terraform show -json tfplan > plan.json`, then
`groundplan push-plan`. Note this needs real provider credentials — nothing here
was ever applied, and several resource names (globally-unique storage account and
bucket names) will collide if you try.

## These are examples, not reference architectures

They are written to be *readable in a diagram*: realistic enough that the graph
means something, small enough to take in at a glance. They are not hardened, not
cost-optimised, and `azure-policy-violations` is actively dangerous by design.
Do not copy them into an estate.

Nothing here has ever been applied. Provider versions are pinned so a `terraform
init` resolves, but the only guarantee made is about what the **parser** does
with the files.

## Known rough edge: `required-tags` and `tags = local.tags`

The built-in `required-tags` rule (off by default) reads a **literal**
`tags = { … }` block from the resource's source. The single most common way real
Terraform tags things —

```hcl
tags = local.tags          # or var.tags, or merge(local.tags, {…})
```

— is not a literal block, so the rule reports every required key as missing.
`missing-tags` is unaffected: it only asks whether a `tags =` assignment exists
at all, so it stays quiet.

You can see both behaviours side by side: [`azure-policy-clean`](azure-policy-clean)
writes its tag maps out inline and passes, while
[`multi-module-monorepo`](multi-module-monorepo) tags through `local.tags` /
`var.tags` and collects five false positives. Enable the rule in Policies to
reproduce it.

## A second thing worth knowing when testing

Rule **applicability** in a policy report is about the kind of graph (Terraform
vs Kubernetes), not the provider. Thirteen of the sixteen built-in rules look for
`azurerm_*` types, so on [`aws-three-tier`](aws-three-tier) and
[`gcp-landing-zone`](gcp-landing-zone) they are reported as enabled, applicable
and silent — indistinguishable in the report from a rule that genuinely found
nothing wrong. Only `orphan-resource`, `encryption-at-rest-disabled` and
`hardcoded-secret` really judge a non-Azure graph today.

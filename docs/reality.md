# Reality vs code: what exists, compared with what you wrote

Drift (`docs/drift.md`) tells you what changed under Terraform's feet. It cannot
tell you about a resource somebody created by hand — that one is in nobody's
state, so a refresh has nothing to compare. This is the other half: a picture of
everything the state knows about, set beside the picture your code describes.

## The rule: your state never leaves your machine

A Terraform state file is the most sensitive artefact your pipeline produces.
Every database password, every generated key, every certificate your
configuration touched is in there, in the clear.

So Groundplan never takes one. **The parsing and the sanitising happen in the
CLI, on your machine**, and only the derived graph is sent. If you post a raw
state at the API it is refused, with a message pointing back here — the promise
is checkable from both ends.

```sh
terraform state pull > terraform.tfstate
npx @asteriusit/cli push-state --file terraform.tfstate
```

### Read exactly what would be sent, before sending it

```sh
npx @asteriusit/cli push-state --file terraform.tfstate --dry-run
```

`--dry-run` writes the payload to `groundplan-state.json` (or `--out <path>`) and
sends nothing. It needs no URL and no token: demanding credentials to perform a
local audit would be a strange way to ask for trust.

Every run — dry or not — prints what it derived before it does anything:

```
derived 214 resources and 388 relationships from terraform.tfstate (Terraform 1.9.5)
sending 1809 attributes; 2140 withheld (sensitive, secret-named, or not a plain value)
no sensitive value is included — the state itself is never sent
```

## What is kept, and what is dropped

Kept: each resource's Terraform address, type, name, provider and module path;
the dependency edges the state records; module containment; and a **scalar-only**
attribute bag.

Three filters run over every attribute, in order:

1. Anything Terraform flagged in `sensitive_attributes` is dropped.
2. Anything whose name looks like a secret is dropped — `password`, `secret`,
   `token`, `*_key`, `connection_string`, `certificate` and friends — whether or
   not the provider bothered to flag it.
3. Anything that is not a string, number or boolean is dropped **entirely**,
   not summarised. This is the filter doing the heavy lifting: a secret buried at
   `environment.variables.API_KEY` cannot escape inside a structure that is never
   serialised.

Outputs are not sent at all, sensitive or otherwise. Neither is the state's
`lineage` or `serial`.

**The residual risk, stated plainly:** a *scalar* attribute holding a secret that
your provider did not mark, and whose name looks innocuous, would survive the
filters. That is what `--dry-run` is for.

### What the reality graph deliberately does not derive

No network containment, no NSG rules, no role-assignment semantics. Those lenses
are derived by the plan and HCL producers, which read provider knowledge this
parser does not have. A reality graph says *what exists and what depends on what*
— and says nothing it cannot honestly derive, rather than filling the network
lens with a guess.

## The view

Once a state has been pushed, the repository's documentation page grows a
**Reality vs code** lens. It compares the documentation of your default branch
with the reality snapshot and reports three things:

| Finding | Meaning |
| --- | --- |
| **Not managed by this repository** | In the cloud, absent from the code. Somebody made it by hand: nobody reviewed it, and destroying this workspace would leave it behind. |
| **Declared but not found** | In the code, absent from the state. Never applied, or removed underneath it. |
| **Disagreeing** | Present on both sides, with an attribute the two record differently. |

Only attributes **both** sides recorded are compared. The two producers keep
different bags, and reading "the code did not record this" as "the cloud changed
it" would mark an entire estate divergent for the crime of being described by two
different parsers.

The lens is absent until a state has been pushed. A comparison with nothing on
the other side would report your whole estate as never applied, which is a
confident lie shaped like a finding.

**Neither side is live.** The banner always names the commit the code came from
and how long ago the state was read, because a comparison whose age you cannot
see is one a reader assumes is current.

## An example job

Reality, like drift, is a schedule rather than an event.

```yaml
name: Groundplan reality
on:
  schedule:
    - cron: "30 3 * * *"
  workflow_dispatch:

jobs:
  reality:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # if you authenticate to your cloud with OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
      - run: terraform state pull > terraform.tfstate
      - name: Send the derived graph to Groundplan
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}
        run: npx --yes @asteriusit/cli push-state --file terraform.tfstate
      - if: always()
        run: rm -f terraform.tfstate
```

The same shape works on GitLab CI and Azure DevOps; see `docs/drift.md` for those
two written out.

## Supported state formats

Version 4 — what every Terraform since 0.12 and every OpenTofu release writes.
An older state is refused with a message telling you to run `terraform state
pull` with a current CLI, rather than being half-read.

One reality snapshot is kept per repository, replaced on each push. A drift
measurement is an event worth keeping a history of; a reality snapshot is a
position, and the previous position answers no question.

## Kubernetes repositories

There is no Terraform state behind one. A cluster's reality is the cluster:
attach it read-only (Clusters in the sidebar) and it is drawn per namespace.

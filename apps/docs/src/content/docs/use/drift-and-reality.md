---
title: Drift & reality
description: What changed in the cloud without the code asking, and what exists that the code never described — measured by your pipeline, never by us.
---

For the team that suspects the code is not the whole story. Two different
questions, two different artefacts, one posture: **the party that already holds
the cloud access does the reading**, and we ingest what it produced.

| | Drift | Reality |
| --- | --- | --- |
| Question | What changed under Terraform's feet? | What exists, including what nobody wrote down? |
| Artefact | `terraform plan -refresh-only` | A graph derived from your state, **in the CLI** |
| Sees resources created by hand | No — they are in nobody's state | Yes |
| Cadence | A schedule; nightly is a good default | A schedule |

## Drift

```sh
terraform plan -refresh-only -out=tfplan
terraform show -json tfplan > plan.json
npx @asteriusit/cli push-drift --file plan.json
```

The refresh happens in your pipeline, where the cloud access already is. We
never run it.

**A refresh-only plan plans nothing**, and that is enforced at both ends. A file
proposing a create, an update or a delete came from an ordinary `terraform plan`
— it says what your code *wants*, not what the cloud *did* — and pushing it
would put your own pull request on a screen labelled reality. So it is refused,
with the command that produces the right artefact in the message. `no-op` and
`read` entries are exactly what a refresh-only plan contains, and they are fine.

**A measurement with no drift is worth sending.** It is what lets the
documentation page say *"measured 40 minutes ago, clean"* rather than saying
nothing. "No drift" and "nobody looked" are different answers.

### Staleness is derived, not stored

A measurement is anchored to the **commit sha it refreshed**. When main moves,
the interface says the measurement is stale rather than showing yesterday's
drift against today's code — a merge invalidates a measurement by simply
happening, with nothing to expire and nothing to clean up.

Re-measuring the same sha replaces that measurement; measuring a new one starts
a new measurement and keeps the old as history.

### It is also graded

The drift report is folded over the code's graph and run through the
[policy engine](/use/policies/): a resource somebody changed in the portal is
judged by the same rules as one somebody merged. What the policy delta calls
`added` here is exactly "introduced outside your infrastructure as code".

## Reality

```sh
terraform state pull > terraform.tfstate
npx @asteriusit/cli push-state --file terraform.tfstate
```

### Your state never leaves your machine

A state file is the most sensitive artefact your pipeline produces: every
database password, every generated key, every certificate your configuration
touched is in it, in the clear.

So we never take one. **The parsing and the sanitising happen in the CLI, on
your machine**, and only the derived graph is sent. Post a raw state at the API
and it is refused — the promise is checkable from both ends.

Read exactly what would be sent, before sending it, with no URL and no token:

```sh
npx @asteriusit/cli push-state --file terraform.tfstate --dry-run
```

### What is kept and what is dropped

Kept: each resource's address, type, name, provider and module path; the
dependency edges the state records; module containment; and a **scalar-only**
attribute bag.

Three filters run over every attribute, in order:

1. Anything Terraform flagged in `sensitive_attributes` is dropped.
2. Anything whose **name** looks like a secret is dropped — `password`,
   `secret`, `token`, `*_key`, `connection_string`, `certificate` and friends —
   whether or not the provider bothered to flag it.
3. Anything that is not a string, a number or a boolean is dropped **entirely**,
   not summarised. This filter does the heavy lifting: a secret buried at
   `environment.variables.API_KEY` cannot escape inside a structure that is never
   serialised.

Outputs are not sent at all, sensitive or otherwise, and neither are the state's
`lineage` or `serial`.

**The residual risk, stated plainly:** a *scalar* attribute holding a secret that
your provider did not mark, under a name that looks innocuous, would survive the
filters. That is what `--dry-run` is for.

State format version 4 — what every Terraform since 0.12 and every OpenTofu
release writes. An older one is refused with the command that produces a current
one, rather than being half-read.

### The comparison

Once a state has been pushed, the documentation page grows a **Reality vs code**
lens:

| Finding | Meaning |
| --- | --- |
| **Not managed by this repository** | In the cloud, absent from the code. Somebody made it by hand: nobody reviewed it, and destroying this workspace would leave it behind. |
| **Declared but not found** | In the code, absent from the state. Never applied, or removed underneath it. |
| **Disagreeing** | Present on both sides, with an attribute the two record differently. |

Only attributes **both** sides recorded are compared. The two producers keep
different bags, and reading "the code did not record this" as "the cloud changed
it" would mark an entire estate divergent for the crime of being described by
two different parsers.

**Neither side is live**, and the banner always says so — the commit the code
came from, and how long ago the state was read. A comparison whose age you
cannot see is one a reader assumes is current, and that is this feature's one
real failure mode.

The reality graph deliberately derives **no** network containment, no security
group rules and no role-assignment semantics: a state does not carry the
provider knowledge those lenses need, and filling them with a guess would be
worse than leaving them to the producers that can. One reality snapshot is kept
per repository, replaced on each push — a drift measurement is an event worth a
history, a reality snapshot is a position.

## Kubernetes repositories

Neither applies: there is no Terraform state behind one, and a cluster's reality
is the cluster. Attach it read-only and draw it —
[Live clusters](/use/live-clusters/).

## Example jobs

Both are schedules rather than events. Run them on the default branch, from a
checkout of the default branch.

```yaml title=".github/workflows/groundplan-drift.yml"
name: Groundplan drift
on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

jobs:
  drift:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # if you authenticate to your cloud with OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
      - run: terraform plan -refresh-only -out=tfplan
      - run: terraform show -json tfplan > plan.json
      - name: Send drift
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_TOKEN }}
        run: npx --yes @asteriusit/cli push-drift --file plan.json
```

```yaml title=".github/workflows/groundplan-reality.yml"
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
      - name: Send the derived graph
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_TOKEN }}
        run: npx --yes @asteriusit/cli push-state --file terraform.tfstate
      - if: always()
        run: rm -f terraform.tfstate
```

GitLab CI and Azure DevOps take the same shape — see
[CI integration](/ci/) for those two wrappers.

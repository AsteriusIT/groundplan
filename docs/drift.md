# Drift: what changed in the cloud without the code being asked

Terraform tells you what your code *wants*. It does not tell you what somebody
did in the portal at 2am. `terraform plan -refresh-only` does — and because it is
a plan like any other, Groundplan can read it with the producer it already has.

**Groundplan never runs the refresh.** It has no cloud credentials, no access to
your state, and it is not getting either. Your pipeline already holds the access
that a refresh needs, so your pipeline does the refresh and pushes the artefact —
the same arrangement as pushing a `plan.json` instead of letting us run
`terraform`, and the same arrangement as rendering your own Helm charts.

## What you send

```sh
terraform plan -refresh-only -out=tfplan
terraform show -json tfplan > plan.json
npx @asteriusit/cli push-drift --file plan.json
```

`push-drift` uses the same two variables `push-plan` does — `GROUNDPLAN_URL` and
`GROUNDPLAN_TOKEN`, both on the repository's CI setup page. It derives the drift
endpoint from the URL you already configured; there is nothing extra to set.

### A refresh-only plan plans nothing

That is the whole rule, and both the CLI and the server enforce it. If the file
proposes a create, an update or a delete, it came from a normal `terraform plan`:
it describes what your code wants, not what the cloud did. Pushing it would put
your own pull request on the screen labelled "reality", so it is refused — with
the command that produces the right artefact in the message.

`no-op` and `read` entries are exactly what a refresh-only plan does contain, and
they are fine.

### Nothing drifted is a result worth sending

A push with an empty `resource_drift` is stored like any other. It is what lets
the docs page say *"measured 40 minutes ago, clean"* instead of saying nothing,
and there is a real difference between "no drift" and "nobody looked".

## Where it shows up

A measurement is stored beside the documentation of your default branch and
anchored to the **sha it refreshed**. When main moves, the measurement is marked
stale and the UI says so rather than showing yesterday's drift against today's
code: drift shown against the wrong sha is a confident answer to a question
nobody asked.

Re-measuring the same sha replaces that measurement. Measuring a new sha starts a
new one, and the previous one stays as history.

## Example jobs

Drift is a *schedule*, not an event — nightly is a good default. Run it on the
default branch, from a checkout of the default branch.

### GitHub Actions

```yaml
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
      - name: Send drift to Groundplan
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}
        run: npx --yes @asteriusit/cli push-drift --file plan.json
```

### GitLab CI

```yaml
groundplan-drift:
  image: hashicorp/terraform:latest
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  variables:
    GROUNDPLAN_URL: $GROUNDPLAN_URL
    GROUNDPLAN_TOKEN: $GROUNDPLAN_WEBHOOK_TOKEN
  before_script:
    - apk add --no-cache nodejs npm
  script:
    - terraform init
    - terraform plan -refresh-only -out=tfplan
    - terraform show -json tfplan > plan.json
    - npx --yes @asteriusit/cli push-drift --file plan.json
```

Add the schedule under **Build → Pipeline schedules**, on the default branch.

### Azure DevOps

```yaml
schedules:
  - cron: "0 3 * * *"
    displayName: Nightly drift
    branches:
      include: [main]
    always: true

trigger: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
  - task: NodeTool@0
    inputs:
      versionSpec: "22.x"
  - script: |
      terraform init
      terraform plan -refresh-only -out=tfplan
      terraform show -json tfplan > plan.json
      npx --yes @asteriusit/cli push-drift --file plan.json
    env:
      GROUNDPLAN_URL: $(GROUNDPLAN_URL)
      GROUNDPLAN_TOKEN: $(GROUNDPLAN_WEBHOOK_TOKEN)
```

## Without the CLI

The CLI only wraps one request. If you would rather not add it:

```sh
curl -sf -X POST "$GROUNDPLAN_URL/drift" \
  -H "X-Groundplan-Token: $GROUNDPLAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg ref "$GIT_BRANCH" \
        --arg sha "$GIT_SHA" \
        --slurpfile plan plan.json \
        '{ref:$ref, commit_sha:$sha, payload:$plan[0]}')"
```

The endpoint caps a body at 10 MB, answers `202` with the drifted count, and
`422` with an explanation when the plan is not refresh-only. `curl -sf` turns
either failure into a red step.

## Kubernetes repositories

There is no Terraform state to refresh. A cluster's reality is the cluster, and
attaching it read-only (Clusters in the sidebar) draws it per namespace.

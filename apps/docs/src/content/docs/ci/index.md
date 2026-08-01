---
title: CI integration
description: Feed the plan from GitHub Actions, GitLab CI or Azure DevOps — one command, three wrappers.
---

For the platform engineer wiring the pipeline. There is one command, and the
three snippets below differ only in the yaml around it.

Two things are true of every one of them, and they are the reason the
integration is this small:

- **Your pipeline produces the plan.** %PRODUCT% never runs `terraform` against
  your infrastructure, your state or your code — it has no cloud credentials to
  run it with, and that is the whole point. You already run `terraform plan` in
  review; this adds a step that posts the JSON.
- **The plan is data, not access.** Nothing is granted, so nothing needs
  revoking if you stop.

## The two secrets

Both are shown on the repository's CI setup page in %PRODUCT%. Store them as
pipeline secrets:

| Variable | What it is |
| --- | --- |
| `GROUNDPLAN_URL` | The repository's webhook URL. It contains the repository id — copying it from another repository is the most common silent failure. |
| `GROUNDPLAN_TOKEN` | The repository's webhook secret, displayed **once** when the repository is attached, rotatable from its settings at any time. |

## Producing the plan

```sh
terraform plan -out=tfplan
terraform show -json tfplan > plan.json
```

The binary plan file is not what gets sent — `terraform show -json` is. Be aware
of what that file contains: a plan carries the **values** of the attributes it is
about, and Terraform marks some of them sensitive. Those marked values are
masked in every diagram, diff and summary %PRODUCT% renders, and never appear in
a pull-request comment. Values your provider did not mark are stored like any
other attribute. Treat `plan.json` as an artefact worth deleting at the end of a
job, the same way you already treat the plan itself.

## GitHub Actions

```yaml title=".github/workflows/groundplan.yml"
name: Groundplan
on:
  pull_request:
  push:
    branches: [main]

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # only if you authenticate to your cloud with OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
      - run: terraform plan -out=tfplan
      - run: terraform show -json tfplan > plan.json
      - name: Send the plan
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_TOKEN }}
        run: npx --yes @asteriusit/cli push-plan --file plan.json
```

A pull request **from a fork** gets no repository secrets, so the step is
skipped by GitHub, not by us. That is the right default; a fork's pipeline
should not hold your ingestion token.

## GitLab CI

```yaml title=".gitlab-ci.yml"
groundplan:
  image: hashicorp/terraform:latest
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  variables:
    GROUNDPLAN_URL: $GROUNDPLAN_URL
    GROUNDPLAN_TOKEN: $GROUNDPLAN_TOKEN
  before_script:
    - apk add --no-cache nodejs npm
  script:
    - terraform init
    - terraform plan -out=tfplan
    - terraform show -json tfplan > plan.json
    - npx --yes @asteriusit/cli push-plan --file plan.json
```

Define both variables under **Settings → CI/CD → Variables**, masked and
protected.

## Azure DevOps

```yaml title="azure-pipelines.yml"
trigger:
  branches:
    include: [main]
pr:
  branches:
    include: ["*"]

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
  - task: NodeTool@0
    inputs:
      versionSpec: "22.x"
  - script: |
      terraform init
      terraform plan -out=tfplan
      terraform show -json tfplan > plan.json
      npx --yes @asteriusit/cli push-plan --file plan.json
    env:
      GROUNDPLAN_URL: $(GROUNDPLAN_URL)
      GROUNDPLAN_TOKEN: $(GROUNDPLAN_TOKEN)
```

## What is detected, and what to pass yourself

The CLI works out the branch, the commit sha and the pull-request number from
the checkout and the provider's own variables — including a detached-HEAD CI
checkout, where `git rev-parse` alone would give you the wrong answer.

| It reads | On |
| --- | --- |
| `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, `GITHUB_SHA`, `GITHUB_REF` | GitHub Actions |
| `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`, `CI_COMMIT_REF_NAME`, `CI_COMMIT_SHA`, `CI_MERGE_REQUEST_IID` | GitLab CI |
| `BUILD_SOURCEBRANCHNAME`, `BUILD_SOURCEVERSION`, `SYSTEM_PULLREQUEST_PULLREQUESTID` | Azure DevOps |
| the git checkout itself | anywhere else |

On a merge-request pipeline the **source branch** is what matters, not the
merge ref, which is why the head-branch variables are preferred. Where detection
is wrong — a bespoke runner, a mirrored repository, a monorepo pipeline — pass
`--branch`, `--sha` and `--pr` explicitly. The CLI prints what it detected
before it sends, so a disagreement is visible in the job log.

## Beyond pull requests

Two more commands run on a **schedule** rather than an event, because they
measure rather than review:

```sh
npx @asteriusit/cli push-drift --file plan.json   # what changed in the cloud
npx @asteriusit/cli push-state --file state.json  # what actually exists
```

Both are explained on [Drift & reality](/use/drift-and-reality/), with the point
worth repeating here: `push-state` parses and strips the state **on your
machine**, and only the derived graph is sent.

Kubernetes repositories have their own shape, because there is no plan to
produce — [Kubernetes manifests](/ci/kubernetes/).

## The job is green and nothing appeared

In this order, because this is the order in which it is usually one of them:

1. **Wrong token** — the CLI exits non-zero with `authentication failed`. If your
   step is green, it never ran; check the `if:` condition and fork rules.
2. **Wrong repository** — `GROUNDPLAN_URL` copied from another repository is a
   `404` from the CLI, with that word in it.
3. **The branch is not being tracked** — a pull request whose head branch the
   repository does not know about lands nowhere visible. The CLI's printed
   detection is the evidence.
4. **Over 10 MB** — a `413`, named as such. Very large estates split into
   several repositories or several paths.
5. **Right everywhere, wrong organization** — the same repository attached twice
   in two organizations, with the token of the other one.

The full symptom table is [Troubleshooting](/help/troubleshooting/); the flags,
exit codes and retry behaviour are the [CLI reference](/ci/cli/).

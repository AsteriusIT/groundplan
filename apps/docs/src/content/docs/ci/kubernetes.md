---
title: Kubernetes manifests
description: Review a manifests repository like a Terraform one — raw YAML read from the clone, Helm and Kustomize rendered by your CI.
---

For a team whose infrastructure is manifests rather than HCL. A manifests
repository gets the same loop as a Terraform one — documentation of main, a
diagram per pull request — with one difference that explains everything else:
**there is no plan file**, so a pull request is coloured by comparing its graph
against the latest documentation of main.

Reading a running cluster is the other half, and a different thing entirely:
[Live clusters](/use/live-clusters/).

## Attach the repository as `kubernetes`

The type is chosen when the repository is attached and is **immutable**
afterwards: every producer branches on it, and a repository that changed type
would silently invalidate its own history. `terraform_path` doubles as the
manifests directory.

A repository is one type **or** the other, never both. For a monorepo holding
`infra/terraform` and `deploy/manifests`, attach it **twice** — once as
`terraform` with the first path, once as `kubernetes` with the second. Two
repositories, two documentation pages, two review streams, one git remote.

## Raw YAML: nothing to render

If the repository holds plain manifests, %PRODUCT% reads them from the clone
itself. Merges to main re-document it with no pipeline step at all; the ref
poller notices the branch moved.

You still want a pull-request step, because a pull request's head is not
something we clone:

```yaml
- run: cat manifests/*.yaml > rendered.yaml
```

…and post it, as below.

## Helm and Kustomize: your CI renders

We never run `helm` or `kustomize`. They are programs that execute a
repository's own code — running somebody's chart inside our backend is exactly
the access this product is built not to take. So the render happens where it
already happens, in your pipeline, and we ingest the output. Identical
arrangement to plan JSON instead of `terraform`.

```yaml title=".github/workflows/groundplan.yml"
name: Groundplan
on:
  pull_request:
  push:
    branches: [main]

jobs:
  manifests:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: helm template . -f values.yaml > rendered.yaml
      - name: Send the rendered manifests
        run: |
          curl -sf -X POST "$GROUNDPLAN_URL" \
            -H "X-Groundplan-Token: $GROUNDPLAN_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
              --arg ref "$GITHUB_HEAD_REF" \
              --arg sha "$GITHUB_SHA" \
              --argjson pr ${{ github.event.pull_request.number }} \
              --arg manifests "$(cat rendered.yaml)" \
              '{ref:$ref, commit_sha:$sha, event:"pull_request", pr_number:$pr, payload:{manifests:$manifests}}')"
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_TOKEN }}

  docs:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: helm template . -f values.yaml > rendered.yaml
      - name: Send main's manifests
        run: |
          curl -sf -X POST "$GROUNDPLAN_URL" \
            -H "X-Groundplan-Token: $GROUNDPLAN_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
              --arg ref "$GITHUB_REF" \
              --arg sha "$GITHUB_SHA" \
              --arg manifests "$(cat rendered.yaml)" \
              '{ref:$ref, commit_sha:$sha, event:"push", payload:{manifests:$manifests}}')"
        env:
          GROUNDPLAN_URL: ${{ secrets.GROUNDPLAN_URL }}
          GROUNDPLAN_TOKEN: ${{ secrets.GROUNDPLAN_TOKEN }}
```

Kustomize is the same file with one line changed:

```yaml
- run: kustomize build overlays/prod > rendered.yaml
```

**The `docs` job is not optional for a chart or an overlay.** Templates are not
manifests — a chart's `templates/` directory is Go source, and reading it as
YAML produces nonsense. So main's documentation has to come from the same render
its pull requests do. A raw-YAML repository is the only one that can skip it.

The in-app CI setup panel generates this workflow for your flavour, with your
repository's URL already filled in.

## What a review looks like without a plan

The head graph is compared with the latest documentation of main, structurally:
objects only in the head are created, objects only in main are deleted, and
objects in both whose recorded attributes differ are updated. The comparison
base is recorded with the result, so a diagram always says what it was coloured
against.

Node identity is **namespace-qualified**, so the same Deployment name in two
namespaces is two nodes rather than one confusing one.

A body we cannot parse is a `422` that stores nothing. Half a graph is worse
than no graph: it would look like a deletion.

## What a Kubernetes snapshot does not get

Deliberate, and worth knowing before you plan around it. A Kubernetes snapshot
gets **the diagram and the deterministic summary — and nothing else**:

- no annotations (so no adapted view and no C4 view);
- no AI summaries or explanations;
- no guided tours;
- no public share links;
- no network or IAM lens — those read Terraform provider semantics that a
  manifest does not have.

An empty lens is worse than a missing one: it tells the reader their system has
no network and no permissions, which is a lie shaped like information. So the
lenses that cannot be honest are not offered.

Also not supported, and not planned as a silent surprise: custom resources,
pod-level granularity, multi-namespace views, and cross-linking a Terraform
graph to a Kubernetes one.

## Secrets

A `Secret` object appears on the diagram as a node with its name, so you can see
that one exists and what mounts it. Its **values are never read, stored or
drawn** — not from a manifest that hands them over in the clear, and not from a
cluster. See [Live clusters](/use/live-clusters/) for the same rule on the
reading side.

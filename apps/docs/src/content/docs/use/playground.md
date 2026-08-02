---
title: Playground
description: Paste HCL or Kubernetes YAML, get a diagram — multi-file, savable, and touching no repository.
---

For anybody who wants a diagram in thirty seconds: an evaluator, somebody
sketching a design, somebody explaining a module in a meeting. The playground
parses what you paste and draws it. No repository is touched, no pipeline is
involved, and nothing you type is pushed anywhere.

## What it takes

- **Terraform HCL** or **Kubernetes YAML**, several files at a time — paste them,
  or drag them in.
- Up to **50 files**, and **1 MB** in total. Beyond that it is a repository, and
  a repository is what [attaching one](/quickstart/) is for.

Editing is a real editor, because pasting four files into one textarea is not a
workflow: a file tree with folders (so a module layout stays a module layout),
open-file tabs that remember where you were in each file, and syntax
highlighting. The diagram beside it redraws itself a moment after you stop
typing — and when the files stop parsing, the last good diagram stays on screen
with the error named beside it, rather than a blank canvas.

Selecting a resource on the diagram opens the file that declares it, at the
right line.

## What you get

The same graph engine the rest of the product uses — the same parser, the same
inferred dependencies, the same layout. A diagram here and a diagram of the same
files in a repository are identical by construction, not by resemblance.

Available lenses: **Global**, **Network** and **IAM** for Terraform; the diagram
alone for Kubernetes. There is no annotation layer in the playground, so Adapted
and C4 would fold over nothing and are not offered.

The [twelve lint rules](/use/policies/) run here too, so a security finding you
meet while sketching is the same finding your pull request will raise.

## Drafts

Save what you are working on and come back to it. A draft stores your **source
files**, not the snapshot — the graph is regenerated when you load it, so a
draft saved in March and opened in July is parsed by July's parser rather than
replaying a stale picture.

Drafts belong to your organization, like everything else.

## What it is not

It does not read `plan.json`, does not resolve variables from a workspace, does
not expand `count` or `for_each`, and does not talk to any cloud. It is the
static parse, applied to what you pasted — the same producer behind
[the documentation of main](/use/living-documentation/), with the same honest
limits.

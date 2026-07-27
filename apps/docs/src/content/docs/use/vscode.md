---
title: VS Code extension
description: A live architecture diagram beside your editor while you type — fully offline, with a diff mode that is a code diff, not a plan diff.
---

For the engineer writing the Terraform. The extension renders the workspace
folder's HCL as an interactive diagram beside the editor, and updates it about a
second after you stop typing — **before you save**.

## It runs locally, and that is the whole trust model

Parsing happens inside the extension host on your machine. No cloud call, no
account, no sign-in, no telemetry, and it works with the network off. Nothing is
uploaded anywhere, ever. The extension does not talk to a %PRODUCT% server at
all — not even an optional one.

## Install and open

Install the extension, open a folder containing `.tf` files, and use the preview
button in any `.tf` editor's title bar (or **%PRODUCT%: Open Preview** from the
command palette).

## What it does

- **Live preview** — the current workspace folder's Terraform as an interactive
  diagram: pan, zoom, search, filters, and real vendor icons for Azure, AWS, GCP
  and Kubernetes resources.
- **Live while you type** — unsaved edits count. A syntax error never blanks the
  panel: the last good diagram stays, marked *out of sync*, and the error lands
  in the Problems panel with its file and line until you fix it.
- **Node ↔ code navigation** — click a node to open its block; put your cursor
  inside a `resource` block to light up its node.
- **The same lenses** — Network and IAM are here too, with the same
  `azurerm`-first semantics as the web product.

It uses the **same parser, differ and canvas packages** as the web product, so a
diagram in your editor and a diagram in a pull request are identical by
construction rather than by resemblance.

## Diff mode: a code diff, not a plan diff

Toggle diff mode and the working tree is compared against a git baseline — `HEAD`
or your branch's merge-base — with unchanged resources ghosted and a
changed-only filter.

**This is a diff of your code, not of a plan.** It has no state, so:

- it shows no drift and nothing about what exists in your cloud;
- `count` and `for_each` are not expanded;
- a resource renamed without a `moved` block reads as a delete plus a create —
  exactly as Terraform itself would read it.

For the plan-level truth — the real blast radius, the attribute diff, the
replacements — push a plan and read
[the pull-request view](/use/pull-requests/).

## Settings, not chrome

Three preferences: `groundplan.theme`, `groundplan.rootDir` and
`groundplan.followActiveFile`. They live in settings because that is where
preferences live; the panel itself stays a diagram.

## Limits, from its README, unembellished

- A multi-root workspace previews the **first folder**, and the panel says so.
- Repositories of 500+ resources are not tuned for yet.
- No `helm`, `kustomize` or `plan.json` rendering in the editor.
- No annotations, no AI, no policies, no sharing — those need the server, and
  the extension deliberately has none.

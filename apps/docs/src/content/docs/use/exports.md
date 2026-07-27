---
title: Exports & sharing
description: Get the diagram out — SVG, PNG, an editable draw.io file, a Confluence page, or a revocable public link.
---

For the moment a diagram has to leave the product: a slide, a wiki, an auditor,
a customer. Four ways out, each with a different trade between fidelity and
control.

## SVG and PNG

Rendered on the server and cached, so the same snapshot always produces the same
file, byte for byte. That is what makes an export usable as evidence: two people
exporting the same version get the same image.

On a pull request you can also export **changes only** — the changed resources
and their blast radius, without the ghosted estate. It is what the pull-request
comment embeds.

## draw.io

An editable `.drawio` file: real shapes, real edges, real labels — not an image
in a frame. Edge semantics match the canvas (declared and inferred dependencies
stay distinguishable), and the vendor icons travel with the file rather than
being fetched from anywhere at open time.

For the icons to appear in the draw.io shape picker, install the shape library
**from Device** rather than from a URL. The repository ships the generated
library beside the exporter.

This is a one-way door: an edited draw.io file is your document from then on. It
does not come back, and it does not update on the next merge. Use it for the
board slide; use the living documentation for the truth.

## Confluence

Publish a repository's documentation as **one page per repository**, updated in
place. It carries a 2× rendered image, the deterministic summary, and a "view
live" link back into %PRODUCT% — a share link when one exists, the in-app URL
otherwise.

Publishing again updates the same page rather than creating a second one, so the
wiki does not grow a graveyard. A failure is recorded on the connection and
shown in the interface rather than thrown away, so a page that stopped updating
says why.

The credential lives on an **organization-level integration** and can be
attached by any number of repositories — see
[Integrations](/admin/integrations/).

## Public share links

A tokenized, read-only URL that needs no login. For the auditor, the customer,
or the colleague who does not have an account.

| Choice | What it means |
| --- | --- |
| **Always latest** | Resolves to the newest documentation of main, so the link stays true as the estate moves |
| **Pinned** | Locked to one version, so a link in a report keeps showing what the report described |

What a share link exposes: the diagram, its lenses, and the deterministic
summary. What it does not: your organization, your other repositories, your
settings, any credential, and **any AI-generated content** — that is excluded by
construction rather than by a checkbox. The [compliance state](/use/policies/) is
excluded too unless the person creating the link opts in.

Links are **revocable at any time**, and revocation is immediate. Public access
is rate-limited per IP, so a link that escapes cannot be used to hammer the
instance.

Kubernetes snapshots have no share links —
[the limits](/ci/kubernetes/#what-a-kubernetes-snapshot-does-not-get).

## Which one to use

| You need | Use |
| --- | --- |
| A picture in a slide or a ticket | PNG |
| A picture that scales in a document | SVG |
| To edit the drawing and own the result | draw.io |
| The wiki your organization already reads | Confluence |
| To show someone outside, and take it back later | A share link |

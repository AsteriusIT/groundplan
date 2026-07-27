---
title: The AI layer
description: Optional, contained, and unable to change what a diagram says — what it sees, what it produces, and where the data goes.
---

For whoever decides whether this gets switched on, and for whoever has to
explain that decision. The short version: it is off unless you configure a key,
it never sees your plan files or your HCL, and it cannot change a single thing a
diagram says.

## Without `AI_API_KEY`, the AI layer does not exist

Not hidden, not disabled, not "coming soon" — **absent**. With no key
configured, the status endpoint reports it off, every generation route answers
`404`, and the frontend renders no AI surface at all: no buttons, no panels, no
menu entries. There is no dev default, because inference costs money and
defaults are how surprises happen.

Setting `AI_API_KEY` (and optionally `AI_MODEL`) is the whole activation.
[Configuration reference](/reference/configuration/).

## What the model sees

**Never your raw `plan.json`. Never HCL from your repositories.**

Every generation is grounded in a **deterministic Markdown brief** that
%PRODUCT% renders from its own outputs — the change counts, the resource
addresses, the summary it already produced, the context your team wrote. The
brief-building code is golden-tested, which means the exact text sent to a model
is a reviewable artefact in the repository rather than a runtime accident.

So the blast radius on your screen was computed by a graph algorithm; the model
is describing it, not deciding it.

## What it produces

| Feature | What it is |
| --- | --- |
| **Change summary** on a pull request | Prose above the deterministic summary, never instead of it |
| **Explain this infrastructure** on the documentation | A narrative walk-through of the estate |
| **Annotation proposals** | Suggested groups and renames, delivered to a [review inbox](/use/annotations/) — a human accepts every one |
| **Guided tours** | A narrated, camera-driven walk-through; the camera script is validated against the snapshot, so a step pointing at a resource that does not exist is dropped rather than shown |

The deterministic summary is the default and always present. The AI summary is
an addition on top of it — turning the layer off does not remove a feature you
were relying on, it removes an extra.

## How output is treated

As **untrusted input**, because that is what it is:

- rendered as Markdown, never as HTML;
- hallucinated anchors — a reference to a resource not in the snapshot — are
  dropped rather than rendered as a broken link;
- a response that should be JSON and is not is rejected, and **failures are never
  cached**, so a bad generation is not served twice.

Generation is always **user-triggered** — never on page load — **streamed**,
**cached** per (target, prompt version, model) so a second ask costs nothing, and
always **labelled with the model name** so nobody mistakes it for a measurement.
One generation per target at a time.

AI content is **excluded from public share links** by construction.

## Where the data goes

When the layer is on, the briefs described above are sent to the model provider
you configured, over its API, from your deployment. Nothing else is. No plan
files, no repository contents, no credentials, no state.

That is the sentence to hand to whoever asks: *the deployment sends
%PRODUCT%-generated summaries of infrastructure structure to the configured
model provider; it sends no source code, no plan files and no secrets.* If that
is not acceptable, leave the key unset and the product loses nothing
deterministic.

## Not this

The AI layer does not decide what a diagram shows, does not modify a snapshot,
does not accept its own annotation proposals, and does not run when nobody asked
it to. Those are structural properties, not settings.

The Terraform-generating chat on top of this layer is a separate surface with
its own rules, and it is **experimental and Azure-only**:
[AI Studio](/ai/studio/).

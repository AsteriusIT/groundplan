---
title: Living documentation
description: The diagram of your default branch, redrawn on every merge, with history and version comparison.
---

For anybody who has maintained an architecture diagram by hand and stopped. The
documentation of main is generated from your HCL, regenerated when main moves,
and versioned — so it is never older than your last merge and you can always see
what changed between two dates.

## Where it comes from

A **static parse of the HCL in your repository**. No plan, no apply, no cloud
call: we clone the default branch with the credential you gave us and read the
files. That is why the documentation exists from the moment a repository is
attached, before any pipeline has ever run.

It regenerates when the default branch moves. A ref poller checks each
repository's remote every minute; where the provider can reach you, a webhook
makes it seconds instead. Both funnel through the same handler and are
deduplicated on the fact — a webhook and a poll finding the same commit produce
one regeneration, not two.

## What a static parse does and does not resolve

It reads the configuration, not an execution of it, and it says so rather than
guessing:

- **Modules** are read and their containment is drawn.
- **Dependencies** come from `depends_on` **and** from expression references —
  `azurerm_subnet.web.id` in another resource's argument is an edge, whether or
  not anyone declared it.
- **`count` and `for_each` are not expanded.** A resource with `count = 3` is one
  node in the documentation, not three. Expansion is something only a plan knows,
  and a plan is what the [pull-request view](/use/pull-requests/) reads.
- **Variables are not resolved** to the values a particular workspace would
  supply. The documentation describes the code, and the code is what every
  workspace shares.

If what you want is what *exists* rather than what is described, that is
[Drift & reality](/use/drift-and-reality/).

## History

Every regeneration is a version, kept and dated with the commit it came from.
The history control on the documentation page walks them, and the canvas shows
the estate as of that version — not the newest one with a label.

## Comparing two versions

Pick two versions and the diagram colours the difference: **added**, **removed**
and **moved** (the same resource under a different module path or name). A
summary strip counts them.

This is a different question from a pull-request diagram, and it is drawn
differently on purpose: a pull request asks *what would this change do*, and a
version comparison asks *what has this repository become since March*. Both are
graph comparisons; only the second one has two graphs that both really exist.

## From diagram to code

Click a node and read the HCL it came from — the actual text, at the file and
line the parser recorded, at that version. A diagram that cannot show you its
source is asking to be trusted; one that can is checkable.

## Kubernetes repositories

The same tab, from the same idea: a `kubernetes` repository's documentation is
built from its manifests. Raw YAML is read from the clone; a chart or an overlay
is documented from the render your CI pushed, because templates are not
manifests. See [Kubernetes manifests](/ci/kubernetes/).

## It regenerated with less in it than before

Almost always one of three things, and all three are visible rather than
silent:

| Cause | What you see |
| --- | --- |
| The default branch is not what we think it is | The repository's settings name the branch being tracked. |
| The path is wrong | A repository with `terraform_path` set to a directory that moved parses an empty tree. |
| A parse error in a file | The affected file is reported; the rest of the graph is still drawn, and the snapshot is marked partial. |

We never store a graph that is silently empty in place of one that failed.

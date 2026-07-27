---
title: FAQ
description: The questions that come up before a trial, answered without hedging.
---

For the person about to have this conversation with their security team, their
platform team or their manager.

## Do you need access to our cloud account?

**No.** %PRODUCT% holds no cloud credentials — no subscription, no IAM role, no
access key — and there is no code path in the product that could use one. Your
pipeline already runs `terraform plan`; you add a step that posts the JSON it
produced.

That is also why there is nothing to revoke if you stop: nothing was ever
granted.

## Do you run `terraform`, `helm` or `kustomize`?

**Never.** Rendering happens in your pipeline, where the access already is, and
we ingest the output. Running somebody's chart inside our backend would be
exactly the access we promise not to take.

## Do you read our Terraform state?

**No.** For the "what actually exists" view, the state is parsed and stripped
**by the CLI on your machine**, and only the derived graph is sent — post a raw
state at the API and it is refused. The filters, and the residual risk, are
written out on [Drift & reality](/use/drift-and-reality/), and `--dry-run` shows
you the exact payload before anything is sent.

## What does the AI see?

A deterministic Markdown brief that %PRODUCT% renders from its own outputs —
never your raw plan files, never HCL from your repositories. With no API key
configured the AI layer does not exist at all: no routes, no interface, no
calls. [The AI layer](/ai/).

## What if your service goes down — does our CI break?

The push step fails, so the job fails if you let it. The CLI exits non-zero
deliberately, because a silent success is worse than a red step. If you would
rather a documentation push never block a deployment, mark that step as
non-blocking in your pipeline — nothing downstream of it depends on us.

Nothing else changes: %PRODUCT% is not in the path of an `apply`, does not hold
a lock, and is not a gate unless you make it one.

## Can we self-host?

Yes, and it is the primary shape. The whole platform — reverse proxy with
automatic HTTPS, API, frontend, database, identity provider — comes up from
[one compose file](/install/docker-compose/), or from
[a Helm chart](/install/kubernetes/) on a cluster. No managed service, no
external dependency at runtime, no telemetry.

## Does it work with AWS or GCP?

Yes, with an honest boundary. Any Terraform provider gets nodes, dependencies,
modules, the attribute diff, the change summary, policy evaluation and vendor
icons. The **Network and IAM lenses** and the exposure badges read
Azure-specific semantics and are not offered elsewhere —
[Known limits](/help/limits/).

## Does the VS Code extension send our code anywhere?

**No.** It parses inside the extension host, works fully offline, has no account
and contains no telemetry. [Details](/use/vscode/).

## What happens if a diagram cannot be fully built?

It says so. Partial results carry explicit warnings naming what was skipped, and
a body that cannot be parsed is rejected without storing anything. An empty or
misleading graph is never stored in place of one that failed.

## Who can see what, inside an organization?

Everyone in an organization sees its whole estate; roles decide what they may
**change**. There is no ownership below the organization and no per-project
permissions — two teams that must not see each other need two organizations.
[Organizations & roles](/admin/organizations/).

## Do you email our users?

No. There is no SMTP anywhere in the product. Invitations are links you copy and
send yourself, and authentication is your identity provider's.

## Does it cost-estimate our infrastructure?

No. Nothing in the product prices resources, and this documentation will not
imply otherwise.

## How do we get our data out?

Diagrams export as SVG, PNG and editable draw.io files; documentation publishes
to Confluence; share links are public read-only URLs. The database is yours —
it is running on your infrastructure. [Exports & sharing](/use/exports/).

## Something is broken — what do you need from us?

The version, the deployment mode (Compose or Helm), what was pushed, and the
exact message. [Troubleshooting](/help/troubleshooting/) probably has it already.

---
title: Known limits
description: What %PRODUCT% does not do, stated as the choices they are rather than discovered as surprises.
---

For anybody sizing up whether this fits. Everything below is a deliberate
boundary, not a defect awaiting a fix — if one of them is a blocker for you, it
is better to know now than in week three.

## Nothing prices anything

There is no notion of money in the product: no rates, no forecasting, no budget
alerts. A diagram tells you what changes and what depends on it, and says
nothing about what it will be billed at.

## Deep semantics are Azure-first

The Network view, the IAM view, the `Exposed` and `Privileged` badges and the
join-resource catalogue read `azurerm` resources. **Any** Terraform provider
gets nodes, dependencies (declared and inferred), modules, the full attribute
diff, the change summary, policies over the graph and its vendor icons — AWS,
GCP and Kubernetes icons all ship.

What you do not get on AWS or GCP is a security-group exposure analysis or a
role-assignment lens. Those lenses are not offered rather than drawn empty.

## Kubernetes snapshots get the diagram and the summary

No annotations, no adapted or C4 view, no AI, no guided tours, no share links,
and no network or IAM lens. Also unsupported: custom resources, pod-level
granularity, multi-namespace views, and cross-linking a Terraform graph to a
Kubernetes one.

## The static parse does not execute anything

The documentation of main comes from reading your HCL, so `count` and `for_each`
are **not expanded** (one resource with `count = 3` is one node) and variables
are not resolved to a particular workspace's values. Plan-level truth comes from
a plan; what exists comes from
[a state graph](/use/drift-and-reality/).

## No ownership below the organization

Every member of an organization sees its whole estate. There are no
per-project ACLs, no private repositories inside a shared organization, and no
group-to-role mapping from your identity provider. Separating two teams means
two organizations.

## Invitations are copy-the-link

No SMTP is configured, required or used anywhere. You copy a link and send it
yourself.

## The VS Code extension is offline and narrower on purpose

First workspace folder only; not tuned for repositories of 500+ resources; no
`helm`, `kustomize` or `plan.json` rendering in the editor; and diff mode is a
**code** diff against a git baseline, not a plan diff — no state, no drift, no
`count` expansion, and a rename without a `moved` block reads as delete plus
create. [Details](/use/vscode/).

## The AI layer is optional and contained

Off entirely without a key. When on, it never sees raw plan files or repository
HCL, never modifies a snapshot, and never applies its own suggestions. The
[AI Studio](/ai/studio/) on top of it is **experimental and Azure-only**, and its
sessions store nothing.

## Policies have no custom-rule language

Sixteen built-in rules, configurable per organization and per repository
(enabled, severity, parameters). Writing a new rule means adding it to the
codebase, not authoring one in the interface.

## Operational shape

- A pushed plan or manifest body is capped at **10 MB**.
- The playground takes up to **50 files** and **1 MB** in total.
- The documentation of main lags a merge by up to a minute without a provider
  webhook.
- There is **no audit log** of user actions, no billing, and no status page.
- One reality snapshot is kept per repository — a position, not a history.

## And the name

The public product name is not final. The working name appears throughout the
product, the CLI and this site while a trademark clearance completes, which is
also why this site asks search engines not to index it.

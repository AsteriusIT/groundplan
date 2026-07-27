---
title: Policies
description: Grade every snapshot against rules your organization chose — on pull requests, on main, with waivers that mark rather than hide.
---

For the person who has been leaving the same review comment for two years. A
policy is that comment, written once and enforced by the product: a set of
deterministic rules evaluated over every snapshot, with the result shown where
people already look.

There is **no AI in this** and no cloud access. A rule is a pure function over
the graph, like the parsers and the differ — the same input always produces the
same verdict, which is what makes it fair to block a merge on one.

## Where you meet it

- **Policies** in the sidebar is the rule catalogue: the standard your estate is
  graded against, readable by everyone in the organization. A rule you are judged
  by should never be invisible to you.
- **On a pull request**: the violations this change **introduces**, separated
  from the ones that were already on main — nobody should inherit somebody
  else's debt in their review, and nobody should be able to hide a new violation
  inside an old one.
- **On the documentation of main**: where each repository stands, with a badge on
  the dashboard, and the difference between any two versions.

## The rules

Sixteen built-in rules ship today, in two families.

**Twelve security and best-practice rules** shared with the
[Playground](/use/playground/) lint pass — they are wrapped, not duplicated, so
a rule you meet while sketching in the playground is the same rule that judges
your pull request:

`nsg-open-to-internet` · `ssh-rdp-open-to-internet` · `hardcoded-secret` ·
`storage-public-blob-access` · `storage-container-public` ·
`storage-http-allowed` · `weak-tls` · `app-https-only-off` ·
`key-vault-public-network` · `sql-public-network` · `vm-password-auth` ·
`missing-tags`

**Four graph rules** that judge the shape of the estate rather than one
resource: `privileged-role-assignment`, `required-tags`,
`encryption-at-rest-disabled`, `orphan-resource`.

The `Exposed` badge on a diagram and the `nsg-open-to-internet` rule are the same
judgement, reached the same way.

## Configuring it

One document per organization, with an optional **per-repository override**
folded field by field — a repository can loosen or tighten a rule without
restating the whole configuration. Per rule you can set: enabled or not, its
severity, and its parameters (which tags are required, which scopes count as
broad).

Changing the configuration needs the `policy:manage` permission — `admin` and
above. Members read it.

## Not applicable is not passed

A rule that cannot judge a graph reports itself **not applicable**, and the
interface says so. A Kubernetes snapshot is not silently compliant with twelve
Terraform rules; it is simply not judged by them.

"Not checked" is never rendered as "passed". That distinction is the difference
between a compliance page and a decoration.

## Waivers

Some violations are accepted deliberately. A waiver **marks** a violation; it
never hides it. Each one requires:

- a **reason**, in writing;
- an **author**, recorded;
- an **expiry**, because a permanent exception is a policy change, not a waiver.

Every state change is appended to a trail, so "why is this allowed?" has an
answer with a name and a date on it. Waivers reconcile exactly like
[annotations](/use/annotations/): when a violation stops occurring, its waiver is
marked orphaned rather than deleted, and it comes back if the violation does.

## Stored verdicts stay readable

A report records the **effective configuration it ran under**. Reading a verdict
from March tells you what the rules were in March, not what they are today —
otherwise a configuration change would silently rewrite history.

Reports live beside the snapshot, never inside it, one per snapshot. The
pull-request delta is computed once and stored, so the comment on the pull
request and the panel in the interface cannot disagree with each other.

## Adding a rule

There is no custom-rule language yet, and this page will not pretend otherwise.
A new rule is implemented in the codebase and listed in the catalogue; the
engine itself does not change. If you need one, that is the shape of the
contribution.

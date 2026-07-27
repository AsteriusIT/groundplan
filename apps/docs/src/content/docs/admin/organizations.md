---
title: Organizations & roles
description: The permission matrix, invitations by link, ownership transfer, and the two tenancy modes.
---

For whoever administers the instance. An organization is the tenancy boundary
and the unit of ownership: repositories, projects, clusters, policies,
integrations and members all belong to exactly one.

## The permission matrix

Three roles in a strict hierarchy — `owner` > `admin` > `member` — so each
permission names the **minimum** role that holds it and everyone above inherits
it.

| Permission | Minimum role | What it covers |
| --- | --- | --- |
| `org:read` | member | Read everything the organization owns, and trigger a regeneration or a generation (a read-shaped action) |
| `project:manage` | admin | Create, edit and delete projects, repositories and clusters; manage their credentials |
| `integration:manage` | admin | Create, edit, delete and verify organization-level integrations |
| `policy:manage` | admin | Enable rules, set severities and parameters, override per repository |
| `member:manage` | admin | Invite, remove, and change roles between member and admin |
| `org:manage` | admin | Organization settings and rename |
| `org:delete` | owner | Delete the organization |
| `ownership:transfer` | owner | Hand ownership to somebody else |

This table is the one the API enforces, mirrored field-for-field in the
frontend so an interface cannot offer a button the server will refuse.

**There is no ownership below the organization.** No per-project ACLs, no
per-repository permissions, no private repositories inside a shared
organization. Every member sees the whole estate; roles decide what they may
**change**, not what they may **see**. If two teams must not see each other's
infrastructure, they need two organizations.

## Invitations are links, and no email is sent

Invite somebody and you get a **link to copy**. You send it however your
organization already communicates — chat, ticket, in person.

This is a choice, not a gap: no SMTP server to configure, no deliverability to
debug, no mail queue in an air-gapped install, and no email address required for
somebody who authenticates through your identity provider anyway.

The links are single-use, role-scoped, expiring, and **stored as hashes** — a
database dump does not yield usable invitations.

## Ownership

An organization always has at least one `owner`. The last one cannot be removed,
demoted or deleted away; the operation is refused with that reason. Transfer
ownership first, then leave.

## The two tenancy modes

Set by `SINGLE_ORG`, and worth deciding **before the first login**.

| | `SINGLE_ORG=true` (default) | `SINGLE_ORG=false` |
| --- | --- | --- |
| Who joins | Everyone your identity provider lets in auto-joins one seeded organization | Nobody automatically |
| The first user | Becomes `owner` | Owns the organization they create |
| Everyone after | Joins as `member` | Lands on a create-organization screen, or uses an invitation |
| Creating organizations | Disabled | Allowed |
| The interface | No switcher, no create-organization flow | Switcher, onboarding, invitations |

Flipping the flag later does not move existing users between the models — their
memberships already exist. In single-org mode, **who may log in at all** is your
identity provider's decision; see [OIDC & single sign-on](/reference/oidc/).

## Cross-tenant requests are `404`

A request for something in an organization you do not belong to is answered
`404`, never `403`. A `403` would confirm that the thing exists, which is a
disclosure in itself. Details on [Security posture](/admin/security/).

## Not in the product

Named plainly so nobody plans around them: no billing or plans, no audit log, no
service accounts, no domain-based auto-join, and no per-project permissions.

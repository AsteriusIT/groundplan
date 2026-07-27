---
title: The encryption key
description: What ENCRYPTION_KEY protects, how to generate it, and what happens if you lose or rotate it.
---

For whoever will be woken up if this goes wrong. `ENCRYPTION_KEY` is the one
piece of configuration whose loss cannot be repaired by redeploying, so it is
worth five minutes now.

## Generate it

Thirty-two random bytes, base64-encoded:

```sh
openssl rand -base64 32
```

Store it wherever your other production secrets live — a secret manager, a
sealed secret, your password vault. Store it **separately from your database
backups**, because together they are the plaintext.

## What it protects

Every credential the product holds for you, encrypted at rest with AES-256-GCM:

- repository access tokens (personal access tokens, and the refresh tokens
  behind App/OAuth connections);
- kubeconfigs for live clusters;
- Confluence credentials.

All of them are **write-only**. Once stored, no interface and no API response
ever returns them — they are masked as `***` everywhere, including to the owner
who typed them. That is not a display convention; the mapper that builds every
response drops them.

What it does **not** protect: your graphs, annotations, policy reports and
snapshots. Those are ordinary rows. The database itself should be encrypted at
rest by your platform, the way any database should.

## If you lose it

Nothing else breaks. The application starts, every diagram, annotation and
policy report is intact — but each stored credential is unreadable, and
%PRODUCT% will say so rather than failing mysteriously: affected repositories
report a credential error on their next clone.

The recovery is to set a new key and re-enter the credentials: a token per
repository, a kubeconfig per cluster, a credential per integration. Tedious in
proportion to your estate, and permanent — there is no recovery of the old
values, by design and by arithmetic.

## Rotating it

There is no automatic re-encryption pass, so rotation is the same procedure as
losing it, done deliberately:

1. Take a database backup.
2. Set the new `ENCRYPTION_KEY` and restart.
3. Re-enter each credential. Repositories and clusters keep their identity,
   history, annotations and documentation — only the secret is replaced.

Rotate when a key has been exposed. Rotating on a calendar buys little here:
the key never leaves your deployment, and the credentials it protects are
individually rotatable at their own provider, which is the faster response to an
actual leak.

## In the two installation modes

| Mode | How it is supplied |
| --- | --- |
| Docker Compose | `ENCRYPTION_KEY` in `.env.prod` |
| Kubernetes | `api.existingSecret` (a Secret holding `ENCRYPTION_KEY`), an External Secrets reference, or `api.encryptionKey` inline for evaluation only |

In production the API **refuses to boot** without it. Development and test use a
fixed built-in key so the application works out of the box — which is also the
reason a development instance is not a place to store a real token.

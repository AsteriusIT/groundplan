# azure-policy-clean — every rule passes

The "orders" application on Azure, written the way the built-in catalogue wants
it: private storage and database, TLS 1.2, HTTPS only, SSH keys instead of
passwords, no secret in the code, one narrow role assignment, tags everywhere.

## Verified result

Evaluated with **every built-in rule enabled**, including the ones that ship
disabled:

```
status: passing   {error: 0, warning: 0, info: 0, total: 0}
```

19 nodes, 28 edges, no parser warnings.

## The twin

[`azure-policy-violations`](../azure-policy-violations) is the *same estate* —
same file names, same resource addresses — with one violation introduced per
rule. Because the addresses match, diffing the two is a real pull request rather
than a wholesale replacement, which is what makes it useful for testing the
review flow:

```bash
# in a repo attached to a project, with this example on main
git checkout -b break-everything
cp ../azure-policy-violations/*.tf .
git commit -am "loosen a few things" && git push -u origin break-everything
```

Open the pull request and the review comment should show **16 new violations
against a clean baseline**, no resource creations or deletions except the one
leftover resource group.

## Why some things are written the way they are

- `administrator_login_password = var.sql_admin_password` — a variable with no
  default. Any literal string of 8+ characters in a password-shaped attribute is
  a `hardcoded-secret` finding.
- `tags = { … }` written out inline rather than `tags = local.tags`. The
  `required-tags` rule reads the literal block; see the note in the
  [top-level README](../README.md#known-rough-edge-required-tags-and-tags--localtags).
- Encryption attributes are set to `true` explicitly. They could equally be
  omitted — `encryption-at-rest-disabled` only fires on an explicit `false`,
  never on an absent attribute, because the providers encrypt by default.
- Every resource has at least one dependency in one direction, so nothing trips
  `orphan-resource`.

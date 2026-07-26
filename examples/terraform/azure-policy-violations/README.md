# azure-policy-violations — every rule fires

The same "orders" estate as [`azure-policy-clean`](../azure-policy-clean) — same
files, same resource addresses — loosened until **all sixteen built-in rules**
have something to say. Every offending block carries a `# VIOLATES:` comment
naming the rule it trips.

## Verified result

```
status: failing   {error: 7, warning: 9, info: 3, total: 19}
```

| Rule | Severity | Where |
| --- | --- | --- |
| `nsg-open-to-internet` | error | `azurerm_network_security_group.web` |
| `ssh-rdp-open-to-internet` | error | `azurerm_network_security_group.web` |
| `hardcoded-secret` | error | `azurerm_mssql_server.orders` |
| `storage-public-blob-access` | error | `azurerm_storage_account.orders` |
| `storage-container-public` | error | `azurerm_storage_container.uploads` |
| `encryption-at-rest-disabled` | error | `azurerm_mssql_database.orders` |
| `privileged-role-assignment` | error | `azurerm_role_assignment.ci_deploy` |
| `storage-http-allowed` | warning | `azurerm_storage_account.orders` |
| `weak-tls` | warning | `azurerm_storage_account.orders` |
| `app-https-only-off` | warning | `azurerm_linux_web_app.orders` |
| `key-vault-public-network` | warning | `azurerm_key_vault.orders` |
| `sql-public-network` | warning | `azurerm_mssql_server.orders` |
| `vm-password-auth` | warning | `azurerm_linux_virtual_machine.batch` |
| `required-tags` | warning | `azurerm_virtual_network.orders` (+ the two untagged resources) |
| `missing-tags` | info | `azurerm_key_vault.orders`, `azurerm_service_plan.orders` |
| `orphan-resource` | info | `azurerm_resource_group.leftover` |

`required-tags` is **off by default** — enable it in Policies (org scope, or a
per-repository override) to see the last four warnings. Everything else fires
out of the box.

## What to test with it

- **Docs of main** — the compliance badge on the repository, the per-repo
  compliance state on the dashboard, the violation list on the docs page.
- **Pull request review** — push [`azure-policy-clean`](../azure-policy-clean) to
  `main` first, then this on a branch: the comment separates the 16 *new*
  violations from a baseline that had none.
- **Waivers** — waive `orphan-resource` on `azurerm_resource_group.leftover`
  with a reason and an expiry, confirm the violation is marked rather than
  hidden, and that the status stops counting it.
- **Severity overrides** — drop `missing-tags` to disabled, or raise
  `weak-tls` to error, and confirm the stored report carries the effective
  configuration it ran under.

## Not a security lesson

Nothing here is a subtle mistake — it is a checklist rendered as HCL. Do not
copy any of it. For an estate that is wrong in a *realistic* way (one internet
facing security group in an otherwise sensible network), use
[`azure-hub-spoke`](../azure-hub-spoke).

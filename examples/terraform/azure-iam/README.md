# azure-iam — the permissions lens

A small platform estate whose interesting part is not the resources but the
grants between them: two workload identities, one system-assigned cluster
identity, one human group, five role assignments.

Open it on `?view=iam`.

## What it exercises

| Feature | Where to see it |
| --- | --- |
| principal → role → scope | five rows, one per `azurerm_role_assignment` |
| Reference resolution on both sides | `principal_id = azurerm_user_assigned_identity.app.principal_id` resolves to the identity *node*, not a GUID string — so the grant lands on the real resource |
| System-assigned identities | the AKS cluster **is** the principal of `AcrPull`, because `kubelet_identity[0].object_id` resolves back to the cluster |
| User-assigned identities | `azurerm_linux_web_app.app` carries `identity { type = "UserAssigned" }` pointing at `id-app-orders` |
| Principals outside the snapshot | the platform group's object id has no node to resolve to, so the view keeps it as a principal of its own |
| Broad scope ≠ privileged | two grants sit at resource-group and subscription scope and neither is flagged |

## What the parser produces

16 nodes, 20 edges. Grants, as the engine resolved them:

```
azurerm_kubernetes_cluster.platform    --[AcrPull]-->                   azurerm_container_registry.platform
azurerm_user_assigned_identity.app     --[Key Vault Secrets User]-->    azurerm_key_vault.platform
azurerm_user_assigned_identity.data    --[Storage Blob Data Reader]-->  azurerm_storage_account.data
azurerm_user_assigned_identity.data    --[Monitoring Reader]-->         data.azurerm_subscription.current
11111111-2222-3333-4444-555555555555   --[Reader]-->                    azurerm_resource_group.platform
```

## Policy

**Clean** — zero violations with every built-in rule enabled, including the ones
that are off by default.

That is the point of the last two grants. `privileged-role-assignment` wants a
high-privilege role (Owner, Contributor, User Access Administrator, or any role
whose name contains "admin") **at** subscription or resource-group scope. A wide
scope with a narrow role is not a finding, and neither is a strong role on a
single resource. To see the rule fire, look at `azurerm_role_assignment.ci_owner`
in [`azure-policy-violations`](../azure-policy-violations).

# Every grant in the estate, in one file. On `?view=iam` this whole file becomes
# the diagram: principal -> role -> scope, one row per assignment.
#
# Read this file as a set of answers to "who can do what, where":
#   - the app identity reads secrets, and only secrets, and only in one vault;
#   - the cluster pulls images, and cannot push them;
#   - the ingest identity reads blobs, and cannot write them;
#   - humans get Reader, broadly - a wide scope with a narrow role, which is not
#     what the `Privileged` badge is looking for.
#
# Nothing here trips `privileged-role-assignment`. The rule wants a *high*
# privilege role (Owner, Contributor, User Access Administrator, or anything
# named "…Admin…") at subscription or resource-group scope. Broad scope alone is
# not a finding, and neither is a powerful role on a single resource - which is
# the distinction this example exists to make.

resource "azurerm_role_assignment" "app_reads_secrets" {
  scope                = azurerm_key_vault.platform.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "aks_pulls_images" {
  scope                = azurerm_container_registry.platform.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.platform.kubelet_identity[0].object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "ingest_reads_blobs" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.data.principal_id
  principal_type       = "ServicePrincipal"
}

# A broad scope, deliberately: the platform team can look at everything in the
# resource group. "Reader" is not a high-privilege role, so this is a wide grant
# the diagram shows plainly and the policy engine does not object to.
resource "azurerm_role_assignment" "platform_team_reads_rg" {
  scope                = azurerm_resource_group.platform.id
  role_definition_name = "Reader"
  # A literal object id, not a reference: the IAM view keeps it as a principal
  # of its own, which is what a grant to a human group looks like in a snapshot.
  principal_id   = "11111111-2222-3333-4444-555555555555"
  principal_type = "Group"
}

# The widest scope there is - the whole subscription - with a role that can only
# look at metrics.
resource "azurerm_role_assignment" "ingest_reads_metrics" {
  scope                = data.azurerm_subscription.current.id
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_user_assigned_identity.data.principal_id
  principal_type       = "ServicePrincipal"
}

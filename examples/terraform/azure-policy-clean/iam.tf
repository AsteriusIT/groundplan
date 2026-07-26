# One identity, one grant, and the grant is on a single storage account rather
# than on everything in the resource group.
resource "azurerm_user_assigned_identity" "ci" {
  name                = "id-orders-ci"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
}

resource "azurerm_role_assignment" "ci_deploy" {
  scope                = azurerm_storage_account.orders.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ci.principal_id
  principal_type       = "ServicePrincipal"
}

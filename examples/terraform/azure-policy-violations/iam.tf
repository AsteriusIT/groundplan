resource "azurerm_user_assigned_identity" "ci" {
  name                = "id-orders-ci"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
}

# VIOLATES: privileged-role-assignment
#
# Owner (a high-privilege role) at resource-group scope (a broad scope). Either
# one alone would be fine; together they are what the `Privileged` badge names.
resource "azurerm_role_assignment" "ci_deploy" {
  scope                = azurerm_resource_group.orders.id
  role_definition_name = "Owner"
  principal_id         = azurerm_user_assigned_identity.ci.principal_id
  principal_type       = "ServicePrincipal"
}

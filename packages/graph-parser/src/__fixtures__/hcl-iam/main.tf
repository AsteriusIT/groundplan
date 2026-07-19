# Docs-flow fixture for IAM extraction (GP-47): a user-assigned identity used by
# an AKS cluster, with role assignments spanning narrow and broad scope.

resource "azurerm_resource_group" "main" {
  name     = "rg-main"
  location = "westeurope"
}

resource "azurerm_container_registry" "main" {
  name                = "acrmain"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_user_assigned_identity" "aks" {
  name                = "id-aks"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_kubernetes_cluster" "main" {
  name = "aks-main"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks.id]
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.aks.principal_id
}

resource "azurerm_role_assignment" "owner_rg" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Owner"
  principal_id         = "11111111-1111-1111-1111-111111111111"
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "reader_rg" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Reader"
  principal_id         = "33333333-3333-3333-3333-333333333333"
}

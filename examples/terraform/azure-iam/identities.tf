# Two workload identities. Nothing else in this file: an identity that exists
# without a grant is a principal with no power, and the IAM view says so by
# leaving it with no outgoing edge.

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-app-orders"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
}

resource "azurerm_user_assigned_identity" "data" {
  name                = "id-data-ingest"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
}

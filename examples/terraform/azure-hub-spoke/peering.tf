# A peering is not a resource anybody looks at - it is a line between two
# networks. The diagram collapses both sides into one edge between vnet-hub and
# vnet-app rather than drawing two peering boxes nobody asked about.

resource "azurerm_virtual_network_peering" "hub_to_app" {
  name                         = "peer-hub-to-app"
  resource_group_name          = azurerm_resource_group.hub.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.app.id
  allow_forwarded_traffic      = true
  allow_virtual_network_access = true
}

resource "azurerm_virtual_network_peering" "app_to_hub" {
  name                         = "peer-app-to-hub"
  resource_group_name          = azurerm_resource_group.app.name
  virtual_network_name         = azurerm_virtual_network.app.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_forwarded_traffic      = false
  allow_virtual_network_access = true
}

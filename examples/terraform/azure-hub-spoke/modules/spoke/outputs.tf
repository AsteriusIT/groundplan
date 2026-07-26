output "vnet_id" {
  value = azurerm_virtual_network.spoke.id
}

output "compute_subnet_id" {
  value = azurerm_subnet.compute.id
}

# azurerm join-catalog fixture: association/attachment resources binding things
# that never reference each other directly — the NAT gateway ↔ subnet case, a
# vnet peering, a NIC ↔ LB pool binding, a data-disk attachment, and the VMSS
# inline-NSG duality. Both producers must derive the same placements and edges.

provider "azurerm" {
  features {}
}

resource "azurerm_virtual_network" "hub" {
  name          = "hub"
  address_space = ["10.0.0.0/16"]
}

resource "azurerm_virtual_network" "spoke" {
  name          = "spoke"
  address_space = ["10.1.0.0/16"]
}

resource "azurerm_virtual_network_peering" "hub_to_spoke" {
  name                      = "hub-to-spoke"
  virtual_network_name      = azurerm_virtual_network.hub.name
  remote_virtual_network_id = azurerm_virtual_network.spoke.id
}

resource "azurerm_subnet" "internal" {
  name                 = "internal"
  virtual_network_name = azurerm_virtual_network.hub.name
}

resource "azurerm_nat_gateway" "out" {
  name = "outbound"
}

resource "azurerm_subnet_nat_gateway_association" "a" {
  subnet_id      = azurerm_subnet.internal.id
  nat_gateway_id = azurerm_nat_gateway.out.id
}

resource "azurerm_network_interface" "nic" {
  name = "nic"

  ip_configuration {
    name      = "internal"
    subnet_id = azurerm_subnet.internal.id
  }
}

resource "azurerm_lb" "main" {
  name = "lb"
}

resource "azurerm_lb_backend_address_pool" "pool" {
  loadbalancer_id = azurerm_lb.main.id
  name            = "pool"
}

resource "azurerm_network_interface_backend_address_pool_association" "npa" {
  network_interface_id    = azurerm_network_interface.nic.id
  ip_configuration_name   = "internal"
  backend_address_pool_id = azurerm_lb_backend_address_pool.pool.id
}

resource "azurerm_network_security_group" "web" {
  name = "web"
}

resource "azurerm_linux_virtual_machine_scale_set" "workers" {
  name = "workers"

  network_interface {
    name                      = "primary"
    network_security_group_id = azurerm_network_security_group.web.id

    ip_configuration {
      name      = "internal"
      subnet_id = azurerm_subnet.internal.id
    }
  }
}

resource "azurerm_linux_virtual_machine" "app" {
  name = "app"
}

resource "azurerm_managed_disk" "data" {
  name = "data"
}

resource "azurerm_virtual_machine_data_disk_attachment" "da" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.app.id
  lun                = 0
}

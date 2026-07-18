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

resource "azurerm_availability_set" "app" {
  name = "app-avset"
}

resource "azurerm_linux_virtual_machine" "app" {
  name                  = "app"
  availability_set_id   = azurerm_availability_set.app.id
  network_interface_ids = [azurerm_network_interface.nic.id]
}

resource "azurerm_managed_disk" "data" {
  name = "data"
}

resource "azurerm_virtual_machine_data_disk_attachment" "da" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.app.id
  lun                = 0
}

# A second subnet and a NAT gateway serving both: ambiguous containment must
# degrade to the vnet (nearest common ancestor), never guess a subnet.
resource "azurerm_subnet" "internal2" {
  name                 = "internal2"
  virtual_network_name = azurerm_virtual_network.hub.name
}

resource "azurerm_nat_gateway" "shared" {
  name = "shared"
}

resource "azurerm_subnet_nat_gateway_association" "s1" {
  subnet_id      = azurerm_subnet.internal.id
  nat_gateway_id = azurerm_nat_gateway.shared.id
}

resource "azurerm_subnet_nat_gateway_association" "s2" {
  subnet_id      = azurerm_subnet.internal2.id
  nat_gateway_id = azurerm_nat_gateway.shared.id
}

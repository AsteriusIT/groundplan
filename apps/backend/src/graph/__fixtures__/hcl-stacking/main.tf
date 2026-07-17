# GP-86 stacking fixture: the demo estate — LB + probe/pool/rule, appgw + public
# IP, bastion + public IP, VM + NIC — inferred entirely from expressions. Both
# producers must derive the same stacked parent_id map for this source.

provider "azurerm" {
  features {}
}

resource "azurerm_virtual_network" "main" {
  name          = "vnet"
  address_space = ["10.0.0.0/16"]
}

resource "azurerm_subnet" "internal" {
  name                 = "internal"
  virtual_network_name = azurerm_virtual_network.main.name
}

resource "azurerm_lb" "main" {
  name = "lb"

  frontend_ip_configuration {
    name      = "internal"
    subnet_id = azurerm_subnet.internal.id
  }
}

resource "azurerm_lb_probe" "https" {
  loadbalancer_id = azurerm_lb.main.id
  port            = 443
}

resource "azurerm_lb_backend_address_pool" "pool" {
  loadbalancer_id = azurerm_lb.main.id
  name            = "pool"
}

resource "azurerm_lb_rule" "http" {
  loadbalancer_id         = azurerm_lb.main.id
  backend_address_pool_ids = [azurerm_lb_backend_address_pool.pool.id]
  probe_id                = azurerm_lb_probe.https.id
}

resource "azurerm_public_ip" "appgw" {
  name              = "appgw-ip"
  allocation_method = "Static"
}

resource "azurerm_application_gateway" "appgw" {
  name = "appgw"

  gateway_ip_configuration {
    name      = "gw-ipcfg"
    subnet_id = azurerm_subnet.internal.id
  }

  frontend_ip_configuration {
    name                 = "fe"
    public_ip_address_id = azurerm_public_ip.appgw.id
  }
}

resource "azurerm_public_ip" "bastion" {
  name              = "bastion-ip"
  allocation_method = "Static"
}

resource "azurerm_bastion_host" "bastion" {
  name = "bastion"

  ip_configuration {
    name                 = "cfg"
    subnet_id            = azurerm_subnet.internal.id
    public_ip_address_id = azurerm_public_ip.bastion.id
  }
}

resource "azurerm_network_interface" "nic" {
  name = "nic"

  ip_configuration {
    name      = "primary"
    subnet_id = azurerm_subnet.internal.id
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                  = "vm"
  network_interface_ids = [azurerm_network_interface.nic.id]
}

# A NAT gateway binds its public IP through a dedicated association resource —
# the gateway never references the IP directly, so containment must resolve the
# public IP's host *through* the association (GP-86).
resource "azurerm_public_ip" "nat" {
  name              = "nat-ip"
  allocation_method = "Static"
}

resource "azurerm_nat_gateway" "nat" {
  name = "nat"
}

resource "azurerm_nat_gateway_public_ip_association" "nat" {
  nat_gateway_id       = azurerm_nat_gateway.nat.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

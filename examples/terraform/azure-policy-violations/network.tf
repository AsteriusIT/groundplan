resource "azurerm_resource_group" "orders" {
  name     = "rg-orders-prod"
  location = var.location

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

# VIOLATES: required-tags (no `owner` key).
# `missing-tags` stays silent - there *is* a tags block, it is just incomplete.
resource "azurerm_virtual_network" "orders" {
  name                = "vnet-orders"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  address_space       = ["10.30.0.0/16"]

  tags = {
    environment = "prod"
  }
}

resource "azurerm_subnet" "web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.orders.name
  virtual_network_name = azurerm_virtual_network.orders.name
  address_prefixes     = ["10.30.1.0/24"]
}

resource "azurerm_subnet" "data" {
  name                 = "snet-data"
  resource_group_name  = azurerm_resource_group.orders.name
  virtual_network_name = azurerm_virtual_network.orders.name
  address_prefixes     = ["10.30.2.0/24"]
}

# VIOLATES: nsg-open-to-internet (an inbound Allow whose source is the internet)
# VIOLATES: ssh-rdp-open-to-internet (and the port it reaches is 22)
#
# Both fire on the same rule, and both are worth saying: the first is "this
# subnet is reachable from the internet at all", the second is "the thing it is
# reachable on is the management port".
resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name

  security_rule {
    name                       = "allow-ssh-from-anywhere"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.web.id
}

# VIOLATES: orphan-resource (nothing references it, it references nothing).
# What a half-finished migration leaves behind - the only rule in the catalogue
# about tidiness rather than risk, which is why it is `info`.
resource "azurerm_resource_group" "leftover" {
  name     = "rg-orders-migration-2024"
  location = "westeurope"

  tags = {
    environment = "prod"
    owner       = "orders-team"
  }
}

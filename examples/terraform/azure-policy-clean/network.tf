resource "azurerm_resource_group" "orders" {
  name     = "rg-orders-prod"
  location = var.location

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_virtual_network" "orders" {
  name                = "vnet-orders"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  address_space       = ["10.30.0.0/16"]

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
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

# Inbound HTTPS from the corporate range only. No rule in this group has an
# internet source, so nothing here is `Exposed` and nothing trips
# `nsg-open-to-internet` or `ssh-rdp-open-to-internet`.
resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name

  security_rule {
    name                       = "allow-https-from-corp"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "203.0.113.0/24"
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

# Docs-flow fixture: a connected graph inferred entirely from attribute
# expressions — there is no explicit depends_on anywhere.

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

data "azurerm_image" "ubuntu" {
  name = "ubuntu"
}

resource "azurerm_network_interface" "main" {
  name = "nic"

  ip_configuration {
    name      = "primary"
    subnet_id = azurerm_subnet.internal.id
  }
}

resource "azurerm_virtual_machine" "main" {
  name                  = "vm"
  network_interface_ids = [azurerm_network_interface.main.id]
  source_image_id       = data.azurerm_image.ubuntu.id

  # Reference to a resource that isn't declared here → dropped + counted.
  secondary_vnet_id = azurerm_virtual_network.secondary.id
}

module "monitoring" {
  source     = "./modules/monitoring"
  network_id = azurerm_virtual_network.main.id
}

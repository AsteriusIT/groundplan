terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

provider "azurerm" {
  alias           = "secondary"
  subscription_id = "00000000-0000-0000-0000-000000000000"

  features {}
}

variable "location" {
  type    = string
  default = "westeurope"
}

# A small, entirely well-formed base so the snapshot is not empty and the
# diagnostics below have something to point away from.
resource "azurerm_resource_group" "main" {
  name     = "rg-edge-cases"
  location = var.location

  tags = {
    environment = "test"
    owner       = "platform-team"
  }
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-edge-cases"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.80.0.0/16"]

  tags = {
    environment = "test"
    owner       = "platform-team"
  }
}

resource "azurerm_subnet" "main" {
  name                 = "snet-main"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.80.1.0/24"]
}

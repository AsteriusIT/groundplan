# The platform stack: the entrypoint to point `terraform_path` at.
#
# It sources both modules from two directories up. A module living above the
# configured root resolves normally - the root selects where the parse *starts*,
# the way `terraform -chdir` does, not which files exist.

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

variable "location" {
  type    = string
  default = "westeurope"
}

locals {
  tags = {
    environment = "prod"
    owner       = "platform-team"
    stack       = "platform"
  }
}

resource "azurerm_resource_group" "platform" {
  name     = "rg-platform-prod"
  location = var.location
  tags     = local.tags
}

module "network" {
  source = "../../modules/network"

  name                = "platform"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  address_space       = "10.60.0.0/16"
  tags                = local.tags
}

module "workload" {
  source = "../../modules/workload"

  name                = "orders-prod"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  app_subnet_id       = module.network.app_subnet_id
  data_subnet_id      = module.network.data_subnet_id
  tags                = local.tags
}

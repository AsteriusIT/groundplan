# A second, unrelated stack in the same repository. It reuses the network module
# and nothing else.
#
# Point `terraform_path` at `stacks/sandbox` and this is the whole diagram - the
# platform stack simply does not appear, because the parse never reaches it.

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
  default = "northeurope"
}

locals {
  tags = {
    environment = "sandbox"
    owner       = "platform-team"
    stack       = "sandbox"
  }
}

resource "azurerm_resource_group" "sandbox" {
  name     = "rg-sandbox"
  location = var.location
  tags     = local.tags
}

module "network" {
  source = "../../modules/network"

  name                = "sandbox"
  location            = azurerm_resource_group.sandbox.location
  resource_group_name = azurerm_resource_group.sandbox.name
  address_space       = "10.70.0.0/16"
  tags                = local.tags
}

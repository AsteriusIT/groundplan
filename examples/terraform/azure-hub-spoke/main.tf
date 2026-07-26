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

# The one thing this stack asks of a caller: where it runs and how VMs are
# reached. Everything else is derived, so the diagram is the same on every clone.
variable "location" {
  type    = string
  default = "westeurope"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "admin_ssh_public_key" {
  type        = string
  description = "OpenSSH public key installed on every VM in this stack."
  default     = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC-example-key-not-a-secret example"
}

locals {
  tags = {
    environment = var.environment
    owner       = "platform-team"
    managed_by  = "terraform"
  }
}

# A spoke written as a local module: the diagram nests its network chain inside
# the module box, so `module.analytics` reads as one system at C4 altitude and
# expands to vnet -> subnet -> vm on the network lens.
module "analytics" {
  source = "./modules/spoke"

  name                = "analytics"
  location            = var.location
  resource_group_name = azurerm_resource_group.app.name
  address_space       = "10.20.0.0/16"
  ssh_public_key      = var.admin_ssh_public_key
  tags                = local.tags
}

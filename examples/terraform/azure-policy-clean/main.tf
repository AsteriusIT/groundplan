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

# No default, and never written into the code: the one way to hand a database a
# password without `hardcoded-secret` having something to find.
variable "sql_admin_password" {
  type      = string
  sensitive = true
}

variable "vm_admin_password" {
  type      = string
  sensitive = true
  default   = null
}

variable "admin_ssh_public_key" {
  type    = string
  default = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC-example-key-not-a-secret example"
}

data "azurerm_client_config" "current" {}

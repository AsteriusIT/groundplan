# Syntax that a naive brace-counter gets wrong: heredocs full of braces, strings
# containing braces, block comments, nested and dynamic blocks. Everything in
# this file must parse, and the resources must all appear in the snapshot.

locals {
  # A heredoc whose body is JSON - braces, quotes, and a `}` on its own line.
  cloud_init = <<-EOT
    #cloud-config
    write_files:
      - path: /etc/app/config.json
        content: |
          {
            "endpoint": "https://example.invalid/api",
            "retries": { "max": 3 }
          }
  EOT

  # A string containing an unbalanced brace, which must not end the block.
  banner = "welcome {"

  subnets = toset(["a", "b", "c"])
}

/*
  A block comment containing a brace { and a resource-shaped token that must
  never become a node:  resource "azurerm_storage_account" "not_real" {
*/

resource "azurerm_network_security_group" "dynamic" {
  name                = "nsg-dynamic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # A dynamic block: the security rules are generated, so a static parse sees
  # the `dynamic` wrapper and not the rules. The NSG therefore carries no rule
  # payload and no exposure verdict - "unknown" rather than a guess.
  dynamic "security_rule" {
    for_each = { https = 443, grpc = 8443 }

    content {
      name                       = "allow-${security_rule.key}"
      priority                   = 100 + index(keys({ https = 443, grpc = 8443 }), security_rule.key)
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = tostring(security_rule.value)
      source_address_prefix      = "VirtualNetwork"
      destination_address_prefix = "*"
    }
  }
}

# `count` with a literal: the snapshot keeps `count = 3` as an attribute and
# still draws one node. A static parse never invents instances.
resource "azurerm_public_ip" "counted" {
  count               = 3
  name                = "pip-counted-${count.index}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

# `for_each` over a local: the count is not knowable without evaluation, so no
# count attribute is recorded - absent rather than wrong.
resource "azurerm_subnet" "per_each" {
  for_each = local.subnets

  name                 = "snet-${each.key}"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet("10.80.0.0/16", 8, index(tolist(local.subnets), each.key) + 20)]
}

resource "azurerm_storage_account" "heredoc" {
  name                            = "stedgecases0001"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false

  tags = {
    environment = "test"
    owner       = "platform-team"
    notes       = local.banner
  }
}

resource "azurerm_linux_virtual_machine" "heredoc" {
  name                            = "vm-heredoc"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  size                            = "Standard_B2s"
  admin_username                  = "azureuser"
  disable_password_authentication = true
  custom_data                     = base64encode(local.cloud_init)
  network_interface_ids           = [azurerm_network_interface.dangling.id]

  # An explicit dependency, on top of the inferred ones.
  depends_on = [azurerm_storage_account.heredoc]

  admin_ssh_key {
    username   = "azureuser"
    public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC-example-key-not-a-secret example"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  tags = {
    environment = "test"
    owner       = "platform-team"
  }
}

# Top-level blocks that are not resources, data sources or modules. The scanner
# reads them and moves on - they must not become nodes.
moved {
  from = azurerm_public_ip.old_name
  to   = azurerm_public_ip.counted[0]
}

check "endpoint_is_reachable" {
  assert {
    condition     = length(azurerm_public_ip.counted) == 3
    error_message = "expected three addresses"
  }
}

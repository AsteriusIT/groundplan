# DELIBERATELY BROKEN. This file does not parse, and it is supposed to not
# parse: it is how you check that one bad file does not take the diagram down
# with it. `terraform fmt` and `terraform validate` will both refuse this folder.
#
# The second resource never closes its brace. The parser reports
#   error  broken.tf: unbalanced braces
# skips this file whole, and builds the snapshot from everything else. Both
# resources below are therefore absent from the diagram - including the first
# one, which is fine on its own. A file is the unit of failure.

resource "azurerm_storage_account" "never_appears" {
  name                     = "stneverappears0001"
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_key_vault" "unclosed" {
  name                = "kv-unclosed-0001"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "standard"

  network_acls {
    bypass         = "AzureServices"
    default_action = "Deny"

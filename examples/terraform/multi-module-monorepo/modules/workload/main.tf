# A web app, its plan, its storage, and a nested module for its telemetry.
#
# Note what the subnet ids do here: they arrive as `var.app_subnet_id`, and a
# static parse cannot follow a variable back to the resource that produced it.
# So these resources are *not* nested inside the network module's subnets on the
# diagram - the relationship is carried by the module-to-module edge instead.
# Compare with `modules/network`, whose resources reference each other directly
# and do nest.

resource "azurerm_service_plan" "this" {
  name                = "asp-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  os_type             = "Linux"
  sku_name            = "P1v3"
  tags                = var.tags
}

resource "azurerm_linux_web_app" "this" {
  name                      = "app-${var.name}"
  location                  = var.location
  resource_group_name       = var.resource_group_name
  service_plan_id           = azurerm_service_plan.this.id
  virtual_network_subnet_id = var.app_subnet_id
  https_only                = true
  tags                      = var.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    minimum_tls_version = "1.2"
    always_on           = true
  }
}

resource "azurerm_storage_account" "this" {
  name                            = "st${replace(var.name, "-", "")}0001"
  location                        = var.location
  resource_group_name             = var.resource_group_name
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  public_network_access_enabled   = false
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_private_endpoint" "storage" {
  name                = "pe-${var.name}-storage"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.data_subnet_id

  private_service_connection {
    name                           = "psc-${var.name}-storage"
    private_connection_resource_id = azurerm_storage_account.this.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }
}

module "observability" {
  source = "../observability"

  name                  = var.name
  location              = var.location
  resource_group_name   = var.resource_group_name
  monitored_resource_id = azurerm_linux_web_app.this.id
  tags                  = var.tags
}

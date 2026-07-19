resource "azurerm_key_vault" "main" {
  name                = "kv-groundplan-example"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = var.tenant_id
  sku_name            = "standard"
}

resource "azurerm_key_vault_secret" "redis_connection" {
  name         = "redis-connection-string"
  key_vault_id = azurerm_key_vault.main.id
  value        = azurerm_redis_cache.sessions.primary_connection_string
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-example"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

variable "tenant_id" {
  type        = string
  description = "Azure AD tenant for the Key Vault."
}

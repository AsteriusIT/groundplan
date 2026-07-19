resource "azurerm_service_plan" "main" {
  name                = "asp-example"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "P1v3"
}

resource "azurerm_linux_web_app" "api" {
  name                      = "groundplan-example-api"
  resource_group_name       = azurerm_resource_group.main.name
  location                  = azurerm_resource_group.main.location
  service_plan_id           = azurerm_service_plan.main.id
  virtual_network_subnet_id = azurerm_subnet.web.id
  https_only                = true

  site_config {
    minimum_tls_version = "1.2"
  }

  app_settings = {
    DATABASE_HOST = azurerm_postgresql_flexible_server.main.fqdn
    REDIS_HOST    = azurerm_redis_cache.sessions.hostname
    SESSION_STORE = "redis"
  }
}

resource "azurerm_monitor_diagnostic_setting" "api" {
  name                       = "diag-api"
  target_resource_id        = azurerm_linux_web_app.api.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AppServiceHTTPLogs"
  }
}

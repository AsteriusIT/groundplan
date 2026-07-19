resource "azurerm_postgresql_flexible_server" "main" {
  name                = "psql-example"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"
  sku_name            = "GP_Standard_D2ds_v5"
  delegated_subnet_id = azurerm_subnet.data.id
}

resource "azurerm_redis_cache" "sessions" {
  name                          = "redis-sessions"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  capacity                      = 1
  family                        = "C"
  sku_name                      = "Standard"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-redis-sessions"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  subnet_id           = azurerm_subnet.data.id

  private_service_connection {
    name                           = "psc-redis"
    private_connection_resource_id = azurerm_redis_cache.sessions.id
    subresource_names              = ["redisCache"]
    is_manual_connection           = false
  }
}

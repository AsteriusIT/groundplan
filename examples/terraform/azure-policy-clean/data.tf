# Storage: private, HTTPS-only, TLS 1.2, encrypted, no anonymous access.
resource "azurerm_storage_account" "orders" {
  name                              = "stordersprod0001"
  location                          = azurerm_resource_group.orders.location
  resource_group_name               = azurerm_resource_group.orders.name
  account_tier                      = "Standard"
  account_replication_type          = "ZRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  public_network_access_enabled     = false
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.orders.id
  container_access_type = "private"
}

resource "azurerm_key_vault" "orders" {
  name                          = "kv-orders-0001"
  location                      = azurerm_resource_group.orders.location
  resource_group_name           = azurerm_resource_group.orders.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  purge_protection_enabled      = true
  enable_rbac_authorization     = true
  public_network_access_enabled = false

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_mssql_server" "orders" {
  name                          = "sql-orders-0001"
  location                      = azurerm_resource_group.orders.location
  resource_group_name           = azurerm_resource_group.orders.name
  version                       = "12.0"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false
  administrator_login           = "sqladmin"
  administrator_login_password  = var.sql_admin_password

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_mssql_database" "orders" {
  name                                = "sqldb-orders"
  server_id                           = azurerm_mssql_server.orders.id
  sku_name                            = "S1"
  transparent_data_encryption_enabled = true
}

# The database is reached over a private endpoint, never over the internet.
resource "azurerm_private_endpoint" "sql" {
  name                = "pe-sql-orders"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  subnet_id           = azurerm_subnet.data.id

  private_service_connection {
    name                           = "psc-sql-orders"
    private_connection_resource_id = azurerm_mssql_server.orders.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }
}

# VIOLATES: storage-public-blob-access (anonymous access to blobs)
# VIOLATES: storage-http-allowed (plain HTTP accepted)
# VIOLATES: weak-tls (TLS 1.0)
resource "azurerm_storage_account" "orders" {
  name                              = "stordersprod0001"
  location                          = azurerm_resource_group.orders.location
  resource_group_name               = azurerm_resource_group.orders.name
  account_tier                      = "Standard"
  account_replication_type          = "ZRS"
  min_tls_version                   = "TLS1_0"
  https_traffic_only_enabled        = false
  public_network_access_enabled     = true
  allow_nested_items_to_be_public   = true
  infrastructure_encryption_enabled = true

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

# VIOLATES: storage-container-public (world-readable container)
resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.orders.id
  container_access_type = "container"
}

# VIOLATES: key-vault-public-network
# VIOLATES: missing-tags (no tags block at all - and because there is none,
#           required-tags reports both required keys missing too)
resource "azurerm_key_vault" "orders" {
  name                          = "kv-orders-0001"
  location                      = azurerm_resource_group.orders.location
  resource_group_name           = azurerm_resource_group.orders.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  purge_protection_enabled      = true
  enable_rbac_authorization     = true
  public_network_access_enabled = true
}

# VIOLATES: sql-public-network (reachable from any network)
# VIOLATES: hardcoded-secret (a password written into the code)
resource "azurerm_mssql_server" "orders" {
  name                          = "sql-orders-0001"
  location                      = azurerm_resource_group.orders.location
  resource_group_name           = azurerm_resource_group.orders.name
  version                       = "12.0"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true
  administrator_login           = "sqladmin"
  administrator_login_password  = "Sup3rSecret-Passw0rd!"

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

# VIOLATES: encryption-at-rest-disabled (TDE explicitly turned off)
#
# Note what this rule does *not* do: deleting the attribute entirely would not
# be a finding, because the provider encrypts by default and flagging an absent
# attribute would flag every database ever written.
resource "azurerm_mssql_database" "orders" {
  name                                = "sqldb-orders"
  server_id                           = azurerm_mssql_server.orders.id
  sku_name                            = "S1"
  transparent_data_encryption_enabled = false
}

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

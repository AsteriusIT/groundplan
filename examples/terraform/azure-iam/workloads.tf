# The things that hold data or run code. Each one is a *scope* something is
# granted on, or a *principal* that gets granted something - which is all the
# IAM view cares about.

resource "azurerm_key_vault" "platform" {
  name                          = "kv-platform-0001"
  location                      = azurerm_resource_group.platform.location
  resource_group_name           = azurerm_resource_group.platform.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  purge_protection_enabled      = true
  public_network_access_enabled = false
  enable_rbac_authorization     = true

  tags = {
    environment = "prod"
    owner       = "platform-team"
  }
}

resource "azurerm_storage_account" "data" {
  name                            = "stplatformdata0001"
  location                        = azurerm_resource_group.platform.location
  resource_group_name             = azurerm_resource_group.platform.name
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  public_network_access_enabled   = false
  allow_nested_items_to_be_public = false

  tags = {
    environment = "prod"
    owner       = "data-team"
  }
}

resource "azurerm_container_registry" "platform" {
  name                = "acrplatform0001"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  sku                 = "Premium"
  admin_enabled       = false
}

resource "azurerm_service_plan" "app" {
  name                = "asp-app"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  os_type             = "Linux"
  sku_name            = "P1v3"

  tags = {
    environment = "prod"
    owner       = "app-team"
  }
}

# A user-assigned identity, attached to the app. The IAM view draws the identity
# as the principal and the app as the thing wearing it.
resource "azurerm_linux_web_app" "app" {
  name                = "app-orders-prod"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  service_plan_id     = azurerm_service_plan.app.id
  https_only          = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  site_config {
    minimum_tls_version = "1.2"
  }

  tags = {
    environment = "prod"
    owner       = "app-team"
  }
}

# A system-assigned identity: the principal *is* the cluster, so the IAM view
# shows the cluster node itself on the left of the grant.
resource "azurerm_kubernetes_cluster" "platform" {
  name                = "aks-platform"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  dns_prefix          = "aks-platform"

  identity {
    type = "SystemAssigned"
  }

  default_node_pool {
    name       = "system"
    node_count = 3
    vm_size    = "Standard_D4s_v5"
  }

  tags = {
    environment = "prod"
    owner       = "platform-team"
  }
}

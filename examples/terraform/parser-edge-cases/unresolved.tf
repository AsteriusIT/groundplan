# Every reference in this file points at something that is not in the
# repository. Each one becomes a `warning` diagnostic naming the reference and
# the block it was written in - and the resource itself still appears in the
# snapshot, because a dangling reference is a missing edge, not a missing node.

# A resource that no longer exists (the name is wrong, the type is real).
resource "azurerm_network_interface" "dangling" {
  name                = "nic-dangling"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.renamed_last_week.id
    private_ip_address_allocation = "Dynamic"
  }
}

# A module that is not declared anywhere.
resource "azurerm_public_ip" "from_missing_module" {
  name                = "pip-from-missing-module"
  location            = module.networking.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

# A data source nobody wrote.
resource "azurerm_key_vault" "missing_data_source" {
  name                      = "kv-edge-cases-0001"
  location                  = azurerm_resource_group.main.location
  resource_group_name       = azurerm_resource_group.main.name
  tenant_id                 = data.azurerm_client_config.current.tenant_id
  sku_name                  = "standard"
  enable_rbac_authorization = true

  tags = {
    environment = "test"
    owner       = "platform-team"
  }
}

# A reference in a *comment* is still reference-shaped, and the parser does not
# pretend to know better: azurerm_subnet.decommissioned below is reported too.
# That is a deliberate trade - see this example's README.
resource "azurerm_route_table" "commented" {
  name                = "rt-commented"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # TODO: restore the route that pointed at azurerm_subnet.decommissioned
  route {
    name           = "default"
    address_prefix = "0.0.0.0/0"
    next_hop_type  = "Internet"
  }
}

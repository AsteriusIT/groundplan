resource "azurerm_service_plan" "orders" {
  name                = "asp-orders"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  os_type             = "Linux"
  sku_name            = "P1v3"

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_linux_web_app" "orders" {
  name                = "app-orders-prod"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  service_plan_id     = azurerm_service_plan.orders.id
  https_only          = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ci.id]
  }

  site_config {
    minimum_tls_version = "1.2"
  }

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

resource "azurerm_network_interface" "batch" {
  name                = "nic-batch"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Dynamic"
  }
}

# Keys, not passwords.
resource "azurerm_linux_virtual_machine" "batch" {
  name                            = "vm-batch"
  location                        = azurerm_resource_group.orders.location
  resource_group_name             = azurerm_resource_group.orders.name
  size                            = "Standard_D2s_v5"
  admin_username                  = "azureuser"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.batch.id]

  admin_ssh_key {
    username   = "azureuser"
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  tags = {
    environment = "prod"
    owner       = "orders-team"
    managed_by  = "terraform"
  }
}

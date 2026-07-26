# VIOLATES: missing-tags (no tags block - so required-tags reports both keys too)
resource "azurerm_service_plan" "orders" {
  name                = "asp-orders"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  os_type             = "Linux"
  sku_name            = "P1v3"
}

# VIOLATES: app-https-only-off (the app serves plain HTTP)
resource "azurerm_linux_web_app" "orders" {
  name                = "app-orders-prod"
  location            = azurerm_resource_group.orders.location
  resource_group_name = azurerm_resource_group.orders.name
  service_plan_id     = azurerm_service_plan.orders.id
  https_only          = false

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

# VIOLATES: vm-password-auth (password login on a Linux VM)
#
# The password itself comes from a variable, so `hardcoded-secret` has nothing to
# find here - the finding is the *mechanism*, not the value.
resource "azurerm_linux_virtual_machine" "batch" {
  name                            = "vm-batch"
  location                        = azurerm_resource_group.orders.location
  resource_group_name             = azurerm_resource_group.orders.name
  size                            = "Standard_D2s_v5"
  admin_username                  = "azureuser"
  admin_password                  = var.vm_admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.batch.id]

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

# The application spoke: three tiers, three subnets, one public entry point.
#
# What to look for on the network lens:
#   - nsg-web carries an inbound Allow from Internet, so snet-web and everything
#     the NSG is associated with is drawn as exposed. That is deliberate: this
#     example exists to show the exposure signal, not to pass every policy.
#   - the load balancer's probe, backend pool and rule stack *inside* the load
#     balancer instead of scattering across the subnet;
#   - the NICs nest inside the VM that owns them, and the VM sits in the subnet
#     its NIC reaches - a VM never references a subnet, its NIC does.

resource "azurerm_resource_group" "app" {
  name     = "rg-app-prod"
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "app" {
  name                = "vnet-app"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  address_space       = ["10.10.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.10.2.0/24"]
}

resource "azurerm_subnet" "data" {
  name                              = "snet-data"
  resource_group_name               = azurerm_resource_group.app.name
  virtual_network_name              = azurerm_virtual_network.app.name
  address_prefixes                  = ["10.10.3.0/24"]
  private_endpoint_network_policies = "Enabled"
}

# --- Security groups ---------------------------------------------------------

resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name

  security_rule {
    name                       = "allow-https-inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-app"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name

  security_rule {
    name                       = "allow-http-from-web"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefix      = "10.10.1.0/24"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.web.id
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# --- Public entry point ------------------------------------------------------

resource "azurerm_public_ip" "lb" {
  name                = "pip-lb-web"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_lb" "web" {
  name                = "lb-web"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Standard"

  frontend_ip_configuration {
    name                 = "public"
    public_ip_address_id = azurerm_public_ip.lb.id
  }
}

resource "azurerm_lb_backend_address_pool" "web" {
  name            = "bepool-web"
  loadbalancer_id = azurerm_lb.web.id
}

resource "azurerm_lb_probe" "web" {
  name            = "probe-https"
  loadbalancer_id = azurerm_lb.web.id
  protocol        = "Tcp"
  port            = 443
}

resource "azurerm_lb_rule" "web" {
  name                           = "rule-https"
  loadbalancer_id                = azurerm_lb.web.id
  protocol                       = "Tcp"
  frontend_port                  = 443
  backend_port                   = 443
  frontend_ip_configuration_name = "public"
  probe_id                       = azurerm_lb_probe.web.id
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.web.id]
}

# --- Application tier --------------------------------------------------------

resource "azurerm_network_interface" "app" {
  count               = 2
  name                = "nic-app-${count.index}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_network_interface_backend_address_pool_association" "app" {
  count                   = 2
  network_interface_id    = azurerm_network_interface.app[count.index].id
  ip_configuration_name   = "internal"
  backend_address_pool_id = azurerm_lb_backend_address_pool.web.id
}

resource "azurerm_linux_virtual_machine" "app" {
  count                           = 2
  name                            = "vm-app-${count.index}"
  location                        = azurerm_resource_group.app.location
  resource_group_name             = azurerm_resource_group.app.name
  size                            = "Standard_D2s_v5"
  admin_username                  = "azureuser"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.app[count.index].id]
  tags                            = local.tags

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
}

# --- Data tier: reachable over a private endpoint only -----------------------

resource "azurerm_storage_account" "app" {
  name                            = "stappprod0001"
  location                        = azurerm_resource_group.app.location
  resource_group_name             = azurerm_resource_group.app.name
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  public_network_access_enabled   = false
  allow_nested_items_to_be_public = false
  tags                            = local.tags
}

resource "azurerm_private_endpoint" "storage" {
  name                = "pe-storage-app"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  subnet_id           = azurerm_subnet.data.id

  private_service_connection {
    name                           = "psc-storage-app"
    private_connection_resource_id = azurerm_storage_account.app.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }
}

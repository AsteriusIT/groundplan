# The hub: shared ingress (Bastion) and shared egress (NAT gateway).
#
# What to look for on the network lens:
#   - vnet-hub contains three subnets, each showing its declared CIDR;
#   - the Bastion host and the NAT gateway stack their public IPs (a public IP
#     is drawn inside the resource that owns it, not beside it);
#   - the route table rides on snet-egress as a header chip, because the
#     association resource *is* the relationship.

resource "azurerm_resource_group" "hub" {
  name     = "rg-network-hub"
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name
  address_space       = ["10.0.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "bastion" {
  # Azure requires this exact name for a Bastion host.
  name                 = "AzureBastionSubnet"
  resource_group_name  = azurerm_resource_group.hub.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.0.0/26"]
}

resource "azurerm_subnet" "shared" {
  name                 = "snet-shared"
  resource_group_name  = azurerm_resource_group.hub.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_subnet" "egress" {
  name                 = "snet-egress"
  resource_group_name  = azurerm_resource_group.hub.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.2.0/24"]
}

# --- Ingress: Bastion, so no VM in this estate needs a public IP -------------

resource "azurerm_public_ip" "bastion" {
  name                = "pip-bastion"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_bastion_host" "hub" {
  name                = "bas-hub"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name

  ip_configuration {
    name                 = "configuration"
    subnet_id            = azurerm_subnet.bastion.id
    public_ip_address_id = azurerm_public_ip.bastion.id
  }
}

# --- Egress: one NAT gateway, one predictable outbound address ---------------

resource "azurerm_public_ip" "nat" {
  name                = "pip-nat"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "hub" {
  name                = "natgw-hub"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name
  sku_name            = "Standard"
}

resource "azurerm_nat_gateway_public_ip_association" "hub" {
  nat_gateway_id       = azurerm_nat_gateway.hub.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "egress" {
  subnet_id      = azurerm_subnet.egress.id
  nat_gateway_id = azurerm_nat_gateway.hub.id
}

# --- Forced tunnelling of everything that leaves the egress subnet -----------

resource "azurerm_route_table" "egress" {
  name                = "rt-egress"
  location            = azurerm_resource_group.hub.location
  resource_group_name = azurerm_resource_group.hub.name

  route {
    name           = "default-to-internet"
    address_prefix = "0.0.0.0/0"
    next_hop_type  = "Internet"
  }
}

resource "azurerm_subnet_route_table_association" "egress" {
  subnet_id      = azurerm_subnet.egress.id
  route_table_id = azurerm_route_table.egress.id
}

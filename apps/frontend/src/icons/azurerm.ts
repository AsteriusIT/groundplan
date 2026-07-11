/**
 * azurerm resource type → glyph mapping (GP-29). Azure is the demo provider; the
 * mapping mechanism itself is provider-generic (add an `aws.ts` / `google.ts`
 * later and widen the resolver). Two tables:
 *
 *  - `AZURERM_ICON_MAP` — exact type → glyph, covering the common ~40 azurerm
 *    types (100% of the example repo + the obvious ones).
 *  - `AZURERM_PREFIX_MAP` — type-prefix → glyph heuristic, so a type we didn't
 *    map explicitly (`azurerm_storage_share`, a brand-new resource) still lands
 *    on the right family icon. Longest prefix wins (see resolver).
 */
import type { AzureGlyphKey } from "./azure-glyphs";

export const AZURERM_ICON_MAP: Record<string, AzureGlyphKey> = {
  // compute
  azurerm_linux_virtual_machine: "virtual-machine",
  azurerm_windows_virtual_machine: "virtual-machine",
  azurerm_virtual_machine: "virtual-machine",
  azurerm_linux_virtual_machine_scale_set: "vmss",
  azurerm_windows_virtual_machine_scale_set: "vmss",
  azurerm_virtual_machine_scale_set: "vmss",
  azurerm_kubernetes_cluster: "kubernetes",
  azurerm_kubernetes_cluster_node_pool: "kubernetes",
  azurerm_container_registry: "container-registry",
  azurerm_container_group: "container-registry",
  // network
  azurerm_virtual_network: "vnet",
  azurerm_subnet: "subnet",
  azurerm_network_security_group: "nsg",
  azurerm_network_security_rule: "nsg",
  azurerm_lb: "load-balancer",
  azurerm_lb_backend_address_pool: "load-balancer",
  azurerm_lb_rule: "load-balancer",
  azurerm_application_gateway: "app-gateway",
  azurerm_public_ip: "public-ip",
  azurerm_network_interface: "nic",
  azurerm_route_table: "route-table",
  azurerm_route: "route-table",
  azurerm_firewall: "firewall",
  azurerm_private_dns_zone: "dns",
  azurerm_private_dns_zone_virtual_network_link: "dns",
  azurerm_dns_zone: "dns",
  // data
  azurerm_storage_account: "storage",
  azurerm_storage_container: "storage",
  azurerm_managed_disk: "storage",
  azurerm_mssql_server: "database",
  azurerm_mssql_database: "database",
  azurerm_sql_server: "database",
  azurerm_sql_database: "database",
  azurerm_postgresql_server: "database",
  azurerm_postgresql_flexible_server: "database",
  azurerm_mysql_flexible_server: "database",
  azurerm_cosmosdb_account: "cosmos-db",
  azurerm_redis_cache: "redis",
  // security / identity
  azurerm_key_vault: "key-vault",
  azurerm_key_vault_secret: "key-vault",
  azurerm_key_vault_key: "key-vault",
  azurerm_role_assignment: "identity",
  azurerm_role_definition: "identity",
  azurerm_user_assigned_identity: "identity",
  // observability
  azurerm_log_analytics_workspace: "monitor",
  azurerm_monitor_diagnostic_setting: "monitor",
  azurerm_application_insights: "monitor",
  // app hosting
  azurerm_app_service: "app-service",
  azurerm_app_service_plan: "app-service",
  azurerm_service_plan: "app-service",
  azurerm_linux_web_app: "app-service",
  azurerm_windows_web_app: "app-service",
  azurerm_linux_function_app: "app-service",
  azurerm_windows_function_app: "app-service",
  azurerm_function_app: "app-service",
  // grouping
  azurerm_resource_group: "resource-group",
};

/** Type-prefix → glyph heuristic. Longest prefix wins (resolver sorts these). */
export const AZURERM_PREFIX_MAP: Record<string, AzureGlyphKey> = {
  azurerm_virtual_machine_scale_set: "vmss",
  azurerm_virtual_machine: "virtual-machine",
  azurerm_kubernetes: "kubernetes",
  azurerm_container: "container-registry",
  azurerm_virtual_network: "vnet",
  azurerm_subnet: "subnet",
  azurerm_network_security: "nsg",
  azurerm_network_interface: "nic",
  azurerm_lb: "load-balancer",
  azurerm_application_gateway: "app-gateway",
  azurerm_public_ip: "public-ip",
  azurerm_route: "route-table",
  azurerm_firewall: "firewall",
  azurerm_private_dns: "dns",
  azurerm_dns: "dns",
  azurerm_storage: "storage",
  azurerm_managed_disk: "storage",
  azurerm_mssql: "database",
  azurerm_sql: "database",
  azurerm_postgresql: "database",
  azurerm_mysql: "database",
  azurerm_cosmosdb: "cosmos-db",
  azurerm_redis: "redis",
  azurerm_key_vault: "key-vault",
  azurerm_role: "identity",
  azurerm_user_assigned_identity: "identity",
  azurerm_log_analytics: "monitor",
  azurerm_monitor: "monitor",
  azurerm_application_insights: "monitor",
  azurerm_app_service: "app-service",
  azurerm_service_plan: "app-service",
  azurerm_resource_group: "resource-group",
};

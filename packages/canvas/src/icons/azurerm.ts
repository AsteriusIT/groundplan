/**
 * azurerm resource type → official Azure icon (GP-29). Azure is the demo
 * provider; the mapping mechanism itself is provider-generic (add an `aws.ts` /
 * `google.ts` later and widen the resolver). Two tables:
 *
 *  - `AZURERM_ICON_MAP` — exact type → icon, covering the common ~40 azurerm
 *    types (100% of the example repo + the obvious ones).
 *  - `AZURERM_PREFIX_MAP` — type-prefix → icon heuristic, so a type we didn't
 *    map explicitly (`azurerm_storage_share`, a brand-new resource) still lands
 *    on the right family icon. Longest prefix wins (see resolver).
 */
import type { AzureIconKey } from "./azure-icons";

export const AZURERM_ICON_MAP: Record<string, AzureIconKey> = {
  // compute
  azurerm_linux_virtual_machine: "virtual-machine",
  azurerm_windows_virtual_machine: "virtual-machine",
  azurerm_virtual_machine: "virtual-machine",
  azurerm_linux_virtual_machine_scale_set: "vm-scale-set",
  azurerm_windows_virtual_machine_scale_set: "vm-scale-set",
  azurerm_virtual_machine_scale_set: "vm-scale-set",
  azurerm_kubernetes_cluster: "kubernetes-service",
  azurerm_kubernetes_cluster_node_pool: "kubernetes-service",
  azurerm_container_registry: "container-registry",
  azurerm_container_group: "container-registry",
  // network
  azurerm_virtual_network: "virtual-network",
  azurerm_subnet: "subnet",
  azurerm_network_security_group: "network-security-group",
  azurerm_network_security_rule: "network-security-group",
  azurerm_lb: "load-balancer",
  azurerm_lb_backend_address_pool: "load-balancer",
  azurerm_lb_rule: "load-balancer",
  azurerm_application_gateway: "application-gateway",
  azurerm_public_ip: "public-ip",
  azurerm_network_interface: "network-interface",
  azurerm_route_table: "route-table",
  azurerm_route: "route-table",
  azurerm_firewall: "firewall",
  azurerm_private_dns_zone: "dns-zone",
  azurerm_private_dns_zone_virtual_network_link: "dns-zone",
  azurerm_dns_zone: "dns-zone",
  // data
  azurerm_storage_account: "storage-account",
  azurerm_storage_container: "storage-account",
  azurerm_managed_disk: "disk",
  azurerm_mssql_server: "sql-database",
  azurerm_mssql_database: "sql-database",
  azurerm_sql_server: "sql-database",
  azurerm_sql_database: "sql-database",
  azurerm_postgresql_server: "postgresql",
  azurerm_postgresql_flexible_server: "postgresql",
  azurerm_mysql_flexible_server: "mysql",
  azurerm_cosmosdb_account: "cosmos-db",
  azurerm_redis_cache: "redis",
  // security / identity
  azurerm_key_vault: "key-vault",
  azurerm_key_vault_secret: "key-vault",
  azurerm_key_vault_key: "key-vault",
  azurerm_role_assignment: "role",
  azurerm_role_definition: "role",
  azurerm_user_assigned_identity: "managed-identity",
  // observability
  azurerm_log_analytics_workspace: "log-analytics",
  azurerm_monitor_diagnostic_setting: "monitor",
  azurerm_application_insights: "application-insights",
  // app hosting
  azurerm_app_service: "app-service",
  azurerm_app_service_plan: "app-service-plan",
  azurerm_service_plan: "app-service-plan",
  azurerm_linux_web_app: "app-service",
  azurerm_windows_web_app: "app-service",
  azurerm_linux_function_app: "function-app",
  azurerm_windows_function_app: "function-app",
  azurerm_function_app: "function-app",
  // grouping
  azurerm_resource_group: "resource-group",
};

/** Type-prefix → icon heuristic. Longest prefix wins (resolver sorts these). */
export const AZURERM_PREFIX_MAP: Record<string, AzureIconKey> = {
  azurerm_virtual_machine_scale_set: "vm-scale-set",
  azurerm_virtual_machine: "virtual-machine",
  azurerm_kubernetes: "kubernetes-service",
  azurerm_container: "container-registry",
  azurerm_virtual_network: "virtual-network",
  azurerm_subnet: "subnet",
  azurerm_network_security: "network-security-group",
  azurerm_network_interface: "network-interface",
  azurerm_lb: "load-balancer",
  azurerm_application_gateway: "application-gateway",
  azurerm_application_insights: "application-insights",
  azurerm_public_ip: "public-ip",
  azurerm_route: "route-table",
  azurerm_firewall: "firewall",
  azurerm_private_dns: "dns-zone",
  azurerm_dns: "dns-zone",
  azurerm_storage: "storage-account",
  azurerm_managed_disk: "disk",
  azurerm_mssql: "sql-database",
  azurerm_sql: "sql-database",
  azurerm_postgresql: "postgresql",
  azurerm_mysql: "mysql",
  azurerm_cosmosdb: "cosmos-db",
  azurerm_redis: "redis",
  azurerm_key_vault: "key-vault",
  azurerm_role: "role",
  azurerm_user_assigned_identity: "managed-identity",
  azurerm_log_analytics: "log-analytics",
  azurerm_monitor: "monitor",
  azurerm_app_service: "app-service",
  azurerm_service_plan: "app-service-plan",
  azurerm_resource_group: "resource-group",
};

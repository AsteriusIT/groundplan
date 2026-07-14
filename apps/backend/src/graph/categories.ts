/**
 * Static resource-type → category mapping — the backend twin of the frontend's
 * `lib/resource-category.ts` (GP-24), kept in sync so the deterministic change
 * summary (GP-36) groups creations exactly the way the UI colours them.
 *
 * Deliberately a plain data table (matching prefixes by longest-first);
 * unknown types fall back to "other". Icons live only on the frontend — the
 * backend needs the label, nothing more.
 */

export type Category =
  | "compute"
  | "network"
  | "data"
  | "security"
  | "identity"
  | "observability"
  | "other";

/** type-prefix → category. Longest matching prefix wins. Mirrors the frontend. */
const PREFIX_TO_CATEGORY: Record<string, Category> = {
  // compute
  aws_instance: "compute",
  aws_lambda: "compute",
  aws_ecs: "compute",
  aws_eks: "compute",
  aws_autoscaling: "compute",
  azurerm_virtual_machine: "compute",
  azurerm_linux_virtual_machine: "compute",
  azurerm_kubernetes: "compute",
  azurerm_container: "compute",
  google_compute_instance: "compute",
  google_container: "compute",
  google_cloudfunctions: "compute",
  // network
  aws_vpc: "network",
  aws_subnet: "network",
  aws_lb: "network",
  aws_route: "network",
  aws_network: "network",
  aws_eip: "network",
  aws_internet_gateway: "network",
  azurerm_virtual_network: "network",
  azurerm_subnet: "network",
  azurerm_network_interface: "network",
  azurerm_lb: "network",
  azurerm_route: "network",
  azurerm_public_ip: "network",
  google_compute_network: "network",
  google_compute_subnetwork: "network",
  // data
  aws_s3: "data",
  aws_db: "data",
  aws_rds: "data",
  aws_dynamodb: "data",
  aws_elasticache: "data",
  azurerm_storage: "data",
  azurerm_cosmosdb: "data",
  azurerm_mssql: "data",
  azurerm_postgresql: "data",
  google_storage: "data",
  google_sql: "data",
  // security
  aws_kms: "security",
  aws_security_group: "security",
  aws_wafv2: "security",
  azurerm_key_vault: "security",
  azurerm_network_security_group: "security",
  azurerm_firewall: "security",
  google_kms: "security",
  // identity
  aws_iam: "identity",
  azurerm_role: "identity",
  azurerm_user_assigned_identity: "identity",
  google_service_account: "identity",
  google_project_iam: "identity",
  // observability
  aws_cloudwatch: "observability",
  azurerm_monitor: "observability",
  azurerm_log_analytics: "observability",
  azurerm_application_insights: "observability",
  google_monitoring: "observability",
  google_logging: "observability",
};

/**
 * Bare Kubernetes kinds (GP-103), matched exactly rather than by prefix — they
 * are PascalCase, so they can never collide with a snake_case Terraform type.
 * The frontend has held the same table since GP-93; the backend needs it now
 * that the change summary describes Kubernetes pull requests too, and without it
 * every workload in a diagram would be filed under "Other".
 */
const KIND_TO_CATEGORY: Record<string, Category> = {
  Pod: "compute",
  Deployment: "compute",
  ReplicaSet: "compute",
  StatefulSet: "compute",
  DaemonSet: "compute",
  Job: "compute",
  CronJob: "compute",
  HorizontalPodAutoscaler: "compute",
  Namespace: "compute",
  Node: "compute",
  Service: "network",
  Ingress: "network",
  NetworkPolicy: "network",
  ConfigMap: "security",
  Secret: "security",
  PersistentVolume: "data",
  PersistentVolumeClaim: "data",
  ServiceAccount: "identity",
  Role: "identity",
  ClusterRole: "identity",
  RoleBinding: "identity",
  ClusterRoleBinding: "identity",
};

// Longest-first so e.g. aws_instance beats a hypothetical aws_ prefix.
const SORTED_PREFIXES = Object.keys(PREFIX_TO_CATEGORY).sort(
  (a, b) => b.length - a.length,
);

/** Human label for each category (title-case). */
export const CATEGORY_LABEL: Record<Category, string> = {
  compute: "Compute",
  network: "Network",
  data: "Data",
  security: "Security",
  identity: "Identity",
  observability: "Observability",
  other: "Other",
};

/** Categorise a resource type or Kubernetes kind; anything unknown → "other". */
export function categorize(type: string): Category {
  const kind = KIND_TO_CATEGORY[type];
  if (kind) return kind;
  for (const prefix of SORTED_PREFIXES) {
    if (type === prefix || type.startsWith(`${prefix}_`)) {
      return PREFIX_TO_CATEGORY[prefix] as Category;
    }
  }
  return "other";
}

/** Short, type-first label: strip the provider prefix (`azurerm_` etc.). */
export function shortType(type: string): string {
  const underscore = type.indexOf("_");
  return underscore === -1 ? type : type.slice(underscore + 1);
}

/**
 * Static resource-type → category mapping (GP-24). Deliberately a plain data
 * table (~30 entries across azurerm / aws / google) so it can be replaced by a
 * smarter classifier later. Matching is by longest type-prefix; unknown types
 * fall back to "other".
 */
import {
  Activity,
  Box,
  Cpu,
  Database,
  KeyRound,
  Network,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type Category =
  | "compute"
  | "network"
  | "data"
  | "security"
  | "identity"
  | "observability"
  | "other";

/** type-prefix → category. Longest matching prefix wins. */
const PREFIX_TO_CATEGORY: Record<string, Category> = {
  // compute
  aws_instance: "compute",
  aws_spot_instance: "compute",
  aws_launch: "compute",
  aws_lambda: "compute",
  aws_ecs: "compute",
  aws_eks: "compute",
  aws_ecr: "compute",
  aws_autoscaling: "compute",
  azurerm_virtual_machine: "compute",
  azurerm_linux_virtual_machine: "compute",
  azurerm_kubernetes: "compute",
  azurerm_container: "compute",
  google_compute_instance: "compute",
  google_compute_region_instance: "compute",
  google_container: "compute",
  google_cloudfunctions: "compute",
  google_cloudfunctions2: "compute",
  google_cloud_run: "compute",
  google_artifact_registry: "compute",
  // network
  aws_vpc: "network",
  aws_subnet: "network",
  aws_lb: "network",
  aws_alb: "network",
  aws_elb: "network",
  aws_route: "network",
  aws_route53: "network",
  aws_network: "network",
  aws_eip: "network",
  aws_internet_gateway: "network",
  aws_nat_gateway: "network",
  aws_cloudfront: "network",
  aws_api_gateway: "network",
  aws_apigatewayv2: "network",
  // messaging / integration — mapped onto the network hue (no new token: the
  // category palette is fixed, and message/event plumbing is connectivity).
  aws_sqs: "network",
  aws_sns: "network",
  aws_cloudwatch_event: "network",
  aws_sfn: "network",
  azurerm_virtual_network: "network",
  azurerm_subnet: "network",
  azurerm_network_interface: "network",
  azurerm_lb: "network",
  azurerm_route: "network",
  azurerm_public_ip: "network",
  google_compute_network: "network",
  google_compute_subnetwork: "network",
  google_compute_forwarding: "network",
  google_compute_global: "network",
  google_compute_backend: "network",
  google_compute_url_map: "network",
  google_compute_target: "network",
  google_compute_router: "network",
  google_compute_firewall: "network",
  google_compute_address: "network",
  google_dns: "network",
  google_pubsub: "network",
  // data
  aws_s3: "data",
  aws_ebs: "data",
  aws_efs: "data",
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
  google_compute_disk: "data",
  google_compute_region_disk: "data",
  google_firestore: "data",
  google_bigtable: "data",
  google_redis: "data",
  google_bigquery: "data",
  // security
  aws_kms: "security",
  aws_security_group: "security",
  aws_wafv2: "security",
  aws_waf: "security",
  aws_secretsmanager: "security",
  aws_acm: "security",
  azurerm_key_vault: "security",
  azurerm_network_security_group: "security",
  azurerm_firewall: "security",
  google_kms: "security",
  google_secret_manager: "security",
  // identity
  aws_iam: "identity",
  aws_cognito: "identity",
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

// Longest-first so e.g. aws_instance beats a hypothetical aws_ prefix.
const SORTED_PREFIXES = Object.keys(PREFIX_TO_CATEGORY).sort(
  (a, b) => b.length - a.length,
);

// Category no longer drives colour: the icon *shape* + the type-first label carry
// the category, and colour is reserved for the plan diff (create/update/delete).
// So every category renders its icon in one quiet neutral ink (`text-muted-
// foreground`); official vendor icons (rendered as <img>) keep their own colour.
const CATEGORY_ICON_CLASS = "text-muted-foreground";
export const CATEGORY_META: Record<
  Category,
  { label: string; icon: LucideIcon; className: string }
> = {
  compute: { label: "Compute", icon: Cpu, className: CATEGORY_ICON_CLASS },
  network: { label: "Network", icon: Network, className: CATEGORY_ICON_CLASS },
  data: { label: "Data", icon: Database, className: CATEGORY_ICON_CLASS },
  security: { label: "Security", icon: ShieldCheck, className: CATEGORY_ICON_CLASS },
  identity: { label: "Identity", icon: KeyRound, className: CATEGORY_ICON_CLASS },
  observability: { label: "Observability", icon: Activity, className: CATEGORY_ICON_CLASS },
  other: { label: "Other", icon: Box, className: CATEGORY_ICON_CLASS },
};

/** Categorise a resource type; unknown / non-prefixed types → "other". */
export function categorize(type: string): Category {
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

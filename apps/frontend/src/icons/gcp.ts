/**
 * google resource type → official Google Cloud product icon (GP-92). Same
 * machinery as GP-29 (Azure) / GP-91 (AWS) — two tables:
 *
 *  - `GCP_ICON_MAP` — exact `google_*` type → icon, covering the common estate.
 *  - `GCP_PREFIX_MAP` — type-prefix → icon heuristic for the long tail. Longest
 *    prefix wins (see resolver).
 *
 * `google-beta` provider aliases are normalised to `google_` in the resolver, so
 * both flow through the same table. Everything the tables miss falls back to the
 * lucide category glyph — by design. Sub-resources with no dedicated official
 * icon (subnetwork, address) point at their parent-service icon.
 */
import type { GcpIconKey } from "./gcp-icons";

export const GCP_ICON_MAP: Record<string, GcpIconKey> = {
  // compute
  google_compute_instance: "compute-engine",
  google_compute_instance_template: "compute-engine",
  google_compute_instance_group_manager: "compute-engine",
  google_compute_region_instance_group_manager: "compute-engine",
  google_cloudfunctions_function: "cloud-functions",
  google_cloudfunctions2_function: "cloud-functions",
  google_cloud_run_service: "cloud-run",
  google_cloud_run_v2_service: "cloud-run",
  google_cloud_run_v2_job: "cloud-run",
  // network
  google_compute_network: "vpc",
  google_compute_subnetwork: "vpc",
  google_compute_forwarding_rule: "load-balancing",
  google_compute_global_forwarding_rule: "load-balancing",
  google_compute_backend_service: "load-balancing",
  google_compute_url_map: "load-balancing",
  google_compute_target_http_proxy: "load-balancing",
  google_dns_managed_zone: "cloud-dns",
  google_dns_record_set: "cloud-dns",
  google_compute_router: "cloud-router",
  google_compute_router_nat: "cloud-nat",
  google_compute_firewall: "cloud-firewall",
  google_compute_address: "external-ip",
  google_compute_global_address: "external-ip",
  // storage / data
  google_storage_bucket: "cloud-storage",
  google_compute_disk: "persistent-disk",
  google_compute_region_disk: "persistent-disk",
  google_sql_database_instance: "cloud-sql",
  google_sql_database: "cloud-sql",
  google_firestore_database: "firestore",
  google_bigtable_instance: "bigtable",
  google_bigtable_table: "bigtable",
  google_redis_instance: "memorystore",
  google_bigquery_dataset: "bigquery",
  google_bigquery_table: "bigquery",
  // identity
  google_service_account: "iam",
  google_project_iam_member: "iam",
  google_project_iam_binding: "iam",
  google_project_iam_custom_role: "iam",
  // messaging
  google_pubsub_topic: "pubsub",
  google_pubsub_subscription: "pubsub",
  // containers
  google_container_cluster: "gke",
  google_container_node_pool: "gke",
  google_artifact_registry_repository: "artifact-registry",
  // security
  google_kms_key_ring: "kms",
  google_kms_crypto_key: "kms",
  google_secret_manager_secret: "secret-manager",
  // observability
  google_monitoring_alert_policy: "cloud-monitoring",
  google_monitoring_dashboard: "cloud-monitoring",
};

/** Type-prefix → icon heuristic. Longest prefix wins (resolver sorts these). */
export const GCP_PREFIX_MAP: Record<string, GcpIconKey> = {
  google_compute_instance: "compute-engine",
  google_compute_network: "vpc",
  google_compute_subnetwork: "vpc",
  google_compute_global_forwarding_rule: "load-balancing",
  google_compute_forwarding_rule: "load-balancing",
  google_compute_backend: "load-balancing",
  google_compute_url_map: "load-balancing",
  google_compute_target: "load-balancing",
  google_compute_router_nat: "cloud-nat",
  google_compute_router: "cloud-router",
  google_compute_firewall: "cloud-firewall",
  google_compute_global_address: "external-ip",
  google_compute_address: "external-ip",
  google_compute_region_disk: "persistent-disk",
  google_compute_disk: "persistent-disk",
  google_cloudfunctions2: "cloud-functions",
  google_cloudfunctions: "cloud-functions",
  google_cloud_run: "cloud-run",
  google_dns: "cloud-dns",
  google_storage: "cloud-storage",
  google_sql: "cloud-sql",
  google_firestore: "firestore",
  google_bigtable: "bigtable",
  google_redis: "memorystore",
  google_bigquery: "bigquery",
  google_service_account: "iam",
  google_project_iam: "iam",
  google_pubsub: "pubsub",
  google_container: "gke",
  google_artifact_registry: "artifact-registry",
  google_kms: "kms",
  google_secret_manager: "secret-manager",
  google_monitoring: "cloud-monitoring",
};

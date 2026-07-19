/**
 * Kubernetes kind → community icon (GP-93). Same machinery as the cloud provider
 * maps, but with **two key spaces in one table**: the Terraform-managed types
 * (`kubernetes_deployment`, `kubernetes_service`, …) and the bare native kinds
 * (`Deployment`, `Service`, …) resolve to the *same* icons, so both producers —
 * the Terraform parser and the future Kubernetes namespace epic — render
 * identically for free.
 *
 *  - `KUBERNETES_ICON_MAP` — exact type/kind → icon.
 *  - `KUBERNETES_PREFIX_MAP` — Terraform type-prefix → icon, so versioned
 *    variants (`kubernetes_deployment_v1`) land on the right glyph. Longest
 *    prefix wins (see resolver). Bare kinds are exact-only.
 *
 * Everything the table misses falls back to the lucide category glyph — by
 * design (CRDs, Helm releases, …).
 */
import type { KubernetesIconKey } from "./kubernetes-icons";

export const KUBERNETES_ICON_MAP: Record<string, KubernetesIconKey> = {
  // --- Terraform types (kubernetes_* provider) ---
  kubernetes_pod: "pod",
  kubernetes_deployment: "deployment",
  kubernetes_replication_controller: "replica-set",
  kubernetes_replica_set: "replica-set",
  kubernetes_stateful_set: "stateful-set",
  kubernetes_daemonset: "daemon-set",
  kubernetes_daemon_set: "daemon-set",
  kubernetes_job: "job",
  kubernetes_cron_job: "cron-job",
  kubernetes_horizontal_pod_autoscaler: "horizontal-pod-autoscaler",
  kubernetes_service: "service",
  kubernetes_ingress: "ingress",
  kubernetes_network_policy: "network-policy",
  kubernetes_config_map: "config-map",
  kubernetes_secret: "secret",
  kubernetes_persistent_volume: "persistent-volume",
  kubernetes_persistent_volume_claim: "persistent-volume-claim",
  kubernetes_service_account: "service-account",
  kubernetes_role: "role",
  kubernetes_cluster_role: "cluster-role",
  kubernetes_role_binding: "role-binding",
  kubernetes_cluster_role_binding: "cluster-role-binding",
  kubernetes_namespace: "namespace",
  kubernetes_node: "node",
  // --- Bare native kinds (as the K8s epic will emit them) ---
  Pod: "pod",
  Deployment: "deployment",
  ReplicaSet: "replica-set",
  ReplicationController: "replica-set",
  StatefulSet: "stateful-set",
  DaemonSet: "daemon-set",
  Job: "job",
  CronJob: "cron-job",
  HorizontalPodAutoscaler: "horizontal-pod-autoscaler",
  Service: "service",
  Ingress: "ingress",
  NetworkPolicy: "network-policy",
  ConfigMap: "config-map",
  Secret: "secret",
  PersistentVolume: "persistent-volume",
  PersistentVolumeClaim: "persistent-volume-claim",
  ServiceAccount: "service-account",
  Role: "role",
  ClusterRole: "cluster-role",
  RoleBinding: "role-binding",
  ClusterRoleBinding: "cluster-role-binding",
  Namespace: "namespace",
  Node: "node",
};

/**
 * Terraform type-prefix → icon heuristic (longest wins). Only Terraform types
 * need this — it catches versioned resources (`kubernetes_deployment_v1`,
 * `kubernetes_service_v1`). Bare kinds are matched exactly by the map above.
 */
export const KUBERNETES_PREFIX_MAP: Record<string, KubernetesIconKey> = {
  kubernetes_persistent_volume_claim: "persistent-volume-claim",
  kubernetes_persistent_volume: "persistent-volume",
  kubernetes_cluster_role_binding: "cluster-role-binding",
  kubernetes_cluster_role: "cluster-role",
  kubernetes_role_binding: "role-binding",
  kubernetes_role: "role",
  kubernetes_horizontal_pod_autoscaler: "horizontal-pod-autoscaler",
  kubernetes_network_policy: "network-policy",
  kubernetes_service_account: "service-account",
  kubernetes_service: "service",
  kubernetes_config_map: "config-map",
  kubernetes_secret: "secret",
  kubernetes_ingress: "ingress",
  kubernetes_namespace: "namespace",
  kubernetes_deployment: "deployment",
  kubernetes_replication_controller: "replica-set",
  kubernetes_replica_set: "replica-set",
  kubernetes_stateful_set: "stateful-set",
  kubernetes_daemonset: "daemon-set",
  kubernetes_daemon_set: "daemon-set",
  kubernetes_cron_job: "cron-job",
  kubernetes_job: "job",
  kubernetes_pod: "pod",
  kubernetes_node: "node",
};

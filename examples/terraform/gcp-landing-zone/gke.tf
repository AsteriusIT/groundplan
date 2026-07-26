# A private GKE cluster with its own least-privilege node service account.

resource "google_service_account" "gke_nodes" {
  account_id   = "sa-gke-nodes-${var.environment}"
  display_name = "GKE node pool"
}

resource "google_project_iam_member" "gke_nodes_logging" {
  project = data.google_project.current.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_metrics" {
  project = data.google_project.current.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_artifacts" {
  project = data.google_project.current.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_container_cluster" "main" {
  name                     = "gke-${local.name}"
  location                 = var.region
  network                  = google_compute_network.main.id
  subnetwork               = google_compute_subnetwork.gke.id
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = true

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = true
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  database_encryption {
    state    = "ENCRYPTED"
    key_name = google_kms_crypto_key.main.id
  }

  resource_labels = local.labels
}

resource "google_container_node_pool" "main" {
  name       = "np-main"
  location   = var.region
  cluster    = google_container_cluster.main.name
  node_count = 3

  node_config {
    machine_type    = "e2-standard-4"
    service_account = google_service_account.gke_nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    tags            = ["lz-backend"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    labels = local.labels
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "google_artifact_registry_repository" "main" {
  location      = var.region
  repository_id = "images-${var.environment}"
  format        = "DOCKER"

  labels = local.labels
}

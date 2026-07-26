# The public face: a Cloud Run service behind a global HTTPS load balancer, and
# the DNS record that points at it.

resource "google_service_account" "api" {
  account_id   = "sa-api-${var.environment}"
  display_name = "Orders API"
}

resource "google_project_iam_member" "api_reads_secrets" {
  project = data.google_project.current.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_publishes" {
  project = data.google_project.current.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_run_v2_service" "api" {
  name     = "api-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.api.email

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.main.repository_id}/api:latest"

      env {
        name = "DB_PASSWORD"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_password.secret_id
            version = "latest"
          }
        }
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.services.id
      }
    }
  }

  labels = local.labels
}

resource "google_compute_global_address" "lb" {
  name = "gaddr-lb-${local.name}"
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "neg-api-${var.environment}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "bes-api-${var.environment}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  log_config {
    enable = true
  }
}

resource "google_compute_url_map" "main" {
  name            = "urlmap-${local.name}"
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_managed_ssl_certificate" "main" {
  name = "cert-${local.name}"

  managed {
    domains = ["api.example.com"]
  }
}

resource "google_compute_target_https_proxy" "main" {
  name             = "proxy-${local.name}"
  url_map          = google_compute_url_map.main.id
  ssl_certificates = [google_compute_managed_ssl_certificate.main.id]
}

resource "google_compute_global_forwarding_rule" "main" {
  name                  = "fr-${local.name}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.main.id
  ip_address            = google_compute_global_address.lb.id
}

resource "google_dns_managed_zone" "main" {
  name     = "zone-${local.name}"
  dns_name = "example.com."
}

resource "google_dns_record_set" "api" {
  name         = "api.${google_dns_managed_zone.main.dns_name}"
  managed_zone = google_dns_managed_zone.main.name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb.address]
}

resource "google_monitoring_alert_policy" "api_errors" {
  display_name = "api-5xx-${var.environment}"
  combiner     = "OR"

  conditions {
    display_name = "5xx rate"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.api.name}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
    }
  }
}

# A custom-mode VPC: one subnet for the cluster (with secondary ranges for pods
# and services), one for everything else, private Google access on both, and a
# Cloud NAT so nothing needs an external address.

resource "google_compute_network" "main" {
  name                    = "vpc-${local.name}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "gke" {
  name                     = "snet-gke-${local.name}"
  ip_cidr_range            = "10.50.0.0/20"
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.52.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.53.0.0/20"
  }
}

resource "google_compute_subnetwork" "services" {
  name                     = "snet-services-${local.name}"
  ip_cidr_range            = "10.51.0.0/20"
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

resource "google_compute_firewall" "deny_all_ingress" {
  name      = "fw-deny-all-ingress-${local.name}"
  network   = google_compute_network.main.name
  direction = "INGRESS"
  priority  = 65000

  deny {
    protocol = "all"
  }

  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_health_checks" {
  name      = "fw-allow-health-checks-${local.name}"
  network   = google_compute_network.main.name
  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  # Google's published health-check ranges, not the internet.
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["lz-backend"]
}

resource "google_compute_router" "main" {
  name    = "router-${local.name}"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name                               = "nat-${local.name}"
  router                             = google_compute_router.main.name
  region                             = google_compute_router.main.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Private Service Access, so Cloud SQL is reachable over the VPC and never over
# a public address.
resource "google_compute_global_address" "private_service_access" {
  name          = "psa-${local.name}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
}

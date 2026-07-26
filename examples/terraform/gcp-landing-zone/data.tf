# Keys first, then the things they protect.

resource "google_kms_key_ring" "main" {
  name     = "kr-${local.name}"
  location = var.region
}

resource "google_kms_crypto_key" "main" {
  name            = "key-${local.name}"
  key_ring        = google_kms_key_ring.main.id
  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = true
  }

  labels = local.labels
}

resource "google_sql_database_instance" "main" {
  name                = "sql-${local.name}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_service_networking_connection.private_service_access]

  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    user_labels = local.labels
  }
}

resource "google_sql_database" "orders" {
  name     = "orders"
  instance = google_sql_database_instance.main.name
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "db-password-${var.environment}"

  replication {
    user_managed {
      replicas {
        location = var.region

        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.main.id
        }
      }
    }
  }

  labels = local.labels
}

resource "google_storage_bucket" "assets" {
  name                        = "${var.project_id}-assets"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  encryption {
    default_kms_key_name = google_kms_crypto_key.main.id
  }

  versioning {
    enabled = true
  }

  labels = local.labels
}

resource "google_bigquery_dataset" "analytics" {
  dataset_id = "analytics_${var.environment}"
  location   = var.region

  default_encryption_configuration {
    kms_key_name = google_kms_crypto_key.main.id
  }

  labels = local.labels
}

resource "google_pubsub_topic" "orders" {
  name         = "orders-${var.environment}"
  kms_key_name = google_kms_crypto_key.main.id

  labels = local.labels
}

resource "google_pubsub_subscription" "orders_to_analytics" {
  name  = "orders-to-analytics-${var.environment}"
  topic = google_pubsub_topic.orders.id

  bigquery_config {
    table = "${google_bigquery_dataset.analytics.project}.${google_bigquery_dataset.analytics.dataset_id}.orders"
  }

  labels = local.labels
}

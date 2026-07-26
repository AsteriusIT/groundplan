terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type    = string
  default = "example-landing-zone"
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "environment" {
  type    = string
  default = "prod"
}

locals {
  name = "lz-${var.environment}"

  labels = {
    environment = var.environment
    owner       = "platform-team"
    managed_by  = "terraform"
  }
}

data "google_project" "current" {
  project_id = var.project_id
}

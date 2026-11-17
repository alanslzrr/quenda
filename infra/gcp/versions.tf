terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.40"
    }
  }
}

# Credentials come from Application Default Credentials (gcloud auth
# application-default login) or GOOGLE_APPLICATION_CREDENTIALS.
provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}

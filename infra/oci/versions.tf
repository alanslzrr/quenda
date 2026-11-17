terraform {
  required_version = ">= 1.6"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.12"
    }
  }
}

# Credentials come from an OCI CLI profile (~/.oci/config): API key, tenancy,
# user and fingerprint never appear in this configuration or its state.
provider "oci" {
  region              = var.region
  config_file_profile = var.config_profile
}

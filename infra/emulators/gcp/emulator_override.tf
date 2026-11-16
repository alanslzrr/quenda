# floci-gcp serves Compute Engine at its native REST path and ignores the
# access token (GOOGLE_OAUTH_ACCESS_TOKEN is a placeholder).
provider "google" {
  compute_custom_endpoint = "http://gcp:4588/compute/v1/"
}

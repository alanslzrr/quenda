output "public_ip" {
  description = "Static IP for the domain's A record."
  value       = google_compute_address.quenda.address
}

output "ssh_target" {
  description = "Target for `pnpm deploy:host` and SSH."
  value       = "ubuntu@${google_compute_address.quenda.address}"
}

output "url" {
  description = "Public address once a release is deployed."
  value       = var.domain != "" ? "https://${var.domain}" : "https://${replace(google_compute_address.quenda.address, ".", "-")}.sslip.io"
}

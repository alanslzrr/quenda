output "public_ip" {
  description = "Static IP for the domain's A record."
  value       = azurerm_public_ip.quenda.ip_address
}

output "ssh_target" {
  description = "Target for `pnpm deploy:host` and SSH."
  value       = "ubuntu@${azurerm_public_ip.quenda.ip_address}"
}

output "url" {
  description = "Public address once a release is deployed."
  value       = var.domain != "" ? "https://${var.domain}" : "https://${replace(azurerm_public_ip.quenda.ip_address, ".", "-")}.sslip.io"
}

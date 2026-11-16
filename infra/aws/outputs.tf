output "public_ip" {
  description = "Elastic IP for the domain's A record."
  value       = aws_eip.quenda.public_ip
}

output "ssh_target" {
  description = "Target for `pnpm deploy:host` and SSH."
  value       = "ubuntu@${aws_eip.quenda.public_ip}"
}

output "url" {
  description = "Public address once a release is deployed."
  value       = var.domain != "" ? "https://${var.domain}" : "https://${replace(aws_eip.quenda.public_ip, ".", "-")}.sslip.io"
}

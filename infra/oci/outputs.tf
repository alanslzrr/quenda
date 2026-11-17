output "public_ip" {
  description = "Address for the domain's A record."
  value       = oci_core_instance.quenda.public_ip
}

output "ssh_target" {
  description = "Target for `pnpm deploy:host` and SSH."
  value       = "ubuntu@${oci_core_instance.quenda.public_ip}"
}

output "url" {
  description = "Public address once a release is deployed."
  value       = var.domain != "" ? "https://${var.domain}" : "https://${replace(oci_core_instance.quenda.public_ip, ".", "-")}.sslip.io"
}

output "compartment_ocid" {
  value = oci_identity_compartment.quenda.id
}

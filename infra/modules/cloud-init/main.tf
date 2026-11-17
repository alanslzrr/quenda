# Cloud-agnostic first boot for one Quenda host. Every cloud root passes the
# rendered `user_data` to its VM, so all of them boot the same way.
terraform {
  required_version = ">= 1.6"
}

locals {
  settings = join("\n", concat(
    [
      "QUENDA_DOMAIN=${var.domain}",
      "ACME_EMAIL=${var.acme_email}",
      "EMAIL_LOCALE=${var.email_locale}",
      "SMTP_HOST=${var.smtp.host}",
      "SMTP_PORT=${var.smtp.port}",
      "SMTP_TLS=${var.smtp.tls}",
      "SMTP_FROM=${var.smtp.from}",
    ],
    var.smtp.user == "" ? [] : ["SMTP_USER=${var.smtp.user}"],
    var.smtp.servername == "" ? [] : ["SMTP_SERVERNAME=${var.smtp.servername}"],
    [""],
  ))
}

locals {
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    settings = base64encode(local.settings)
    cli      = base64gzip(file("${path.module}/../../../deploy/host/quenda"))
  })
}

output "user_data" {
  description = "cloud-config document for the VM's first boot."
  value       = local.user_data
  precondition {
    # The smallest limit among the supported clouds (AWS).
    condition     = length(local.user_data) <= 16384
    error_message = "The first-boot document exceeds the 16 KiB user data limit of AWS."
  }
}

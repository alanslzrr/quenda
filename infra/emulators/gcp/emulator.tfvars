project         = "quenda-emulator"
region          = "europe-southwest1"
zone            = "europe-southwest1-a"
ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDuhy/Wct12D3ua3C2kd8BQtSfOV0Mwox67rDe3xxoU emulator"
ssh_source_cidr = "203.0.113.10/32"
domain          = "quenda.example.org"
acme_email      = "operacion@example.org"
smtp = {
  host = "smtp.example.org"
  from = "reservas@example.org"
  user = "quenda"
}

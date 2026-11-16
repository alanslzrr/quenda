region                  = "us-ashburn-1"
parent_compartment_ocid = "ocid1.tenancy.oc1..flocilocaltenancy0000000000000000000000000000000000000000"
# floci-oci has no Compute API: a fixed image skips the image lookup.
image_ocid      = "ocid1.image.oc1.iad.emulatorubuntu2404"
ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDuhy/Wct12D3ua3C2kd8BQtSfOV0Mwox67rDe3xxoU emulator"
ssh_source_cidr = "203.0.113.10/32"
domain          = "quenda.example.org"
acme_email      = "operacion@example.org"
smtp = {
  host = "smtp.example.org"
  from = "reservas@example.org"
  user = "quenda"
}

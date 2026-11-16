# Renders the shared cloud-init module exactly as a cloud root would.
module "cloud_init" {
  source     = "../../../../infra/modules/cloud-init"
  domain     = "quenda.localhost"
  acme_email = "operacion@quenda.localhost"
  smtp = {
    host = "smtp.invalid"
    from = "reservas@quenda.localhost"
  }
}

output "user_data" {
  value = module.cloud_init.user_data
}

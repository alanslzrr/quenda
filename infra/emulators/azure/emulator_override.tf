# floci-az describes itself as an Azure Stack-style cloud at metadata_host
# (HTTPS, CA trusted through SSL_CERT_DIR) and accepts its seeded dev app.
provider "azurerm" {
  use_cli         = false
  environment     = "stack"
  metadata_host   = "azure:4577"
  tenant_id       = "00000000-0000-0000-0000-000000000002"
  client_id       = "11111111-1111-1111-1111-111111111111"
  client_secret   = "floci-az-dev-secret"
}

# floci-az reads back additional_capabilities with default values that were
# never sent; declaring those defaults keeps the drift check meaningful.
resource "azurerm_linux_virtual_machine" "quenda" {
  additional_capabilities {
    ultra_ssd_enabled   = false
    hibernation_enabled = false
  }
}

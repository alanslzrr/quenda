# floci-oci parses request signatures without verifying them: any API key works.
# Only Identity is routed to the emulator, so a stray call to another service
# fails instead of reaching a real region.
provider "oci" {
  config_file_profile = null
  tenancy_ocid        = "ocid1.tenancy.oc1..flocilocaltenancy0000000000000000000000000000000000000000"
  user_ocid           = "ocid1.user.oc1..flociiacuser00000000000000000000000000000000000000000000000"
  fingerprint         = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
  private_key_path    = "/work/emulator-key.pem"
}

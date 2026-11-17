# One Quenda host on OCI, sized for the Always Free tier: an Ampere A1 VM in its
# own compartment and VCN, reachable on 80/443 and on SSH from one CIDR.

module "host" {
  source       = "../modules/cloud-init"
  domain       = var.domain
  acme_email   = var.acme_email
  email_locale = var.email_locale
  smtp         = var.smtp
}

resource "oci_identity_compartment" "quenda" {
  compartment_id = var.parent_compartment_ocid
  name           = var.name
  description    = "Quenda installation managed by OpenTofu/Terraform"
  enable_delete  = true
}

data "oci_identity_availability_domains" "all" {
  compartment_id = var.parent_compartment_ocid
}

# Latest Canonical Ubuntu 24.04 build for the shape, unless pinned.
data "oci_core_images" "ubuntu" {
  count                    = var.image_ocid == "" ? 1 : 0
  compartment_id           = var.parent_compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  state                    = "AVAILABLE"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  image_ocid          = var.image_ocid != "" ? var.image_ocid : data.oci_core_images.ubuntu[0].images[0].id
  availability_domain = data.oci_identity_availability_domains.all.availability_domains[var.availability_domain_number - 1].name
}

resource "oci_core_vcn" "quenda" {
  compartment_id = oci_identity_compartment.quenda.id
  display_name   = var.name
  cidr_blocks    = ["10.20.0.0/16"]
  dns_label      = "quenda"
}

resource "oci_core_internet_gateway" "quenda" {
  compartment_id = oci_identity_compartment.quenda.id
  vcn_id         = oci_core_vcn.quenda.id
  display_name   = "${var.name}-internet"
}

resource "oci_core_route_table" "public" {
  compartment_id = oci_identity_compartment.quenda.id
  vcn_id         = oci_core_vcn.quenda.id
  display_name   = "${var.name}-public"
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.quenda.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = oci_identity_compartment.quenda.id
  vcn_id         = oci_core_vcn.quenda.id
  display_name   = "${var.name}-public"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  ingress_security_rules {
    description = "SSH for operators"
    source      = var.ssh_source_cidr
    protocol    = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }
  dynamic "ingress_security_rules" {
    for_each = { http = { protocol = "6", port = 80 }, https = { protocol = "6", port = 443 } }
    content {
      description = upper(ingress_security_rules.key)
      source      = "0.0.0.0/0"
      protocol    = ingress_security_rules.value.protocol
      tcp_options {
        min = ingress_security_rules.value.port
        max = ingress_security_rules.value.port
      }
    }
  }
  ingress_security_rules {
    description = "HTTP/3"
    source      = "0.0.0.0/0"
    protocol    = "17"
    udp_options {
      min = 443
      max = 443
    }
  }
  ingress_security_rules {
    description = "Path MTU discovery"
    source      = "0.0.0.0/0"
    protocol    = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = oci_identity_compartment.quenda.id
  vcn_id            = oci_core_vcn.quenda.id
  display_name      = "${var.name}-public"
  cidr_block        = "10.20.1.0/24"
  dns_label         = "public"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.public.id]
}

resource "oci_core_instance" "quenda" {
  compartment_id      = oci_identity_compartment.quenda.id
  availability_domain = local.availability_domain
  display_name        = var.name
  shape               = var.shape

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_ocid
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = var.name
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(module.host.user_data)
  }

  # The boot volume holds the database. A newer Ubuntu image or edited first-boot
  # settings must never replace the VM: change settings with `quenda` on the host.
  lifecycle {
    ignore_changes = [source_details[0].source_id, metadata]
  }
}

# Weekly crash-consistent backups of the boot volume, kept four weeks: at most
# five backups exist at once, the Always Free allowance.
resource "oci_core_volume_backup_policy" "weekly" {
  compartment_id = oci_identity_compartment.quenda.id
  display_name   = "${var.name}-weekly"
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_WEEK"
    day_of_week       = "SUNDAY"
    hour_of_day       = 3
    offset_type       = "STRUCTURED"
    retention_seconds = 2419200
    time_zone         = "REGIONAL_DATA_CENTER_TIME"
  }
}

resource "oci_core_volume_backup_policy_assignment" "boot" {
  asset_id  = oci_core_instance.quenda.boot_volume_id
  policy_id = oci_core_volume_backup_policy.weekly.id
}

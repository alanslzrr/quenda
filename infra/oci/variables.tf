variable "region" {
  description = "OCI region identifier, e.g. eu-madrid-1. Always Free A1 capacity exists only in the home region."
  type        = string
}

variable "config_profile" {
  description = "Profile of ~/.oci/config holding the API key used by the provider."
  type        = string
  default     = "DEFAULT"
}

variable "parent_compartment_ocid" {
  description = "Compartment (or tenancy OCID for the root) that will contain the Quenda compartment."
  type        = string
}

variable "name" {
  description = "Name of the compartment, VCN, VM and related resources."
  type        = string
  default     = "quenda"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.name))
    error_message = "name must be 2-15 lowercase letters, digits or hyphens, starting with a letter (it is also a DNS label)."
  }
}

variable "availability_domain_number" {
  description = "1-based availability domain. Change it when A1 capacity is exhausted in one domain."
  type        = number
  default     = 1
}

variable "shape" {
  description = "VM shape. VM.Standard.A1.Flex is the Always Free Ampere shape."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "ocpus" {
  description = "OCPUs of the flexible shape. The Always Free allowance is shared by every A1 VM of the tenancy."
  type        = number
  default     = 2
}

variable "memory_in_gbs" {
  description = "Memory of the flexible shape in GB."
  type        = number
  default     = 12
}

variable "boot_volume_size_in_gbs" {
  description = "Boot volume size; it holds the OS, images and the database. 200 GB of block storage are Always Free in total."
  type        = number
  default     = 50
  validation {
    condition     = var.boot_volume_size_in_gbs >= 50
    error_message = "OCI boot volumes start at 50 GB."
  }
}

variable "image_ocid" {
  description = "Pinned image OCID. Empty selects the newest Canonical Ubuntu 24.04 image for the shape."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Public key (OpenSSH format) authorized for the `ubuntu` user."
  type        = string
}

variable "ssh_source_cidr" {
  description = "Only this CIDR can reach SSH, e.g. your public address with /32."
  type        = string
  validation {
    condition     = can(cidrhost(var.ssh_source_cidr, 0)) && var.ssh_source_cidr != "0.0.0.0/0"
    error_message = "ssh_source_cidr must be a CIDR narrower than the whole Internet."
  }
}

variable "domain" {
  description = "Public DNS name pointed at the VM. Empty serves https://<ip>.sslip.io."
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Contact address for the Let's Encrypt account."
  type        = string
}

variable "email_locale" {
  description = "Language of the reservation emails: gl or es."
  type        = string
  default     = "gl"
}

variable "smtp" {
  description = "SMTP relay without its password (see the shared cloud-init module)."
  type = object({
    host       = string
    from       = string
    port       = optional(number, 587)
    tls        = optional(string, "starttls")
    user       = optional(string, "")
    servername = optional(string, "")
  })
}

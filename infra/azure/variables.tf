variable "subscription_id" {
  description = "Azure subscription that receives the resource group."
  type        = string
}

variable "location" {
  description = "Azure region, e.g. spaincentral."
  type        = string
}

variable "name" {
  description = "Name of the resource group, VNet, VM and related resources."
  type        = string
  default     = "quenda"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "size" {
  description = "VM size. Images are built off the host, so 4 GB of memory are plenty; B2ps_v2 is ARM, B2s is x86."
  type        = string
  default     = "Standard_B2ps_v2"
}

variable "architecture" {
  description = "Ubuntu image architecture matching size: arm64 or amd64."
  type        = string
  default     = "arm64"
  validation {
    condition     = contains(["arm64", "amd64"], var.architecture)
    error_message = "architecture must be arm64 or amd64."
  }
}

variable "disk_size_gb" {
  description = "OS disk size; it holds the OS, images and the database."
  type        = number
  default     = 32
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
  description = "Public DNS name pointed at the public IP. Empty serves https://<ip>.sslip.io."
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

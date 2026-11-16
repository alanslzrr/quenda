variable "project" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "GCP region, e.g. europe-southwest1."
  type        = string
}

variable "zone" {
  description = "Zone of the VM inside the region, e.g. europe-southwest1-a."
  type        = string
}

variable "name" {
  description = "Name of the network, VM and related resources."
  type        = string
  default     = "quenda"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "machine_type" {
  description = "Machine type. Images are built off the host, so 2 GB of memory are enough."
  type        = string
  default     = "e2-small"
}

variable "image" {
  description = "Boot image or family; use ubuntu-os-cloud/ubuntu-2404-lts-arm64 with ARM machine types."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "disk_size_gb" {
  description = "Boot disk size; it holds the OS, images and the database."
  type        = number
  default     = 30
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
  description = "Public DNS name pointed at the static IP. Empty serves https://<ip>.sslip.io."
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

variable "region" {
  description = "AWS region, e.g. eu-south-2."
  type        = string
}

variable "name" {
  description = "Name of the VPC, instance and related resources."
  type        = string
  default     = "quenda"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "instance_type" {
  description = "Instance type. Images are built off the host, so 2 GB of memory are enough; t4g is ARM, t3 is x86."
  type        = string
  default     = "t4g.small"
}

variable "architecture" {
  description = "Ubuntu image architecture matching instance_type: arm64 or amd64."
  type        = string
  default     = "arm64"
  validation {
    condition     = contains(["arm64", "amd64"], var.architecture)
    error_message = "architecture must be arm64 or amd64."
  }
}

variable "ami_id" {
  description = "Pinned AMI. Empty selects the newest Canonical Ubuntu 24.04 AMI."
  type        = string
  default     = ""
}

variable "volume_size_gb" {
  description = "Root volume size; it holds the OS, images and the database."
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
  description = "Public DNS name pointed at the Elastic IP. Empty serves https://<ip>.sslip.io."
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

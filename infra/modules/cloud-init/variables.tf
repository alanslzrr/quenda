# Values end up in a shell-sourced settings file: each one is validated to a
# safe character set so it cannot inject commands or extra variables.

variable "domain" {
  description = "Public DNS name with an A record to the VM. Empty uses <ip>.sslip.io."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^$|^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a lowercase DNS name or empty."
  }
}

variable "acme_email" {
  description = "Contact address for the Let's Encrypt account (expiry notices)."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.acme_email))
    error_message = "acme_email must be an email address."
  }
}

variable "email_locale" {
  description = "Language of the reservation emails: gl or es."
  type        = string
  default     = "gl"
  validation {
    condition     = contains(["gl", "es"], var.email_locale)
    error_message = "email_locale must be gl or es."
  }
}

variable "smtp" {
  description = "SMTP relay of the operating entity. The password is not set here: it is stored on the host with `quenda smtp-password`."
  type = object({
    host       = string
    from       = string
    port       = optional(number, 587)
    tls        = optional(string, "starttls")
    user       = optional(string, "")
    servername = optional(string, "")
  })
  validation {
    condition = alltrue([
      can(regex("^[A-Za-z0-9.-]+$", var.smtp.host)),
      can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.smtp.from)),
      contains(["starttls", "tls"], var.smtp.tls),
      var.smtp.port >= 1 && var.smtp.port <= 65535,
      can(regex("^[A-Za-z0-9._@+-]*$", var.smtp.user)),
      can(regex("^[A-Za-z0-9.-]*$", var.smtp.servername)),
    ])
    error_message = "smtp needs a host name, a single from address, tls starttls or tls, a valid port and a user without spaces or quotes."
  }
}

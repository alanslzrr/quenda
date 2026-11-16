terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
  }
}

# Credentials come from the standard AWS chain (profile, SSO, environment).
provider "aws" {
  region = var.region
  default_tags {
    tags = { Application = "quenda", Installation = var.name }
  }
}

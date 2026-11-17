terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.70"
    }
  }
}

# Credentials come from the Azure CLI login or ARM_* environment variables.
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

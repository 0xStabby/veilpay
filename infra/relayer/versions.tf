terraform {
  required_version = ">= 1.4.0"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.20"
    }
  }
}

provider "vultr" {}

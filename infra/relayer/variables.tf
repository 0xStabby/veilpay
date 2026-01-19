variable "region" {
  type    = string
  default = "sea"
}

variable "plan" {
  type    = string
  default = "vc2-1c-2gb"
}

variable "os_id" {
  type    = number
  default = 2284
}

variable "ssh_key_id" {
  type    = string
  default = ""
}

variable "relayer_port" {
  type    = number
  default = 8080
}

variable "relayer_rpc_url" {
  type    = string
  default = "https://api.devnet.solana.com"
}

variable "relayer_allowed_origins" {
  type    = string
  default = "*"
}

variable "relayer_domain" {
  type    = string
  default = ""
}

variable "relayer_cert_email" {
  type    = string
  default = ""
}

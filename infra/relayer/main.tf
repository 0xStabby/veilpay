resource "vultr_instance" "relayer" {
  label             = "veilpay-relayer"
  region            = var.region
  plan              = var.plan
  os_id             = var.os_id
  ssh_key_ids       = [var.ssh_key_id]
  user_data = templatefile("${path.module}/cloud-init.tftpl", {
    relayer_port            = var.relayer_port
    relayer_rpc_url         = var.relayer_rpc_url
    relayer_allowed_origins = var.relayer_allowed_origins
    relayer_domain          = var.relayer_domain
    relayer_cert_email      = var.relayer_cert_email
  })
}

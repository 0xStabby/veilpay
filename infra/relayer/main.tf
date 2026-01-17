resource "vultr_firewall_group" "relayer" {
  description = "veilpay-relayer"
}

resource "vultr_firewall_rule" "ssh" {
  firewall_group_id = vultr_firewall_group.relayer.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "22"
  notes             = "SSH"
}

resource "vultr_firewall_rule" "http" {
  firewall_group_id = vultr_firewall_group.relayer.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "80"
  notes             = "HTTP"
}

resource "vultr_firewall_rule" "https" {
  firewall_group_id = vultr_firewall_group.relayer.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "443"
  notes             = "HTTPS"
}

resource "vultr_firewall_rule" "relayer" {
  firewall_group_id = vultr_firewall_group.relayer.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = tostring(var.relayer_port)
  notes             = "Relayer port"
}

resource "vultr_instance" "relayer" {
  label             = "veilpay-relayer"
  region            = var.region
  plan              = var.plan
  os_id             = var.os_id
  ssh_key_ids       = [var.ssh_key_id]
  firewall_group_id = vultr_firewall_group.relayer.id
  user_data = templatefile("${path.module}/cloud-init.tftpl", {
    relayer_port            = var.relayer_port
    relayer_rpc_url         = var.relayer_rpc_url
    relayer_allowed_origins = var.relayer_allowed_origins
  })
}

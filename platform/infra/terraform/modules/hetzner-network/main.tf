terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.47"
    }
  }
}

# ─── Variables ───────────────────────────────────────────────────────────────

variable "name" {
  description = "Network name prefix"
  type        = string
}

variable "ip_range" {
  description = "CIDR block for the private network"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_ip_range" {
  description = "CIDR block for the primary subnet"
  type        = string
  default     = "10.0.0.0/24"
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
}

variable "labels" {
  description = "Labels applied to all resources"
  type        = map(string)
  default     = {}
}

# ─── Resources ───────────────────────────────────────────────────────────────

resource "hcloud_network" "main" {
  name     = "${var.name}-net"
  ip_range = var.ip_range
  labels   = var.labels
}

resource "hcloud_network_subnet" "main" {
  network_id   = hcloud_network.main.id
  type         = "cloud"
  network_zone = local.network_zone
  ip_range     = var.subnet_ip_range
}

resource "hcloud_firewall" "k3s" {
  name   = "${var.name}-k3s-fw"
  labels = var.labels

  # Allow all traffic within the private network
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "1-65535"
    source_ips = [var.ip_range]
  }

  # SSH — restrict to your operator IPs in production
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Kubernetes API
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "6443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTP / HTTPS for ingress
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

locals {
  network_zone_map = {
    nbg1 = "eu-central"
    fsn1 = "eu-central"
    hel1 = "eu-central"
    ash  = "us-east"
    hil  = "us-west"
    sin  = "ap-southeast"
  }
  network_zone = lookup(local.network_zone_map, var.location, "eu-central")
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "network_id" {
  value = hcloud_network.main.id
}

output "subnet_id" {
  value = hcloud_network_subnet.main.id
}

output "firewall_id" {
  value = hcloud_firewall.k3s.id
}

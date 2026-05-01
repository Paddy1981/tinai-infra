terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.47"
    }
  }
}

# ─── Variables ───────────────────────────────────────────────────────────────

variable "cluster_name" {
  description = "Cluster identifier used in resource names"
  type        = string
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
}

variable "network_id" {
  description = "Hetzner network ID to attach nodes to"
  type        = number
}

variable "firewall_id" {
  description = "Hetzner firewall ID"
  type        = number
}

variable "server_type_control" {
  description = "Hetzner server type for control-plane nodes"
  type        = string
  default     = "cx22"
}

variable "server_type_worker" {
  description = "Hetzner server type for worker nodes"
  type        = string
  default     = "cx32"
}

variable "worker_count" {
  description = "Number of worker nodes"
  type        = number
  default     = 3
}

variable "ssh_key_name" {
  description = "Name of the SSH key already uploaded to Hetzner"
  type        = string
}

variable "k3s_version" {
  description = "k3s release version to install"
  type        = string
  default     = "v1.30.2+k3s1"
}

variable "labels" {
  description = "Labels applied to all Hetzner resources"
  type        = map(string)
  default     = {}
}

# ─── Data Sources ─────────────────────────────────────────────────────────────

data "hcloud_ssh_key" "default" {
  name = var.ssh_key_name
}

data "hcloud_image" "ubuntu" {
  name             = "ubuntu-24.04"
  most_recent      = true
  with_architecture = "x86"
}

# ─── Control Plane ────────────────────────────────────────────────────────────

resource "hcloud_server" "control" {
  name        = "${var.cluster_name}-control"
  server_type = var.server_type_control
  image       = data.hcloud_image.ubuntu.id
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.default.id]
  firewall_ids = [var.firewall_id]
  labels      = merge(var.labels, { role = "control-plane" })

  network {
    network_id = var.network_id
  }

  user_data = templatefile("${path.module}/cloud-init-control.yaml.tpl", {
    k3s_version  = var.k3s_version
    cluster_name = var.cluster_name
  })
}

# ─── Worker Nodes ─────────────────────────────────────────────────────────────

resource "hcloud_server" "worker" {
  count       = var.worker_count
  name        = "${var.cluster_name}-worker-${count.index + 1}"
  server_type = var.server_type_worker
  image       = data.hcloud_image.ubuntu.id
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.default.id]
  firewall_ids = [var.firewall_id]
  labels      = merge(var.labels, { role = "worker" })

  network {
    network_id = var.network_id
  }

  user_data = templatefile("${path.module}/cloud-init-worker.yaml.tpl", {
    k3s_version      = var.k3s_version
    control_plane_ip = hcloud_server.control.network[0].ip
    cluster_name     = var.cluster_name
  })

  depends_on = [hcloud_server.control]
}

# ─── Floating IP (stable entry point) ─────────────────────────────────────────

resource "hcloud_floating_ip" "ingress" {
  name          = "${var.cluster_name}-ingress"
  type          = "ipv4"
  home_location = var.location
  labels        = var.labels
}

resource "hcloud_floating_ip_assignment" "ingress" {
  floating_ip_id = hcloud_floating_ip.ingress.id
  server_id      = hcloud_server.control.id
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "control_plane_ip" {
  description = "Public IP of the control-plane node"
  value       = hcloud_server.control.ipv4_address
}

output "worker_ips" {
  description = "Public IPs of worker nodes"
  value       = hcloud_server.worker[*].ipv4_address
}

output "ingress_ip" {
  description = "Floating IP for ingress (stable entry point)"
  value       = hcloud_floating_ip.ingress.ip_address
}

output "kubeconfig_command" {
  description = "Command to fetch kubeconfig after cluster is ready"
  value       = "ssh root@${hcloud_server.control.ipv4_address} 'cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/${hcloud_server.control.ipv4_address}/g'"
}

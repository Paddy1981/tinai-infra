# tinai.cloud — UAE / Middle East region (Hetzner Falkenstein, closest available)
# Region code: AE | Hetzner location: nbg1 (Nuremberg, DE)

terraform {
  required_version = ">= 1.7"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.47"
    }
  }

  backend "s3" {
    endpoint                    = "https://minio.tinai.cloud"
    bucket                      = "tinai-tf-state"
    key                         = "ae/terraform.tfstate"
    region                      = "eu-central-1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    force_path_style            = true
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

locals {
  region   = "ae"
  location = "nbg1"
  labels = {
    "tinai.cloud/region"      = local.region
    "tinai.cloud/environment" = "production"
    "tinai.cloud/managed-by"  = "terraform"
  }
}

module "network" {
  source          = "../../modules/hetzner-network"
  name            = "tinai-${local.region}"
  location        = local.location
  ip_range        = "10.30.0.0/16"
  subnet_ip_range = "10.30.0.0/24"
  labels          = local.labels
}

module "cluster" {
  source               = "../../modules/k3s-cluster"
  cluster_name         = "tinai-${local.region}"
  location             = local.location
  network_id           = module.network.network_id
  firewall_id          = module.network.firewall_id
  server_type_control  = var.server_type_control
  server_type_worker   = var.server_type_worker
  worker_count         = var.worker_count
  ssh_key_name         = var.ssh_key_name
  k3s_version          = var.k3s_version
  labels               = local.labels
}

variable "hcloud_token"         { sensitive = true }
variable "ssh_key_name"         { default = "tinai-ops" }
variable "server_type_control"  { default = "cx22" }
variable "server_type_worker"   { default = "cx32" }
variable "worker_count"         { default = 2 }
variable "k3s_version"          { default = "v1.30.2+k3s1" }

output "control_plane_ip" { value = module.cluster.control_plane_ip }
output "ingress_ip"        { value = module.cluster.ingress_ip }
output "worker_ips"        { value = module.cluster.worker_ips }
output "kubeconfig_command" { value = module.cluster.kubeconfig_command }

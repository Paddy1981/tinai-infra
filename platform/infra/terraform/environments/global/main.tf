# tinai.cloud — Global Cloudflare DNS / geo-routing layer
#
# This environment manages the single Cloudflare Load Balancer that geo-steers
# api.tinai.cloud to the nearest of the three regional k3s clusters.
#
# It is intentionally separate from the per-region Hetzner environments because
# the load balancer is a global resource and must be applied only once, after
# all three clusters are up and their ingress floating IPs are known.
#
# Usage:
#   tofu init  -backend-config="access_key=$MINIO_KEY" \
#              -backend-config="secret_key=$MINIO_SECRET"
#   tofu apply -var="cloudflare_api_token=$CF_API_TOKEN" \
#              -var="cloudflare_account_id=$CF_ACCOUNT_ID" \
#              -var="cloudflare_zone_id=$CF_ZONE_ID" \
#              -var="in_ip=$(tofu -chdir=../in output -raw ingress_ip)" \
#              -var="qa_ip=$(tofu -chdir=../qa output -raw ingress_ip)" \
#              -var="ae_ip=$(tofu -chdir=../ae output -raw ingress_ip)"

terraform {
  required_version = ">= 1.7"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    endpoint                    = "https://minio.tinai.cloud"
    bucket                      = "tinai-tf-state"
    key                         = "global/terraform.tfstate"
    region                      = "ap-southeast-1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    force_path_style            = true
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ─── Module ───────────────────────────────────────────────────────────────────

module "cloudflare_dns" {
  source = "../../modules/cloudflare-dns"

  cloudflare_api_token  = var.cloudflare_api_token
  cloudflare_account_id = var.cloudflare_account_id
  zone_id               = var.cloudflare_zone_id
  domain                = "tinai.cloud"

  in_ip = var.in_ip
  qa_ip = var.qa_ip
  ae_ip = var.ae_ip

  notification_email = var.notification_email
}

# ─── Variables ────────────────────────────────────────────────────────────────

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone.DNS and Load Balancers write permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for tinai.cloud"
  type        = string
}

variable "in_ip" {
  description = "Ingress floating IP of the India (sin) cluster — from environments/in output ingress_ip"
  type        = string
}

variable "qa_ip" {
  description = "Ingress floating IP of the Qatar / Gulf (fsn1) cluster — from environments/qa output ingress_ip"
  type        = string
}

variable "ae_ip" {
  description = "Ingress floating IP of the UAE (nbg1) cluster — from environments/ae output ingress_ip"
  type        = string
}

variable "notification_email" {
  description = "E-mail address for load balancer pool health notifications (optional)"
  type        = string
  default     = ""
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "load_balancer_hostname" {
  description = "Hostname of the provisioned Cloudflare load balancer"
  value       = module.cloudflare_dns.load_balancer_hostname
}

output "health_check_id" {
  description = "ID of the Cloudflare load balancer monitor"
  value       = module.cloudflare_dns.health_check_id
}

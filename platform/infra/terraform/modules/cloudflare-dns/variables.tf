variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone.DNS and Load Balancers write permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (required for load balancer pools and monitors)"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the domain (e.g. tinai.cloud)"
  type        = string
}

variable "domain" {
  description = "Root domain managed in Cloudflare; the load balancer is created at api.<domain>"
  type        = string
  default     = "tinai.cloud"
}

variable "in_ip" {
  description = "Floating IP of the India (Singapore) cluster ingress"
  type        = string
}

variable "qa_ip" {
  description = "Floating IP of the Qatar / Gulf (Falkenstein) cluster ingress"
  type        = string
}

variable "ae_ip" {
  description = "Floating IP of the UAE (Nuremberg) cluster ingress"
  type        = string
}

variable "notification_email" {
  description = "E-mail address for load balancer pool health notifications"
  type        = string
  default     = ""
}

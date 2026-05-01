output "load_balancer_hostname" {
  description = "Hostname of the Cloudflare load balancer (api.<domain>)"
  value       = cloudflare_load_balancer.api.name
}

output "health_check_id" {
  description = "ID of the Cloudflare load balancer monitor (HTTPS /healthz)"
  value       = cloudflare_load_balancer_monitor.healthz.id
}

output "pool_id_in" {
  description = "Cloudflare load balancer pool ID for the India region"
  value       = cloudflare_load_balancer_pool.in.id
}

output "pool_id_qa" {
  description = "Cloudflare load balancer pool ID for the Qatar / Gulf region"
  value       = cloudflare_load_balancer_pool.qa.id
}

output "pool_id_ae" {
  description = "Cloudflare load balancer pool ID for the UAE region"
  value       = cloudflare_load_balancer_pool.ae.id
}

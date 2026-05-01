# Cloudflare geo-steering load balancer for api.tinai.cloud
# Routes traffic to the nearest of three regional k3s clusters (IN / QA / AE).

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# ─── Health Check ─────────────────────────────────────────────────────────────

resource "cloudflare_load_balancer_monitor" "healthz" {
  account_id     = var.cloudflare_account_id
  type           = "https"
  path           = "/healthz"
  expected_codes = "200"
  interval       = 60
  timeout        = 10
  retries        = 2
  description    = "tinai API health check — HTTPS GET /healthz expect 200"
}

# ─── Origin Pools ─────────────────────────────────────────────────────────────

resource "cloudflare_load_balancer_pool" "in" {
  account_id  = var.cloudflare_account_id
  name        = "tinai-in"
  description = "India region — Hetzner Singapore (sin) floating IP"

  origins {
    name    = "tinai-in-origin"
    address = var.in_ip
    enabled = true
  }

  monitor            = cloudflare_load_balancer_monitor.healthz.id
  notification_email = var.notification_email
  check_regions      = ["SEAS"] # South-East Asia
}

resource "cloudflare_load_balancer_pool" "qa" {
  account_id  = var.cloudflare_account_id
  name        = "tinai-qa"
  description = "Qatar / Gulf region — Hetzner Falkenstein (fsn1) floating IP"

  origins {
    name    = "tinai-qa-origin"
    address = var.qa_ip
    enabled = true
  }

  monitor            = cloudflare_load_balancer_monitor.healthz.id
  notification_email = var.notification_email
  check_regions      = ["WEU"] # Western Europe (closest probe to fsn1)
}

resource "cloudflare_load_balancer_pool" "ae" {
  account_id  = var.cloudflare_account_id
  name        = "tinai-ae"
  description = "UAE / Middle East region — Hetzner Nuremberg (nbg1) floating IP"

  origins {
    name    = "tinai-ae-origin"
    address = var.ae_ip
    enabled = true
  }

  monitor            = cloudflare_load_balancer_monitor.healthz.id
  notification_email = var.notification_email
  check_regions      = ["EEU"] # Eastern Europe (closest probe to nbg1)
}

# ─── Load Balancer ────────────────────────────────────────────────────────────

resource "cloudflare_load_balancer" "api" {
  zone_id          = var.zone_id
  name             = "api.${var.domain}"
  description      = "Geo-steered load balancer for api.tinai.cloud"
  proxied          = true
  session_affinity = "none"

  # Fallback: India pool (primary region)
  default_pool_ids = [cloudflare_load_balancer_pool.in.id]

  fallback_pool_id = cloudflare_load_balancer_pool.in.id

  # ── Geo-steering rules ────────────────────────────────────────────────────
  # Cloudflare region codes reference:
  # https://developers.cloudflare.com/load-balancing/understand-basics/traffic-steering/steering-policies/geo-steering/

  rules {
    name      = "asia-oceania-to-in"
    condition = "cf.region == \"SEAS\" || cf.region == \"NEAS\" || cf.region == \"OC\""
    overrides {
      default_pools = [cloudflare_load_balancer_pool.in.id]
    }
  }

  rules {
    name      = "middle-east-to-qa"
    condition = "cf.region == \"ME\""
    overrides {
      default_pools = [cloudflare_load_balancer_pool.qa.id]
    }
  }

  rules {
    name      = "europe-to-qa"
    condition = "cf.region == \"EEU\" || cf.region == \"WEU\" || cf.region == \"NEU\""
    overrides {
      default_pools = [cloudflare_load_balancer_pool.qa.id]
    }
  }

  # Geo-steering region config (coarser fallback used when rules don't match)
  region_pools {
    region   = "SEAS"
    pool_ids = [cloudflare_load_balancer_pool.in.id]
  }

  region_pools {
    region   = "NEAS"
    pool_ids = [cloudflare_load_balancer_pool.in.id]
  }

  region_pools {
    region   = "OC"
    pool_ids = [cloudflare_load_balancer_pool.in.id]
  }

  region_pools {
    region   = "ME"
    pool_ids = [cloudflare_load_balancer_pool.qa.id]
  }

  region_pools {
    region   = "WEU"
    pool_ids = [cloudflare_load_balancer_pool.qa.id]
  }

  region_pools {
    region   = "EEU"
    pool_ids = [cloudflare_load_balancer_pool.qa.id]
  }

  region_pools {
    region   = "NEU"
    pool_ids = [cloudflare_load_balancer_pool.qa.id]
  }
}

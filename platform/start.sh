#!/bin/bash
# =============================================================================
# TinAI Cloud - Ubuntu Server Stack Manager
#
# Usage:
#   ./start.sh              - Start all services
#   ./start.sh stop         - Stop all services
#   ./start.sh rebuild      - Rebuild images and start
#   ./start.sh logs api     - Tail logs for a service
#   ./start.sh status       - Show running containers
#   ./start.sh db           - Open psql shell
#   ./start.sh shell api    - Open shell in a container
#   ./start.sh monitoring   - Start monitoring stack
#   ./start.sh monitoring-stop - Stop monitoring stack
# =============================================================================

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}OK${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!!${NC}  $1"; }
fail() { echo -e "  ${RED}XX${NC}  $1"; exit 1; }
hdr()  { echo -e "\n  ${CYAN}>> $1${NC}"; }

resolve() {
  case "$1" in
    api)       echo "tinai-api" ;;
    auth)      echo "tinai-auth" ;;
    dash|dashboard) echo "tinai-dashboard" ;;
    forge)     echo "tinai-forge" ;;
    gw|gateway) echo "tinai-gateway" ;;
    ws|realtime) echo "tinai-realtime" ;;
    fn|functions) echo "tinai-functions" ;;
    db|pg)     echo "postgres" ;;
    redis)     echo "redis" ;;
    git|forgejo) echo "forgejo" ;;
    *)         echo "$1" ;;
  esac
}

CMD="${1:-start}"

case "$CMD" in

  stop)
    hdr "Stopping TinAI"
    docker compose down
    ok "All services stopped"
    ;;

  status)
    docker compose ps
    echo ""
    docker compose -f docker-compose.monitoring.yml ps 2>/dev/null || true
    ;;

  logs)
    SVC=$(resolve "${2:-}")
    if [ -z "$SVC" ]; then
      docker compose logs -f --tail=100
    else
      docker compose logs -f --tail=100 "$SVC"
    fi
    ;;

  db)
    docker compose exec postgres psql -U tinai tinai
    ;;

  shell)
    SVC=$(resolve "${2:-api}")
    docker compose exec "$SVC" sh
    ;;

  rebuild)
    hdr "Rebuilding all images"
    docker compose build --no-cache
    docker compose up -d
    ;;

  monitoring)
    hdr "Starting monitoring stack"
    docker compose -f docker-compose.monitoring.yml up -d
    ok "Monitoring started"
    echo "   Grafana      ->  http://${NODE_IP:-localhost}:3100  (admin / see .env GRAFANA_PASSWORD)"
    echo "   Prometheus   ->  http://${NODE_IP:-localhost}:9090"
    echo "   Alertmanager ->  http://${NODE_IP:-localhost}:9093"
    ;;

  monitoring-stop)
    hdr "Stopping monitoring stack"
    docker compose -f docker-compose.monitoring.yml down
    ok "Monitoring stopped"
    ;;

  start|*)
    echo ""
    echo "  ================================"
    echo "   TinAI Cloud - Ubuntu Stack"
    echo "  ================================"

    if ! docker info > /dev/null 2>&1; then
      fail "Docker is not running."
    fi
    ok "Docker running ($(uname -m))"

    # Check .env
    if [ ! -f ".env" ]; then
      fail ".env not found. Copy .env.example to .env and fill in values."
    fi
    ok ".env ready"

    # Check service directories
    SERVICES=(tinai-api tinai-auth tinai-functions tinai-gateway tinai-realtime tinai-forge tinai-dashboard)
    for svc in "${SERVICES[@]}"; do
      if [ ! -d "./services/$svc" ]; then
        warn "services/$svc not found"
      fi
    done

    hdr "Starting services"
    docker compose up -d --build

    sleep 10

    hdr "Status"
    docker compose ps

    echo ""
    echo -e "  ${GREEN}================================${NC}"
    echo -e "  ${GREEN} TinAI Cloud is running!${NC}"
    echo -e "  ${GREEN}================================${NC}"
    echo ""
    echo "   Dashboard   ->  http://${NODE_IP:-localhost}:3000"
    echo "   API         ->  http://${NODE_IP:-localhost}:3001"
    echo "   Auth        ->  http://${NODE_IP:-localhost}:3002"
    echo "   Functions   ->  http://${NODE_IP:-localhost}:3004"
    echo "   Gateway     ->  http://${NODE_IP:-localhost}:3005"
    echo "   Realtime    ->  http://${NODE_IP:-localhost}:3006"
    echo "   Forge       ->  http://${NODE_IP:-localhost}:8090"
    echo "   Forgejo Git ->  http://${NODE_IP:-localhost}:3010"
    echo "   MinIO       ->  http://${NODE_IP:-localhost}:9001"
    echo "   PostgreSQL  ->  ${NODE_IP:-localhost}:5432"
    echo "   Redis       ->  ${NODE_IP:-localhost}:6379"
    echo ""
    echo "   Logs:   ./start.sh logs api"
    echo "   DB:     ./start.sh db"
    echo "   Stop:   ./start.sh stop"
    echo ""
    ;;
esac

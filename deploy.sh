#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

usage() {
  cat <<'EOF'
Usage: ./deploy.sh <command>

Commands:
  all       Pull origin/main, build and start the full Anubis stack
  api       Pull origin/main, build/update FastAPI backend
  front     Pull origin/main, build/update Angular frontend
  status    Show compose status and resource summary
  logs [S]  Follow logs. Optional service name S.

Run from /opt/anubis on the production VPS.
EOF
}

require_prod_files() {
  test -f .env || { echo "Missing .env"; exit 1; }
  "${COMPOSE[@]}" config >/dev/null
}

pull_main() {
  echo ">>> Updating repository"
  git fetch origin main
  git checkout main
  git reset --hard origin/main
  git log --oneline -3
}

update_api() {
  require_prod_files
  echo ">>> Building API and PDF worker images"
  "${COMPOSE[@]}" build anubis-api anubis-pdf-worker
  echo ">>> Recreating API and PDF worker (migrations run via entrypoint)"
  "${COMPOSE[@]}" up -d anubis-api anubis-pdf-worker
}

update_front() {
  require_prod_files
  echo ">>> Building frontend image"
  "${COMPOSE[@]}" build anubis-front
  echo ">>> Recreating frontend"
  "${COMPOSE[@]}" up -d anubis-front
}

update_all() {
  require_prod_files
  echo ">>> Building application images"
  "${COMPOSE[@]}" build anubis-api anubis-pdf-worker anubis-front
  echo ">>> Starting full stack"
  "${COMPOSE[@]}" up -d
}

status() {
  require_prod_files
  echo ">>> Compose status"
  "${COMPOSE[@]}" ps
  echo
  echo ">>> Container state"
  for cid in $("${COMPOSE[@]}" ps -q); do
    docker inspect -f '{{.Name}} restart={{.RestartCount}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid"
  done
  echo
  echo ">>> Disk"
  df -h /
  echo
  echo ">>> Docker disk"
  docker system df
  echo
  echo ">>> Memory"
  free -h
}

cmd="${1:-}"
case "$cmd" in
  all)
    pull_main
    update_all
    status
    ;;
  api)
    pull_main
    update_api
    status
    ;;
  front)
    pull_main
    update_front
    status
    ;;
  status)
    status
    ;;
  logs)
    shift || true
    "${COMPOSE[@]}" logs -f --tail=200 "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd"
    usage
    exit 2
    ;;
esac
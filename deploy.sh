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
  office-ai Reapply ONLYOFFICE AI plugin helper patch
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

wait_onlyoffice_healthy() {
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' anubis-onlyoffice 2>/dev/null || true)"
    echo "ONLYOFFICE health[$i]=$status"
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

patch_onlyoffice_ai_plugin() {
  require_prod_files

  local helper_path="/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}/scripts/helpers/helpers.js"
  echo ">>> Patching ONLYOFFICE AI plugin helper"

  for _ in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Running}}' anubis-onlyoffice 2>/dev/null || true)" = "true" ]; then
      break
    fi
    sleep 2
  done

  local patch_output
  if ! patch_output="$(docker exec -i anubis-onlyoffice python3 - <<'PY'
from pathlib import Path
import sys

p = Path('/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}/scripts/helpers/helpers.js')
s = p.read_text()

pairs = [
    (
        'generateDocx',
        'let fullPrompt = instructions + "\\nDescription:\\n\\n" + params.description;',
        'const description = params.description || params.prompt || params.text || "";\n\t\tlet fullPrompt = instructions + "\\nDescription:\\n\\n" + description;',
    ),
    (
        'generateForm',
        'let fullPrompt = instructions + "\\n\\n# Document to Generate\\n\\n" + params.description;',
        'const description = params.description || params.prompt || params.text || "";\n\t\tlet fullPrompt = instructions + "\\n\\n# Document to Generate\\n\\n" + description;',
    ),
]

changed = 0
for label, old, new in pairs:
    if old in s:
        s = s.replace(old, new, 1)
        changed += 1
    elif new in s:
        continue
    else:
        print(f'{label}=pattern-not-found', file=sys.stderr)
        sys.exit(2)

if changed:
    backup_dir = Path('/var/www/onlyoffice/Data/anubis-ai-helper-backups')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / 'helpers.js.before-param-alias-20260629'
    if not backup.exists():
        backup.write_text(p.read_text())
    p.write_text(s)

print(f'changed={changed}')
PY
)"; then
    echo "$patch_output"
    echo "WARNING: could not patch ONLYOFFICE AI plugin helper; continuing deploy"
    return 0
  fi

  echo "$patch_output"
  docker exec anubis-onlyoffice sh -lc "gzip -kf9 '$helper_path'"

  if echo "$patch_output" | grep -Eq 'changed=[1-9]'; then
    echo ">>> Restarting ONLYOFFICE to reload patched helper"
    "${COMPOSE[@]}" restart anubis-onlyoffice
    wait_onlyoffice_healthy || echo "WARNING: ONLYOFFICE did not become healthy after AI helper patch"
  fi
}

update_all() {
  require_prod_files
  echo ">>> Building application images"
  "${COMPOSE[@]}" build anubis-api anubis-pdf-worker anubis-front
  echo ">>> Starting full stack"
  "${COMPOSE[@]}" up -d
  patch_onlyoffice_ai_plugin
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
  office-ai)
    patch_onlyoffice_ai_plugin
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

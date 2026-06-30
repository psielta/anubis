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

  local plugin_root="/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}"
  local helper_path="$plugin_root/scripts/helpers/helpers.js"
  local generate_path="$plugin_root/scripts/generate.js"
  local config_path="$plugin_root/config.json"
  local restart_onlyoffice=0
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

locale = (
    "\\n\\nRegras obrigatorias de idioma e formato:\\n"
    "- Escreva em portugues do Brasil, salvo se o usuario pedir outro idioma explicitamente.\\n"
    "- Entregue texto pronto para documento Word, nao Markdown.\\n"
    "- Nao use simbolos de Markdown como #, **, _, blocos de codigo ou tabelas Markdown.\\n"
    "- Escreva titulos como linhas normais, sem #.\\n"
)

pairs = [
    (
        'generateDocx',
        [
            'let fullPrompt = instructions + "\\nDescription:\\n\\n" + params.description;',
            'const description = params.description || params.prompt || params.text || "";\n\t\tlet fullPrompt = instructions + "\\nDescription:\\n\\n" + description;',
        ],
        'const description = params.description || params.prompt || params.text || "";\n\t\tconst localeInstructions = "' + locale + '";\n\t\tlet fullPrompt = instructions + localeInstructions + "\\nDescription:\\n\\n" + description;',
    ),
    (
        'generateForm',
        [
            'let fullPrompt = instructions + "\\n\\n# Document to Generate\\n\\n" + params.description;',
            'const description = params.description || params.prompt || params.text || "";\n\t\tlet fullPrompt = instructions + "\\n\\n# Document to Generate\\n\\n" + description;',
        ],
        'const description = params.description || params.prompt || params.text || "";\n\t\tconst localeInstructions = "' + locale + '";\n\t\tlet fullPrompt = instructions + localeInstructions + "\\nDocument to Generate:\\n\\n" + description;',
    ),
]

changed = 0
for label, old_values, new in pairs:
    if new in s:
        continue
    for old in old_values:
        if old in s:
            s = s.replace(old, new, 1)
            changed += 1
            break
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
    restart_onlyoffice=1
  fi

  local generate_patch_output
  if ! generate_patch_output="$(docker exec -i anubis-onlyoffice python3 - <<'PY'
from pathlib import Path
import sys

p = Path('/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}/scripts/generate.js')
s = p.read_text()

start = s.find('async function streamPromptResultToDocument(prompt)')
end = s.find('async function getFormGenerationPrompt()', start)
if start < 0 or end < 0:
    print('generate=function-boundary-not-found', file=sys.stderr)
    sys.exit(2)

old = s[start:end]
new = """async function streamPromptResultToDocument(prompt)
{
\tlet requestEngine = AI.Request.create(AI.ActionType.Chat);
\tif (!requestEngine)
\t\treturn;

\tlet isSendedEndLongAction = false;
\tasync function checkEndAction() {
\t\tif (!isSendedEndLongAction) {
\t\t\tawait Asc.Editor.callMethod("EndAction", ["Block", "AI (" + requestEngine.modelUI.name + ")"]);
\t\t\tisSendedEndLongAction = true
\t\t}
\t}

\tawait Asc.Editor.callMethod("StartAction", ["Block", "AI (" + requestEngine.modelUI.name + ")"]);

\ttry {
\t\tlet agentHistory = [];

\t\tif (!Array.isArray(prompt)) {
\t\t\tagentHistory.push({
\t\t\t\trole: "user",
\t\t\t\tcontent: prompt
\t\t\t});
\t\t} else {
\t\t\tagentHistory = prompt;
\t\t}

\t\t/* Plain-text Anubis patch marker. */
\t\tlet result = await requestEngine.chatRequest(agentHistory, false);
\t\tif (window.AgentState && window.AgentState.isStopped)
\t\t\treturn;

\t\tif (result) {
\t\t\tlet text = Asc.Library.getMarkdownResult ? Asc.Library.getMarkdownResult(result, false) : result;
\t\t\t/* Plain-text Anubis Markdown sanitizer marker. */
\t\t\ttext = String(text)
\t\t\t\t.replace(/\\r\\n/g, String.fromCharCode(10))
\t\t\t\t.replace(/^\\s*```[a-zA-Z0-9_-]*\\s*$/gm, "")
\t\t\t\t.replace(/^\\s{0,3}#{1,6}\\s+/gm, "")
\t\t\t\t.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "$1")
\t\t\t\t.replace(/__([^_\\n]+)__/g, "$1")
\t\t\t\t.trim();
\t\t\tawait checkEndAction();
\t\t\tawait Asc.Editor.callMethod("FocusEditor");
\t\t\tawait Asc.Library.PasteText(String.fromCharCode(10) + text);
\t\t}
\t} finally {
\t\tawait checkEndAction();
\t}
}

"""

changed = 0
if 'Plain-text Anubis patch marker' in old and 'Plain-text Anubis Markdown sanitizer marker' in old and 'String.fromCharCode(10) + text' in old:
    pass
else:
    s = s[:start] + new + s[end:]
    changed = 1

if changed:
    backup_dir = Path('/var/www/onlyoffice/Data/anubis-ai-helper-backups')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / 'generate.js.before-unblock-before-paste-20260629'
    if not backup.exists():
        backup.write_text(p.read_text())
    p.write_text(s)

print(f'generate_changed={changed}')
PY
)"; then
    echo "$generate_patch_output"
    echo "WARNING: could not patch ONLYOFFICE AI generate helper; continuing deploy"
  else
    echo "$generate_patch_output"
    docker exec anubis-onlyoffice sh -lc "gzip -kf9 '$generate_path'"
    if echo "$generate_patch_output" | grep -Eq 'generate_changed=[1-9]'; then
      restart_onlyoffice=1
    fi
  fi

  local version_patch_output
  if ! version_patch_output="$(docker exec -i anubis-onlyoffice python3 - <<'PY'
from pathlib import Path
import json

p = Path('/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}/config.json')
s = p.read_text()
d = json.loads(s)
changed = 0

if d.get('version') != '3.2.5':
    backup_dir = Path('/var/www/onlyoffice/Data/anubis-ai-helper-backups')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / 'config.json.before-anubis-ai-version-20260629'
    if not backup.exists():
        backup.write_text(s)
    d['version'] = '3.2.5'
    p.write_text(json.dumps(d, ensure_ascii=False, indent=4))
    changed = 1

print(f'version_changed={changed}')
PY
)"; then
    echo "$version_patch_output"
    echo "WARNING: could not patch ONLYOFFICE AI plugin version; continuing deploy"
  else
    echo "$version_patch_output"
    docker exec anubis-onlyoffice sh -lc "gzip -kf9 '$config_path' || true"
    if echo "$version_patch_output" | grep -Eq 'version_changed=[1-9]'; then
      restart_onlyoffice=1
    fi
  fi

  if [ "$restart_onlyoffice" = "1" ]; then
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

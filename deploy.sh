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
  # Nginx in anubis-front caches upstream IPs at start; bounce it so login/proxy
  # keep working after API IP changes on trx_trxnet.
  echo ">>> Restarting frontend proxy to refresh anubis-api DNS"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate anubis-front || \
    docker restart anubis-front || true
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
  local register_path="$plugin_root/scripts/engine/register.js"
  local library_path="$plugin_root/scripts/engine/library.js"
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

  local context_menu_patch_output
  if ! context_menu_patch_output="$(docker exec -i anubis-onlyoffice python3 - <<'PY'
from pathlib import Path
import re
import sys

root = Path('/var/www/onlyoffice/documentserver/sdkjs-plugins/{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}')
register_path = root / 'scripts/engine/register.js'
library_path = root / 'scripts/engine/library.js'

register = register_path.read_text()
library = library_path.read_text()
changed = 0

def fail(label):
    print(f'{label}=pattern-not-found', file=sys.stderr)
    sys.exit(2)

def replace_all(text, old, new, label, required=False):
    count = text.count(old)
    if count:
        return text.replace(old, new), count
    if required and new not in text:
        fail(label)
    return text, 0

register_helper = '''
\tfunction normalizeAnubisAiTextResult(result) {
\t\tif (Asc.Library && Asc.Library.normalizeAnubisAiTextResult)
\t\t\treturn Asc.Library.normalizeAnubisAiTextResult(result);
\t\treturn String(result || "").trim();
\t}
'''

if 'function normalizeAnubisAiTextResult(result)' not in register:
    needle = '''\tfunction getContextMenuButtonIcons(icon) {
\t\treturn "resources/icons/%theme-type%(light|dark)/" + icon + "%scale%(default).png";
\t}
'''
    if needle not in register:
        fail('register-helper-anchor')
    register = register.replace(needle, needle + register_helper, 1)
    changed += 1

register_replacements = [
    ('button.text = "Summarization";', 'button.text = "Resumir";', 'label-summarization'),
    ('button1.text = "Text analysis";', 'button1.text = "Analise de texto";', 'label-text-analysis'),
    ('button2.text = "Rewrite differently";', 'button2.text = "Reescrever";', 'label-rewrite'),
    ('button3.text = "Make longer";', 'button3.text = "Aumentar texto";', 'label-longer'),
    ('button4.text = "Make shorter";', 'button4.text = "Encurtar texto";', 'label-shorter'),
    ('button5.text = "Explain text in comment";', 'button5.text = "Explicar em comentario";', 'label-explain-comment'),
    ('button6.text = "Explain text in hyperlink";', 'button6.text = "Explicar com link";', 'label-explain-link'),
    ('button7.text = "Fix spelling & grammar";', 'button7.text = "Corrigir ortografia e gramatica";', 'label-fix-grammar'),
    ('button8.text = "Keywords";', 'button8.text = "Palavras-chave";', 'label-keywords'),
    ('button1.text = "Translate";', 'button1.text = "Traduzir";', 'label-translate'),
    ('button2.text = "English";', 'button2.text = "Ingles";', 'label-english'),
    ('button3.text = "French";', 'button3.text = "Frances";', 'label-french'),
    ('button4.text = "German";', 'button4.text = "Alemao";', 'label-german'),
    ('button5.text = "Chinese";', 'button5.text = "Chines";', 'label-chinese'),
    ('button6.text = "Japanese";', 'button6.text = "Japones";', 'label-japanese'),
    ('button7.text = "Russian";', 'button7.text = "Russo";', 'label-russian'),
    ('button8.text = "Korean";', 'button8.text = "Coreano";', 'label-korean'),
    ('button9.text = "Spanish";', 'button9.text = "Espanhol";', 'label-spanish'),
    ('button10.text = "Italian";', 'button10.text = "Italiano";', 'label-italian'),
    ('button1.text = "Show hyperlink content";', 'button1.text = "Mostrar conteudo do link";', 'label-hyperlink'),
    ('buttonImages.text = "Image";', 'buttonImages.text = "Imagem";', 'label-image'),
    ('buttonGen.text = "Text to Image";', 'buttonGen.text = "Texto para imagem";', 'label-text-to-image'),
    ('buttonExplainImage.text = "Image to Text";', 'buttonExplainImage.text = "Imagem para texto";', 'label-image-to-text'),
    ('button2.text = "Summarization";', 'button2.text = "Resumir";', 'label-toolbar-summarization'),
    ('button4.text = "Translation";', 'button4.text = "Traducao";', 'label-toolbar-translation'),
    ("text:'Settings'", "text:'Configuracoes'", 'label-translation-settings'),
    ('window.buttonSettings.text = "Settings";', 'window.buttonSettings.text = "Configuracoes";', 'label-settings'),
    ('AI.Actions[AI.ActionType.Summarization]   = new ActionUI("Summarization", "summarization");', 'AI.Actions[AI.ActionType.Summarization]   = new ActionUI("Resumir", "summarization");', 'action-summarization'),
    ('AI.Actions[AI.ActionType.Translation]     = new ActionUI("Translation", "translation");', 'AI.Actions[AI.ActionType.Translation]     = new ActionUI("Traducao", "translation");', 'action-translation'),
    ('AI.Actions[AI.ActionType.TextAnalyze]     = new ActionUI("Text analysis", "text-analysis-ai");', 'AI.Actions[AI.ActionType.TextAnalyze]     = new ActionUI("Analise de texto", "text-analysis-ai");', 'action-text-analysis'),
    ('AI.Actions[AI.ActionType.ImageGeneration] = new ActionUI("Image generation", "image-ai", "", AI.CapabilitiesUI.Image);', 'AI.Actions[AI.ActionType.ImageGeneration] = new ActionUI("Geracao de imagem", "image-ai", "", AI.CapabilitiesUI.Image);', 'action-image-generation'),
    ('AI.Actions[AI.ActionType.Vision]          = new ActionUI("Vision", "vision-ai", "", AI.CapabilitiesUI.Vision);', 'AI.Actions[AI.ActionType.Vision]          = new ActionUI("Visao", "vision-ai", "", AI.CapabilitiesUI.Vision);', 'action-vision'),
]

for old, new, label in register_replacements:
    register, count = replace_all(register, old, new, label)
    changed += count

summary_old = 'result = "Summary:\\n\\n" + result;'
summary_new = '''result = normalizeAnubisAiTextResult(result).replace(/^Resumo\\s*:\\s*/i, "");
\t\t\tresult = "Resumo:" + String.fromCharCode(10) + String.fromCharCode(10) + result;'''
register, count = replace_all(register, summary_old, summary_new, 'summary-prefix', required=True)
changed += count

paste_old = '''result = result.replace(/\\n\\n/g, '\\n');
\t\t\tawait Asc.Library.PasteText(result);'''
paste_new = '''result = normalizeAnubisAiTextResult(result).replace(/\\n\\n/g, '\\n');
\t\t\tawait Asc.Library.PasteText(result);'''
register, count = replace_all(register, paste_old, paste_new, 'paste-normalize')
changed += count

comment_old = '''result = result.replace(/\\n\\n/g, '\\n');
\t\t\tawait Asc.Library.InsertAsComment(result);'''
comment_new = '''result = normalizeAnubisAiTextResult(result).replace(/\\n\\n/g, '\\n');
\t\t\tawait Asc.Library.InsertAsComment(result);'''
register, count = replace_all(register, comment_old, comment_new, 'comment-normalize')
changed += count

spell_old = '''if (result !== 'The text is correct, there are no errors in it.')
\t\t\t   await Asc.Library.ReplaceTextSmart([result]);
\t\t\telse
\t\t\t\tconsole.log('The text is correct, there are no errors in it.');'''
spell_new = '''result = normalizeAnubisAiTextResult(result);
\t\t\tif (result)
\t\t\t\tawait Asc.Library.ReplaceTextSmart([result]);'''
register, count = replace_all(register, spell_old, spell_new, 'spell-normalize')
changed += count

insert_text_old = 'await Asc.Library.InsertAsText(result);'
insert_text_new = 'await Asc.Library.InsertAsText(normalizeAnubisAiTextResult(result));'
register, count = replace_all(register, insert_text_old, insert_text_new, 'insert-text-normalize')
changed += count

insert_md_old = 'await Asc.Library.InsertAsMD(result);'
insert_md_new = 'await Asc.Library.InsertAsMD(normalizeAnubisAiTextResult(result));'
register, count = replace_all(register, insert_md_old, insert_md_new, 'insert-md-normalize')
changed += count

normalizer = r'''
	Library.prototype.normalizeAnubisAiTextResult = function(data) {
		let text = String(data || "")
			.replace(/\r\n/g, String.fromCharCode(10))
			.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
			.replace(/^\s{0,3}#{1,6}\s+/gm, "")
			.replace(/\*\*([^*\n]+)\*\*/g, "$1")
			.replace(/__([^_\n]+)__/g, "$1")
			.trim();

		const labelMap = [
			[/^summary\s*:?\s*/i, "Resumo:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^resumo\s*:?\s*/i, "Resumo:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^explanation\s*:?\s*/i, "Explicacao:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^explain\s*:?\s*/i, "Explicacao:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^keywords\s*:?\s*/i, "Palavras-chave:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^key words\s*:?\s*/i, "Palavras-chave:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^translation\s*:?\s*/i, "Traducao:" + String.fromCharCode(10) + String.fromCharCode(10)],
			[/^rewrite\s*:?\s*/i, "Reescrita:" + String.fromCharCode(10) + String.fromCharCode(10)],
		];

		for (let i = 0; i < labelMap.length; i++) {
			if (labelMap[i][0].test(text)) {
				text = text.replace(labelMap[i][0], labelMap[i][1]);
				break;
			}
		}

		return text.trim();
	};
'''

if 'normalizeAnubisAiTextResult' not in library:
    needle = '''\tLibrary.prototype.getJSONResult = function(data) {
\t\tconst markdownMarker = "```json";
\t\tlet markdownEscape = data.indexOf(markdownMarker);
\t\tif (-1 !== markdownEscape && markdownEscape < 5)
\t\t\tdata = data.substring(markdownEscape + markdownMarker.length);
\t\treturn this.trimResult(data);
\t};
'''
    if needle not in library:
        fail('library-normalizer-anchor')
    library = library.replace(needle, needle + normalizer, 1)
    changed += 1

def replace_method(text, name, new, marker):
    if marker in text:
        return text, 0
    pattern = r'[ \t]*' + re.escape(name) + r'\([^)]*\) \{.*?\n[ \t]*\},'
    text2, count = re.subn(pattern, new, text, count=1, flags=re.S)
    if count != 1:
        fail(f'prompt-{name}')
    return text2, count

library, count = replace_method(library, 'getFixAndSpellPrompt', r'''		getFixAndSpellPrompt(content) {
			let prompt = `Atue como revisor de portugues do Brasil. Corrija ortografia e gramatica mantendo o sentido original. Retorne somente o texto corrigido, sem comentarios, sem Markdown e sem titulo. Se nao houver erros, retorne exatamente o texto original. Texto para revisar: "${content}"`;
			return prompt;
		},''', 'Atue como revisor de portugues do Brasil')
changed += count

library, count = replace_method(library, 'getSummarizationPrompt', r'''		getSummarizationPrompt(content, language) {
			let prompt = "Resuma o texto a seguir em portugues do Brasil. ";
			if (language) {
				prompt += "Depois traduza o resumo para " + language + ". ";
			}
			prompt += "Retorne somente o texto final, sem Markdown e sem prefixos como Summary ou Resumo.";
			prompt += String.fromCharCode(10) + String.fromCharCode(10) + "Texto:" + String.fromCharCode(10);
			prompt += content;
			return prompt;
		},''', 'Resuma o texto a seguir em portugues do Brasil')
changed += count

library_replacements = [
    (
        'let prompt = "Translate the following text to " + language;\n\t\t\tprompt += ". Return only the resulting text.";',
        'let prompt = "Traduza o texto a seguir para " + language;\n\t\t\tprompt += ". Retorne somente o texto traduzido, sem Markdown e sem comentarios.";',
        'prompt-translate',
    ),
    (
        'let prompt = "Explain what the following text means. Return only the resulting text.";',
        'let prompt = "Explique em portugues do Brasil o que o texto a seguir significa. Retorne somente a explicacao, sem Markdown e sem titulo.";',
        'prompt-explain',
    ),
    (
        'let prompt = "Make the following text longer. Return only the resulting text.";',
        'let prompt = "Expanda o texto a seguir em portugues do Brasil, mantendo o sentido original. Retorne somente o texto final, sem Markdown e sem titulo.";',
        'prompt-longer',
    ),
    (
        'let prompt = "Make the following text simpler. Return only the resulting text.";',
        'let prompt = "Simplifique e encurte o texto a seguir em portugues do Brasil, mantendo o sentido original. Retorne somente o texto final, sem Markdown e sem titulo.";',
        'prompt-shorter',
    ),
    (
        'let prompt = "Rewrite the following text differently. Return only the resulting text.";',
        'let prompt = "Reescreva o texto a seguir em portugues do Brasil, com redacao natural e mantendo o sentido original. Retorne somente o texto final, sem Markdown e sem titulo.";',
        'prompt-rewrite',
    ),
    (
        'let prompt = `Get Key words from this text: "${content}"`;',
        'let prompt = `Extraia as palavras-chave do texto a seguir em portugues do Brasil. Retorne somente as palavras-chave, separadas por virgula, sem Markdown e sem titulo: "${content}"`;',
        'prompt-keywords',
    ),
    (
        'let prompt = "Give a link to the explanation of the following text. Return only the resulting link.";',
        'let prompt = "Indique um link confiavel para explicar o texto a seguir. Retorne somente o link, sem Markdown e sem comentarios.";',
        'prompt-explain-link',
    ),
    (
        'return "Describe in detail everything you see in this image. Mention the objects, their appearance, colors, arrangement, background, and any noticeable actions or interactions. Be as specific and accurate as possible. Avoid making assumptions about things that are not clearly visible."',
        'return "Descreva em portugues do Brasil, em texto simples, tudo que voce ve nesta imagem. Mencione objetos, aparencia, cores, organizacao, fundo e acoes visiveis. Seja especifico e preciso. Nao faca suposicoes sobre o que nao estiver claramente visivel."',
        'prompt-image-description',
    ),
]

for old, new, label in library_replacements:
    library, count = replace_all(library, old, new, label)
    changed += count

if changed:
    backup_dir = Path('/var/www/onlyoffice/Data/anubis-ai-helper-backups')
    backup_dir.mkdir(parents=True, exist_ok=True)
    for path, original, name in (
        (register_path, register_path.read_text(), 'register.js.before-anubis-ptbr-context-menu-20260630'),
        (library_path, library_path.read_text(), 'library.js.before-anubis-ptbr-context-menu-20260630'),
    ):
        backup = backup_dir / name
        if not backup.exists():
            backup.write_text(original)
    register_path.write_text(register)
    library_path.write_text(library)

print(f'context_menu_changed={changed}')
PY
)"; then
    echo "$context_menu_patch_output"
    echo "WARNING: could not patch ONLYOFFICE AI context menu localization; continuing deploy"
  else
    echo "$context_menu_patch_output"
    docker exec anubis-onlyoffice sh -lc "gzip -kf9 '$register_path' '$library_path'"
    if echo "$context_menu_patch_output" | grep -Eq 'context_menu_changed=[1-9]'; then
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

if d.get('version') != '3.2.6':
    backup_dir = Path('/var/www/onlyoffice/Data/anubis-ai-helper-backups')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / 'config.json.before-anubis-ai-version-20260629'
    if not backup.exists():
        backup.write_text(s)
    d['version'] = '3.2.6'
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

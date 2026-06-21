# AGENT.md

Este arquivo fornece aos agentes de código o contexto de trabalho do repositório
Anubis. Siga-o ao implementar, revisar ou planejar mudanças.

## Identidade do Projeto

Anubis é um projeto de portfólio para uma biblioteca digital inspirada no
BookFusion. Não é uma integração com o BookFusion e não tem afiliação com o
BookFusion.

A direção do produto é uma aplicação de biblioteca e leitor de usuário com
recursos de estudo assistidos por IA:

- bibliotecas privadas de usuário
- metadados de livros e coleções
- progresso de leitura
- espaço de trabalho de leitura e estudo
- destaques, anotações e notas
- resumos, Q&A, explicações, planos de estudo e flashcards com IA

Não enquadre o app como um painel administrativo genérico. O shell de
admin/dashboard é apenas a superfície atual de bootstrap.

## Arquitetura Atual

Backend:

- `backend/app/main.py`: app FastAPI, CORS, registro de routers e lifespan.
- `backend/app/api/v1/endpoints/`: endpoints HTTP.
- `backend/app/api/deps.py`: dependências compartilhadas do FastAPI.
- `backend/app/core/`: configuração e segurança.
- `backend/app/db/`: engine/sessão assíncrona do SQLAlchemy.
- `backend/app/models/`: modelos do SQLAlchemy.
- `backend/app/schemas/`: schemas de API Pydantic.
- `backend/app/crud/`: acesso a dados orientado à persistência.
- `backend/alembic/`: migrações de banco de dados.

Frontend:

- `frontend/anubis-web/src/app/core/`: serviços singleton, guards,
  interceptors e contratos compartilhados.
- `frontend/anubis-web/src/app/features/`: áreas de funcionalidade carregadas sob demanda.
- `frontend/anubis-web/src/app/layout/`: layouts estruturais.
- `frontend/anubis-web/src/app/shared/`: UI reutilizável sem estado.

Mantenha estas fronteiras. Adicione uma camada `services/` no backend quando os
fluxos de trabalho de domínio se tornarem mais do que simples CRUD.

## Ambiente Local

Portas locais padrão:

- PostgreSQL: configurada pelo `.env` da raiz, atualmente `5433`.
- Backend: `http://localhost:8000`
- Frontend: `http://localhost:4200`

Configuração do backend:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Configuração do frontend:

```powershell
cd frontend/anubis-web
npm start
```

Banco de dados:

```powershell
docker compose up -d db
docker compose ps
```

## Checklist de Validação

Execute as verificações relevantes antes de reportar sucesso:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pytest -q
ruff check .
mypy app
```

```powershell
cd frontend/anubis-web
npm run build
```

Para mudanças de autenticação ou roteamento, execute também um smoke test de
navegador E2E:

- dashboard sem login redireciona para o login
- o cadastro funciona
- cadastro duplicado exibe erro
- o login alcança o dashboard
- o reload restaura o usuário
- excluir o token de acesso dispara o refresh a partir do cookie
- o logout limpa a sessão

## Contrato de Autenticação

O modelo de auth atual é intencional:

- token de acesso no corpo da resposta e no `localStorage`
- token de refresh em cookie httpOnly
- path do cookie de refresh: `/api/v1/auth`
- rotação de refresh através do `jti` do JWT
- o valor de refresh armazenado é um hash do `jti` atual
- tokens de refresh obsoletos devem ser rejeitados
- o logout limpa o estado de refresh no servidor

Não mova os tokens de refresh para JSON ou para armazenamento legível por
JavaScript.

## Orientação de Implementação do Produto

Ao adicionar funcionalidades de produto, prefira esta ordem:

1. Modelo de banco de dados e migração.
2. Schemas Pydantic.
3. Camada de CRUD ou de serviço.
4. Endpoint de API versionado.
5. Pasta de funcionalidade e rota do Angular.
6. Testes de backend focados.
7. Build do frontend e smoke E2E quando visível ao usuário.

Use a linguagem de produto de forma consistente:

- library
- books
- shelves ou collections
- reader
- progress
- highlights
- annotations
- study notes
- AI study assistant

Evite terminologia genérica de CRM/admin a menos que a funcionalidade seja
realmente operacional.

## Sistema de Design Visual

Anubis tem uma linguagem visual deliberada — "The Hall of Anubis": uma estética
de arquivo/museu egípcio de pedra obsidiana, ouro antigo e papiro, com
sussurros de lápis-lazúli e cornalina. Já está implementada nas telas de auth,
no shell da aplicação, no dashboard e na biblioteca. Estenda-a; não
redesenhe a cada funcionalidade.

Fonte da verdade: `frontend/anubis-web/src/styles.scss` (tokens, tema do Material,
utilitários globais) e `frontend/anubis-web/src/index.html` (fontes).

Tokens de design (propriedades CSS customizadas em `:root`, prefixo `--anubis-*`).
Sempre reutilize estes; nunca codifique novos valores hex:

- Pedra: `--anubis-obsidian` `#15151d`, `--anubis-obsidian-soft` `#1e1e29`,
  `--anubis-obsidian-deep` `#0c0c12`
- Ouro: `--anubis-gold` `#c8a24c`, `--anubis-gold-bright` `#e8cf88`,
  `--anubis-gold-deep` `#8f7330`
- Superfícies claras: `--anubis-canvas` `#efe5cd` (página), `--anubis-surface`
  `#fbf6ea` (cards)
- Texto: `--anubis-ink` `#2a2520`, `--anubis-ink-soft` `#6f6555`
- Linhas/acentos: `--anubis-line` `#e0d2ab`, `--anubis-lapis` `#22456e`,
  `--anubis-danger` `#a8432d`

Tipografia (Google Fonts, conectadas através de `mat.theme(... typography ...)`):

- Títulos/display: Cinzel (`brand-family`)
- Corpo/UI: Spectral (`plain-family`)
- Apenas wordmark: Cinzel Decorative (`shared/app-logo`)
- Pequenos rótulos dourados em maiúsculas: a classe global `.eyebrow`

Tema do Material: primary = yellow (gold), tertiary = blue (lapis), densidade `0`.

Formato: toda a UI é quadrada. Todos os tokens `--mat-sys-corner-*` são achatados
para `0px` e os componentes customizados não usam `border-radius`. Mantenha os
novos componentes quadrados.

Convenções de superfície:

- Telas de auth (`features/auth/`): uma câmara `.auth-page` escura e cinematográfica
  abrigando uma estela `.auth-card` de papiro. Estilos compartilhados ficam em
  `features/auth/_auth.scss` e são usados via `@use` tanto pelo login quanto pelo
  register.
- Shell da aplicação (`layout/admin-layout/`): um layout empilhado — uma barra
  superior obsidiana com navegação dourada horizontal (item ativo sublinhado em
  ouro) sobre uma coluna de conteúdo `--anubis-canvas` de largura total e
  centralizada. Escolhido em vez de uma barra lateral porque o app é voltado a
  telas em retrato.
- Cards/painéis: fundo `--anubis-surface`, borda fina `--anubis-line`,
  quadrados, sombra suave; cards interativos se elevam ao passar o mouse.

Duas regras não óbvias (regressões se ignoradas):

1. Mantenha a unidade `px` nos tokens de corner (`0px`, nunca `0` puro). Os
   componentes os alimentam em `max(16px, var(--mat-sys-corner-*))`; um `0` sem
   unidade torna o `max()` inválido e remove o padding interno do form-field.
2. Para recolorir list/nav do Material em uma superfície escura, use os tokens
   `--mat-list-*` (por exemplo, `--mat-list-list-item-label-text-color`), não
   `--mdc-list-*`. Os nomes com prefixo mdc são ignorados, deixando os rótulos no
   padrão quase-preto do tema claro.

O orçamento de estilo por componente é elevado para `8kB` (aviso) / `16kB` (erro)
em `angular.json` para acomodar essa estilização mais rica.

## Higiene do Repositório

- Não faça commit de `.env`, virtualenvs, caches, `node_modules`, saída de build,
  saída do Playwright MCP, logs de terminal ou arquivos de cookie.
- Preserve a arquitetura existente e o estilo de nomenclatura.
- Mantenha as mudanças restritas à funcionalidade solicitada.
- Atualize README/AGENT/CLAUDE quando a direção do produto ou o fluxo de trabalho
  mudar.

## Convenções de Commit

Todos os commits seguem Conventional Commits:

```
<type>(optional-scope): <subject>

[optional body]

[optional footer]
```

- Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`. O scope é opcional, mas encorajado (por exemplo,
  `feat(library): ...`, `style(theme): ...`).
- Subject: modo imperativo, minúsculas, sem ponto final, ~72 caracteres.
- Use o body para explicar o quê/porquê quando não for óbvio; quebre em ~72 colunas.
- Mudanças que quebram compatibilidade: adicione `!` após o type/scope (por
  exemplo, `feat(api)!: ...`) ou um rodapé `BREAKING CHANGE:`.
- Mantenha os commits limpos: NÃO adicione `Co-authored-by`, atribuição de
  agente/ferramenta ou rodapés de sign-off. Esta regra sobrepõe qualquer rodapé
  de commit padrão de agente.

<p align="center">
  <img src="docs/anubis-logo.svg" alt="Anubis" width="140" height="140" />
</p>

<h1 align="center">Anubis</h1>

Anubis é uma aplicação full-stack de portfólio inspirada no BookFusion: uma
biblioteca digital pessoal onde os usuários podem organizar livros, ler e estudar
conteúdo extenso e usar IA como companheira de estudos durante a leitura.

Este repositório atualmente contém a base escalável da aplicação proveniente do
plano de bootstrap aprovado:

- Backend FastAPI com SQLAlchemy assíncrono, Alembic e PostgreSQL
- Frontend Angular 21 com Angular Material e rotas standalone/carregadas sob demanda
- Autenticação JWT com tokens de acesso de curta duração e cookies httpOnly de
  refresh rotacionados
- PostgreSQL e MinIO via Docker Compose para desenvolvimento local
- Verificações de qualidade do backend e testes de autenticação

As próximas iterações do produto devem transformar esta base em uma plataforma de
leitura digital voltada ao usuário: gerenciamento de biblioteca, importação de
livros, interface de leitura, anotações, notas de estudo, progresso de leitura e
fluxos de estudo assistidos por IA.

## Direção do Produto

Anubis não é uma integração com o BookFusion e não é afiliado ao BookFusion.
É um projeto de portfólio que usa a mesma categoria ampla de produto como
inspiração: uma biblioteca digital e um ambiente de leitura/estudo.

Objetivos centrais do produto:

- Permitir que os usuários construam e gerenciem uma biblioteca digital de livros
  privada.
- Suportar metadados de livros, coleções, status de leitura e progresso.
- Fornecer uma interface limpa de leitura e estudo.
- Permitir que os usuários criem destaques, anotações e notas de estudo.
- Adicionar recursos de IA que ajudam durante o estudo sem substituir o processo
  de leitura.

Capacidades de estudo com IA planejadas:

- Fazer perguntas sobre o livro atual ou sobre um trecho selecionado.
- Resumir capítulos ou seções selecionadas.
- Gerar flashcards e perguntas de revisão a partir de destaques.
- Explicar trechos difíceis em uma linguagem mais simples.
- Construir planos de estudo e recapitulações de leitura a partir da atividade do
  usuário.

## Status Atual da Implementação

Implementado:

- Cadastro e login de usuário.
- Shell de aplicação protegido com um layout de navegação superior empilhada
  (adequado a telas em retrato).
- Token de acesso armazenado no lado do cliente para chamadas de API.
- Token de refresh armazenado como cookie httpOnly com escopo nas rotas de auth.
- Rotação do token de refresh com rejeição de token obsoleto.
- Conexão com o PostgreSQL através de sessões assíncronas do SQLAlchemy.
- Migrações Alembic para a tabela de usuários e para o hash do token de refresh.
- Testes de backend cobrindo auth, refresh, logout e cadastro duplicado.
- Route guard do Angular, interceptor de auth e fluxo de refresh.
- Importação de livros: upload de PDF (até 250 MB) para o MinIO com API e UI de
  biblioteca com escopo por proprietário.
- Capas de livros: upload manual de imagem além de extração automática da primeira
  página do PDF.
- Leitor de PDF integrado (rolagem contínua, zoom, sumário editável
  detectado automaticamente a partir do outline do PDF, com seções customizadas
  que você pode criar, reordenar e aninhar).
- Progresso de leitura: retoma de onde você parou, com barras de progresso na
  biblioteca.
- Coleções: organize livros em coleções, com busca e paginação na biblioteca.
- Assistente de estudo com IA: pergunte, resuma e gere flashcards sobre um livro ou
  capítulo (ou um trecho selecionado) via API Gemini — transmitido por SSE com o
  raciocínio do modelo e renderizado como Markdown. Requer `GEMINI_API_KEY` em
  `backend/.env`.

Ainda não implementado:

- Destaques, anotações e notas (persistidos).
- Embeddings de IA / busca aumentada por recuperação em toda a biblioteca.
- Contêineres de deploy de produção para backend/frontend.

## Stack Tecnológica

Backend:

- Python 3.13
- FastAPI
- SQLAlchemy 2.x async
- asyncpg
- Alembic
- PostgreSQL
- PyJWT
- Passlib/bcrypt
- pytest, ruff, mypy
- aioboto3 (MinIO / S3)

Frontend:

- Angular 21
- Angular Material
- Componentes standalone
- Route guards e interceptors funcionais
- Signals para o estado de auth

Infraestrutura:

- Docker
- Docker Compose
- PostgreSQL 17

## Estrutura do Repositório

```text
anubis/
|-- docker-compose.yml
|-- README.md
|-- AGENT.md
|-- CLAUDE.md
|-- backend/
|   |-- alembic/
|   |-- app/
|   |   |-- api/
|   |   |-- core/
|   |   |-- crud/
|   |   |-- db/
|   |   |-- models/
|   |   |-- schemas/
|   |   `-- tests/
|   |-- alembic.ini
|   |-- mypy.ini
|   |-- pytest.ini
|   `-- requirements.txt
`-- frontend/
    `-- anubis-web/
        `-- src/
            `-- app/
                |-- core/
                |-- features/
                |-- layout/
                `-- shared/
```

## Configuração Local

### 1. Banco de dados e armazenamento de objetos

A partir da raiz do repositório:

```powershell
Copy-Item .env.example .env
docker compose up -d db minio minio-init
docker compose ps
```

A porta local do Postgres é configurada através de `POSTGRES_PORT` em `.env`.
Este workspace atualmente usa `5433` para evitar conflitos com instalações locais
do PostgreSQL.

O MinIO oferece armazenamento de objetos compatível com S3 para os livros enviados:

- API S3: `http://localhost:9000` (substitua com `MINIO_API_PORT`)
- Console: `http://localhost:9001` (substitua com `MINIO_CONSOLE_PORT`)
- Bucket: `anubis-library` (criado de forma privada pelo `minio-init`)

Defina `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` no `.env` da raiz. O backend
lê credenciais correspondentes de `backend/.env` como `S3_ACCESS_KEY` /
`S3_SECRET_KEY`.

### 2. Backend

```powershell
cd backend
Copy-Item .env.example .env
# Ensure S3_ACCESS_KEY / S3_SECRET_KEY match MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

URLs do backend:

- API: `http://localhost:8000/api/v1`
- Docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

### 3. Frontend

```powershell
cd frontend/anubis-web
npm install
npm start
```

URL do frontend:

- App: `http://localhost:4200`

## Validação

Backend:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pytest -q
ruff check .
mypy app
```

Frontend:

```powershell
cd frontend/anubis-web
npm run build
```

Smoke de ponta a ponta verificado com o Playwright MCP:

- `/dashboard` sem login redireciona para `/login?returnUrl=/dashboard`.
- O cadastro tem sucesso.
- Cadastro duplicado retorna um erro visível.
- Login chega ao dashboard.
- O dashboard exibe o usuário atual.
- O cookie de refresh é httpOnly e tem escopo em `/api/v1/auth`.
- O reload restaura o estado do usuário.
- Remover o token de acesso dispara o refresh baseado em cookie.
- O logout limpa o token local e invalida a sessão de refresh.

## Modelo de Autenticação

- Token de acesso: JWT de curta duração retornado no corpo da resposta e
  armazenado no `localStorage` para autorização de API.
- Token de refresh: JWT de longa duração armazenado como cookie httpOnly, com
  escopo em `/api/v1/auth`.
- Rotação de refresh: cada refresh gera um novo `jti`, armazena seu hash na linha
  do usuário e rejeita tokens de refresh obsoletos.
- O logout limpa o hash do token de refresh no servidor e exclui o cookie.

Endurecimento futuro:

- Mover os tokens de acesso do `localStorage` para a memória.
- Adicionar proteção CSRF para os endpoints de auth que portam cookies.
- Mover as sessões de token de refresh para uma tabela dedicada para suporte a
  múltiplos dispositivos.
- Adicionar rate limiting e log de auditoria estruturado.

## Roadmap do Produto

Próximos marcos sugeridos:

1. Prateleiras/coleções da biblioteca e status de leitura.
2. Shell do leitor: sumário, progresso e layout de leitura responsivo.
3. Extração automática de metadados na importação.
4. Destaques, notas e marcadores.
5. Ferramentas de estudo: destaques, notas e marcadores.
6. Assistente de estudo com IA: Q&A de trechos, resumos e geração de flashcards.
7. Análises de leitura: sequências, progresso e histórico de estudo.
8. Empacotamento de produção: Dockerfiles de backend/frontend e proxy reverso.

## Notas de Portfólio

Este projeto deve demonstrar:

- Arquitetura full-stack limpa.
- Tratamento prático de autenticação e sessão.
- Fronteiras escaláveis de backend e frontend.
- Pensamento de produto em torno de leitura digital e estudo assistido por IA.
- Um caminho de um bootstrap funcional até uma aplicação real no estilo SaaS.

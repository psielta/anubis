# Anubis

Anubis is a portfolio full-stack application inspired by BookFusion: a personal
digital library where users can organize books, read and study long-form
content, and use AI as a study companion while reading.

This repository currently contains the scalable application foundation from the
approved bootstrap plan:

- FastAPI backend with async SQLAlchemy, Alembic and PostgreSQL
- Angular 21 frontend with Angular Material and standalone/lazy-loaded routes
- JWT authentication with short-lived access tokens and rotated httpOnly refresh
  cookies
- Docker Compose PostgreSQL for local development
- Backend quality gates and auth tests

The next product iterations should turn this foundation into a user-facing
digital reading platform: library management, book import, reader UI,
annotations, study notes, reading progress and AI-assisted study workflows.

## Product Direction

Anubis is not a BookFusion integration and is not affiliated with BookFusion.
It is a portfolio project that uses the same broad product category as
inspiration: a digital library and reading/study environment.

Core product goals:

- Let users build and manage a private digital book library.
- Support book metadata, collections, reading status and progress.
- Provide a clean reading and study interface.
- Let users create highlights, annotations and study notes.
- Add AI features that help during study without replacing the reading process.

Planned AI study capabilities:

- Ask questions about the current book or selected passage.
- Summarize chapters or selected sections.
- Generate flashcards and review prompts from highlights.
- Explain difficult excerpts in simpler language.
- Build study plans and reading recaps from user activity.

## Current Implementation Status

Implemented:

- User registration and login.
- Protected admin/dashboard shell.
- Access token stored client-side for API calls.
- Refresh token stored as an httpOnly cookie scoped to auth routes.
- Refresh token rotation with stale-token rejection.
- PostgreSQL connection through SQLAlchemy async sessions.
- Alembic migrations for the users table and refresh-token hash.
- Backend tests covering auth, refresh, logout and duplicate registration.
- Angular route guard, auth interceptor and refresh flow.

Not implemented yet:

- Book upload/import.
- Library shelves/collections.
- Reader interface.
- Highlights, annotations and notes.
- AI ingestion, embeddings, chat or summarization workflows.
- Production deployment containers for backend/frontend.

## Tech Stack

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

Frontend:

- Angular 21
- Angular Material
- Standalone components
- Functional route guards and interceptors
- Signals for auth state

Infrastructure:

- Docker
- Docker Compose
- PostgreSQL 17

## Repository Layout

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

## Local Setup

### 1. Database

From the repository root:

```powershell
Copy-Item .env.example .env
docker compose up -d db
docker compose ps
```

The local Postgres port is configured through `POSTGRES_PORT` in `.env`.
This workspace currently uses `5433` to avoid conflicts with local PostgreSQL
installations.

### 2. Backend

```powershell
cd backend
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Backend URLs:

- API: `http://localhost:8000/api/v1`
- Docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

### 3. Frontend

```powershell
cd frontend/anubis-web
npm install
npm start
```

Frontend URL:

- App: `http://localhost:4200`

## Validation

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

End-to-end smoke verified with Playwright MCP:

- Logged-out `/dashboard` redirects to `/login?returnUrl=/dashboard`.
- Registration succeeds.
- Duplicate registration returns a visible error.
- Login lands on dashboard.
- Dashboard displays the current user.
- Refresh cookie is httpOnly and scoped to `/api/v1/auth`.
- Reload restores user state.
- Removing the access token triggers cookie-based refresh.
- Logout clears local token and invalidates the refresh session.

## Authentication Model

- Access token: short-lived JWT returned in the response body and stored in
  `localStorage` for API authorization.
- Refresh token: long-lived JWT stored as an httpOnly cookie, scoped to
  `/api/v1/auth`.
- Refresh rotation: each refresh generates a new `jti`, stores its hash on the
  user row, and rejects stale refresh tokens.
- Logout clears the refresh-token hash server-side and deletes the cookie.

Future hardening:

- Move access tokens from `localStorage` to memory.
- Add CSRF protection for cookie-bearing auth endpoints.
- Move refresh-token sessions to a dedicated table for multi-device support.
- Add rate limiting and structured audit logging.

## Product Roadmap

Suggested next milestones:

1. Library domain model: books, authors, files, shelves and ownership.
2. User library UI: book grid/list, search, filters and status.
3. Book import: upload EPUB/PDF and extract metadata.
4. Reader shell: table of contents, progress and responsive reading layout.
5. Study tools: highlights, notes and bookmarks.
6. AI study assistant: passage Q&A, summaries and flashcard generation.
7. Reading analytics: streaks, progress and study history.
8. Production packaging: backend/frontend Dockerfiles and reverse proxy.

## Portfolio Notes

This project should demonstrate:

- Clean full-stack architecture.
- Practical authentication and session handling.
- Scalable backend and frontend boundaries.
- Product thinking around digital reading and AI-assisted study.
- A path from a working bootstrap to a real SaaS-style application.

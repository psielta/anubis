# CLAUDE.md

This file is the project handoff for Claude sessions working on Anubis.

## Mission

Build Anubis into a portfolio-quality digital library inspired by BookFusion,
with AI-assisted study workflows. The current repo is a full-stack bootstrap:
FastAPI, PostgreSQL, Angular 21, Angular Material, JWT auth and a protected
dashboard shell.

The next implementation plans should move the product beyond the bootstrap into
a real user library and study experience.

## Required Context

Before planning or implementing, read:

1. `README.md`
2. `AGENT.md`
3. `backend/app/api/v1/endpoints/auth.py`
4. `frontend/anubis-web/src/app/core/services/auth.ts`
5. `frontend/anubis-web/src/app/app.routes.ts`

If a saved plan path is provided by the user, reopen that exact file and use it
as the source of truth.

## Existing Foundation

Backend:

- FastAPI app mounted under `/api/v1`
- async SQLAlchemy sessions with `asyncpg`
- Alembic migrations
- user model with refresh-token `jti` hash
- register, login, refresh, logout and `/users/me`
- pytest auth coverage
- ruff and mypy configured

Frontend:

- Angular 21 standalone app
- Angular Material layout and auth pages
- route guard that bootstraps session through refresh cookie
- auth interceptor for bearer tokens
- error interceptor for 401 refresh/retry
- signal-backed token/user state

Infrastructure:

- Docker Compose PostgreSQL
- local backend on `8000`
- local frontend on `4200`

## Planning Rules

Plans should be implementation-ready and should include:

- affected files
- database migration needs
- API contracts
- frontend routes/components/services
- security and auth implications
- validation commands
- E2E smoke scenario when user-visible

Do not create vague "future improvements" without concrete file-level steps.

## Product Roadmap Priority

Prefer plans that build toward this sequence:

1. Books and library ownership.
2. Book metadata and shelves/collections.
3. Upload/import flow.
4. Reader UI.
5. Highlights, annotations and notes.
6. AI study assistant for selected passages.
7. Summaries, flashcards and study plans.
8. Reading progress and analytics.

For AI features, keep the reading context explicit: book, chapter, location,
selection, highlight or note. Do not design generic chatbot-only flows.

## Security Constraints

Preserve the current auth contract:

- access token is short-lived
- refresh token is httpOnly cookie
- refresh token rotates on use
- stale refresh token reuse is rejected
- logout invalidates server-side refresh state

If proposing production hardening, include:

- CSRF strategy for cookie-bearing endpoints
- rate limiting
- audit logging
- access-token-in-memory option
- multi-device refresh-session table

## Validation Commands

Backend:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
alembic upgrade head
pytest -q
ruff check .
mypy app
```

Frontend:

```powershell
cd frontend/anubis-web
npm run build
```

E2E browser smoke:

- visit `/dashboard` while logged out
- register a new user
- verify duplicate registration error
- login and land on dashboard
- reload and verify user state
- remove `anubis_access` and verify refresh from cookie
- logout and verify refresh returns `401`

## Output Expectations

For review-only tasks:

- stay read-only
- list findings first
- include exact file references
- say clearly whether the implementation is approved or needs revision

For implementation tasks:

- make the code changes
- run relevant validation
- report what changed and what passed
- do not leave dev servers running unless the user asked for them

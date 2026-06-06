# AGENT.md

This file gives coding agents the working context for the Anubis repository.
Follow it when implementing, reviewing or planning changes.

## Project Identity

Anubis is a portfolio project for a BookFusion-inspired digital library. It is
not a BookFusion integration and has no affiliation with BookFusion.

The product direction is a user library and reader application with AI-assisted
study features:

- private user libraries
- book metadata and collections
- reading progress
- reader and study workspace
- highlights, annotations and notes
- AI summaries, Q&A, explanations, study plans and flashcards

Do not frame the app as a generic admin dashboard. The admin/dashboard shell is
only the current bootstrap surface.

## Current Architecture

Backend:

- `backend/app/main.py`: FastAPI app, CORS, router registration and lifespan.
- `backend/app/api/v1/endpoints/`: HTTP endpoints.
- `backend/app/api/deps.py`: shared FastAPI dependencies.
- `backend/app/core/`: config and security.
- `backend/app/db/`: SQLAlchemy async engine/session.
- `backend/app/models/`: SQLAlchemy models.
- `backend/app/schemas/`: Pydantic API schemas.
- `backend/app/crud/`: persistence-oriented data access.
- `backend/alembic/`: database migrations.

Frontend:

- `frontend/anubis-web/src/app/core/`: singleton services, guards,
  interceptors and shared contracts.
- `frontend/anubis-web/src/app/features/`: lazy feature areas.
- `frontend/anubis-web/src/app/layout/`: structural layouts.
- `frontend/anubis-web/src/app/shared/`: reusable stateless UI.

Keep these boundaries. Add a backend `services/` layer when domain workflows
become more than simple CRUD.

## Local Environment

Default local ports:

- PostgreSQL: configured by root `.env`, currently `5433`.
- Backend: `http://localhost:8000`
- Frontend: `http://localhost:4200`

Backend setup:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Frontend setup:

```powershell
cd frontend/anubis-web
npm start
```

Database:

```powershell
docker compose up -d db
docker compose ps
```

## Validation Checklist

Run relevant checks before reporting success:

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

For authentication or routing changes, also run an E2E browser smoke test:

- logged-out dashboard redirects to login
- register works
- duplicate register displays error
- login reaches dashboard
- reload restores user
- deleting access token triggers refresh from cookie
- logout clears session

## Authentication Contract

The current auth model is intentional:

- access token in response body and `localStorage`
- refresh token in httpOnly cookie
- refresh cookie path: `/api/v1/auth`
- refresh rotation through JWT `jti`
- stored refresh value is a hash of the current `jti`
- stale refresh tokens must be rejected
- logout clears server-side refresh state

Do not move refresh tokens into JSON or JavaScript-readable storage.

## Product Implementation Guidance

When adding product features, prefer this order:

1. Database model and migration.
2. Pydantic schemas.
3. CRUD or service layer.
4. Versioned API endpoint.
5. Angular feature folder and route.
6. Focused backend tests.
7. Frontend build and E2E smoke where user-visible.

Use product language consistently:

- library
- books
- shelves or collections
- reader
- progress
- highlights
- annotations
- study notes
- AI study assistant

Avoid generic CRM/admin terminology unless the feature is truly operational.

## Repository Hygiene

- Do not commit `.env`, virtualenvs, caches, `node_modules`, build output,
  Playwright MCP output, terminal logs or cookie files.
- Preserve the existing architecture and naming style.
- Keep changes scoped to the requested feature.
- Update README/AGENT/CLAUDE when the product direction or workflow changes.

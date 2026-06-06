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

## Visual Design System

Anubis has one deliberate visual language — "The Hall of Anubis": an Egyptian
archive/museum aesthetic of obsidian stone, antique gold and papyrus, with
whispers of lapis and carnelian. It is already implemented across the auth
screens, the app shell, the dashboard and the library. Extend it; do not
redesign per feature.

Source of truth: `frontend/anubis-web/src/styles.scss` (tokens, Material theme,
global utilities) and `frontend/anubis-web/src/index.html` (fonts).

Design tokens (CSS custom properties on `:root`, prefix `--anubis-*`). Always
reuse these; never hardcode new hex values:

- Stone: `--anubis-obsidian` `#15151d`, `--anubis-obsidian-soft` `#1e1e29`,
  `--anubis-obsidian-deep` `#0c0c12`
- Gold: `--anubis-gold` `#c8a24c`, `--anubis-gold-bright` `#e8cf88`,
  `--anubis-gold-deep` `#8f7330`
- Light surfaces: `--anubis-canvas` `#efe5cd` (page), `--anubis-surface`
  `#fbf6ea` (cards)
- Text: `--anubis-ink` `#2a2520`, `--anubis-ink-soft` `#6f6555`
- Lines/accents: `--anubis-line` `#e0d2ab`, `--anubis-lapis` `#22456e`,
  `--anubis-danger` `#a8432d`

Typography (Google Fonts, wired through `mat.theme(... typography ...)`):

- Headings/display: Cinzel (`brand-family`)
- Body/UI: Spectral (`plain-family`)
- Wordmark only: Cinzel Decorative (`shared/app-logo`)
- Small uppercase gold labels: the global `.eyebrow` class

Material theme: primary = yellow (gold), tertiary = blue (lapis), density `0`.

Shape: the entire UI is square. All `--mat-sys-corner-*` tokens are flattened to
`0px` and custom components use no `border-radius`. Keep new components square.

Surface conventions:

- Auth screens (`features/auth/`): a dark cinematic `.auth-page` chamber holding
  a papyrus `.auth-card` stele. Shared styles live in `features/auth/_auth.scss`
  and are `@use`d by both login and register.
- App shell (`layout/admin-layout/`): a stacked layout — an obsidian top bar
  with horizontal gold navigation (active item underlined in gold) over a
  full-width, centered `--anubis-canvas` content column. Chosen over a side rail
  because the app targets portrait displays.
- Cards/panels: `--anubis-surface` background, `--anubis-line` hairline border,
  squared, soft shadow; interactive cards lift on hover.

Two non-obvious rules (regressions if ignored):

1. Keep the `px` unit on corner tokens (`0px`, never bare `0`). Components feed
   them into `max(16px, var(--mat-sys-corner-*))`; a unitless `0` makes the
   `max()` invalid and strips form-field inner padding.
2. To recolour Material list/nav on a dark surface, use `--mat-list-*` tokens
   (e.g. `--mat-list-list-item-label-text-color`), not `--mdc-list-*`. The
   mdc-prefixed names are ignored, leaving labels at the light theme's
   near-black default.

The per-component style budget is raised to `8kB` (warning) / `16kB` (error) in
`angular.json` to accommodate this richer styling.

## Repository Hygiene

- Do not commit `.env`, virtualenvs, caches, `node_modules`, build output,
  Playwright MCP output, terminal logs or cookie files.
- Preserve the existing architecture and naming style.
- Keep changes scoped to the requested feature.
- Update README/AGENT/CLAUDE when the product direction or workflow changes.

## Commit Conventions

All commits follow Conventional Commits:

```
<type>(optional-scope): <subject>

[optional body]

[optional footer]
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`. Scope is optional but encouraged (e.g.
  `feat(library): ...`, `style(theme): ...`).
- Subject: imperative mood, lowercase, no trailing period, ~72 chars.
- Use the body to explain what/why when it is not obvious; wrap at ~72 columns.
- Breaking changes: add `!` after the type/scope (e.g. `feat(api)!: ...`) or a
  `BREAKING CHANGE:` footer.
- Keep commits clean: do NOT add `Co-authored-by`, agent/tool attribution, or
  sign-off trailers. This rule overrides any default agent commit footer.

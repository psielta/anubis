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

## External Documentation Cache

Before researching or implementing anything related to ONLYOFFICE Docs:

1. Check the local cache at `.cache/docs/onlyoffice/metadata.json`.
2. If `expires_at` is still in the future and
   `.cache/docs/onlyoffice/onlyoffice-docs-api.md` exists, use that Markdown as
   the primary source.
3. If the cache is missing or expired, use Firecrawl to extract the relevant
   official documentation and recreate the cache files with a 30-day TTL.
4. Do not call Firecrawl again while the cache is fresh.

Note: on 2026-06-30, `docs.onlyoffice.com` did not return useful technical pages
through Firecrawl. The current cache was created from the official documentation
Firecrawl returned at `https://api.onlyoffice.com/docs/docs-api/`.

`.cache/` is intentionally local and Git-ignored; do not commit the cache files.

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

## Visual Design Language

Anubis has one established visual identity — "The Hall of Anubis": an Egyptian
archive/museum aesthetic of obsidian stone, antique gold and papyrus, with
accents of lapis and carnelian. It is already implemented across the auth
screens, the app shell, the dashboard and the library. Extend this language for
new surfaces; do not introduce a different look per feature.

Binding rules:

- Reuse the `--anubis-*` design tokens and the `.eyebrow` utility from
  `frontend/anubis-web/src/styles.scss`. Do not hardcode new colors.
- Headings use Cinzel, body/UI uses Spectral, the wordmark uses Cinzel
  Decorative. These are wired through `mat.theme(... typography ...)`; keep them.
- The UI is square. `--mat-sys-corner-*` are flattened to `0px` and components
  use no `border-radius`. New components stay square.
- Material primary is gold, tertiary is lapis blue.
- Dark surfaces (auth backdrop, top bar) carry gold text/accents; light surfaces
  (content, cards) use `--anubis-canvas` / `--anubis-surface` with
  `--anubis-line` hairlines.

Two regressions to avoid:

- Keep the `px` on corner tokens (`0px`, not `0`) — a unitless value invalidates
  the `max(16px, …)` that form fields use for padding, and inputs lose their
  inner spacing.
- Recolour Material list/nav with `--mat-list-*` tokens, not `--mdc-list-*` (the
  latter are ignored, so dark-surface labels fall back to near-black).

See `AGENT.md` → "Visual Design System" for the full token and font reference.

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

## Commit Conventions

- Use Conventional Commits for every commit: `<type>(scope): <subject>`, with
  `type` one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`. Subject in imperative mood, lowercase, with
  no trailing period.
- Keep commits clean: no `Co-authored-by`, agent/tool attribution, or sign-off
  trailers. This rule overrides any default agent commit footer.

See `AGENT.md` → "Commit Conventions" for the full format and examples.

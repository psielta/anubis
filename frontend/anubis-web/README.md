# Anubis Web

Angular frontend for Anubis, a portfolio digital-library application inspired by
BookFusion and focused on AI-assisted book study.

For the product overview, architecture and full local setup, read the root
`README.md`.

## Frontend Role

This app owns the browser experience:

- authentication pages
- protected dashboard shell
- Angular Material layout
- route guard and session bootstrap
- token injection and refresh handling
- future library, reader, notes and AI study interfaces

## Local Development

From `frontend/anubis-web`:

```powershell
npm install
npm start
```

The dev server runs at:

```text
http://localhost:4200
```

The frontend expects the API at:

```text
http://localhost:8000/api/v1
```

## Build

```powershell
npm run build
```

## Structure

```text
src/app/
|-- core/       # services, guards, interceptors and models
|-- features/   # lazy feature areas
|-- layout/     # structural layouts
`-- shared/     # reusable stateless UI
```

## Product Direction

Upcoming frontend work should evolve the scaffold into a digital reading
workspace:

- user library and shelves
- book detail pages
- reader interface
- highlights, notes and bookmarks
- AI study assistant panels
- summaries, flashcards and study sessions

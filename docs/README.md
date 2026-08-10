# Docs Router — X Ripper
Purpose: index of every doc under `docs/`; tells an agent which doc to open for a task.
Scope: navigation only — one line per doc, grouped by system area; no content lives here.
Entry points: the docs listed below; each opens with a 7-line header (`head -7` summarizes it).
Related: `AGENTS.md` (agent rules)
Last-verified: 2026-08-10 — verified against current main
Status: current

## How to use

Scan the index for the system area you are touching, open that doc, and read its 7-line header first. If you add a doc, add a line here. If you make a listed doc stale, update it and re-stamp its `Last-verified`.

## Index

### Capture and extraction

- `docs/specs/2026-08-10-01-graphql-interceptor.md` — passive GraphQL capture spec: architecture, verified x.com schema paths, Markdown mapping, capture-source stats; read before touching `src/interceptor.js`, the capture store in `src/content.js`, or the harness assertions — Last-verified: 2026-08-10
- `docs/plans/2026-08-10-01-graphql-interceptor.md` — implementation plan for the interceptor upgrade and its support items (fixtures, popup progress, CI, docs, lessons ingest); read to see slice status and proof gates — Last-verified: 2026-08-10

### Process

- `docs/lessons.md` — append-only session feedback log; read when ingesting lessons or reviewing recurring friction — Last-verified: 2026-08-10

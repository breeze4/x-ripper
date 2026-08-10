# Lessons
Purpose: Append-only session feedback log; the ingest-lessons skill reads and stamps entries here.
Scope: Workflow lessons from sessions in this project; read when ingesting lessons or reviewing recurring friction.
Entry points: `src/content.js`, `src/popup/popup.js`
Related: none — no docs router yet
Last-verified: 2026-08-10 — verified against working tree
Status: current

### 2026-08-10 — worked-well — Verify X DOM behavior live before coding the scraper change
Context: feature session — expand "Show more" pseudo links before ripping a thread
Clicking a live thread's "Show more" buttons via agent-browser proved inline expansion (no navigation) in minutes, and a parallel web-researcher pass over scraper codebases confirmed the same for the logged-in DOM (`tweet-text-show-more-link` is a button; anchor-guard before click is the standard safety pattern). The two independent checks agreed and de-risked the design.

### 2026-08-10 — friction — No logged-in x.com session available for DOM verification
Context: feature session — expand "Show more" pseudo links before ripping a thread
Logged-out x.com serves a different bundle with all `data-testid` attributes stripped, so the extension's primary selectors cannot be exercised without a login. Logged-in verification had to rely on third-party scraper source code instead of direct inspection.
Proposed fix: log in to x.com once in agent-browser and `agent-browser state save x-auth.json` so future sessions can test the logged-in DOM.

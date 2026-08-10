# Lessons
Purpose: Append-only session feedback log; the ingest-lessons skill reads and stamps entries here.
Scope: Workflow lessons from sessions in this project; read when ingesting lessons or reviewing recurring friction.
Entry points: `src/content.js`, `src/popup/popup.js`
Related: `docs/README.md` (router)
Last-verified: 2026-08-10 — verified against working tree
Status: current

### 2026-08-10 — worked-well — Verify X DOM behavior live before coding the scraper change
Context: feature session — expand "Show more" pseudo links before ripping a thread
Clicking a live thread's "Show more" buttons via agent-browser proved inline expansion (no navigation) in minutes, and a parallel web-researcher pass over scraper codebases confirmed the same for the logged-in DOM (`tweet-text-show-more-link` is a button; anchor-guard before click is the standard safety pattern). The two independent checks agreed and de-risked the design.

### 2026-08-10 — correction — Expand-then-read-once dropped the tail of a long thread
Context: feature session — expand "Show more" pseudo links before ripping a thread
First shipped version clicked expanders and then read the DOM once; the user's 20-post rip captured only 14 because X inserts cursor-loaded posts below the viewport and virtualizes off-screen rows out of the DOM. The fix is the pattern the research had already flagged as best practice: harvest rendered posts on every pass of a scroll-and-expand sweep, keyed by status ID, then sort by timestamp. Treat "scrape incrementally" advice from prior art as a requirement, not an option, when a virtualized list is involved.

### 2026-08-10 — worked-well — Canonical prior rips as live smoke fixtures
Context: cleanup session — scenario smoke tests and pre-commit wiring
Fixture URLs mined from the frontmatter `source:` lines of already-ripped inbox files gave one proven fixture per artifact kind (thread, thread with media, article, single post), each with a known-good expected shape. Restoring the stripped `data-testid` markers via a decoration script lets the logged-in extraction paths run against the logged-out bundle.

### 2026-08-10 — worked-well — Prototype the interceptor as a harness init script before writing the spec
Context: feature session — passive GraphQL interception
A 60-line recorder registered via `agent-browser --init-script` answered every design question live before any extension code existed: logged-out x.com makes zero GraphQL requests (data ships embedded in HTML), logged-in `TweetDetail` carries note_tweet/quoted/video with stable paths, and init scripts compose with `state load`. The spec's verified-facts section came straight from this, and the same init-script mechanism became the harness wiring.

### 2026-08-10 — correction — Web-sourced fixture candidates must be verified live before they enter scenarios.json
Context: feature session — new smoke fixtures (40+ thread, quote thread)
The web researcher's famous-thread candidates (Foone) all died on live check — the account is protected, every status URL tombstones — and the researcher itself caught WebFetch's summarizer hallucinating status IDs (only IDs present verbatim in indexed URLs were trustworthy). The usable mega-thread came from searching X directly (live-trial reporters like @innercitypress self-thread 80+ posts) and reading `conversation_id_str` from captured traffic to find the root. Treat web-found fixture URLs as leads, never as fixtures, until a live rip confirms them.

### 2026-08-10 — worked-well — Contract-pinned parallel coding agents on disjoint file sets
Context: feature session — passive GraphQL interception
Two affordable-model agents implemented extension core and harness/CI in parallel with zero merge friction because the briefs pinned the exact interfaces up front (stat field names, scenario override shape, file ownership, "IIFE last line stays `})();`") and reserved integration verification for the orchestrating session. Review still earned its keep: it caught the quote-permalink strip missing the expanded-URL form and media t.co links leaking into text — both invisible to static checks, both found by ripping a live quote+video post.

### 2026-08-10 — friction — No logged-in x.com session available for DOM verification
Context: feature session — expand "Show more" pseudo links before ripping a thread
Logged-out x.com serves a different bundle with all `data-testid` attributes stripped, so the extension's primary selectors cannot be exercised without a login. Logged-in verification had to rely on third-party scraper source code instead of direct inspection.
Proposed fix: log in to x.com once in agent-browser and `agent-browser state save x-auth.json` so future sessions can test the logged-in DOM.
Ingested: 2026-08-10 — resolved directly: `~/.agent-browser/x-auth.json` saved (cookies hand-carried from the user's normal browser after X's login flow blocked the automated one); `tools/smoke-test` consumes it via `XR_AUTH_STATE`.

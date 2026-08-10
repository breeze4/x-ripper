# AGENTS.md — X Ripper

Chrome extension (Manifest V3) that saves the current X article, post, or same-author thread as Markdown. Source lives in `src/`; there is no build step — load `src/` unpacked at `chrome://extensions`. `src/content.js` does all extraction; `src/popup/` is the UI.

## Docs

The docs router is `docs/README.md` — consult it before searching, and read a doc's `head -7` header to confirm relevance. When a change makes a router-listed doc stale, update that doc in the same unit of work and re-stamp its `Last-verified` date; new docs get the 7-line header and a router line.

<!-- APPEND POINT: tools -->
## Tools

Before re-deriving a multi-step command, check `tools/README.md` for an existing script and run it with `--help`. When you run the same multi-step operation a second time, extract it to an executable `tools/<name>` script — validates args, non-zero exit on failure, `--help` usage, secrets from env not inline, `--dry-run` for anything destructive — and add its row to `tools/README.md`.

Run `tools/smoke-test` after any change to `src/content.js` — it rips the canonical live fixtures in `tools/scenarios.json` and fails on extraction regressions. The pre-commit hook runs it automatically (`SKIP_SMOKE=1 git commit ...` to bypass in an emergency). If the hook does not fire, re-wire it with `git config core.hooksPath tools/githooks`.

<!-- APPEND POINT: lessons -->
## Lessons-derived rules

- Verify x.com facts live before they land: any claim about X's DOM, GraphQL schema, or a fixture URL must be confirmed first-hand via agent-browser (logged-out and, when it matters, logged-in via `XR_AUTH_STATE`) before it enters `src/`, `tools/scenarios.json`, or a spec. Web-search results, scraper codebases, and AI-summarized pages are leads, not evidence — status IDs only count when read from a literal URL or live capture, and a fixture URL enters `scenarios.json` only after a live rip has produced the observed values its thresholds are set from.

<!-- APPEND POINT: lint -->

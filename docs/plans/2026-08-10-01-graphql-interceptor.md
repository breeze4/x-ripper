# Plan: GraphQL Interception Upgrade + Support Items
Purpose: Implementation plan for the passive GraphQL capture spec plus the five support items and the proof gates.
Scope: Everything in the goal — interceptor, fixtures, popup progress, docs router, CI workflow, lessons ingest; excludes the goal's out-of-scope list.
Entry points: `docs/specs/2026-08-10-01-graphql-interceptor.md` (the spec this plan implements)
Related: `docs/lessons.md`
Last-verified: 2026-08-10 — written after live schema verification, before implementation
Status: current

## Slices

- [x] 1. Interceptor core: `src/interceptor.js` (MAIN world, document_start, manifest entry), bounded buffer + replay, capture store and generic tweet-result walker in `src/content.js`, thread entries built from the store with per-entry source, `captureSource`/`sourceCounts` in stats. Smoke logged-out still passes (all `dom`).
- [x] 2. Harness wiring: `tools/smoke-test` registers the interceptor as an init script; `tools/browser/assert.js` learns the `loggedIn` scenario override (thresholds + expected `captureSource`); existing thread scenarios gain `loggedIn.captureSource: "graphql"`. Logged-in smoke shows `graphql` for both existing thread fixtures.
- [x] 3. Payoff rendering: `note_tweet` full text with t.co expansion, quoted posts as attributed blockquotes (permalink t.co stripped, media t.co links dropped), video as labeled post-URL + MP4 link + thumbnail; `quotedCount`/`videoCount` stats. Demonstrated live on a quote+video post (graphql source).
- [x] 4. New fixtures: verified live in both modes — `thread-mega` (SBF sentencing live thread, 82 same-author posts; Foone candidates dead: protected account) and `thread-quote` (conspirator0, one self-quote) — thresholds set from observed values; `minQuoted` guards the blockquote payoff under `loggedIn`; post scenarios pin `captureSource: "dom"` (longform by design).
- [x] 5. Popup live progress: harvest-round progress messages from `src/content.js`, "Captured N posts…" in `src/popup/popup.js`; user manually rips the mega-thread in Chrome and confirms the live count in chat. (Code done; user confirmation pending.)
- [ ] 6. CI: `.github/workflows/ci.yml` running `node --check` on every `.js` under `src/` and `tools/`, plus `shellcheck` on `tools/smoke-test` and `tools/githooks/*`; push and confirm green via `gh run list`. (Workflow written; push + green run pending.)
- [x] 7. Docs router: `docs/README.md` per the project-docs conventions, one row per doc in `docs/` (spec, this plan, lessons); `tools/README.md` and root `README.md` updated where behavior changed.
- [ ] 8. Lessons ingest: run the ingest-lessons pass over the un-stamped `docs/lessons.md` entries, apply what the user approves, stamp every backlog entry `Ingested:`; append this session's lessons.
- [ ] 9. Final proof in conversation: logged-out smoke output, logged-in smoke output with `graphql` thread sources, `gh run list` green for the final commit, `git log --oneline` showing work pushed to origin/main, user's popup confirmation.

## Decisions already made

- Longform Articles stay DOM-sourced (fragile rich-text schema; DOM extractor already good).
- `captureSource` is the majority source across entries; `sourceCounts` published alongside for transparency.
- The generic walker parses every GraphQL response body rather than allow-listing operation names — stable across renames, and the keyed store dedupes.
- Logged-out passes stay `dom` by design: verified that logged-out x.com makes zero GraphQL requests.

## Execution note

Code-writing slices run on an affordable model (Sonnet subagents) with the stats/scenario contracts fixed in their briefs; spec, review, live verification, and proof gates stay with the orchestrating session.

## Done when

All proof gates in slice 9 are shown in the conversation — or a gate fails and the failing output is reported with no further changes attempted.

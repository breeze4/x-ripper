# Passive GraphQL Interception for X Ripper
Purpose: Specify how the extension captures X's own GraphQL responses and builds rips from them, with the DOM sweep as automatic fallback.
Scope: Capture architecture, response-to-Markdown mapping, capture-source stats, harness/fixture changes, popup progress; excludes active fetching, i18n, options page, packaging, batch ripping.
Entry points: `src/interceptor.js` (planned), `src/content.js`, `src/manifest.json`, `tools/smoke-test`
Related: `docs/plans/2026-08-10-01-graphql-interceptor.md`, `docs/lessons.md`
Last-verified: 2026-08-10 — all schema facts verified live on x.com (logged-out and logged-in)
Status: current

## Why

The DOM sweep loses data the page never renders fully: truncated long posts need "Show more" clicks, quoted posts flatten into unattributed text, videos survive only as thumbnails, and X's timeline virtualization can unmount posts before harvest. X's own GraphQL responses carry all of it, untruncated and structured. The extension copies those responses passively — it never sends a request to X itself.

## Verified facts (2026-08-10, live)

- Logged-out x.com makes zero GraphQL requests for conversation pages. The full conversation ships embedded in the page HTML and hydrates on scroll (24 articles rendered with an empty resource log). Passive capture therefore has nothing to intercept logged-out; the DOM sweep remains the only path there.
- Logged-in conversation pages fetch `TweetDetail` (~160 KB for a 23-post thread) on load, and further `TweetDetail` pages as the user scrolls. The sweep's existing scroll loop is what triggers those cursor fetches.
- Response shape: `data.threaded_conversation_with_injections_v2.instructions[]` → entries of kinds `tweet`, `conversationthread` (posts under `content.items[].item.itemContent`), `cursor`. Tweet results sit at `itemContent.tweet_results.result`, sometimes wrapped in `TweetWithVisibilityResults` (unwrap via `.tweet`).
- Per tweet result: `rest_id`; author at `core.user_results.result` (`core.screen_name` or `legacy.screen_name`, plus display name); `legacy.full_text`, `legacy.created_at`, `legacy.entities.urls[]` (`url` = t.co, `expanded_url` = real); `legacy.extended_entities.media[]`.
- Untruncated long posts: `note_tweet.note_tweet_results.result.text` holds the full text (verified 308 chars where `legacy.full_text` was truncated); `entity_set.urls` expands its t.co links.
- Quoted posts: `quoted_status_result.result` is a full tweet result (own author, text, media); `quoted_status_permalink.url` is the trailing t.co in the quoting post's text — strip it when rendering the blockquote.
- Video: media `type` is `video` or `animated_gif`; `expanded_url` is the post's `/video/1` URL; `video_info.variants[]` holds direct MP4 URLs with bitrates; `video_info.duration_millis` present. Thumbnail at `media_url_https`.
- `agent-browser --init-script <path>` registers a page script that runs before every navigation in the session, and it composes with `state load` (verified: the recorder captured `TweetDetail` after auth-state load). This is the harness equivalent of the extension's MAIN-world script.
- Other operations (`SearchTimeline`, `TweetResultByRestId`, `UserTweets`) embed the same tweet-result objects at different paths. A generic walker that finds tweet results anywhere in a response is stable across all of them and across operation renames.

## Ubiquitous language

- Interceptor: the MAIN-world script that copies GraphQL response bodies.
- Capture store: the content script's map of normalized posts, keyed by status ID.
- Capture source: where a rip entry's content came from — `graphql` or `dom`.
- Replay: the interceptor re-emitting buffered captures when the content script asks.

## Architecture

1. `src/interceptor.js` runs in the MAIN world at `document_start` (declared in the manifest, Chrome ≥ 111). It wraps `window.fetch` and `XMLHttpRequest` transparently: the page's promise/stream is returned untouched; a clone of any response whose URL contains `/i/api/graphql/` is read as text. Zero extension-initiated requests to X; the interceptor only observes.
2. Each captured body is posted to the page via `window.postMessage` under a namespaced type, and also held in a bounded FIFO buffer (capped by total bytes). The content script runs at `document_idle`, so captures from the initial page load land before its listener exists — on startup it posts a replay request and the interceptor re-emits the buffer.
3. `src/content.js` (ISOLATED world) listens with an origin check, parses each body with the generic tweet-result walker, and normalizes every tweet found into the capture store: status ID, author name and handle, ISO timestamp, full text (`note_tweet` text preferred over `legacy.full_text`, t.co links expanded), quoted post (recursively normalized, one level), media list (photos as image URLs, videos as post URL + MP4 variant + thumbnail), conversation ID.
4. At rip time the sweep runs exactly as today — the scroll loop both harvests the DOM and triggers X's own cursor fetches. For each harvested post whose status ID is in the capture store, the entry is built from the store (source `graphql`); otherwise from the DOM as today (source `dom`). After the sweep, store-only posts that belong to the same conversation, same author, and are not earlier than the focal post are merged in — this recovers posts virtualization unmounted before harvest.
5. Longform X Articles (`longformRichTextComponent`) keep the DOM path by design: their Draft.js rich-text GraphQL structure is a fragile mapping, and the DOM extractor already handles headings, lists, code, and embeds well. Their capture source is `dom`.

## Markdown mapping (graphql-sourced entries)

- Text: full untruncated text, t.co links replaced by expanded URLs, no "Show more" residue.
- Quoted post: an attributed blockquote in the existing embedded-post style — an intro line `Quoted post - <name> @<handle> - <status URL>:` followed by `> `-prefixed text lines and `> `-prefixed image lines. The quoting post's trailing permalink t.co is stripped.
- Video: a labeled link line naming the post video URL (`expanded_url`) and the highest-bitrate MP4 variant, plus the thumbnail as a regular image after it. Never a bare thumbnail alone.
- Photos: unchanged (`pbs.twimg.com` large variant), so image embedding in the popup keeps working.

## Stats and capture source

`stats` gains: `captureSource` (`graphql` if more than half the entries were graphql-sourced, else `dom`), `sourceCounts` (`{graphql, dom}`), `quotedCount`, `videoCount`. Existing fields keep their meaning. Logged-out rips always report `dom`; logged-in thread rips report `graphql`.

## Popup progress

During the sweep the content script sends a fire-and-forget progress message (captured-post count) after each harvest round; the popup listens while open and shows "Captured N posts…". Messaging failures are swallowed — the harness shim and a closed popup both make delivery impossible, and the rip must not care.

## Harness and fixtures

- `tools/smoke-test` registers `src/interceptor.js` as an agent-browser init script, so captures start at document start exactly as in the real extension.
- `tools/scenarios.json` gains two fixtures: a same-author thread of 40+ posts (`thread-mega`) and a thread containing a quote tweet (`thread-quote`). Thresholds come from observed rips in both modes.
- Scenarios support a `loggedIn` override object (thresholds and expected `captureSource`) that `tools/browser/assert.js` merges when `XR_AUTH_STATE` is set. Logged-out keeps base thresholds and never asserts a graphql source.
- New optional assertions: `minQuoted`, `minVideos` against the new stats, so the quoted/video payoffs are regression-guarded, not one-off demos.

## Risks

- X schema drift: mitigated by the generic walker, the DOM fallback, and live smoke fixtures — a drift shows up as a `captureSource` regression, not a broken rip.
- Interceptor breaking x.com: the wrap returns the original response object untouched and swallows its own errors.
- Forged page messages: origin plus source-window check; worst case is junk in the capture store, and the DOM fallback still stands.
- 40+ post fixture logged-out: X may wall or shorten long logged-out conversations; per-mode thresholds absorb the difference.

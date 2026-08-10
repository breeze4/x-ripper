# X Ripper

Chrome extension for saving the current X article, post, or same-author thread as a Markdown file.

## Install locally

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this repository's `src/` folder.

## Use

1. Open an `x.com` or `twitter.com` article/status page.
2. Click the X Ripper extension button.
3. Click Save Markdown.
4. Choose where to save the generated `.md` file.

The export includes page metadata, readable text, and Markdown image embeds for visible X media. By default, the extension fetches visible X media and writes it into the Markdown as data URIs so the file is self-contained. If an image cannot be fetched, that image remains a normal Markdown image reference to the original X media URL.

The extension passively copies the GraphQL responses x.com itself fetches (a MAIN-world script wraps `fetch`/XHR; it never sends a request of its own). When a post's data was captured this way, the rip builds from it instead of the rendered DOM: full untruncated text without clicking "Show more", quoted posts as attributed blockquotes, and videos as a labeled post/MP4 link plus thumbnail. When no capture exists — logged-out x.com makes no GraphQL requests at all — the DOM extraction below runs unchanged as the automatic fallback. The popup reports which source produced the rip (`Source: graphql` or `Source: dom`).

For same-author threads, the extension sweeps the conversation instead of reading the page once. Each pass clicks the safe "Show more" controls above the reply section (truncated long posts and, on long threads, the "Show replies" continuation cells), waits for X to finish loading, captures the author's posts that are currently rendered, and scrolls down to render more. It repeats until it reaches the first reply from a different author, then sorts the captured posts by timestamp and restores your scroll position. This per-pass capture is necessary because X unmounts off-screen posts, so a single read at the end can miss the tail of a long thread; posts that were captured from GraphQL but never rendered get merged back in afterward. It never clicks real links, so it cannot navigate away from the page. The popup shows a live captured-post count while the sweep runs and reports how many controls it expanded.

## Develop

Run `tools/smoke-test` after changing `src/content.js`. It rips one canonical live fixture per artifact kind (long thread, thread with media, article, single post — see `tools/scenarios.json`) in a logged-out browser and asserts the extraction still works. The pre-commit hook runs it on every commit; bypass with `SKIP_SMOKE=1` if you must. If hooks are not firing, run `git config core.hooksPath tools/githooks` once.

## Current limits

- X changes its DOM often, so extraction is intentionally selector-light and may need tuning for specific layouts.
- GraphQL capture only has material when logged in; logged-out pages embed their data in the HTML, so those rips are always DOM-sourced.
- Videos get a labeled post/MP4 link only when their post was captured from GraphQL; DOM-sourced rips still save the visible thumbnail only.
- Longform X Articles are always DOM-sourced by design (their rich-text GraphQL structure is a fragile mapping the DOM extractor already handles well).
- Large posts can produce large Markdown files when image data embedding is enabled.
- "Show more"/"Show replies" detection uses the `tweet-text-show-more-link` test id plus exact English text matches, so non-English X interface languages only get the test-id path.
- The thread sweep scrolls the page while it works (it restores your position when done) and stops after 30 seconds on pathologically long threads.
- Promoted posts are skipped by their visible "Ad" label, which is English-only.

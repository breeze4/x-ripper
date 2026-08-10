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

Before extraction, the extension expands collapsed content in the thread. It clicks each safe "Show more" control (truncated long posts and inline thread-continuation cells), waits for the new content, and repeats until no more controls appear or a 20-second limit is reached. It never clicks real links, so it cannot navigate away from the page. The popup reports how many controls it expanded.

## Current limits

- X changes its DOM often, so extraction is intentionally selector-light and may need tuning for specific layouts.
- Videos are saved as visible thumbnail images only.
- Large posts can produce large Markdown files when image data embedding is enabled.
- "Show more" detection uses the `tweet-text-show-more-link` test id plus an exact "Show more" text match, so non-English X interface languages only get the test-id path.
- Very long threads can still lose off-screen posts if X removes them from the DOM; the extension rips what is present after expansion.

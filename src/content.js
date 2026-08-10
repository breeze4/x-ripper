(function initializeXRipperContentScript() {
  if (window.__XRipperContentLoaded) {
    return;
  }

  window.__XRipperContentLoaded = true;

  const captureStore = new Map();

  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window || event.origin !== location.origin) {
        return;
      }

      if (event.data?.type === "XRIPPER_GQL" && typeof event.data.body === "string") {
        ingestGqlBody(event.data.body);
      }
    } catch {
      // Never let a malformed message break the content script.
    }
  });

  try {
    window.postMessage({ type: "XRIPPER_GQL_REPLAY_REQUEST" }, location.origin);
  } catch {
    // The interceptor may not be present (e.g. this harness); DOM fallback covers it.
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "XRIPPER_EXTRACT_MARKDOWN") {
      return false;
    }

    (async () => {
      try {
        sendResponse({ ok: true, ...(await ripPage()) });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();

    return true;
  });

  // Capture store: normalizes X's own GraphQL responses (relayed by
  // src/interceptor.js) into posts keyed by status ID, so the sweep can
  // prefer untruncated, structured data over the rendered DOM.
  function ingestGqlBody(bodyText) {
    let payload;

    try {
      payload = JSON.parse(bodyText);
    } catch {
      return;
    }

    const found = [];

    try {
      walkForTweetResults(payload, found);
    } catch {
      return;
    }

    for (const tweetResult of found) {
      try {
        const record = normalizeTweetResult(tweetResult, 0);

        if (record?.statusId) {
          captureStore.set(record.statusId, record);
        }
      } catch {
        // Skip malformed tweet results; the DOM fallback still covers them.
      }
    }
  }

  // Any object anywhere in the response tree with a string rest_id and a
  // legacy object exposing full_text is a tweet result, whatever operation or
  // nesting produced it. This is stable across X schema/operation renames.
  function walkForTweetResults(node, out) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walkForTweetResults(item, out);
      }
      return;
    }

    const candidate = unwrapTweetVisibility(node);

    if (isTweetResult(candidate)) {
      out.push(candidate);
    }

    for (const key of Object.keys(node)) {
      walkForTweetResults(node[key], out);
    }
  }

  function unwrapTweetVisibility(node) {
    if (node?.__typename === "TweetWithVisibilityResults" && node.tweet && typeof node.tweet === "object") {
      return node.tweet;
    }

    return node;
  }

  function isTweetResult(node) {
    return Boolean(node) && typeof node.rest_id === "string" && node.legacy && typeof node.legacy === "object" && node.legacy.full_text !== undefined;
  }

  // depth 0 is a top-level capture; depth 1 is a quoted post, which never
  // carries its own quoted post (one level of nesting only).
  function normalizeTweetResult(tweetResult, depth) {
    if (!tweetResult || typeof tweetResult !== "object") {
      return null;
    }

    const statusId = String(tweetResult.rest_id || "");
    const legacy = tweetResult.legacy || {};
    const user = tweetResult.core?.user_results?.result || null;
    const screenName = user?.core?.screen_name || user?.legacy?.screen_name || "";
    const authorName = user?.core?.name || user?.legacy?.name || "";
    const record = {
      statusId,
      handle: screenName ? `@${screenName}` : "",
      author: authorName,
      published: normalizeCreatedAt(legacy.created_at),
      conversationId: legacy.conversation_id_str || "",
      text: extractTweetText(tweetResult, legacy),
      media: extractMedia(legacy),
      quoted: null,
      sourceUrl: screenName && statusId ? `https://x.com/${screenName}/status/${statusId}` : ""
    };

    const quotedResult = depth === 0 ? tweetResult.quoted_status_result?.result : null;

    if (quotedResult) {
      record.quoted = normalizeTweetResult(unwrapTweetVisibility(quotedResult), 1);
    }

    return record;
  }

  function normalizeCreatedAt(createdAt) {
    try {
      return new Date(createdAt).toISOString();
    } catch {
      return "";
    }
  }

  function extractTweetText(tweetResult, legacy) {
    const noteResult = tweetResult.note_tweet?.note_tweet_results?.result;
    let text = typeof noteResult?.text === "string" ? noteResult.text : legacy.full_text || "";

    const urlEntities = [...(noteResult?.entity_set?.urls || []), ...(legacy.entities?.urls || [])];

    for (const entity of urlEntities) {
      if (entity?.url && entity.expanded_url) {
        text = text.split(entity.url).join(entity.expanded_url);
      }
    }

    // Media t.co links live in entities.media (not entities.urls), so the
    // expansion above never rewrites them; drop them since media renders
    // as explicit blocks/images instead.
    for (const mediaItem of legacy.extended_entities?.media || []) {
      if (mediaItem?.url) {
        text = text.split(mediaItem.url).join("");
      }
    }

    // The quote permalink can survive as either the raw t.co or, after the
    // entity expansion above, its expanded form — strip whichever trails.
    for (const permalinkUrl of [tweetResult.quoted_status_permalink?.url, tweetResult.quoted_status_permalink?.expanded]) {
      if (permalinkUrl && text.trim().endsWith(permalinkUrl)) {
        text = text.trim().slice(0, text.trim().length - permalinkUrl.length);
      }
    }

    return text.trim();
  }

  function extractMedia(legacy) {
    const items = legacy.extended_entities?.media || [];
    const media = [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      if (item.type === "photo") {
        media.push({
          kind: "photo",
          src: normalizeImageUrl(item.media_url_https || ""),
          alt: item.ext_alt_text || ""
        });
        continue;
      }

      if (item.type === "video" || item.type === "animated_gif") {
        media.push({
          kind: "video",
          postUrl: item.expanded_url || "",
          mp4: highestBitrateMp4(item.video_info),
          thumb: item.media_url_https || "",
          durationMs: item.video_info?.duration_millis
        });
      }
    }

    return media;
  }

  function highestBitrateMp4(videoInfo) {
    const variants = videoInfo?.variants || [];
    let best = null;

    for (const variant of variants) {
      if (variant?.content_type !== "video/mp4") {
        continue;
      }

      if (!best || (variant.bitrate || 0) > (best.bitrate || 0)) {
        best = variant;
      }
    }

    return best?.url || "";
  }

  // Converts a capture-store record into the same entry shape extractEntry
  // produces from the DOM, so the rest of the pipeline (sort, buildMarkdown,
  // stats) treats graphql- and dom-sourced entries identically.
  function buildEntryFromRecord(record, index) {
    const blocks = splitIntoBlocks(record.text);

    if (record.quoted) {
      blocks.push(buildQuotedBlock(record.quoted));
    }

    const images = [];
    let videoCount = 0;

    for (const media of record.media) {
      if (media.kind === "photo") {
        images.push({ alt: media.alt || "", src: media.src });
        continue;
      }

      if (media.kind === "video") {
        blocks.push(buildVideoBlock(media));
        images.push({ alt: "Video thumbnail", src: media.thumb });
        videoCount += 1;
      }
    }

    return {
      index,
      author: record.author,
      handle: record.handle,
      published: record.published,
      sourceUrl: record.sourceUrl,
      isLongform: false,
      blocks,
      images: uniqueImages(images),
      source: "graphql",
      quoted: Boolean(record.quoted),
      videoCount
    };
  }

  function splitIntoBlocks(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  function buildQuotedBlock(quotedRecord) {
    const author = [quotedRecord.author, quotedRecord.handle].filter(Boolean).join(" ");
    const intro = ["Quoted post", author, quotedRecord.sourceUrl].filter(Boolean).join(" - ");
    const quotedLines = String(quotedRecord.text || "")
      .split(/\n+/)
      .map((line) => `> ${line}`)
      .join("\n");
    const photoLines = quotedRecord.media
      .filter((media) => media.kind === "photo")
      .map((media) => `> ![${escapeAlt(media.alt)}](${media.src})`)
      .join("\n");

    return [intro ? `${intro}:` : "Quoted post:", quotedLines, photoLines].filter(Boolean).join("\n");
  }

  function buildVideoBlock(media) {
    let line = `Video (${formatDuration(media.durationMs)}): [${media.postUrl}](${media.postUrl})`;

    if (media.mp4) {
      line += ` — [MP4](${media.mp4})`;
    }

    return [line, `![Video thumbnail](${media.thumb})`].join("\n");
  }

  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function computeCaptureStats(entries) {
    const sourceCounts = { graphql: 0, dom: 0 };
    let quotedCount = 0;
    let videoCount = 0;

    for (const entry of entries) {
      sourceCounts[entry.source === "graphql" ? "graphql" : "dom"] += 1;

      if (entry.quoted) {
        quotedCount += 1;
      }

      videoCount += entry.videoCount || 0;
    }

    const captureSource = sourceCounts.graphql > entries.length / 2 ? "graphql" : "dom";

    return { captureSource, sourceCounts, quotedCount, videoCount };
  }

  function sendProgress(captured) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        return;
      }

      const result = chrome.runtime.sendMessage({ type: "XRIPPER_PROGRESS", captured });

      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch {
      // Fire-and-forget: a closed popup, the test shim, or an invalidated
      // extension context all make delivery impossible and must not fail the rip.
    }
  }

  async function ripPage() {
    const statusId = getStatusId(location.href);
    const focalArticle = statusId ? getTweetArticles().find((article) => getTweetStatusId(article) === statusId) : null;

    if (focalArticle && !isLongformRoot(focalArticle)) {
      try {
        return await extractThreadMarkdown(focalArticle);
      } catch {
        // Sweep failed; fall back to the single-pass extraction below.
      }
    }

    let expandedCount = 0;

    try {
      expandedCount = await expandShowMoreLinks();
    } catch {
      // Expansion is best-effort; extraction still runs on whatever is in the DOM.
    }

    const result = extractMarkdown();
    result.stats.expandedCount = expandedCount;
    return result;
  }

  // Single-pass expansion for the non-thread fallback path only. Thread rips
  // go through extractThreadMarkdown, whose sweep has its own expansion loop
  // with boundary filtering and network-quiet waits.
  async function expandShowMoreLinks() {
    const deadline = Date.now() + 20000;
    const alreadyClicked = new WeakSet();
    let totalClicked = 0;

    for (let round = 0; round < 8 && Date.now() < deadline; round += 1) {
      const expanders = findShowMoreExpanders().filter((element) => !alreadyClicked.has(element));

      if (!expanders.length) {
        break;
      }

      for (const element of expanders) {
        alreadyClicked.add(element);
        element.click();
      }

      totalClicked += expanders.length;

      await waitForExpanders(expanders, deadline);
    }

    return totalClicked;
  }

  function findShowMoreExpanders() {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector("main") || document;
    const candidates = new Set();

    for (const element of scope.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) {
      candidates.add(element);
    }

    for (const button of scope.querySelectorAll("button, [role='button']")) {
      if (/^show more$/i.test(compactWhitespace(button.innerText))) {
        candidates.add(button);
      }
    }

    return Array.from(candidates).filter(isSafeExpander);
  }

  // Thread-continuation cursors: long same-author threads (40+ posts) render
  // only the first ~31 posts, gating the rest behind a "Show replies" button.
  // Sweep-only — the non-thread fallback (expandShowMoreLinks) must not use
  // this, since the same label also appears on reply-section cursors after
  // the thread boundary, which findPendingExpanders' boundary filter excludes.
  function findShowRepliesExpanders() {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector("main") || document;
    const candidates = [];

    for (const button of scope.querySelectorAll("button, [role='button']")) {
      if (/^show replies$/i.test(compactWhitespace(button.innerText))) {
        candidates.push(button);
      }
    }

    return candidates.filter(isSafeExpander);
  }

  function isSafeExpander(element) {
    if (!isVisible(element)) {
      return false;
    }

    if (element.tagName.toLowerCase() === "a" || element.closest("a[href]")) {
      return false;
    }

    return true;
  }

  async function waitForExpanders(clicked, deadline) {
    const settleBy = Math.min(Date.now() + 2500, deadline);

    while (Date.now() < settleBy) {
      const pending = clicked.some((element) => element.isConnected && isVisible(element));

      if (!pending) {
        break;
      }

      await sleep(150);
    }

    await sleep(300);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Rips a same-author thread by sweeping down the conversation: expand, harvest
  // what is rendered, scroll, repeat. Harvesting each round is required because
  // X virtualizes the timeline and unmounts off-screen posts.
  async function extractThreadMarkdown(focalArticle) {
    const focalStatusId = getStatusId(location.href);
    const threadHandle = getAuthorHandle(focalArticle);

    if (!threadHandle) {
      throw new Error("Could not identify the thread author.");
    }

    const focalPublished = getPublishedTime(focalArticle) || "";
    const harvest = new Map();
    const alreadyClicked = new WeakSet();
    const deadline = Date.now() + 30000;
    const originalScrollY = window.scrollY;
    let expandedCount = 0;
    let seenCounter = 0;
    let stagnantRounds = 0;

    function threadArticleWalk() {
      const articles = getTweetArticles();
      const startIndex = articles.findIndex((article) => getTweetStatusId(article) === focalStatusId);
      return articles.slice(Math.max(startIndex, 0));
    }

    function findBoundaryArticle() {
      for (const article of threadArticleWalk()) {
        if (isPromotedArticle(article)) {
          continue;
        }

        const handle = getAuthorHandle(article);

        if (handle && handle !== threadHandle) {
          return article;
        }
      }

      return null;
    }

    function findPendingExpanders() {
      const boundary = findBoundaryArticle();
      const candidates = new Set([...findShowMoreExpanders(), ...findShowRepliesExpanders()]);

      return Array.from(candidates)
        .filter((element) => !alreadyClicked.has(element))
        .filter((element) => !boundary || isBeforeInDocument(element, boundary));
    }

    function harvestRound() {
      for (const article of threadArticleWalk()) {
        if (isPromotedArticle(article)) {
          continue;
        }

        const handle = getAuthorHandle(article);

        if (handle && handle !== threadHandle) {
          break;
        }

        if (!handle || !article.querySelector('[data-testid="tweetText"], [data-testid="tweetPhoto"], img[src]')) {
          continue;
        }

        const published = getPublishedTime(article) || "";

        if (focalPublished && published && published < focalPublished) {
          continue;
        }

        const statusId = getTweetStatusId(article);
        const key = statusId || `${published}|${compactWhitespace(article.innerText).slice(0, 80)}`;

        if (harvest.has(key)) {
          continue;
        }

        const record = statusId ? captureStore.get(statusId) : null;
        const entry = record ? buildEntryFromRecord(record, 0) : extractEntry(article, 0);

        if (!entry.blocks.length && !entry.images.length) {
          continue;
        }

        entry.sortPublished = record?.published || published;
        entry.sortSeen = seenCounter += 1;
        harvest.set(key, entry);
      }
    }

    try {
      for (let round = 0; round < 40 && Date.now() < deadline && stagnantRounds < 3; round += 1) {
        const sizeBefore = harvest.size;
        const expanders = findPendingExpanders();

        if (expanders.length) {
          for (const element of expanders) {
            alreadyClicked.add(element);
            element.click();
          }

          expandedCount += expanders.length;
          await waitForExpanders(expanders, deadline);
          await waitForQuiet(deadline);
        }

        harvestRound();
        sendProgress(harvest.size);

        if (findBoundaryArticle() && !findPendingExpanders().length && !isTimelineLoading()) {
          break;
        }

        stagnantRounds = harvest.size > sizeBefore || expanders.length ? 0 : stagnantRounds + 1;
        window.scrollBy(0, window.innerHeight * 2);
        await sleep(350);
      }
    } catch {
      // Keep whatever was harvested before the sweep failed.
    } finally {
      window.scrollTo(0, originalScrollY);
    }

    // Recover posts virtualization unmounted before harvest: any store-only
    // record from the same conversation and author, not earlier than the
    // focal post, gets merged in even though it was never rendered.
    const focalRecord = captureStore.get(focalStatusId) || null;
    const expectedConversationId = focalRecord?.conversationId || focalStatusId;

    if (expectedConversationId) {
      for (const [statusId, record] of captureStore) {
        if (harvest.has(statusId) || record.handle !== threadHandle) {
          continue;
        }

        if ((record.conversationId || "") !== expectedConversationId) {
          continue;
        }

        if (record.published < focalPublished) {
          continue;
        }

        const entry = buildEntryFromRecord(record, 0);

        if (!entry.blocks.length && !entry.images.length) {
          continue;
        }

        entry.sortPublished = record.published || "";
        entry.sortSeen = seenCounter += 1;
        harvest.set(statusId, entry);
      }
    }

    const entries = Array.from(harvest.values()).sort((a, b) => {
      const keyA = a.sortPublished || "\uffff";
      const keyB = b.sortPublished || "\uffff";

      if (keyA !== keyB) {
        return keyA < keyB ? -1 : 1;
      }

      return a.sortSeen - b.sortSeen;
    });

    if (!entries.length) {
      throw new Error("The thread sweep did not capture any posts.");
    }

    entries.forEach((entry, index) => {
      entry.index = index + 1;
    });

    const title = getDocumentTitle(entries);
    const allImages = uniqueImages(entries.flatMap((entry) => entry.images));

    return {
      filename: `${slugify(title || "x-export")}.md`,
      markdown: buildMarkdown(title, entries),
      images: allImages,
      stats: {
        blockCount: entries.reduce((sum, entry) => sum + entry.blocks.length, 0),
        imageCount: allImages.length,
        entryCount: entries.length,
        expandedCount,
        ...computeCaptureStats(entries)
      }
    };
  }

  function isPromotedArticle(article) {
    return normalizedLines(article.innerText).some((line) => line === "Ad" || line === "Promoted");
  }

  function isBeforeInDocument(elementA, elementB) {
    return Boolean(elementA.compareDocumentPosition(elementB) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isTimelineLoading() {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector("main") || document;
    return Array.from(scope.querySelectorAll('[role="progressbar"]')).some(isVisible);
  }

  async function waitForQuiet(deadline) {
    const quietBy = Math.min(Date.now() + 4000, deadline);

    while (Date.now() < quietBy && isTimelineLoading()) {
      await sleep(150);
    }

    await sleep(250);
  }

  function extractMarkdown() {
    const roots = collectArticleRoots();

    if (!roots.length) {
      throw new Error("No article or thread content was found on this page.");
    }

    const entries = roots.map((root, index) => buildEntryForRoot(root, index + 1)).filter((entry) => entry.blocks.length || entry.images.length);

    if (!entries.length) {
      throw new Error("The page did not expose readable article text or media yet. Try again after it finishes loading.");
    }

    const title = getDocumentTitle(entries);
    const markdown = buildMarkdown(title, entries);
    const images = uniqueImages(entries.flatMap((entry) => entry.images));

    return {
      filename: `${slugify(title || "x-export")}.md`,
      markdown,
      images,
      stats: {
        blockCount: entries.reduce((sum, entry) => sum + entry.blocks.length, 0),
        imageCount: images.length,
        entryCount: entries.length,
        ...computeCaptureStats(entries)
      }
    };
  }

  // Longform Articles always stay DOM (their Draft.js structure is a fragile
  // mapping the existing extractor already handles well). Everything else
  // prefers the capture store when the root's status ID was captured.
  function buildEntryForRoot(root, index) {
    if (isLongformRoot(root)) {
      return extractEntry(root, index);
    }

    const statusId = getTweetStatusId(root);
    const record = statusId ? captureStore.get(statusId) : null;

    if (record) {
      const entry = buildEntryFromRecord(record, index);
      entry.sourceUrl = entry.sourceUrl || getEntrySourceUrl(root) || location.href;
      return entry;
    }

    return extractEntry(root, index);
  }

  function collectArticleRoots() {
    const statusId = getStatusId(location.href);
    const tweetArticles = getTweetArticles();

    if (statusId && tweetArticles.length) {
      const matchedIndex = tweetArticles.findIndex((article) => getTweetStatusId(article) === statusId);

      if (matchedIndex >= 0) {
        if (tweetArticles[matchedIndex].querySelector('[data-testid="longformRichTextComponent"]')) {
          return [tweetArticles[matchedIndex]];
        }

        return collectSameAuthorThread(tweetArticles, matchedIndex);
      }
    }

    if (tweetArticles.length) {
      return [tweetArticles[0]];
    }

    const articleRoot = findLongformArticleRoot();
    return articleRoot ? [articleRoot] : [];
  }

  function getTweetArticles() {
    return Array.from(document.querySelectorAll('main article[data-testid="tweet"], main [role="article"][data-testid="tweet"]')).filter(isVisible);
  }

  function collectSameAuthorThread(tweetArticles, startIndex) {
    const firstArticle = tweetArticles[startIndex];
    const firstHandle = getAuthorHandle(firstArticle);
    const thread = [];

    if (!firstHandle) {
      return [firstArticle];
    }

    for (let index = startIndex; index < tweetArticles.length; index += 1) {
      const article = tweetArticles[index];
      const handle = getAuthorHandle(article);
      const hasReadableContent = Boolean(article.querySelector('[data-testid="tweetText"], [data-testid="tweetPhoto"], img[src]'));

      if (!hasReadableContent) {
        continue;
      }

      if (thread.length && handle && handle !== firstHandle) {
        break;
      }

      thread.push(article);
    }

    return thread.length ? thread : [firstArticle];
  }

  function findLongformArticleRoot() {
    const candidates = [
      ...document.querySelectorAll("main article"),
      ...document.querySelectorAll('main [role="article"]'),
      document.querySelector('[data-testid="primaryColumn"]'),
      document.querySelector("main")
    ].filter(Boolean);

    const scored = candidates
      .filter(isVisible)
      .map((element) => ({ element, score: articleTextLength(element) }))
      .filter((candidate) => candidate.score > 160)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.element || null;
  }

  function extractEntry(root, index) {
    return {
      index,
      author: getAuthorName(root),
      handle: getAuthorHandle(root),
      published: getPublishedTime(root),
      sourceUrl: getEntrySourceUrl(root) || location.href,
      isLongform: isLongformRoot(root),
      blocks: extractTextBlocks(root),
      images: extractImages(root),
      source: "dom",
      quoted: false,
      videoCount: 0
    };
  }

  function isLongformRoot(root) {
    return Boolean(root.querySelector('[data-testid="longformRichTextComponent"]'));
  }

  function extractTextBlocks(root) {
    const longformBlocks = extractLongformBlocks(root);

    if (longformBlocks.length) {
      return longformBlocks;
    }

    const preferredBlocks = Array.from(root.querySelectorAll('[data-testid="tweetText"], h1, h2, h3, p')).filter(isVisible);
    const blocks = preferredBlocks.flatMap((element) => elementToMarkdownBlocks(element));

    if (blocks.length) {
      return dedupeStrings(blocks);
    }

    return dedupeStrings(
      normalizedLines(root.innerText)
        .filter(Boolean)
        .filter((line) => !isLikelyChromeText(line))
    );
  }

  function extractLongformBlocks(root) {
    const richTextRoot = root.querySelector('[data-testid="longformRichTextComponent"]');

    if (!richTextRoot) {
      return [];
    }

    const blockContainer = richTextRoot.firstElementChild || richTextRoot;
    const rawBlocks = Array.from(blockContainer.children).filter((element) => isVisible(element) && hasLongformRenderableContent(element));
    const blocks = [];

    for (const element of rawBlocks) {
      const markdown = longformElementToMarkdown(element);

      if (markdown) {
        blocks.push(markdown);
      }
    }

    return dedupeConsecutiveStrings(blocks);
  }

  function hasLongformRenderableContent(element) {
    return Boolean(compactWhitespace(element.innerText) || element.querySelector("img[src], video, pre, code, [data-testid='simpleTweet']"));
  }

  function longformElementToMarkdown(element) {
    if (element.querySelector('[data-testid="simpleTweet"]')) {
      return embeddedTweetToMarkdown(element);
    }

    if (element.matches("section") && element.querySelector("img, video")) {
      return longformMediaToMarkdown(element);
    }

    if (element.matches("ul, ol")) {
      return longformListToMarkdown(element);
    }

    const code = element.querySelector("pre code") || element.querySelector("pre");

    if (code) {
      const language = code.tagName.toLowerCase() === "code" ? codeLanguage(code) : "";
      return ["```" + language, code.innerText.trim(), "```"].join("\n");
    }

    const heading = element.matches("h1, h2, h3") ? element : element.querySelector("h1, h2, h3");
    const text = inlineMarkdown(heading || element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text || isLikelyChromeText(text)) {
      return "";
    }

    if (heading) {
      const tagName = heading.tagName.toLowerCase();
      const depth = tagName === "h1" ? "#" : tagName === "h2" ? "##" : "###";
      return `${depth} ${stripLeadingHashes(text)}`;
    }

    if (element.className && String(element.className).includes("longform-header-two")) {
      return `## ${stripLeadingHashes(text)}`;
    }

    if (element.className && String(element.className).includes("longform-header-three")) {
      return `### ${stripLeadingHashes(text)}`;
    }

    if (element.matches("blockquote") || String(element.className).includes("longform-blockquote")) {
      return text.split(/\n+/).map((line) => `> ${line}`).join("\n");
    }

    if (String(element.className).includes("unordered-list-item")) {
      return `- ${text}`;
    }

    if (String(element.className).includes("ordered-list-item")) {
      return `1. ${text}`;
    }

    return text;
  }

  function longformMediaToMarkdown(element) {
    const images = extractImages(element);
    const caption = inlineMarkdownWithoutMedia(element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const blocks = [];

    for (const image of images) {
      blocks.push(`![${escapeAlt(caption || image.alt)}](${image.src})`);
    }

    if (caption) {
      blocks.push(`*${caption}*`);
    }

    return blocks.join("\n\n");
  }

  function longformListToMarkdown(element) {
    const ordered = element.matches("ol");
    const items = Array.from(element.querySelectorAll(":scope > li")).filter(isVisible);

    return items
      .map((item, index) => {
        const marker = ordered ? `${index + 1}.` : "-";
        const depth = listItemDepth(item);
        const text = inlineMarkdown(item)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{2,}/g, "\n")
          .trim();

        if (!text) {
          return "";
        }

        return `${"  ".repeat(depth)}${marker} ${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  function embeddedTweetToMarkdown(element) {
    const article = element.querySelector("article");
    const tweetText = article?.querySelector('[data-testid="tweetText"]');
    const text = tweetText ? inlineMarkdown(tweetText).trim() : cleanEmbeddedTweetText(element.innerText);

    if (!text) {
      return "";
    }

    const author = article ? [getAuthorName(article), getAuthorHandle(article)].filter(Boolean).join(" ") : "";
    const sourceUrl = article ? getEntrySourceUrl(article) : "";
    const intro = ["Embedded post", author, sourceUrl].filter(Boolean).join(" - ");
    const quoted = text.split(/\n+/).map((line) => `> ${line}`).join("\n");
    const media = article ? extractImages(article).map((image) => `> ![${escapeAlt(image.alt)}](${image.src})`).join("\n") : "";

    return [intro ? `${intro}:` : "Embedded post:", quoted, media].filter(Boolean).join("\n");
  }

  function cleanEmbeddedTweetText(text) {
    return normalizedLines(text)
      .filter((line) => !isLikelyChromeText(line))
      .filter((line) => !/^@[A-Za-z0-9_]+$/.test(line))
      .filter((line) => line !== "·")
      .filter((line) => !/^[A-Z][a-z]{2} \d{1,2}$/.test(line))
      .join("\n")
      .trim();
  }

  function codeLanguage(code) {
    const className = String(code.className || "");
    const match = className.match(/language-([A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
  }

  function elementToMarkdownBlocks(element) {
    const text = inlineMarkdown(element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) {
      return [];
    }

    if (/^H1$/i.test(element.tagName)) {
      return [`# ${stripLeadingHashes(text)}`];
    }

    if (/^H2$/i.test(element.tagName)) {
      return [`## ${stripLeadingHashes(text)}`];
    }

    if (/^H3$/i.test(element.tagName)) {
      return [`### ${stripLeadingHashes(text)}`];
    }

    return text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  }

  function inlineMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\s+/g, " ");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = element.tagName.toLowerCase();

    if (["button", "script", "style", "svg"].includes(tagName)) {
      return "";
    }

    if (tagName === "br") {
      return "\n";
    }

    if (tagName === "img") {
      return "";
    }

    if (tagName === "a") {
      const label = compactWhitespace(Array.from(element.childNodes).map(inlineMarkdown).join(""));
      const href = normalizeHref(element.getAttribute("href"));

      if (!href) {
        return label;
      }

      if (!label || label === href) {
        return href;
      }

      return `[${escapeLinkLabel(label)}](${href})`;
    }

    if (tagName === "code" && !element.closest("pre")) {
      return inlineCode(element.innerText || element.textContent || "");
    }

    const content = Array.from(element.childNodes).map(inlineMarkdown).join("");
    return applyInlineFormatting(element, content);
  }

  function inlineMarkdownWithoutMedia(root) {
    const clone = root.cloneNode(true);

    clone.querySelectorAll("img, video, canvas, svg, button, pre, code, [data-testid='tweetPhoto'], [data-testid='videoComponent']").forEach((element) => element.remove());

    return inlineMarkdown(clone);
  }

  function applyInlineFormatting(element, content) {
    const text = content.trim();

    if (!text) {
      return content;
    }

    const tagName = element.tagName.toLowerCase();
    const style = element.getAttribute("style") || "";
    const isBold = tagName === "strong" || tagName === "b" || /font-weight:\s*(bold|[6-9]00)/i.test(style);
    const isItalic = tagName === "em" || tagName === "i" || /font-style:\s*italic/i.test(style);
    let formatted = content;

    if (isBold) {
      formatted = wrapMarkdown(formatted, "**");
    }

    if (isItalic) {
      formatted = wrapMarkdown(formatted, "*");
    }

    return formatted;
  }

  function wrapMarkdown(value, marker) {
    const leading = value.match(/^\s*/)?.[0] || "";
    const trailing = value.match(/\s*$/)?.[0] || "";
    const middle = value.trim();

    if (!middle || middle.startsWith(marker)) {
      return value;
    }

    return `${leading}${marker}${middle}${marker}${trailing}`;
  }

  function inlineCode(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();

    if (!text) {
      return "";
    }

    const fence = text.includes("`") ? "``" : "`";
    return `${fence}${text}${fence}`;
  }

  function listItemDepth(item) {
    const className = String(item.className || "");
    const match = className.match(/public-DraftStyleDefault-depth(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function extractImages(root) {
    const images = Array.from(root.querySelectorAll("img[src]"))
      .filter(isVisible)
      .filter(isArticleImage)
      .map((img, index) => ({
        alt: imageAltText(img, index + 1),
        src: normalizeImageUrl(img.currentSrc || img.src)
      }))
      .filter((image) => image.src);

    return uniqueImages(images);
  }

  function isArticleImage(img) {
    const source = img.currentSrc || img.src || "";
    const alt = (img.alt || "").trim().toLowerCase();

    if (!source) {
      return false;
    }

    if (source.includes("profile_images") || source.includes("abs.twimg.com") || source.includes("/emoji/")) {
      return false;
    }

    if (source.includes("pbs.twimg.com/media") || source.includes("pbs.twimg.com/ext_tw_video_thumb") || source.includes("pbs.twimg.com/amplify_video_thumb")) {
      return true;
    }

    if (img.closest('[data-testid="tweetPhoto"]')) {
      return true;
    }

    if (alt === "image" || alt.startsWith("image")) {
      return true;
    }

    return img.naturalWidth >= 240 && img.naturalHeight >= 120;
  }

  function buildMarkdown(title, entries) {
    const allImages = uniqueImages(entries.flatMap((entry) => entry.images));
    const hasInlineMedia = entries.some((entry) => entry.isLongform || entry.blocks.some(hasMarkdownImage));
    const lines = [
      "---",
      `title: ${yamlString(title)}`,
      `source: ${yamlString(location.href)}`,
      `exported: ${yamlString(new Date().toISOString())}`,
      "site: X",
      "---",
      "",
      `# ${title}`,
      "",
      `Source: [${location.href}](${location.href})`,
      ""
    ];

    const isThread = entries.length > 1;

    for (const entry of entries) {
      if (isThread) {
        lines.push(`## ${entryTitle(entry)}`, "");
      }

      if (!isThread) {
        const metadata = entryMetadata(entry);

        if (metadata.length) {
          lines.push(metadata.join("  \n"), "");
        }
      }

      lines.push(...entry.blocks, "");

      if (isThread && entry.images.length && !entry.isLongform && !entry.blocks.some(hasMarkdownImage)) {
        lines.push(...entry.images.map((image) => `![${escapeAlt(image.alt)}](${image.src})`), "");
      }
    }

    if (!isThread && allImages.length && !hasInlineMedia) {
      lines.push("## Media", "", ...allImages.map((image) => `![${escapeAlt(image.alt)}](${image.src})`), "");
    }

    return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  }

  function entryTitle(entry) {
    const parts = [];

    if (entry.handle) {
      parts.push(entry.handle);
    } else if (entry.author) {
      parts.push(entry.author);
    } else {
      parts.push(`Entry ${entry.index}`);
    }

    if (entry.published) {
      parts.push(entry.published);
    }

    return parts.join(" - ");
  }

  function entryMetadata(entry) {
    const metadata = [];

    if (entry.author || entry.handle) {
      metadata.push(`Author: ${[entry.author, entry.handle].filter(Boolean).join(" ")}`);
    }

    if (entry.published) {
      metadata.push(`Published: ${entry.published}`);
    }

    if (entry.sourceUrl && entry.sourceUrl !== location.href) {
      metadata.push(`Entry: [${entry.sourceUrl}](${entry.sourceUrl})`);
    }

    return metadata;
  }

  function hasMarkdownImage(block) {
    return /!\[[^\]]*]\([^)]+\)/.test(block);
  }

  function getDocumentTitle(entries) {
    const articleTitle = document.querySelector('[data-testid="twitter-article-title"]');
    const articleTitleText = articleTitle && isVisible(articleTitle) ? compactWhitespace(articleTitle.innerText) : "";

    if (articleTitleText) {
      return articleTitleText;
    }

    const heading = document.querySelector("main h1");
    const headingText = heading && isVisible(heading) ? compactWhitespace(heading.innerText) : "";

    if (headingText && !isLikelyChromeText(headingText)) {
      return headingText;
    }

    const firstBlock = entries.flatMap((entry) => entry.blocks).find(Boolean);

    if (firstBlock) {
      return compactWhitespace(firstBlock.replace(/[#*_`[\]()]/g, "")).slice(0, 90);
    }

    return compactWhitespace(document.title.replace(/\s*\/\s*X\s*$/i, "")) || "X export";
  }

  function getAuthorName(root) {
    const userName = root.querySelector('[data-testid="User-Name"]');

    if (!userName) {
      return "";
    }

    const line = normalizedLines(userName.innerText).find((value) => value && !value.startsWith("@"));
    return line || "";
  }

  function getAuthorHandle(root) {
    const userName = root.querySelector('[data-testid="User-Name"]');

    if (userName) {
      const handle = normalizedLines(userName.innerText).find((value) => /^@[A-Za-z0-9_]+$/.test(value));

      if (handle) {
        return handle;
      }
    }

    const authorLink = root.querySelector('a[href^="/"][role="link"]');
    const href = authorLink?.getAttribute("href") || "";
    const match = href.match(/^\/([A-Za-z0-9_]{1,20})(?:$|[/?#])/);
    return match ? `@${match[1]}` : "";
  }

  function getPublishedTime(root) {
    const dateTime = getRelevantTime(root)?.getAttribute("datetime");

    if (!dateTime) {
      return "";
    }

    try {
      return new Date(dateTime).toISOString();
    } catch {
      return dateTime;
    }
  }

  function getEntrySourceUrl(root) {
    const timeLink = getRelevantTime(root)?.closest("a");
    return timeLink ? normalizeHref(timeLink.getAttribute("href")) : "";
  }

  function getRelevantTime(root) {
    const times = Array.from(root.querySelectorAll("time"));

    if (!times.length) {
      return null;
    }

    const currentStatusId = getStatusId(location.href);

    if (currentStatusId) {
      const currentStatusTime = times.find((time) => getStatusId(normalizeHref(time.closest("a")?.getAttribute("href"))) === currentStatusId);

      if (currentStatusTime) {
        return currentStatusTime;
      }
    }

    return times.find((time) => !time.closest('[data-testid="longformRichTextComponent"], [data-testid="simpleTweet"]')) || times[0];
  }

  function getTweetStatusId(root) {
    const sourceUrl = getEntrySourceUrl(root);
    return getStatusId(sourceUrl);
  }

  function getStatusId(url) {
    return String(url || "").match(/\/status(?:es)?\/(\d+)/)?.[1] || "";
  }

  function articleTextLength(element) {
    return normalizedLines(element.innerText)
      .filter((line) => !isLikelyChromeText(line))
      .join(" ")
      .length;
  }

  function isLikelyChromeText(text) {
    const value = compactWhitespace(text).toLowerCase();
    const blocked = new Set([
      "home",
      "explore",
      "notifications",
      "messages",
      "grok",
      "bookmarks",
      "communities",
      "premium",
      "verified orgs",
      "profile",
      "more",
      "post",
      "reply",
      "repost",
      "like",
      "share",
      "views",
      "show more",
      "discover more",
      "who to follow",
      "what's happening",
      "terms of service",
      "privacy policy",
      "cookie policy",
      "accessibility",
      "ads info"
    ]);

    if (blocked.has(value)) {
      return true;
    }

    return /^[0-9.,]+[kmb]?$/.test(value) || /^[·.]+$/.test(value);
  }

  function normalizedLines(text = "") {
    return text
      .split(/\r?\n/)
      .map(compactWhitespace)
      .filter(Boolean);
  }

  function compactWhitespace(text = "") {
    return text.replace(/\s+/g, " ").trim();
  }

  function dedupeStrings(values) {
    const seen = new Set();
    const result = [];

    for (const value of values.map((item) => item.trim()).filter(Boolean)) {
      const key = value.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }

    return result;
  }

  function dedupeConsecutiveStrings(values) {
    const result = [];
    let previous = "";

    for (const value of values.map((item) => item.trim()).filter(Boolean)) {
      if (value !== previous) {
        result.push(value);
      }

      previous = value;
    }

    return result;
  }

  function uniqueImages(images) {
    const seen = new Set();
    const result = [];

    for (const image of images) {
      if (!image.src || seen.has(image.src)) {
        continue;
      }

      seen.add(image.src);
      result.push(image);
    }

    return result;
  }

  function normalizeHref(href) {
    if (!href) {
      return "";
    }

    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  function normalizeImageUrl(src) {
    try {
      const url = new URL(src, location.href);

      if (url.hostname === "pbs.twimg.com" && url.searchParams.has("name")) {
        url.searchParams.set("name", "large");
      }

      return url.href;
    } catch {
      return src;
    }
  }

  function imageAltText(img, index) {
    const alt = compactWhitespace(img.alt || "");

    if (alt && alt.toLowerCase() !== "image") {
      return alt;
    }

    return `Embedded image ${index}`;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = getComputedStyle(element);

    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function stripLeadingHashes(text) {
    return text.replace(/^#+\s*/, "");
  }

  function escapeAlt(text) {
    return String(text || "").replace(/]/g, "\\]");
  }

  function escapeLinkLabel(text) {
    return String(text || "").replace(/]/g, "\\]");
  }

  function yamlString(value) {
    return JSON.stringify(String(value || ""));
  }

  function slugify(value) {
    const slug = String(value || "x-export")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    const fallback = getStatusId(location.href) ? `x-status-${getStatusId(location.href)}` : "x-export";
    return slug || fallback;
  }
})();

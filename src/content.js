(function initializeXRipperContentScript() {
  if (window.__XRipperContentLoaded) {
    return;
  }

  window.__XRipperContentLoaded = true;

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

      return findShowMoreExpanders()
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

        const key = getTweetStatusId(article) || `${published}|${compactWhitespace(article.innerText).slice(0, 80)}`;

        if (harvest.has(key)) {
          continue;
        }

        const entry = extractEntry(article, 0);

        if (!entry.blocks.length && !entry.images.length) {
          continue;
        }

        entry.sortPublished = published;
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
        expandedCount
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

    const entries = roots.map((root, index) => extractEntry(root, index + 1)).filter((entry) => entry.blocks.length || entry.images.length);

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
        entryCount: entries.length
      }
    };
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
      images: extractImages(root)
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

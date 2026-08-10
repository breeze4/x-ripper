// Runs the thread sweep directly via the exposed test copy of content.js
// (window.__xrtest), starting from the first rendered tweet article.
// Requires shim.js, decorate.js, and the exposed copy to be loaded first.
(async () => {
  const articles = window.__xrtest.getTweetArticles();

  if (!articles.length) {
    return JSON.stringify({ threw: "no tweet articles found after decoration" });
  }

  const scrollBefore = window.scrollY;

  try {
    const result = await window.__xrtest.extractThreadMarkdown(articles[0]);

    return JSON.stringify({
      scrollRestored: window.scrollY === scrollBefore,
      stats: result.stats,
      imageCount: result.images.length,
      markdownChars: result.markdown.length,
      hasShowMoreLeak: /\bshow more\b/i.test(result.markdown)
    });
  } catch (error) {
    return JSON.stringify({
      threw: error.message || String(error),
      scrollRestored: window.scrollY === scrollBefore
    });
  }
})()

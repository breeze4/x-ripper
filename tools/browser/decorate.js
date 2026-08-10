// The logged-out x.com bundle strips every data-testid and role attribute the
// extension keys on. This restores the logged-in markers so the extraction
// paths can be exercised without an authenticated session. A MutationObserver
// keeps decorating articles that render later (e.g. during the thread sweep).
(() => {
  window.__xrDecorate = () => {
    document.querySelectorAll("article").forEach((article) => article.setAttribute("data-testid", "tweet"));
    document.querySelectorAll("article a[href^='/']").forEach((anchor) => anchor.setAttribute("role", "link"));
  };

  window.__xrDecorate();
  new MutationObserver(() => window.__xrDecorate()).observe(document.body, { childList: true, subtree: true });
  return "decorated";
})()

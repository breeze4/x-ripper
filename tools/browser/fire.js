// Fires the extension's extract message through the shimmed listener and
// returns a compact JSON summary of the response for assertion.
(async () => {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("extract timed out after 45s")), 45000);
    const returned = window.__xrShim.listener(
      { type: "XRIPPER_EXTRACT_MARKDOWN" },
      null,
      (resp) => {
        clearTimeout(timer);
        resolve(resp);
      }
    );

    if (returned !== true) {
      clearTimeout(timer);
      reject(new Error("listener did not return true for async response"));
    }
  });

  return JSON.stringify({
    ok: response.ok === true,
    error: response.error || null,
    filename: response.filename || null,
    stats: response.stats || null,
    imageCount: Array.isArray(response.images) ? response.images.length : 0,
    markdownChars: response.markdown ? response.markdown.length : 0,
    hasShowMoreLeak: response.markdown ? /\bshow more\b/i.test(response.markdown) : null
  });
})()

const saveButton = document.querySelector("#save");
const embedImagesInput = document.querySelector("#embed-images");
const statusEl = document.querySelector("#status");

saveButton.addEventListener("click", async () => {
  setStatus("Expanding truncated posts and reading the current X page...");
  saveButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !isSupportedUrl(tab.url)) {
      throw new Error("Open an x.com or twitter.com article/status page before saving.");
    }

    const result = await requestMarkdown(tab.id);

    if (!result.ok) {
      throw new Error(result.error || "Could not extract Markdown from this page.");
    }

    let markdown = result.markdown;
    let imageStats = { embedded: 0, failed: 0 };

    const images = Array.isArray(result.images) ? result.images : [];

    if (embedImagesInput.checked && images.length) {
      setStatus(`Embedding ${images.length} image${plural(images.length)}...`);
      const embedded = await embedImages(markdown, images);
      markdown = embedded.markdown;
      imageStats = embedded.stats;
    }

    await downloadMarkdown(result.filename, markdown);
    setStatus(
      successMessage(result.stats, imageStats, embedImagesInput.checked),
      "success"
    );
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    saveButton.disabled = false;
  }
});

function isSupportedUrl(url = "") {
  try {
    const { hostname } = new URL(url);
    return hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

async function requestMarkdown(tabId) {
  try {
    return await sendExtractMessage(tabId);
  } catch (firstError) {
    if (!String(firstError?.message || firstError).includes("Receiving end does not exist")) {
      throw firstError;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return sendExtractMessage(tabId);
  }
}

function sendExtractMessage(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "XRIPPER_EXTRACT_MARKDOWN" });
}

async function embedImages(markdown, images) {
  let nextMarkdown = markdown;
  const stats = { embedded: 0, failed: 0 };

  for (const image of images) {
    try {
      const dataUri = await imageUrlToDataUri(image.src);
      nextMarkdown = nextMarkdown.split(image.src).join(dataUri);
      stats.embedded += 1;
    } catch {
      stats.failed += 1;
    }
  }

  return { markdown: nextMarkdown, stats };
}

async function imageUrlToDataUri(src) {
  const response = await fetch(src, {
    cache: "force-cache",
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status}`);
  }

  const blob = await response.blob();
  return blobToDataUri(blob);
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read image data.")));
    reader.readAsDataURL(blob);
  });
}

function downloadMarkdown(filename, markdown) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: true,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        URL.revokeObjectURL(url);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!downloadId) {
          reject(new Error("Chrome did not start the download."));
          return;
        }

        resolve(downloadId);
      }
    );
  });
}

function successMessage(stats, imageStats, triedEmbedding) {
  const expanded = stats.expandedCount ? ` Expanded ${stats.expandedCount} "Show more" link${plural(stats.expandedCount)}.` : "";
  const base = `Saved ${stats.blockCount} text block${plural(stats.blockCount)} and ${stats.imageCount} image${plural(stats.imageCount)}.${expanded}`;

  if (!triedEmbedding || !stats.imageCount) {
    return base;
  }

  if (!imageStats.failed) {
    return `${base} Embedded ${imageStats.embedded}.`;
  }

  return `${base} Embedded ${imageStats.embedded}; kept ${imageStats.failed} as URL reference${plural(imageStats.failed)}.`;
}

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.className = `status${tone ? ` ${tone}` : ""}`;
}

function plural(count) {
  return count === 1 ? "" : "s";
}

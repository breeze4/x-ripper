(function initializeXRipperInterceptor() {
  if (window.__XRipperInterceptorLoaded) {
    return;
  }

  window.__XRipperInterceptorLoaded = true;

  const MAX_BUFFER_CHARS = 16000000;
  const buffer = [];
  let bufferChars = 0;

  function isGraphqlUrl(url) {
    return typeof url === "string" && url.includes("/i/api/graphql/");
  }

  function requestUrl(input) {
    try {
      if (typeof input === "string") {
        return input;
      }

      if (input && typeof input.href === "string") {
        return input.href;
      }

      if (input && typeof input.url === "string") {
        return input.url;
      }
    } catch {
      // Fall through to the empty-string default below.
    }

    return "";
  }

  function pushToBuffer(text) {
    try {
      buffer.push(text);
      bufferChars += text.length;

      while (bufferChars > MAX_BUFFER_CHARS && buffer.length) {
        bufferChars -= buffer.shift().length;
      }
    } catch {
      // Never let buffer bookkeeping break capture.
    }
  }

  function deliver(text) {
    try {
      if (typeof text !== "string" || !text) {
        return;
      }

      try {
        window.postMessage({ type: "XRIPPER_GQL", body: text }, location.origin);
      } catch {
        // Swallowed: the page must never see a delivery failure.
      }

      pushToBuffer(text);
    } catch {
      // Delivery must never throw back into the page.
    }
  }

  function wrapFetch() {
    const originalFetch = window.fetch;

    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = function xripperFetch(...args) {
      const promise = originalFetch.apply(this, args);

      try {
        if (isGraphqlUrl(requestUrl(args[0]))) {
          promise
            .then((response) => {
              try {
                response
                  .clone()
                  .text()
                  .then((text) => deliver(text))
                  .catch(() => {});
              } catch {
                // Swallowed by design.
              }
            })
            .catch(() => {
              // Swallowed: the original `promise` still carries the real
              // rejection back to the page untouched.
            });
        }
      } catch {
        // Never let the wrapper break the page's fetch call.
      }

      return promise;
    };
  }

  function wrapXhr() {
    const OriginalXHR = window.XMLHttpRequest;

    if (!OriginalXHR || !OriginalXHR.prototype) {
      return;
    }

    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function xripperOpen(method, url, ...rest) {
      try {
        this.__xripperUrl = requestUrl(url);
      } catch {
        // Swallowed by design.
      }

      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function xripperSend(...args) {
      try {
        if (this.__xripperUrl && isGraphqlUrl(this.__xripperUrl)) {
          this.addEventListener("load", function onLoad() {
            try {
              deliver(this.responseText);
            } catch {
              // Accessing responseText throws for non-text response types;
              // swallowed by design.
            }
          });
        }
      } catch {
        // Swallowed by design.
      }

      return originalSend.apply(this, args);
    };
  }

  function listenForReplayRequests() {
    window.addEventListener("message", (event) => {
      try {
        if (event.source !== window || event.data?.type !== "XRIPPER_GQL_REPLAY_REQUEST") {
          return;
        }

        for (const body of buffer) {
          try {
            window.postMessage({ type: "XRIPPER_GQL", body }, location.origin);
          } catch {
            // Swallowed by design.
          }
        }
      } catch {
        // Never let a malformed message break the page.
      }
    });
  }

  try {
    wrapFetch();
  } catch {
    // Swallowed by design.
  }

  try {
    wrapXhr();
  } catch {
    // Swallowed by design.
  }

  try {
    listenForReplayRequests();
  } catch {
    // Swallowed by design.
  }
})();

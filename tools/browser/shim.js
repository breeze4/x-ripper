(() => {
  window.__xrShim = { listener: null };
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    onMessage: {
      addListener: (fn) => {
        window.__xrShim.listener = fn;
      }
    },
    sendMessage: () => {}
  };
  return "shim ready";
})()

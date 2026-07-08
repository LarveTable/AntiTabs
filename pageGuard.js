(() => {
  const MESSAGE_SOURCE = "ANTITABS_EXTENSION";

  if (window.__antiTabsGuardInstalled) {
    return;
  }

  window.__antiTabsGuardInstalled = true;

  let enabled = false;
  const originalOpen = window.open;

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== MESSAGE_SOURCE ||
      event.data.type !== "STATE"
    ) {
      return;
    }

    enabled = Boolean(event.data.enabled);
  });

  window.open = function antiTabsOpenGuard(...args) {
    if (enabled) {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          type: "EVENT",
          eventType: "scriptPopupBlocked"
        },
        "*"
      );

      return null;
    }

    return originalOpen.apply(window, args);
  };
})();

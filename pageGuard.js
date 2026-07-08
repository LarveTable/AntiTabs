(() => {
  const MESSAGE_SOURCE = "ANTITABS_EXTENSION";

  if (window.__antiTabsGuardInstalled) {
    return;
  }

  window.__antiTabsGuardInstalled = true;

  let enabled = false;
  let allowNextTab = false;
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
    allowNextTab = Boolean(event.data.allowNextTab);
  });

  window.open = function antiTabsOpenGuard(...args) {
    if (enabled) {
      if (allowNextTab) {
        allowNextTab = false;
        window.postMessage(
          {
            source: MESSAGE_SOURCE,
            type: "EVENT",
            eventType: "allowNextTabUsed"
          },
          "*"
        );

        return originalOpen.apply(window, args);
      }

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

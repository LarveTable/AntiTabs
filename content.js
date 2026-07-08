const STORAGE_KEY = "enabledOrigins";
const MESSAGE_SOURCE = "ANTITABS_EXTENSION";

let antiTabsEnabled = false;

function getCurrentOrigin() {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return null;
  }

  return location.origin;
}

function sendStateToPage() {
  window.postMessage(
    {
      source: MESSAGE_SOURCE,
      enabled: antiTabsEnabled
    },
    "*"
  );
}

async function refreshEnabledState() {
  const origin = getCurrentOrigin();

  if (!origin) {
    antiTabsEnabled = false;
    sendStateToPage();
    return;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  antiTabsEnabled = Boolean((result[STORAGE_KEY] || {})[origin]);
  sendStateToPage();
}

function findAnchor(event) {
  const target = event.target;

  if (!target || typeof target.closest !== "function") {
    return null;
  }

  return target.closest("a[href]");
}

function shouldStayInCurrentTab(anchor, event) {
  return (
    anchor.target &&
    anchor.target.toLowerCase() !== "_self"
  ) || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;
}

function keepLinkInCurrentTab(event) {
  if (!antiTabsEnabled) {
    return;
  }

  const anchor = findAnchor(event);

  if (!anchor || !anchor.href || !shouldStayInCurrentTab(anchor, event)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(anchor.href);
}

refreshEnabledState();

document.addEventListener("click", keepLinkInCurrentTab, true);
document.addEventListener("auxclick", keepLinkInCurrentTab, true);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    refreshEnabledState();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "ANTITABS_STATE") {
    return;
  }

  antiTabsEnabled = Boolean(message.enabled);
  sendStateToPage();
});

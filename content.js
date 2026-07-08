const STORAGE_KEY = "enabledOrigins";
const MESSAGE_SOURCE = "ANTITABS_EXTENSION";
const SHIELDED_IFRAME_ATTRIBUTE = "data-antitabs-shielded";
const MIN_OVERLAY_COVERAGE = 0.7;
const INVISIBLE_OPACITY = 0.05;

let antiTabsEnabled = false;
let iframeObserver = null;
let iframeScanTimer = null;

function getCurrentOrigin() {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return null;
  }

  return location.origin;
}

function getProtectedOrigin() {
  const ancestorOrigins = window.location.ancestorOrigins;

  if (ancestorOrigins && ancestorOrigins.length > 0) {
    const topOrigin = ancestorOrigins[ancestorOrigins.length - 1];

    if (topOrigin.startsWith("http://") || topOrigin.startsWith("https://")) {
      return topOrigin;
    }
  }

  return getCurrentOrigin();
}

function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
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
  const origin = getProtectedOrigin();

  if (!origin) {
    antiTabsEnabled = false;
    sendStateToPage();
    updateIframeShield();
    return;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  antiTabsEnabled = Boolean((result[STORAGE_KEY] || {})[origin]);
  sendStateToPage();
  updateIframeShield();
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

  if (isTopFrame()) {
    location.assign(anchor.href);
  }
}

function getViewportSize() {
  const root = document.documentElement;

  return {
    width: Math.max(root ? root.clientWidth : 0, window.innerWidth || 0),
    height: Math.max(root ? root.clientHeight : 0, window.innerHeight || 0)
  };
}

function getViewportCoverage(rect, viewport) {
  const visibleWidth = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));

  if (viewport.width <= 0 || viewport.height <= 0) {
    return 0;
  }

  return (visibleWidth * visibleHeight) / (viewport.width * viewport.height);
}

function parseOpacity(value) {
  const opacity = Number.parseFloat(value);
  return Number.isFinite(opacity) ? opacity : 1;
}

function isEffectivelyInvisible(element) {
  for (let current = element; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
    const style = getComputedStyle(current);

    if (style.display === "none" || style.visibility === "hidden") {
      return true;
    }

    if (parseOpacity(style.opacity) <= INVISIBLE_OPACITY) {
      return true;
    }
  }

  return false;
}

function isSuspiciousIframe(iframe) {
  const rect = iframe.getBoundingClientRect();
  const viewport = getViewportSize();

  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = getComputedStyle(iframe);

  if (style.pointerEvents === "none" || style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const coverage = getViewportCoverage(rect, viewport);
  const reachesViewport =
    rect.left <= viewport.width * 0.15 &&
    rect.top <= viewport.height * 0.15 &&
    rect.right >= viewport.width * 0.85 &&
    rect.bottom >= viewport.height * 0.85;

  return coverage >= MIN_OVERLAY_COVERAGE && reachesViewport && isEffectivelyInvisible(iframe);
}

function shieldIframe(iframe) {
  if (iframe.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
    return;
  }

  iframe.setAttribute(SHIELDED_IFRAME_ATTRIBUTE, iframe.style.pointerEvents || "");
  iframe.style.pointerEvents = "none";
}

function restoreIframe(iframe) {
  const previousPointerEvents = iframe.getAttribute(SHIELDED_IFRAME_ATTRIBUTE);

  if (previousPointerEvents) {
    iframe.style.pointerEvents = previousPointerEvents;
  } else {
    iframe.style.removeProperty("pointer-events");
  }

  iframe.removeAttribute(SHIELDED_IFRAME_ATTRIBUTE);
}

function scanForSuspiciousIframes() {
  if (!antiTabsEnabled || !isTopFrame()) {
    return;
  }

  for (const iframe of document.querySelectorAll("iframe")) {
    if (isSuspiciousIframe(iframe)) {
      shieldIframe(iframe);
    } else if (iframe.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
      restoreIframe(iframe);
    }
  }
}

function restoreShieldedIframes() {
  for (const iframe of document.querySelectorAll(`iframe[${SHIELDED_IFRAME_ATTRIBUTE}]`)) {
    restoreIframe(iframe);
  }
}

function updateIframeShield() {
  if (!isTopFrame()) {
    return;
  }

  if (!antiTabsEnabled) {
    if (iframeObserver) {
      iframeObserver.disconnect();
      iframeObserver = null;
    }

    if (iframeScanTimer) {
      clearInterval(iframeScanTimer);
      iframeScanTimer = null;
    }

    restoreShieldedIframes();
    return;
  }

  if (!iframeObserver) {
    const observerRoot = document.documentElement || document;

    iframeObserver = new MutationObserver(scanForSuspiciousIframes);
    iframeObserver.observe(observerRoot, {
      attributes: true,
      childList: true,
      subtree: true
    });
  }

  if (!iframeScanTimer) {
    iframeScanTimer = setInterval(scanForSuspiciousIframes, 1000);
  }

  scanForSuspiciousIframes();
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

const STORAGE_KEY = "enabledOrigins";
const MESSAGE_SOURCE = "ANTITABS_EXTENSION";
const SHIELDED_IFRAME_ATTRIBUTE = "data-antitabs-shielded";
const SHIELDED_ELEMENT_ATTRIBUTE = "data-antitabs-element-shielded";
const MIN_OVERLAY_COVERAGE = 0.7;
const INVISIBLE_OPACITY = 0.05;
const EXTREME_Z_INDEX = 2147480000;

let antiTabsEnabled = false;
let overlayObserver = null;
let overlayScanTimer = null;

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
      type: "STATE",
      enabled: antiTabsEnabled
    },
    "*"
  );
}

function recordProtectionEvent(eventType) {
  if (!antiTabsEnabled) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "ANTITABS_RECORD_EVENT",
    eventType,
    origin: getProtectedOrigin()
  }).catch(() => {
    // Stats are best-effort; protection should never depend on logging.
  });
}

async function refreshEnabledState() {
  const origin = getProtectedOrigin();

  if (!origin) {
    antiTabsEnabled = false;
    sendStateToPage();
    updateOverlayShield();
    return;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  antiTabsEnabled = Boolean((result[STORAGE_KEY] || {})[origin]);
  sendStateToPage();
  updateOverlayShield();
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
  recordProtectionEvent("newTabLinkKept");

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

function isTransparentColor(value) {
  if (!value || value === "transparent") {
    return true;
  }

  const compactValue = value.replace(/\s+/g, "").toLowerCase();
  return compactValue === "rgba(0,0,0,0)" || compactValue === "rgb(0,0,0,0)";
}

function isSuspiciousIframe(iframe) {
  const rect = iframe.getBoundingClientRect();
  const viewport = getViewportSize();

  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = getComputedStyle(iframe);

  if (style.pointerEvents === "none" && !iframe.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
    return false;
  }

  if (style.display === "none" || style.visibility === "hidden") {
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

function getElementZIndex(style) {
  const zIndex = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(zIndex) ? zIndex : 0;
}

function hasVisibleInteractiveContent(element) {
  if (element.textContent && element.textContent.trim()) {
    return true;
  }

  return Boolean(element.querySelector(
    "a[href], button, canvas, embed, iframe, img, input, object, select, svg, textarea, video"
  ));
}

function isSuspiciousClickLayer(element) {
  if (element === document.documentElement || element === document.body || element instanceof HTMLIFrameElement) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const viewport = getViewportSize();

  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = getComputedStyle(element);

  if (style.pointerEvents === "none" && !element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
    return false;
  }

  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  if (style.position !== "fixed") {
    return false;
  }

  if (getElementZIndex(style) < EXTREME_Z_INDEX) {
    return false;
  }

  if (hasVisibleInteractiveContent(element)) {
    return false;
  }

  const coverage = getViewportCoverage(rect, viewport);
  const reachesViewport =
    rect.left <= viewport.width * 0.05 &&
    rect.top <= viewport.height * 0.05 &&
    rect.right >= viewport.width * 0.95 &&
    rect.bottom >= viewport.height * 0.95;

  const isTransparent = isTransparentColor(style.backgroundColor) || parseOpacity(style.opacity) <= INVISIBLE_OPACITY;
  return coverage >= MIN_OVERLAY_COVERAGE && reachesViewport && isTransparent;
}

function shieldElement(element, attributeName) {
  if (element.hasAttribute(attributeName)) {
    return;
  }

  element.setAttribute(attributeName, element.style.pointerEvents || "");
  element.style.pointerEvents = "none";
}

function restoreElement(element, attributeName) {
  const previousPointerEvents = element.getAttribute(attributeName);

  if (previousPointerEvents) {
    element.style.pointerEvents = previousPointerEvents;
  } else {
    element.style.removeProperty("pointer-events");
  }

  element.removeAttribute(attributeName);
}

function scanForSuspiciousOverlays() {
  if (!antiTabsEnabled || !isTopFrame()) {
    return;
  }

  for (const iframe of document.querySelectorAll("iframe")) {
    if (isSuspiciousIframe(iframe)) {
      if (!iframe.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
        recordProtectionEvent("iframeOverlayShielded");
      }

      shieldElement(iframe, SHIELDED_IFRAME_ATTRIBUTE);
    } else if (iframe.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
      restoreElement(iframe, SHIELDED_IFRAME_ATTRIBUTE);
    }
  }

  for (const element of document.querySelectorAll(`body *:not([${SHIELDED_IFRAME_ATTRIBUTE}])`)) {
    if (isSuspiciousClickLayer(element)) {
      if (!element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
        recordProtectionEvent("clickLayerShielded");
      }

      shieldElement(element, SHIELDED_ELEMENT_ATTRIBUTE);
    } else if (element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
      restoreElement(element, SHIELDED_ELEMENT_ATTRIBUTE);
    }
  }
}

function restoreShieldedOverlays() {
  for (const iframe of document.querySelectorAll(`iframe[${SHIELDED_IFRAME_ATTRIBUTE}]`)) {
    restoreElement(iframe, SHIELDED_IFRAME_ATTRIBUTE);
  }

  for (const element of document.querySelectorAll(`[${SHIELDED_ELEMENT_ATTRIBUTE}]`)) {
    restoreElement(element, SHIELDED_ELEMENT_ATTRIBUTE);
  }
}

function updateOverlayShield() {
  if (!isTopFrame()) {
    return;
  }

  if (!antiTabsEnabled) {
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }

    if (overlayScanTimer) {
      clearInterval(overlayScanTimer);
      overlayScanTimer = null;
    }

    restoreShieldedOverlays();
    return;
  }

  if (!overlayObserver) {
    const observerRoot = document.documentElement || document;

    overlayObserver = new MutationObserver(scanForSuspiciousOverlays);
    overlayObserver.observe(observerRoot, {
      attributes: true,
      childList: true,
      subtree: true
    });
  }

  if (!overlayScanTimer) {
    overlayScanTimer = setInterval(scanForSuspiciousOverlays, 1000);
  }

  scanForSuspiciousOverlays();
}

refreshEnabledState();

document.addEventListener("click", keepLinkInCurrentTab, true);
document.addEventListener("auxclick", keepLinkInCurrentTab, true);

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.source !== MESSAGE_SOURCE ||
    event.data.type !== "EVENT"
  ) {
    return;
  }

  recordProtectionEvent(event.data.eventType);
});

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
  updateOverlayShield();
});

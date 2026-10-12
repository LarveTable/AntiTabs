const STORAGE_KEY = "enabledOrigins";
const MESSAGE_SOURCE = "ANTITABS_EXTENSION";
const SHIELDED_IFRAME_ATTRIBUTE = "data-antitabs-shielded";
const SHIELDED_ELEMENT_ATTRIBUTE = "data-antitabs-element-shielded";
const PROMPT_ATTRIBUTE = "data-antitabs-prompt";
const MIN_OVERLAY_COVERAGE = 0.7;
const INVISIBLE_OPACITY = 0.05;
const EXTREME_Z_INDEX = 2147480000;
const OVERLAY_SCAN_DELAY_MS = 100;
const VIEWPORT_SCAN_DELAY_MS = 250;

let antiTabsEnabled = false;
let allowNextTab = false;
let overlayObserver = null;
let overlayScanTimer = null;
let viewportScanTimer = null;
let resizeScanTimer = null;
const pendingOverlayRoots = new Set();
const viewportCandidates = new Set();
const shieldedElements = new Set();
const decisionQueue = [];
let activeDecision = null;

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
      enabled: antiTabsEnabled,
      allowNextTab
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
    allowNextTab = false;
    sendStateToPage();
    updateOverlayShield();
    return;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  antiTabsEnabled = Boolean((result[STORAGE_KEY] || {})[origin]);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ANTITABS_GET_ALLOW_NEXT",
      origin
    });
    allowNextTab = Boolean(response && response.allowNextTab);
  } catch {
    allowNextTab = false;
  }

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

function isWebUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function keepLinkInCurrentTab(event) {
  if (!antiTabsEnabled) {
    return;
  }

  const anchor = findAnchor(event);

  if (!anchor || !isWebUrl(anchor.href) || !shouldStayInCurrentTab(anchor, event)) {
    return;
  }

  if (allowNextTab) {
    allowNextTab = false;
    sendStateToPage();
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  chrome.runtime.sendMessage({
    type: "ANTITABS_HANDLE_LINK",
    url: anchor.href
  }).catch(() => {});
}

function finishDecision(choice) {
  if (!activeDecision) {
    return;
  }

  const { promptId, host } = activeDecision;
  activeDecision = null;
  host.remove();
  chrome.runtime.sendMessage({
    type: "ANTITABS_RESOLVE_PROMPT",
    promptId,
    choice
  }).catch(() => {});
  showNextDecision();
}

function makeDecisionButton(label, choice, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", () => finishDecision(choice));
  return button;
}

function showNextDecision() {
  if (activeDecision || !isTopFrame() || !decisionQueue.length) {
    return;
  }

  const decision = decisionQueue.shift();
  const isPopup = decision.kind === "popup";
  const host = document.createElement("div");
  host.setAttribute(PROMPT_ATTRIBUTE, "");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; color-scheme: light; font-family: system-ui, sans-serif; }
    .backdrop { align-items: center; background: rgba(15, 23, 42, .55); box-sizing: border-box;
      display: flex; inset: 0; justify-content: center; padding: 18px; position: fixed; }
    .dialog { background: #fff; border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, .28);
      box-sizing: border-box; color: #151515; max-width: 440px; padding: 20px; width: 100%; }
    h2 { font-size: 18px; line-height: 1.25; margin: 0 0 8px; }
    p { color: #4b5563; font-size: 13px; line-height: 1.45; margin: 0 0 12px; }
    .url { background: #f3f4f6; border-radius: 6px; color: #374151; overflow-wrap: anywhere;
      padding: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    button { background: #fff; border: 1px solid #cbd5e1; border-radius: 7px; color: #111827;
      cursor: pointer; font: 600 13px system-ui, sans-serif; padding: 9px 11px; }
    button.primary { background: #246bfe; border-color: #246bfe; color: #fff; }
    button:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const dialog = document.createElement("section");
  dialog.className = "dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.textContent = isPopup ? "Allow this popup tab?" : "This link wants a new tab";
  dialog.setAttribute("aria-label", title.textContent);
  const explanation = document.createElement("p");
  explanation.textContent = isPopup
    ? `A tab from ${decision.origin} is waiting in the background. Allow it or close it within 20 seconds.`
    : "Choose where to open the link, or stay on this page. This choice expires in 20 seconds.";
  const url = document.createElement("p");
  url.className = "url";
  url.textContent = decision.url || "Destination not available yet";
  const actions = document.createElement("div");
  actions.className = "actions";

  if (isPopup) {
    actions.append(
      makeDecisionButton("Close tab", "close", ""),
      makeDecisionButton("Allow tab", "allow", "primary")
    );
  } else {
    actions.append(
      makeDecisionButton("Stay here", "stay", ""),
      makeDecisionButton("Open new tab", "new", ""),
      makeDecisionButton("Open here", "current", "primary")
    );
  }

  dialog.append(title, explanation, url, actions);
  backdrop.append(dialog);
  shadow.append(style, backdrop);
  document.documentElement.append(host);
  activeDecision = { promptId: decision.promptId, host };
  actions.querySelector("button").focus();

  shadow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finishDecision(isPopup ? "close" : "stay");
    } else if (event.key === "Tab") {
      const buttons = actions.querySelectorAll("button");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];

      if (event.shiftKey && event.target === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

function dismissDecision(promptId) {
  const queuedIndex = decisionQueue.findIndex((decision) => decision.promptId === promptId);

  if (queuedIndex !== -1) {
    decisionQueue.splice(queuedIndex, 1);
  }

  if (activeDecision && activeDecision.promptId === promptId) {
    activeDecision.host.remove();
    activeDecision = null;
    showNextDecision();
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

function isSuspiciousClickLayer(element, style = getComputedStyle(element)) {
  if (element === document.documentElement || element === document.body ||
      element instanceof HTMLIFrameElement || element.hasAttribute(PROMPT_ATTRIBUTE)) {
    return false;
  }

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

  const rect = element.getBoundingClientRect();
  const viewport = getViewportSize();

  if (rect.width <= 0 || rect.height <= 0) {
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
    shieldedElements.add(element);
    return;
  }

  element.setAttribute(attributeName, element.style.pointerEvents || "");
  element.style.pointerEvents = "none";
  shieldedElements.add(element);
}

function restoreElement(element, attributeName) {
  const previousPointerEvents = element.getAttribute(attributeName);

  if (previousPointerEvents) {
    element.style.pointerEvents = previousPointerEvents;
  } else {
    element.style.removeProperty("pointer-events");
  }

  element.removeAttribute(attributeName);
  shieldedElements.delete(element);
}

function scanOverlayElement(element) {
  if (element instanceof HTMLIFrameElement) {
    viewportCandidates.add(element);

    if (isSuspiciousIframe(element)) {
      if (!element.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
        recordProtectionEvent("iframeOverlayShielded");
      }

      shieldElement(element, SHIELDED_IFRAME_ATTRIBUTE);
    } else if (element.hasAttribute(SHIELDED_IFRAME_ATTRIBUTE)) {
      restoreElement(element, SHIELDED_IFRAME_ATTRIBUTE);
    }

    return;
  }

  if (element === document.documentElement || element === document.body) {
    return;
  }

  const style = getComputedStyle(element);

  if (style.position === "fixed" || element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
    viewportCandidates.add(element);
  } else {
    viewportCandidates.delete(element);
  }

  if (isSuspiciousClickLayer(element, style)) {
    if (!element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
      recordProtectionEvent("clickLayerShielded");
    }

    shieldElement(element, SHIELDED_ELEMENT_ATTRIBUTE);
  } else if (element.hasAttribute(SHIELDED_ELEMENT_ATTRIBUTE)) {
    restoreElement(element, SHIELDED_ELEMENT_ATTRIBUTE);
  }
}

function scanOverlaySubtree(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE || !root.isConnected) {
    return;
  }

  scanOverlayElement(root);

  for (const element of root.querySelectorAll("*")) {
    scanOverlayElement(element);
  }
}

function flushOverlayScans() {
  overlayScanTimer = null;

  if (!antiTabsEnabled || !isTopFrame()) {
    pendingOverlayRoots.clear();
    return;
  }

  for (const root of pendingOverlayRoots) {
    let ancestor = root.parentElement;

    while (ancestor && !pendingOverlayRoots.has(ancestor)) {
      ancestor = ancestor.parentElement;
    }

    if (!ancestor) {
      scanOverlaySubtree(root);
    }
  }

  pendingOverlayRoots.clear();

  for (const element of viewportCandidates) {
    if (!element.isConnected) {
      viewportCandidates.delete(element);
    }
  }

  for (const element of shieldedElements) {
    if (!element.isConnected) {
      restoreElement(element, element instanceof HTMLIFrameElement
        ? SHIELDED_IFRAME_ATTRIBUTE
        : SHIELDED_ELEMENT_ATTRIBUTE);
    }
  }
}

function queueOverlayScan(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  pendingOverlayRoots.add(root);

  if (!overlayScanTimer) {
    overlayScanTimer = setTimeout(flushOverlayScans, OVERLAY_SCAN_DELAY_MS);
  }
}

function scanViewportCandidates() {
  viewportScanTimer = null;

  if (!antiTabsEnabled || !isTopFrame()) {
    return;
  }

  for (const element of viewportCandidates) {
    if (element.isConnected) {
      scanOverlayElement(element);
    } else {
      viewportCandidates.delete(element);
    }
  }
}

function handleOverlayMutations(records) {
  for (const record of records) {
    if (record.type === "attributes") {
      if (record.target.tagName === "STYLE" || record.target.tagName === "LINK") {
        queueOverlayScan(document.body || document.documentElement);
      } else {
        queueOverlayScan(record.target);
      }
      continue;
    }

    let stylesChanged = record.target.tagName === "STYLE";

    for (const node of record.addedNodes) {
      if (node.tagName === "STYLE" || node.tagName === "LINK") {
        stylesChanged = true;
      }
      queueOverlayScan(node);
    }

    for (const node of record.removedNodes) {
      if (node.tagName === "STYLE" || node.tagName === "LINK") {
        stylesChanged = true;
      }
    }

    if (stylesChanged) {
      queueOverlayScan(document.body || document.documentElement);
    }

    if (record.removedNodes.length > 0) {
      if (!overlayScanTimer) {
        overlayScanTimer = setTimeout(flushOverlayScans, OVERLAY_SCAN_DELAY_MS);
      }
    }
  }
}

function scanAfterViewportChange() {
  if (!viewportScanTimer) {
    viewportScanTimer = setTimeout(scanViewportCandidates, VIEWPORT_SCAN_DELAY_MS);
  }
}

function scanAfterResize() {
  if (!resizeScanTimer) {
    resizeScanTimer = setTimeout(() => {
      resizeScanTimer = null;
      queueOverlayScan(document.body || document.documentElement);
    }, VIEWPORT_SCAN_DELAY_MS);
  }
}

function restoreShieldedOverlays() {
  for (const element of shieldedElements) {
    restoreElement(element, element instanceof HTMLIFrameElement
      ? SHIELDED_IFRAME_ATTRIBUTE
      : SHIELDED_ELEMENT_ATTRIBUTE);
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
      clearTimeout(overlayScanTimer);
      overlayScanTimer = null;
    }

    if (viewportScanTimer) {
      clearTimeout(viewportScanTimer);
      viewportScanTimer = null;
    }

    if (resizeScanTimer) {
      clearTimeout(resizeScanTimer);
      resizeScanTimer = null;
    }

    window.removeEventListener("scroll", scanAfterViewportChange, true);
    window.removeEventListener("resize", scanAfterResize);
    pendingOverlayRoots.clear();
    restoreShieldedOverlays();
    viewportCandidates.clear();
    return;
  }

  if (!overlayObserver) {
    const observerRoot = document.documentElement || document;

    overlayObserver = new MutationObserver(handleOverlayMutations);
    overlayObserver.observe(observerRoot, {
      attributes: true,
      attributeFilter: ["style", "class", "id", "hidden", "href", "rel", "disabled", "media"],
      childList: true,
      subtree: true
    });
    window.addEventListener("scroll", scanAfterViewportChange, true);
    window.addEventListener("resize", scanAfterResize);
  }

  scanOverlaySubtree(document.body || document.documentElement);
}

function setAllowNextState(isEnabled) {
  allowNextTab = Boolean(isEnabled);
  sendStateToPage();
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

  if (event.data.eventType === "allowNextTabUsed") {
    setAllowNextState(false);
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
  if (!message || !message.type) {
    return;
  }

  if (message.type === "ANTITABS_STATE") {
    antiTabsEnabled = Boolean(message.enabled);
    sendStateToPage();
    updateOverlayShield();
    return;
  }

  if (message.type === "ANTITABS_ALLOW_NEXT_STATE") {
    setAllowNextState(message.allowNextTab);
    return;
  }

  if (message.type === "ANTITABS_SHOW_DECISION" && isTopFrame()) {
    decisionQueue.push(message);
    showNextDecision();
    return;
  }

  if (message.type === "ANTITABS_DISMISS_DECISION") {
    dismissDecision(message.promptId);
  }
});

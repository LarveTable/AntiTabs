const STORAGE_KEY = "enabledOrigins";
const STATS_KEY = "sessionStats";
const ALLOW_NEXT_KEY = "allowNextTabOrigins";
const MAX_RECENT_EVENTS = 8;
const PENDING_TAB_TIMEOUT_MS = 10000;
const BADGE_CLEAR_DELAY_MS = 3000;
const ALLOW_BADGE_TEXT = "1";
const ICON_PATHS = {
  active: {
    16: "icons/active-16.png",
    32: "icons/active-32.png",
    48: "icons/active-48.png",
    128: "icons/active-128.png"
  },
  inactive: {
    16: "icons/unactive-16.png",
    32: "icons/unactive-32.png",
    48: "icons/unactive-48.png",
    128: "icons/unactive-128.png"
  }
};
const pendingProtectedTabs = new Map();
let statsWriteQueue = Promise.resolve();
let badgeCount = 0;
let badgeClearTimer = null;

const DEFAULT_STATS = {
  counts: {
    allowedTabs: 0,
    tabsClosed: 0,
    popupsBlocked: 0,
    linksKept: 0,
    overlaysShielded: 0,
    iframeOverlaysShielded: 0,
    clickLayersShielded: 0
  },
  recentEvents: []
};

const EVENT_DETAILS = {
  allowedNextTab: {
    countKeys: ["allowedTabs"],
    label: "Tab allowed once"
  },
  adTabClosed: {
    countKeys: ["tabsClosed"],
    label: "Popup tab closed"
  },
  scriptPopupBlocked: {
    countKeys: ["popupsBlocked"],
    label: "Script popup blocked"
  },
  newTabLinkKept: {
    countKeys: ["linksKept"],
    label: "New-tab link kept here"
  },
  iframeOverlayShielded: {
    countKeys: ["overlaysShielded", "iframeOverlaysShielded"],
    label: "Invisible iframe neutralized"
  },
  clickLayerShielded: {
    countKeys: ["overlaysShielded", "clickLayersShielded"],
    label: "Transparent click layer neutralized"
  }
};

function getOrigin(url) {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    return parsedUrl.origin;
  } catch {
    return null;
  }
}

function getStorageSession() {
  return chrome.storage.session || chrome.storage.local;
}

function getTargetKind(url) {
  if (!url) {
    return "unknown";
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
      return "web";
    }

    if (parsedUrl.protocol === "about:" && parsedUrl.pathname === "blank") {
      return "blank";
    }

    return "internal";
  } catch {
    return "unknown";
  }
}

function getTargetUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

async function updateActionIconForTab(tab) {
  if (!tab || tab.id == null) {
    return;
  }

  const origin = getOrigin(getTargetUrl(tab));
  const isEnabled = await isOriginEnabled(origin);

  try {
    await chrome.action.setIcon({
      tabId: tab.id,
      path: isEnabled ? ICON_PATHS.active : ICON_PATHS.inactive
    });
  } catch {
    // Some browser-owned pages do not accept per-tab action updates.
  }
}

async function updateActionIconForTabId(tabId) {
  const tab = await getTab(tabId);
  await updateActionIconForTab(tab);
}

async function updateAllActionIcons() {
  const tabs = await chrome.tabs.query({});

  await Promise.all(tabs.map((tab) => updateActionIconForTab(tab)));
}

async function hasActiveAllowance() {
  const result = await getStorageSession().get(ALLOW_NEXT_KEY);
  return Object.keys(result[ALLOW_NEXT_KEY] || {}).length > 0;
}

async function showAllowanceBadgeIfNeeded() {
  if (!(await hasActiveAllowance())) {
    return false;
  }

  stopBadgeTimers();
  badgeCount = 0;
  chrome.action.setBadgeText({ text: ALLOW_BADGE_TEXT });
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  chrome.action.setBadgeTextColor({ color: "#111827" });
  return true;
}

async function refreshBadge() {
  if (await showAllowanceBadgeIfNeeded()) {
    return;
  }

  chrome.action.setBadgeText({ text: "" });
}

function stopBadgeTimers() {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
}

async function pulseBadge() {
  if (await showAllowanceBadgeIfNeeded()) {
    return;
  }

  stopBadgeTimers();
  badgeCount += 1;

  chrome.action.setBadgeText({ text: `+${Math.min(badgeCount, 9)}` });
  chrome.action.setBadgeBackgroundColor({ color: "#246bfe" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });

  badgeClearTimer = setTimeout(() => {
    badgeCount = 0;
    badgeClearTimer = null;
    refreshBadge();
  }, BADGE_CLEAR_DELAY_MS);
}

async function isOriginEnabled(origin) {
  if (!origin) {
    return false;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Boolean((result[STORAGE_KEY] || {})[origin]);
}

async function readAllowNextOrigins() {
  const result = await getStorageSession().get(ALLOW_NEXT_KEY);
  return result[ALLOW_NEXT_KEY] || {};
}

async function isAllowNextEnabled(origin) {
  if (!origin) {
    return false;
  }

  const allowNextOrigins = await readAllowNextOrigins();
  return Boolean(allowNextOrigins[origin]);
}

async function setAllowNextOrigin(origin, isEnabled) {
  if (!origin) {
    return false;
  }

  const allowNextOrigins = await readAllowNextOrigins();

  if (isEnabled) {
    allowNextOrigins[origin] = true;
  } else {
    delete allowNextOrigins[origin];
  }

  await getStorageSession().set({ [ALLOW_NEXT_KEY]: allowNextOrigins });
  await refreshBadge();
  return Boolean(allowNextOrigins[origin]);
}

async function consumeAllowNextOrigin(origin) {
  if (!(await isAllowNextEnabled(origin))) {
    return false;
  }

  await setAllowNextOrigin(origin, false);
  return true;
}

function createEmptyStats() {
  return {
    counts: { ...DEFAULT_STATS.counts },
    recentEvents: []
  };
}

function normalizeStats(stats) {
  const normalizedStats = createEmptyStats();

  if (!stats || typeof stats !== "object") {
    return normalizedStats;
  }

  normalizedStats.counts = {
    ...normalizedStats.counts,
    ...(stats.counts || {})
  };
  normalizedStats.recentEvents = Array.isArray(stats.recentEvents) ? stats.recentEvents : [];

  return normalizedStats;
}

async function readStats() {
  const result = await getStorageSession().get(STATS_KEY);
  return normalizeStats(result[STATS_KEY]);
}

async function writeStats(stats) {
  await getStorageSession().set({ [STATS_KEY]: normalizeStats(stats) });
}

async function recordProtectionEvent(eventType, details = {}, options = {}) {
  const eventDetails = EVENT_DETAILS[eventType];

  if (!eventDetails) {
    return;
  }

  if (options.pulse !== false) {
    await pulseBadge();
  }

  statsWriteQueue = statsWriteQueue.catch(() => {}).then(async () => {
    const stats = await readStats();

    for (const countKey of eventDetails.countKeys) {
      stats.counts[countKey] = (stats.counts[countKey] || 0) + 1;
    }

    stats.recentEvents = [
      {
        eventType,
        label: eventDetails.label,
        origin: details.origin || null,
        timestamp: Date.now()
      },
      ...stats.recentEvents
    ].slice(0, MAX_RECENT_EVENTS);

    await writeStats(stats);
  });

  await statsWriteQueue;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
    return true;
  } catch {
    // The tab may already be closed by the time the service worker runs.
    return false;
  }
}

function rememberPendingTab(tabId, origin) {
  forgetPendingTab(tabId);

  const timeoutId = setTimeout(() => {
    pendingProtectedTabs.delete(tabId);
  }, PENDING_TAB_TIMEOUT_MS);

  pendingProtectedTabs.set(tabId, { origin, timeoutId });
}

function forgetPendingTab(tabId) {
  const pendingTab = pendingProtectedTabs.get(tabId);

  if (pendingTab) {
    clearTimeout(pendingTab.timeoutId);
  }

  pendingProtectedTabs.delete(tabId);
}

async function closeIfOpenedByProtectedTab(openerTabId, openedTabId, targetUrl) {
  if (openerTabId == null || openedTabId == null) {
    return;
  }

  const openerTab = await getTab(openerTabId);
  const openerOrigin = openerTab && getOrigin(openerTab.url);

  if (!(await isOriginEnabled(openerOrigin))) {
    return;
  }

  const targetKind = getTargetKind(targetUrl);

  if (targetKind === "internal") {
    forgetPendingTab(openedTabId);
    return;
  }

  if (await consumeAllowNextOrigin(openerOrigin)) {
    await recordProtectionEvent("allowedNextTab", { origin: openerOrigin }, { pulse: false });
    chrome.tabs.sendMessage(openerTabId, {
      type: "ANTITABS_ALLOW_NEXT_STATE",
      allowNextTab: false
    }).catch(() => {});
    return;
  }

  if (targetKind === "unknown") {
    rememberPendingTab(openedTabId, openerOrigin);
    return;
  }

  if (await closeTab(openedTabId)) {
    await recordProtectionEvent("adTabClosed", { origin: openerOrigin });
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  updateActionIconForTab(tab);
  closeIfOpenedByProtectedTab(tab.openerTabId, tab.id, getTargetUrl(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateActionIconForTab(tab);
  }

  if (!pendingProtectedTabs.has(tabId)) {
    return;
  }

  const targetUrl = changeInfo.url || getTargetUrl(tab);
  const targetKind = getTargetKind(targetUrl);

  if (targetKind === "internal") {
    forgetPendingTab(tabId);
    return;
  }

  if (targetKind === "web") {
    const openerOrigin = pendingProtectedTabs.get(tabId).origin;
    forgetPendingTab(tabId);

    isAllowNextEnabled(openerOrigin).then((allowNextTab) => {
      if (!allowNextTab) {
        closeTab(tabId).then((wasClosed) => {
          if (wasClosed) {
            recordProtectionEvent("adTabClosed", { origin: openerOrigin });
          }
        });
        return;
      }

      consumeAllowNextOrigin(openerOrigin).then((wasConsumed) => {
        if (wasConsumed) {
          recordProtectionEvent("allowedNextTab", { origin: openerOrigin }, { pulse: false });
        }
      });
    });
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetPendingTab(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateActionIconForTabId(activeInfo.tabId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    updateAllActionIcons();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  updateAllActionIcons();
});

chrome.runtime.onStartup.addListener(() => {
  updateAllActionIcons();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type === undefined) {
    return false;
  }

  if (message.type === "ANTITABS_RECORD_EVENT") {
    const origin = message.origin || (sender.tab && getOrigin(sender.tab.url));
    recordProtectionEvent(message.eventType, { origin });
    return false;
  }

  if (message.type === "ANTITABS_GET_STATS") {
    readStats().then((stats) => sendResponse({ stats }));
    return true;
  }

  if (message.type === "ANTITABS_GET_ALLOW_NEXT") {
    isAllowNextEnabled(message.origin).then((allowNextTab) => sendResponse({ allowNextTab }));
    return true;
  }

  if (message.type === "ANTITABS_SET_ALLOW_NEXT") {
    setAllowNextOrigin(message.origin, Boolean(message.allowNextTab))
      .then((allowNextTab) => sendResponse({ allowNextTab }));
    return true;
  }

  return false;
});

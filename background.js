const STORAGE_KEY = "enabledOrigins";
const STATS_KEY = "sessionStats";
const ALLOW_NEXT_KEY = "allowNextTabOrigins";
const SETTINGS_KEY = "behaviorSettings";
const PENDING_STATE_KEY = "pendingSafariActions";
const MAX_RECENT_EVENTS = 8;
const PENDING_TAB_TIMEOUT_MS = 10000;
const DECISION_TIMEOUT_MS = 20000;
const BADGE_CLEAR_DELAY_MS = 3000;
const ALLOW_BADGE_TEXT = "1";
const DECISION_ALARM_PREFIX = "antitabs-decision:";
const TAB_ALARM_PREFIX = "antitabs-pending-tab:";
const SAFARI_CONTENT_SCRIPTS = [
  {
    id: "antitabs-page-guard",
    js: ["pageGuard.js"],
    matches: ["<all_urls>"],
    runAt: "document_start",
    allFrames: true,
    matchOriginAsFallback: true,
    world: "MAIN",
    persistAcrossSessions: true
  },
  {
    id: "antitabs-content",
    js: ["content.js"],
    matches: ["<all_urls>"],
    runAt: "document_start",
    allFrames: true,
    matchOriginAsFallback: true,
    world: "ISOLATED",
    persistAcrossSessions: true
  }
];
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
const openingTabUrls = new Map();
const pendingDecisions = new Map();
let nextDecisionId = 0;
let statsWriteQueue = Promise.resolve();
let allowNextWriteQueue = Promise.resolve();
let badgeCount = 0;
let badgeClearTimer = null;
let contentScriptRegistration = Promise.resolve();
let pendingStateWriteQueue = Promise.resolve();

const pendingStateReady = (async () => {
  const stored = (await getStorageSession().get(PENDING_STATE_KEY))[PENDING_STATE_KEY] || {};
  for (const decision of stored.decisions || []) {
    pendingDecisions.set(decision.promptId, decision);
  }
  for (const pendingTab of stored.tabs || []) {
    pendingProtectedTabs.set(pendingTab.tabId, pendingTab);
  }
})().catch((error) => {
  console.error("AntiTabs could not restore pending Safari actions", error);
});

function savePendingState() {
  const state = {
    decisions: [...pendingDecisions.values()].map(({ timeoutId, ...decision }) => decision),
    tabs: [...pendingProtectedTabs.entries()].map(([tabId, { timeoutId, ...tab }]) => ({
      tabId, ...tab
    }))
  };
  const write = pendingStateWriteQueue.catch(() => {}).then(async () => {
    await pendingStateReady;
    await getStorageSession().set({ [PENDING_STATE_KEY]: state });
  });
  pendingStateWriteQueue = write.catch(() => {});
  return write;
}

function ensureContentScripts() {
  const registration = contentScriptRegistration.catch(() => {}).then(async () => {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: SAFARI_CONTENT_SCRIPTS.map((script) => script.id)
    });
    const registeredIds = new Set(registered.map((script) => script.id));

    // Register the main-world guard first so it is ready when content.js sends state.
    const failedScripts = [];
    for (const script of SAFARI_CONTENT_SCRIPTS) {
      if (!registeredIds.has(script.id)) {
        try {
          await chrome.scripting.registerContentScripts([script]);
        } catch (error) {
          failedScripts.push({ id: script.id, error });
        }
      }
    }
    if (failedScripts.length) {
      throw new AggregateError(
        failedScripts.map(({ error }) => error),
        `Could not register Safari content scripts: ${failedScripts.map(({ id }) => id).join(", ")}`
      );
    }
  });
  contentScriptRegistration = registration.catch(() => {});
  return registration;
}

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
  newTabLinkOpened: {
    countKeys: [],
    label: "New-tab link opened in a new tab"
  },
  newTabLinkDismissed: {
    countKeys: [],
    label: "New-tab link left unopened"
  },
  popupTabAllowed: {
    countKeys: ["allowedTabs"],
    label: "Popup tab allowed after asking"
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

function getWebUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:"
      ? parsedUrl.href
      : null;
  } catch {
    return null;
  }
}

async function readBehaviorSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = result[SETTINGS_KEY] || {};
  return {
    linkHandling: settings.linkHandling === "current" ? "current" : "ask",
    confirmPopupTabs: settings.confirmPopupTabs === true
  };
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

async function shouldSkipIconUpdateForNewTab(tab) {
  if (!tab || tab.openerTabId == null) {
    return false;
  }

  const openerTab = await getTab(tab.openerTabId);
  const openerOrigin = openerTab && getOrigin(openerTab.url);

  if (!(await isOriginEnabled(openerOrigin))) {
    return false;
  }

  const targetKind = getTargetKind(getTargetUrl(tab));

  if (targetKind === "internal") {
    return false;
  }

  if (await isAllowNextEnabled(openerOrigin)) {
    return false;
  }

  return true;
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
  chrome.action.setBadgeTextColor?.({ color: "#111827" });
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
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });

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

async function notifyAllowNextState(origin, isEnabled) {
  let tabs;

  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  await Promise.all(tabs
    .filter((tab) => tab.id != null && getOrigin(tab.url) === origin)
    .map((tab) => chrome.tabs.sendMessage(tab.id, {
      type: "ANTITABS_ALLOW_NEXT_STATE",
      allowNextTab: isEnabled
    }).catch(() => {})));
}

function queueAllowNextChange(change) {
  const result = allowNextWriteQueue.catch(() => {}).then(change);
  allowNextWriteQueue = result.catch(() => {});
  return result;
}

async function setAllowNextOrigin(origin, isEnabled) {
  if (!origin) {
    return false;
  }

  return queueAllowNextChange(async () => {
    const allowNextOrigins = await readAllowNextOrigins();

    if (isEnabled) {
      allowNextOrigins[origin] = true;
    } else {
      delete allowNextOrigins[origin];
    }

    await getStorageSession().set({ [ALLOW_NEXT_KEY]: allowNextOrigins });
    await refreshBadge();
    await notifyAllowNextState(origin, isEnabled);
    return Boolean(allowNextOrigins[origin]);
  });
}

async function consumeAllowNextOrigin(origin) {
  if (!origin) {
    return false;
  }

  return queueAllowNextChange(async () => {
    const allowNextOrigins = await readAllowNextOrigins();

    if (!allowNextOrigins[origin]) {
      return false;
    }

    delete allowNextOrigins[origin];
    await getStorageSession().set({ [ALLOW_NEXT_KEY]: allowNextOrigins });
    await refreshBadge();
    await notifyAllowNextState(origin, false);
    return true;
  });
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

async function dismissDecisionInPage(decision) {
  try {
    await chrome.tabs.sendMessage(decision.openerTabId, {
      type: "ANTITABS_DISMISS_DECISION",
      promptId: decision.promptId
    }, { frameId: 0 });
  } catch {
    // The source page may have closed or navigated.
  }
}

async function resolveDecision(promptId, choice, respondingTabId = null) {
  await pendingStateReady;
  const decision = pendingDecisions.get(promptId);

  if (!decision || (respondingTabId != null && respondingTabId !== decision.openerTabId)) {
    return false;
  }

  if (decision.kind === "link" && !["current", "new", "stay"].includes(choice)) {
    return false;
  }

  if (decision.kind === "popup" && !["allow", "close"].includes(choice)) {
    return false;
  }

  pendingDecisions.delete(promptId);
  clearTimeout(decision.timeoutId);
  await savePendingState();
  await chrome.alarms.clear(`${DECISION_ALARM_PREFIX}${promptId}`).catch(() => {});

  if (respondingTabId == null) {
    await dismissDecisionInPage(decision);
  }

  if (decision.kind === "link") {
    if (choice === "current") {
      try {
        await chrome.tabs.update(decision.openerTabId, { url: decision.url });
        await recordProtectionEvent("newTabLinkKept", { origin: decision.origin });
      } catch {
        return false;
      }
    } else if (choice === "new") {
      try {
        await chrome.tabs.create({ url: decision.url });
        await recordProtectionEvent("newTabLinkOpened", { origin: decision.origin }, { pulse: false });
      } catch {
        return false;
      }
    } else {
      await recordProtectionEvent("newTabLinkDismissed", { origin: decision.origin }, { pulse: false });
    }

    return true;
  }

  if (choice === "allow") {
    try {
      await chrome.tabs.update(decision.popupTabId, { active: true });
      await recordProtectionEvent("popupTabAllowed", { origin: decision.origin }, { pulse: false });
      return true;
    } catch {
      return false;
    }
  }

  if (await closeTab(decision.popupTabId)) {
    await recordProtectionEvent("adTabClosed", { origin: decision.origin });
  }

  return true;
}

async function askForDecision(details) {
  await pendingStateReady;
  const promptId = `${Date.now()}-${++nextDecisionId}`;
  const defaultChoice = details.kind === "popup" ? "close" : "stay";
  const timeoutId = setTimeout(() => {
    resolveDecision(promptId, defaultChoice).catch(() => {});
  }, DECISION_TIMEOUT_MS);
  const decision = { ...details, promptId, timeoutId };
  pendingDecisions.set(promptId, decision);

  try {
    await savePendingState();
    await chrome.alarms.create(`${DECISION_ALARM_PREFIX}${promptId}`, {
      when: Date.now() + DECISION_TIMEOUT_MS
    });
  } catch {
    await resolveDecision(promptId, defaultChoice);
    return false;
  }

  try {
    await chrome.tabs.sendMessage(details.openerTabId, {
      type: "ANTITABS_SHOW_DECISION",
      promptId,
      kind: details.kind,
      origin: details.origin,
      url: details.url
    }, { frameId: 0 });
  } catch {
    await resolveDecision(promptId, defaultChoice);
    return false;
  }

  return true;
}

async function handleNewTabLink(url, sender) {
  const tabId = sender.tab && sender.tab.id;
  const origin = sender.tab && getOrigin(sender.tab.url);
  const webUrl = getWebUrl(url);

  if (tabId == null || !origin || !webUrl || !(await isOriginEnabled(origin))) {
    return false;
  }

  const settings = await readBehaviorSettings();

  if (settings.linkHandling === "current") {
    try {
      await chrome.tabs.update(tabId, { url: webUrl });
      await recordProtectionEvent("newTabLinkKept", { origin });
      return true;
    } catch {
      return false;
    }
  }

  return askForDecision({ kind: "link", openerTabId: tabId, origin, url: webUrl });
}

async function handlePopupTab(openerTabId, openedTabId, origin, targetUrl) {
  const settings = await readBehaviorSettings();

  if (!settings.confirmPopupTabs) {
    if (await closeTab(openedTabId)) {
      await recordProtectionEvent("adTabClosed", { origin });
    }
    return;
  }

  const popupTab = await getTab(openedTabId);

  if (!popupTab) {
    return;
  }

  try {
    if (popupTab.active) {
      await chrome.tabs.update(openerTabId, { active: true });
    }
  } catch {
    if (await closeTab(openedTabId)) {
      await recordProtectionEvent("adTabClosed", { origin });
    }
    return;
  }

  await askForDecision({
    kind: "popup",
    openerTabId,
    popupTabId: openedTabId,
    origin,
    url: getWebUrl(targetUrl)
  });
}

function rememberPendingTab(tabId, origin, openerTabId) {
  forgetPendingTab(tabId);

  const timeoutId = setTimeout(() => {
    const pendingTab = pendingProtectedTabs.get(tabId);
    forgetPendingTab(tabId);

    if (pendingTab) {
      handlePopupTab(openerTabId, tabId, origin, "").catch(() => {});
    }
  }, PENDING_TAB_TIMEOUT_MS);

  pendingProtectedTabs.set(tabId, { origin, openerTabId, timeoutId });
  savePendingState().catch(() => {});
  chrome.alarms.create(`${TAB_ALARM_PREFIX}${tabId}`, {
    when: Date.now() + PENDING_TAB_TIMEOUT_MS
  }).catch(() => {});
}

function forgetPendingTab(tabId) {
  const pendingTab = pendingProtectedTabs.get(tabId);

  if (pendingTab) {
    clearTimeout(pendingTab.timeoutId);
  }

  pendingProtectedTabs.delete(tabId);
  if (pendingTab) {
    savePendingState().catch(() => {});
    chrome.alarms.clear(`${TAB_ALARM_PREFIX}${tabId}`).catch(() => {});
  }
}

async function closeIfOpenedByProtectedTab(openerTabId, openedTabId, targetUrl) {
  await pendingStateReady;
  if (openerTabId == null || openedTabId == null) {
    return;
  }

  const openerTab = await getTab(openerTabId);
  const openerOrigin = openerTab && getOrigin(openerTab.url);

  if (!(await isOriginEnabled(openerOrigin))) {
    return;
  }

  let currentTargetUrl = openingTabUrls.get(openedTabId) || targetUrl;

  if (getTargetKind(currentTargetUrl) === "internal") {
    forgetPendingTab(openedTabId);
    return;
  }

  if (await consumeAllowNextOrigin(openerOrigin)) {
    await recordProtectionEvent("allowedNextTab", { origin: openerOrigin }, { pulse: false });
    return;
  }

  currentTargetUrl = openingTabUrls.get(openedTabId) || currentTargetUrl;
  const targetKind = getTargetKind(currentTargetUrl);

  if (targetKind === "internal") {
    return;
  }

  if (targetKind === "unknown") {
    rememberPendingTab(openedTabId, openerOrigin, openerTabId);
    return;
  }

  await handlePopupTab(openerTabId, openedTabId, openerOrigin, currentTargetUrl);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null) {
    openingTabUrls.set(tab.id, getTargetUrl(tab));
  }

  shouldSkipIconUpdateForNewTab(tab).then((shouldSkip) => {
    if (!shouldSkip) {
      updateActionIconForTab(tab);
    }
  }).catch(() => {});

  closeIfOpenedByProtectedTab(tab.openerTabId, tab.id, getTargetUrl(tab))
    .catch(() => {})
    .finally(() => openingTabUrls.delete(tab.id));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  pendingStateReady.then(() => handleUpdatedTab(tabId, changeInfo, tab)).catch(() => {});
});

function handleUpdatedTab(tabId, changeInfo, tab) {
  if (openingTabUrls.has(tabId)) {
    openingTabUrls.set(tabId, changeInfo.url || getTargetUrl(tab) || openingTabUrls.get(tabId));
  }

  const isPendingProtectedTab = pendingProtectedTabs.has(tabId);

  if (!isPendingProtectedTab && (changeInfo.url || changeInfo.status === "complete")) {
    updateActionIconForTab(tab);
  }

  if (!isPendingProtectedTab) {
    return;
  }

  const targetUrl = changeInfo.url || getTargetUrl(tab);
  const targetKind = getTargetKind(targetUrl);

  if (targetKind === "internal") {
    forgetPendingTab(tabId);
    return;
  }

  if (targetKind === "web" || targetKind === "blank") {
    const { origin, openerTabId } = pendingProtectedTabs.get(tabId);
    forgetPendingTab(tabId);

    consumeAllowNextOrigin(origin).then((wasConsumed) => {
      if (!wasConsumed) {
        handlePopupTab(openerTabId, tabId, origin, targetUrl).catch(() => {});
        return;
      }

      recordProtectionEvent("allowedNextTab", { origin }, { pulse: false });
    }).catch(() => {});
    return;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingStateReady.then(() => handleRemovedTab(tabId)).catch(() => {});
});

function handleRemovedTab(tabId) {
  openingTabUrls.delete(tabId);
  forgetPendingTab(tabId);

  for (const [promptId, decision] of pendingDecisions) {
    if (decision.openerTabId === tabId || decision.popupTabId === tabId) {
      pendingDecisions.delete(promptId);
      clearTimeout(decision.timeoutId);
      savePendingState().catch(() => {});
      chrome.alarms.clear(`${DECISION_ALARM_PREFIX}${promptId}`).catch(() => {});

      if (decision.popupTabId === tabId) {
        dismissDecisionInPage(decision);
      } else if (decision.kind === "popup") {
        closeTab(decision.popupTabId);
      }
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  pendingStateReady.then(async () => {
    if (alarm.name.startsWith(DECISION_ALARM_PREFIX)) {
      const promptId = alarm.name.slice(DECISION_ALARM_PREFIX.length);
      const decision = pendingDecisions.get(promptId);
      if (decision) {
        await resolveDecision(promptId, decision.kind === "popup" ? "close" : "stay");
      }
      return;
    }

    if (alarm.name.startsWith(TAB_ALARM_PREFIX)) {
      const tabId = Number(alarm.name.slice(TAB_ALARM_PREFIX.length));
      const pendingTab = pendingProtectedTabs.get(tabId);
      if (pendingTab) {
        forgetPendingTab(tabId);
        await handlePopupTab(pendingTab.openerTabId, tabId, pendingTab.origin, "");
      }
    }
  }).catch(() => {});
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
  ensureContentScripts().catch((error) => console.error("AntiTabs Safari setup failed", error));
  updateAllActionIcons();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContentScripts().catch((error) => console.error("AntiTabs Safari setup failed", error));
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

  if (message.type === "ANTITABS_HANDLE_LINK") {
    handleNewTabLink(message.url, sender)
      .then((handled) => sendResponse({ handled }))
      .catch(() => sendResponse({ handled: false }));
    return true;
  }

  if (message.type === "ANTITABS_RESOLVE_PROMPT") {
    if (!sender.tab || sender.tab.id == null || sender.frameId !== 0) {
      return false;
    }

    resolveDecision(message.promptId, message.choice, sender.tab.id)
      .then((resolved) => sendResponse({ resolved }))
      .catch(() => sendResponse({ resolved: false }));
    return true;
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

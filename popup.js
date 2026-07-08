const toggle = document.querySelector("#toggle");
const siteLabel = document.querySelector("#site");
const stateLabel = document.querySelector("#stateLabel");
const message = document.querySelector("#message");
const tabsClosedCount = document.querySelector("#tabsClosedCount");
const popupsBlockedCount = document.querySelector("#popupsBlockedCount");
const overlaysShieldedCount = document.querySelector("#overlaysShieldedCount");
const linksKeptCount = document.querySelector("#linksKeptCount");
const recentEvents = document.querySelector("#recentEvents");
const emptyStats = document.querySelector("#emptyStats");

const STORAGE_KEY = "enabledOrigins";
const STATS_KEY = "sessionStats";

let currentOrigin = null;
let currentTabId = null;

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

function setMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

function updateState(isEnabled) {
  toggle.checked = isEnabled;
  stateLabel.textContent = isEnabled ? "Protection on" : "Protection off";
}

function formatEventTime(timestamp) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function renderStats(stats) {
  const counts = (stats && stats.counts) || {};
  const events = (stats && stats.recentEvents) || [];

  tabsClosedCount.textContent = counts.tabsClosed || 0;
  popupsBlockedCount.textContent = counts.popupsBlocked || 0;
  overlaysShieldedCount.textContent = counts.overlaysShielded || 0;
  linksKeptCount.textContent = counts.linksKept || 0;

  recentEvents.replaceChildren();
  emptyStats.hidden = events.length > 0;

  for (const event of events) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const meta = document.createElement("span");

    label.textContent = event.label || "Protection applied";
    meta.textContent = [event.origin, event.timestamp && formatEventTime(event.timestamp)]
      .filter(Boolean)
      .join(" · ");

    item.append(label, meta);
    recentEvents.append(item);
  }
}

async function refreshStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ANTITABS_GET_STATS" });
    renderStats(response && response.stats);
  } catch {
    renderStats(null);
  }
}

async function readEnabledOrigins() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function setOriginEnabled(origin, isEnabled) {
  const enabledOrigins = await readEnabledOrigins();

  if (isEnabled) {
    enabledOrigins[origin] = true;
  } else {
    delete enabledOrigins[origin];
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: enabledOrigins });
}

async function notifyActiveTab(isEnabled) {
  if (!currentTabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(currentTabId, {
      type: "ANTITABS_STATE",
      enabled: isEnabled
    });
  } catch {
    // The content script may not be available on browser-owned pages.
  }
}

async function initialize() {
  await refreshStats();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url) {
    siteLabel.textContent = "No active website found.";
    setMessage("Open a website tab to use AntiTabs.");
    return;
  }

  currentTabId = tab.id;
  currentOrigin = getOrigin(tab.url);

  if (!currentOrigin) {
    siteLabel.textContent = "This page is not a website.";
    setMessage("AntiTabs works on http and https pages.");
    return;
  }

  siteLabel.textContent = currentOrigin;
  const enabledOrigins = await readEnabledOrigins();
  updateState(Boolean(enabledOrigins[currentOrigin]));
  toggle.disabled = false;
}

toggle.addEventListener("change", async () => {
  if (!currentOrigin) {
    return;
  }

  const isEnabled = toggle.checked;
  updateState(isEnabled);
  await setOriginEnabled(currentOrigin, isEnabled);
  await notifyActiveTab(isEnabled);
  await refreshStats();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes[STATS_KEY]) {
    renderStats(changes[STATS_KEY].newValue);
  }
});

initialize().catch(() => {
  siteLabel.textContent = "AntiTabs could not load.";
  setMessage("Try reopening the popup on a website tab.");
  refreshStats();
});

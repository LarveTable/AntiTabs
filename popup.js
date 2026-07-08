const toggle = document.querySelector("#toggle");
const siteLabel = document.querySelector("#site");
const stateLabel = document.querySelector("#stateLabel");
const message = document.querySelector("#message");

const STORAGE_KEY = "enabledOrigins";

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
});

initialize().catch(() => {
  siteLabel.textContent = "AntiTabs could not load.";
  setMessage("Try reopening the popup on a website tab.");
});

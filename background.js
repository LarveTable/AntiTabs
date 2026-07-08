const STORAGE_KEY = "enabledOrigins";

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

async function isOriginEnabled(origin) {
  if (!origin) {
    return false;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Boolean((result[STORAGE_KEY] || {})[origin]);
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null || tab.id == null) {
    return;
  }

  const openerTab = await getTab(tab.openerTabId);
  const openerOrigin = openerTab && getOrigin(openerTab.url);

  if (await isOriginEnabled(openerOrigin)) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // The tab may already be closed by the time the service worker runs.
    }
  }
});

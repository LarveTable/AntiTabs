const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const ORIGIN = "https://example.com";
const LINK = "https://destination.example/path";
const POPUP = "https://ads.example/offer";

function createBackground(settings) {
  const data = {
    enabledOrigins: { [ORIGIN]: true },
    allowNextTabOrigins: {},
    ...(settings && { behaviorSettings: settings })
  };
  const tabs = new Map([
    [10, { id: 10, url: `${ORIGIN}/page`, active: true }],
    [20, { id: 20, url: POPUP, active: true, openerTabId: 10 }]
  ]);
  const sent = [];
  const updated = [];
  const created = [];
  const removed = [];
  const timers = new Map();
  const listeners = {};
  let timerId = 0;
  const on = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const storage = {
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
  const chrome = {
    storage: { local: storage, session: storage, onChanged: on("storageChanged") },
    tabs: {
      onCreated: on("tabCreated"),
      onUpdated: on("tabUpdated"),
      onRemoved: on("tabRemoved"),
      onActivated: on("tabActivated"),
      async get(id) {
        if (!tabs.has(id)) throw new Error("Tab not found");
        return tabs.get(id);
      },
      async query() { return [...tabs.values()]; },
      async sendMessage(tabId, message, options) { sent.push({ tabId, message, options }); },
      async update(tabId, changes) {
        if (!tabs.has(tabId)) throw new Error("Tab not found");
        updated.push({ tabId, changes: structuredClone(changes) });
        Object.assign(tabs.get(tabId), changes);
        if (changes.active) {
          for (const [id, tab] of tabs) if (id !== tabId) tab.active = false;
        }
        return tabs.get(tabId);
      },
      async create(options) {
        created.push(structuredClone(options));
        return { id: 30 + created.length, ...options };
      },
      async remove(tabId) { removed.push(tabId); tabs.delete(tabId); }
    },
    runtime: { onInstalled: on("installed"), onStartup: on("startup"), onMessage: on("message") },
    action: {
      async setIcon() {},
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {}
    }
  };
  const context = vm.createContext({
    chrome,
    URL,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(code, context);

  return {
    data, tabs, sent, updated, created, removed, timers, listeners,
    call(expression) { return vm.runInContext(expression, context); },
    message(message, sender = { tab: tabs.get(10), frameId: 0 }) {
      return new Promise((resolve) => {
        const asyncResponse = listeners.message(message, sender, (response) => resolve(structuredClone(response)));
        if (!asyncResponse) resolve(undefined);
      });
    },
    prompt() {
      return sent.findLast(({ message }) => message.type === "ANTITABS_SHOW_DECISION")?.message;
    },
    async fireTimer(delay) {
      const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay) || [];
      assert.ok(timer, `Expected a ${delay} ms timer`);
      timers.delete(id);
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test("new-tab links ask first by default and stay unopened when declined", async () => {
  const bg = createBackground();
  assert.deepEqual(await bg.message({ type: "ANTITABS_HANDLE_LINK", url: LINK }), { handled: true });
  assert.equal(bg.prompt().kind, "link");
  assert.equal(bg.prompt().url, LINK);
  assert.deepEqual(bg.updated, []);
  assert.deepEqual(bg.created, []);

  const result = await bg.message({
    type: "ANTITABS_RESOLVE_PROMPT", promptId: bg.prompt().promptId, choice: "stay"
  });
  assert.deepEqual(result, { resolved: true });
  assert.deepEqual(bg.updated, []);
  assert.deepEqual(bg.created, []);
  assert.equal(bg.data.sessionStats.recentEvents[0].eventType, "newTabLinkDismissed");
});

test("link prompt can open here or in a new tab", async () => {
  const here = createBackground();
  await here.message({ type: "ANTITABS_HANDLE_LINK", url: LINK });
  await here.message({ type: "ANTITABS_RESOLVE_PROMPT", promptId: here.prompt().promptId, choice: "current" });
  assert.deepEqual(here.updated, [{ tabId: 10, changes: { url: LINK } }]);
  assert.equal(here.data.sessionStats.counts.linksKept, 1);

  const separate = createBackground();
  await separate.message({ type: "ANTITABS_HANDLE_LINK", url: LINK });
  await separate.message({ type: "ANTITABS_RESOLVE_PROMPT", promptId: separate.prompt().promptId, choice: "new" });
  assert.deepEqual(separate.created, [{ url: LINK }]);
  assert.deepEqual(separate.updated, []);
  assert.equal(separate.data.sessionStats.recentEvents[0].eventType, "newTabLinkOpened");
});

test("legacy link setting opens here immediately and invalid links are ignored", async () => {
  const bg = createBackground({ linkHandling: "current" });
  assert.deepEqual(await bg.message({ type: "ANTITABS_HANDLE_LINK", url: LINK }), { handled: true });
  assert.deepEqual(bg.updated, [{ tabId: 10, changes: { url: LINK } }]);
  assert.equal(bg.prompt(), undefined);
  assert.deepEqual(await bg.message({ type: "ANTITABS_HANDLE_LINK", url: "javascript:alert(1)" }), { handled: false });
});

test("popup closer remains automatic by default", async () => {
  const bg = createBackground();
  await bg.call(`handlePopupTab(10, 20, "${ORIGIN}", "${POPUP}")`);
  assert.deepEqual(bg.removed, [20]);
  assert.equal(bg.prompt(), undefined);
  assert.equal(bg.data.sessionStats.counts.tabsClosed, 1);
});

test("popup confirmation keeps the tab until allowed or closed", async () => {
  const allowed = createBackground({ confirmPopupTabs: true });
  await allowed.call(`handlePopupTab(10, 20, "${ORIGIN}", "${POPUP}")`);
  assert.deepEqual(allowed.removed, []);
  assert.deepEqual(allowed.updated, [{ tabId: 10, changes: { active: true } }]);
  assert.equal(allowed.prompt().kind, "popup");
  await allowed.message({
    type: "ANTITABS_RESOLVE_PROMPT", promptId: allowed.prompt().promptId, choice: "allow"
  });
  assert.deepEqual(allowed.updated.at(-1), { tabId: 20, changes: { active: true } });
  assert.deepEqual(allowed.removed, []);
  assert.equal(allowed.data.sessionStats.recentEvents[0].eventType, "popupTabAllowed");

  const closed = createBackground({ confirmPopupTabs: true });
  await closed.call(`handlePopupTab(10, 20, "${ORIGIN}", "${POPUP}")`);
  await closed.message({
    type: "ANTITABS_RESOLVE_PROMPT", promptId: closed.prompt().promptId, choice: "close"
  });
  assert.deepEqual(closed.removed, [20]);
  assert.equal(closed.data.sessionStats.counts.tabsClosed, 1);
});

test("unanswered popup prompt closes the tab and rejects other tabs' answers", async () => {
  const bg = createBackground({ confirmPopupTabs: true });
  await bg.call(`handlePopupTab(10, 20, "${ORIGIN}", "${POPUP}")`);
  assert.deepEqual(await bg.message(
    { type: "ANTITABS_RESOLVE_PROMPT", promptId: bg.prompt().promptId, choice: "allow" },
    { tab: { id: 999 }, frameId: 0 }
  ), { resolved: false });
  assert.deepEqual(bg.removed, []);
  await bg.fireTimer(20000);
  assert.deepEqual(bg.removed, [20]);
  assert.ok(bg.sent.some(({ message }) => message.type === "ANTITABS_DISMISS_DECISION"));
});

test("Allow once still bypasses popup confirmation", async () => {
  const bg = createBackground({ confirmPopupTabs: true });
  bg.data.allowNextTabOrigins = { [ORIGIN]: true };
  await bg.call(`closeIfOpenedByProtectedTab(10, 20, "${POPUP}")`);
  assert.deepEqual(bg.removed, []);
  assert.equal(bg.prompt(), undefined);
  assert.equal(bg.data.sessionStats.counts.allowedTabs, 1);
  assert.deepEqual(bg.data.allowNextTabOrigins, {});
});

test("a destination reported during onCreated is still prompted", async () => {
  const bg = createBackground({ confirmPopupTabs: true });
  const newTab = bg.tabs.get(20);
  newTab.url = "";
  bg.listeners.tabCreated({ ...newTab });
  newTab.url = POPUP;
  bg.listeners.tabUpdated(20, { url: POPUP }, { ...newTab });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bg.prompt().url, POPUP);
  assert.deepEqual(bg.removed, []);
});

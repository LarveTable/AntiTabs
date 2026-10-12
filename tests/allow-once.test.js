const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundCode = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const ORIGIN = "https://example.com";

function createBackground(initialAllowance = true) {
  const data = {
    allowNextTabOrigins: initialAllowance ? { [ORIGIN]: true } : {}
  };
  const removedTabs = [];
  const sentMessages = [];
  const listeners = {};
  const on = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const storage = {
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
  const chrome = {
    storage: { session: storage, local: storage, onChanged: on("storageChanged") },
    tabs: {
      onCreated: on("tabCreated"),
      onUpdated: on("tabUpdated"),
      onRemoved: on("tabRemoved"),
      onActivated: on("tabActivated"),
      async query() { return [{ id: 10, url: ORIGIN }, { id: 11, url: "https://other.example" }]; },
      async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); },
      async remove(tabId) { removedTabs.push(tabId); }
    },
    runtime: {
      onInstalled: on("installed"),
      onStartup: on("startup"),
      onMessage: on("message")
    },
    alarms: {
      onAlarm: on("alarm"),
      async create() {},
      async clear() { return true; }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {}
    }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(backgroundCode, context);

  return {
    data,
    removedTabs,
    sentMessages,
    listeners,
    call(expression) { return vm.runInContext(expression, context); }
  };
}

test("concurrent consumers can claim an allowance only once", async () => {
  const background = createBackground();
  const results = await Promise.all([
    background.call(`consumeAllowNextOrigin("${ORIGIN}")`),
    background.call(`consumeAllowNextOrigin("${ORIGIN}")`)
  ]);

  assert.deepEqual(results, [true, false]);
  assert.deepEqual(background.data.allowNextTabOrigins, {});
});

test("arming and consuming in order preserves the next allowance", async () => {
  const background = createBackground(false);
  const results = await Promise.all([
    background.call(`setAllowNextOrigin("${ORIGIN}", true)`),
    background.call(`consumeAllowNextOrigin("${ORIGIN}")`),
    background.call(`consumeAllowNextOrigin("${ORIGIN}")`)
  ]);

  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(background.data.allowNextTabOrigins, {});
});

test("two pending tabs opened together leave only one tab open", async () => {
  const background = createBackground();
  background.call(`rememberPendingTab(1, "${ORIGIN}")`);
  background.call(`rememberPendingTab(2, "${ORIGIN}")`);

  background.listeners.tabUpdated(1, { url: "https://ads.example/one" }, { id: 1, url: "https://ads.example/one" });
  background.listeners.tabUpdated(2, { url: "https://ads.example/two" }, { id: 2, url: "https://ads.example/two" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(background.removedTabs.length, 1);
  assert.deepEqual(background.data.allowNextTabOrigins, {});
  assert.equal(background.data.sessionStats.counts.allowedTabs, 1);
  assert.equal(background.data.sessionStats.counts.tabsClosed, 1);
});

test("allowance changes notify only tabs on the protected site", async () => {
  const background = createBackground(false);
  await background.call(`setAllowNextOrigin("${ORIGIN}", true)`);
  await background.call(`consumeAllowNextOrigin("${ORIGIN}")`);

  assert.deepEqual(background.sentMessages.map(({ tabId, message }) => [tabId, message.allowNextTab]), [
    [10, true],
    [10, false]
  ]);
});

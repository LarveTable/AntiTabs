const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("Safari registers both early scripts with their original worlds and frame coverage", async () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(manifest.browser_specific_settings.safari.strict_min_version, "18.4");
  const listeners = {};
  const scripts = [];
  const on = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const storage = { async get() { return {}; }, async set() {} };
  const chrome = {
    scripting: {
      async getRegisteredContentScripts() { return scripts; },
      async registerContentScripts(definitions) { scripts.push(...definitions); }
    },
    storage: { local: storage, session: storage, onChanged: on("storageChanged") },
    tabs: {
      onCreated: on("tabCreated"), onUpdated: on("tabUpdated"),
      onRemoved: on("tabRemoved"), onActivated: on("tabActivated"),
      async query() { return []; }
    },
    alarms: { onAlarm: on("alarm") },
    runtime: { onInstalled: on("installed"), onStartup: on("startup"), onMessage: on("message") },
    action: {}
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(background, context);
  await vm.runInContext("ensureContentScripts()", context);

  assert.deepEqual(structuredClone(scripts.map(({ id, js, world }) => ({ id, js, world }))), [
    { id: "antitabs-page-guard", js: ["pageGuard.js"], world: "MAIN" },
    { id: "antitabs-content", js: ["content.js"], world: "ISOLATED" }
  ]);
  for (const script of scripts) {
    assert.equal(script.runAt, "document_start");
    assert.equal(script.allFrames, true);
    assert.equal(script.matchOriginAsFallback, true);
    assert.equal(script.persistAcrossSessions, true);
    assert.deepEqual(structuredClone(script.matches), ["<all_urls>"]);
  }

  await vm.runInContext("ensureContentScripts()", context);
  assert.equal(scripts.length, 2);
});

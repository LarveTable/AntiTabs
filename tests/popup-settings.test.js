const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");

function createPopup(initialSettings) {
  const controls = new Map();
  const data = initialSettings ? { behaviorSettings: initialSettings } : {};
  const changes = [];

  function control(selector) {
    if (!controls.has(selector)) {
      controls.set(selector, {
        value: "ask",
        checked: false,
        hidden: false,
        disabled: false,
        textContent: "",
        listeners: new Map(),
        classList: { toggle() {} },
        addEventListener(name, listener) { this.listeners.set(name, listener); },
        replaceChildren() {},
        append() {}
      });
    }
    return controls.get(selector);
  }

  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(value) { changes.push(structuredClone(value)); Object.assign(data, structuredClone(value)); }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      async query() { return [{ id: 10, url: "https://example.com" }]; },
      async sendMessage() {}
    },
    runtime: {
      async sendMessage(message) {
        if (message.type === "ANTITABS_GET_STATS") return { stats: null };
        if (message.type === "ANTITABS_GET_ALLOW_NEXT") return { allowNextTab: false };
        return {};
      }
    }
  };
  const document = {
    querySelector: control,
    createElement: () => ({ append() {} })
  };
  const context = vm.createContext({ chrome, document, URL, Intl, Date });
  vm.runInContext(code, context);

  return {
    data, changes,
    control,
    call(expression) { return vm.runInContext(expression, context); }
  };
}

test("global settings default to asking for links and automatic popup closing", async () => {
  const popup = createPopup();
  await popup.call("initialize()");
  assert.equal(popup.control("#linkHandling").value, "ask");
  assert.equal(popup.control("#confirmPopupTabs").checked, false);
});

test("both global behavior settings are saved together", async () => {
  const popup = createPopup({ linkHandling: "current", confirmPopupTabs: false });
  await popup.call("initialize()");
  assert.equal(popup.control("#linkHandling").value, "current");
  popup.control("#confirmPopupTabs").checked = true;
  popup.control("#confirmPopupTabs").listeners.get("change")();
  await popup.call("settingsWriteQueue");

  assert.deepEqual(popup.changes.at(-1), {
    behaviorSettings: { linkHandling: "current", confirmPopupTabs: true }
  });
  popup.control("#linkHandling").value = "ask";
  popup.control("#linkHandling").listeners.get("change")();
  await popup.call("settingsWriteQueue");
  assert.deepEqual(popup.data.behaviorSettings, {
    linkHandling: "ask", confirmPopupTabs: true
  });
});

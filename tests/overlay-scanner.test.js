const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentCode = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const ORIGIN = "https://example.com";

class FakeElement {
  constructor(tagName = "div", options = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.parentElement = null;
    this.children = [];
    this.isConnected = false;
    this.textContent = "";
    this.attributes = new Map();
    this.style = {
      pointerEvents: "",
      removeProperty(name) {
        if (name === "pointer-events") this.pointerEvents = "";
      }
    };
    this.computedStyle = {
      pointerEvents: "auto",
      display: "block",
      visibility: "visible",
      position: "static",
      zIndex: "auto",
      backgroundColor: "rgb(255, 255, 255)",
      opacity: "1",
      ...options.style
    };
    this.rect = options.rect || { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    this.clientWidth = options.clientWidth || 0;
    this.clientHeight = options.clientHeight || 0;
  }

  append(child) {
    child.parentElement = this;
    child.setConnected(this.isConnected);
    this.children.push(child);
  }

  setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected(connected);
  }

  contains(other) {
    return this === other || this.children.some((child) => child.contains(other));
  }

  querySelectorAll(selector) {
    assert.equal(selector, "*");
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }

  querySelector() { return null; }
  getBoundingClientRect() { return this.rect; }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}

class FakeIframe extends FakeElement {
  constructor(options) { super("iframe", options); }
}

function createContent(initialElements = []) {
  const html = new FakeElement("html", { clientWidth: 1000, clientHeight: 800 });
  html.setConnected(true);
  const body = new FakeElement("body");
  html.append(body);
  for (const element of initialElements) body.append(element);

  const timers = new Map();
  const windowListeners = new Map();
  let nextTimerId = 1;
  let styleReads = 0;
  let observer;
  let runtimeMessage;
  const pageMessages = [];
  const windowObject = {
    innerWidth: 1000,
    innerHeight: 800,
    location: { ancestorOrigins: [] },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    removeEventListener(name) { windowListeners.delete(name); },
    postMessage(message) { pageMessages.push(message); }
  };
  windowObject.top = windowObject;

  class FakeObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }

  const chrome = {
    storage: {
      local: { async get() { return { enabledOrigins: { [ORIGIN]: true } }; } },
      onChanged: { addListener() {} }
    },
    runtime: {
      async sendMessage(message) {
        return message.type === "ANTITABS_GET_ALLOW_NEXT" ? { allowNextTab: false } : undefined;
      },
      onMessage: { addListener(listener) { runtimeMessage = listener; } }
    }
  };
  const context = vm.createContext({
    window: windowObject,
    location: { protocol: "https:", origin: ORIGIN },
    document: { documentElement: html, body, addEventListener() {} },
    chrome,
    Node: { ELEMENT_NODE: 1 },
    HTMLIFrameElement: FakeIframe,
    MutationObserver: FakeObserver,
    getComputedStyle(element) {
      styleReads += 1;
      return {
        ...element.computedStyle,
        pointerEvents: element.style.pointerEvents || element.computedStyle.pointerEvents
      };
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    URL
  });
  vm.runInContext(contentCode, context);

  return {
    body,
    pageMessages,
    windowListeners,
    get runtimeMessage() { return runtimeMessage; },
    get observer() { return observer; },
    get styleReads() { return styleReads; },
    resetStyleReads() { styleReads = 0; },
    call(expression) { return vm.runInContext(expression, context); },
    runTimers() {
      for (let pass = 0; pass < 5 && timers.size; pass += 1) {
        const callbacks = [...timers.values()];
        timers.clear();
        for (const callback of callbacks) callback();
      }
    }
  };
}

function transparentLayer() {
  return new FakeElement("div", {
    style: { position: "fixed", zIndex: "2147480000", opacity: "0" },
    rect: { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }
  });
}

async function ready(content) {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(content.observer.active, true);
}

test("batched insertions scan the new subtree instead of the whole page", async () => {
  const content = createContent(Array.from({ length: 200 }, () => new FakeElement()));
  await ready(content);
  content.resetStyleReads();
  const layer = transparentLayer();
  content.body.append(layer);
  const mutation = { type: "childList", target: content.body, addedNodes: [layer], removedNodes: [] };
  content.observer.callback([mutation, mutation, mutation]);
  content.runTimers();

  assert.equal(layer.style.pointerEvents, "none");
  assert.equal(layer.hasAttribute("data-antitabs-element-shielded"), true);
  assert.equal(content.styleReads, 1);
});

test("style changes shield and restore an existing layer", async () => {
  const layer = transparentLayer();
  layer.computedStyle.opacity = "1";
  const content = createContent([layer]);
  await ready(content);
  assert.equal(layer.hasAttribute("data-antitabs-element-shielded"), false);

  layer.computedStyle.opacity = "0";
  content.observer.callback([{ type: "attributes", target: layer, attributeName: "style" }]);
  content.runTimers();
  assert.equal(layer.style.pointerEvents, "none");

  layer.computedStyle.opacity = "1";
  content.observer.callback([{ type: "attributes", target: layer, attributeName: "style" }]);
  content.runTimers();
  assert.equal(layer.style.pointerEvents, "");
  assert.equal(layer.hasAttribute("data-antitabs-element-shielded"), false);
});

test("scroll checks tracked candidates and disabling restores shielded elements", async () => {
  const iframe = new FakeIframe({
    style: { opacity: "0.01" },
    rect: { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }
  });
  const content = createContent([...Array.from({ length: 200 }, () => new FakeElement()), iframe]);
  await ready(content);
  assert.equal(iframe.style.pointerEvents, "none");

  content.resetStyleReads();
  content.windowListeners.get("scroll")();
  content.runTimers();
  assert.ok(content.styleReads < 10, `scroll read styles ${content.styleReads} times`);

  content.call("antiTabsEnabled = false; updateOverlayShield()");
  assert.equal(iframe.style.pointerEvents, "");
  assert.equal(iframe.hasAttribute("data-antitabs-shielded"), false);
  assert.equal(content.observer.active, false);
});

test("removing a shielded layer releases its pointer behavior", async () => {
  const layer = transparentLayer();
  const content = createContent([layer]);
  await ready(content);
  assert.equal(layer.style.pointerEvents, "none");

  layer.setConnected(false);
  content.observer.callback([{
    type: "childList",
    target: content.body,
    addedNodes: [],
    removedNodes: [layer]
  }]);
  content.runTimers();

  assert.equal(layer.style.pointerEvents, "");
  assert.equal(layer.hasAttribute("data-antitabs-element-shielded"), false);
});

test("resize rescans existing elements that become fixed by CSS", async () => {
  const layer = transparentLayer();
  layer.computedStyle.position = "static";
  const content = createContent([layer]);
  await ready(content);
  assert.equal(layer.style.pointerEvents, "");

  layer.computedStyle.position = "fixed";
  content.windowListeners.get("resize")();
  content.runTimers();

  assert.equal(layer.style.pointerEvents, "none");
});

test("background allowance messages update the page guard state", async () => {
  const content = createContent();
  await ready(content);

  content.runtimeMessage({ type: "ANTITABS_ALLOW_NEXT_STATE", allowNextTab: true });
  assert.equal(content.pageMessages.at(-1).allowNextTab, true);

  content.runtimeMessage({ type: "ANTITABS_ALLOW_NEXT_STATE", allowNextTab: false });
  assert.equal(content.pageMessages.at(-1).allowNextTab, false);
});

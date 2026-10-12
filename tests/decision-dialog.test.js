const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }

  attachShadow() {
    this.shadow = new Element("shadow");
    return this.shadow;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelector(selector) {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    return [this, ...this.children.flatMap((child) => child.querySelectorAll(selector))]
      .filter((element) => selector === "button" && element.tagName === "BUTTON");
  }

  focus() { this.focused = true; }
  click() { this.listeners.get("click")(); }
}

function elements(root, tag) {
  return [root, ...root.children.flatMap((child) => elements(child, tag))]
    .filter((element) => element.tagName === tag.toUpperCase());
}

function createContent() {
  const html = new Element("html");
  const documentListeners = new Map();
  const messages = [];
  let runtimeMessage;
  const windowObject = {
    location: { ancestorOrigins: [] },
    postMessage() {},
    addEventListener() {},
    removeEventListener() {}
  };
  windowObject.top = windowObject;
  const chrome = {
    storage: {
      local: { async get() { return { enabledOrigins: {} }; } },
      onChanged: { addListener() {} }
    },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        return message.type === "ANTITABS_GET_ALLOW_NEXT" ? { allowNextTab: false } : {};
      },
      onMessage: { addListener(listener) { runtimeMessage = listener; } }
    }
  };
  const context = vm.createContext({
    document: {
      documentElement: html,
      body: new Element("body"),
      createElement(tag) { return new Element(tag); },
      addEventListener(name, listener) { documentListeners.set(name, listener); }
    },
    window: windowObject,
    location: { protocol: "https:", origin: "https://example.com" },
    chrome,
    URL,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(code, context);

  return {
    html, messages, documentListeners,
    runtimeMessage(message) { runtimeMessage(message); },
    call(expression) { return vm.runInContext(expression, context); },
    buttons() { return html.children.flatMap((host) => elements(host.shadow, "button")); }
  };
}

test("new-tab link clicks ask the background without navigating the page", () => {
  const content = createContent();
  content.call("antiTabsEnabled = true");
  const anchor = { href: "https://destination.example/path", target: "_blank", closest() { return this; } };
  const event = {
    target: anchor,
    button: 0,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };

  content.documentListeners.get("click")(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(content.messages.at(-1), {
    type: "ANTITABS_HANDLE_LINK", url: "https://destination.example/path"
  });
});

test("link dialog offers all three choices and sends the selected answer", () => {
  const content = createContent();
  content.runtimeMessage({
    type: "ANTITABS_SHOW_DECISION", promptId: "one", kind: "link",
    origin: "https://example.com", url: "https://destination.example/path"
  });
  assert.deepEqual(content.buttons().map((button) => button.textContent), [
    "Stay here", "Open new tab", "Open here"
  ]);
  assert.equal(content.buttons()[0].focused, true);
  const buttons = content.buttons();
  const shadow = content.html.children[0].shadow;
  shadow.listeners.get("keydown")({
    key: "Tab", shiftKey: true, target: buttons[0],
    preventDefault() { this.prevented = true; }
  });
  assert.equal(buttons.at(-1).focused, true);
  content.buttons()[1].click();
  assert.deepEqual(content.messages.at(-1), {
    type: "ANTITABS_RESOLVE_PROMPT", promptId: "one", choice: "new"
  });
  assert.equal(content.html.children.length, 0);
});

test("popup dialog queues and can be dismissed when the tab closes", () => {
  const content = createContent();
  const popup = (promptId) => ({
    type: "ANTITABS_SHOW_DECISION", promptId, kind: "popup",
    origin: "https://example.com", url: "https://ads.example"
  });
  content.runtimeMessage(popup("one"));
  content.runtimeMessage(popup("two"));
  assert.deepEqual(content.buttons().map((button) => button.textContent), ["Close tab", "Allow tab"]);
  assert.equal(content.html.children.length, 1);
  content.runtimeMessage({ type: "ANTITABS_DISMISS_DECISION", promptId: "one" });
  assert.equal(content.html.children.length, 1);
  content.buttons()[0].click();
  assert.deepEqual(content.messages.at(-1), {
    type: "ANTITABS_RESOLVE_PROMPT", promptId: "two", choice: "close"
  });
});

test("long popup URLs show only their beginning while the buttons remain available", () => {
  const content = createContent();
  const fullUrl = `https://ads.example/${"a".repeat(10000)}`;
  content.runtimeMessage({
    type: "ANTITABS_SHOW_DECISION", promptId: "long", kind: "popup",
    origin: "https://example.com", url: fullUrl
  });

  const displayedUrl = elements(content.html.children[0].shadow, "p")
    .find((element) => element.className === "url").textContent;
  assert.equal(displayedUrl, `${fullUrl.slice(0, 120)}…`);
  assert.deepEqual(content.buttons().map((button) => button.textContent), ["Close tab", "Allow tab"]);
});

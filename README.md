# AntiTabs

AntiTabs is a browser extension that helps stop websites from opening unwanted tabs while you click around a page.

Current Edge version: **0.1.14**.

It is built for sites that use popups, hidden frames, transparent click layers, or forced `target="_blank"` navigation to push ads into new tabs. Protection is enabled per website from the toolbar popup, so you can keep it active only where you need it.

## Features

- Blocks script-opened popup tabs from protected websites.
- Asks where to open new-tab links by default: here, in a new tab, or nowhere. You can restore the previous automatic **Open in this tab** behavior in Settings.
- Closes detected popup tabs by default. An optional global setting keeps a detected tab in the background and asks whether to allow or close it.
- Neutralizes suspicious invisible iframes and transparent full-page click layers, scanning page changes as they occur.
- Shows session statistics for blocked popups, closed tabs, cleared overlays, and links kept in place.
- Pulses the toolbar badge when protection catches something.
- Includes an **Allow once** mode for sites that intentionally require one new tab to open before continuing.

## Allow Once

Some sites gate a feature behind a new-tab navigation. When protection is on, use **Allow once** to let the next new tab open from the current website.

After that single tab is allowed, AntiTabs automatically returns to normal blocking. The toolbar badge shows `1` while the allowance is armed.

## Link And Popup Decisions

The two behavior settings in the toolbar popup apply to every website where protection is enabled. **New-tab links** defaults to **Ask first**. **Ask about popup tabs** is off by default, so the popup tab closer continues to close detected tabs automatically.

When popup confirmation is enabled, AntiTabs keeps the created tab in the background while showing a decision on the original page. Allowing it activates that same tab; declining closes it. An unanswered decision expires after 20 seconds. A new-tab link decision expires without opening the link, while an unanswered popup decision closes the tab.

Decision dialogs show only the beginning of long destination URLs so the buttons stay visible. AntiTabs still uses the complete URL if you choose to open it.

The popup confirmation setting applies to tabs that the browser has already created. Script popups blocked before tab creation are still blocked immediately. **Allow once** bypasses popup confirmation for one tab.

## Load Locally In Microsoft Edge

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select this project folder, or extract the release ZIP and select the extracted folder.

## Tests

Run `node --test tests/*.test.js` from the project folder.

## Release Package

The locally generated, versioned ZIP in `dist/` contains only the extension files: the manifest, scripts, popup, and icons. It is ignored by Git. Extract it before using **Load unpacked** in Edge.

## Notes

This branch targets Microsoft Edge while the extension is still being developed. The core behavior is intentionally browser-agnostic so it can be ported to other browsers later.

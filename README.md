# AntiTabs

AntiTabs is a browser extension that helps stop websites from opening unwanted tabs while you click around a page.

It is built for sites that use popups, hidden frames, transparent click layers, or forced `target="_blank"` navigation to push ads into new tabs. Protection is enabled per website from the toolbar popup, so you can keep it active only where you need it.

## Features

- Blocks script-opened popup tabs from protected websites.
- Keeps new-tab links in the current tab when protection is active.
- Neutralizes suspicious invisible iframes and transparent full-page click layers.
- Shows session statistics for blocked popups, closed tabs, cleared overlays, and links kept in place.
- Pulses the toolbar badge when protection catches something.
- Includes an **Allow once** mode for sites that intentionally require one new tab to open before continuing.

## Allow Once

Some sites gate a feature behind a new-tab navigation. When protection is on, use **Allow once** to let the next new tab open from the current website.

After that single tab is allowed, AntiTabs automatically returns to normal blocking. The toolbar badge shows `1` while the allowance is armed.

## Load Locally In Microsoft Edge

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select this project folder.

## Notes

This branch targets Microsoft Edge while the extension is still being developed. The core behavior is intentionally browser-agnostic so it can be ported to other browsers later.

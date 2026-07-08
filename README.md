# AntiTabs

AntiTabs is a simple Microsoft Edge extension that helps stop websites from opening unwanted new tabs when you click around a page.

The first version is intentionally small: it will provide a toggle switch so you can turn this protection on or off for the active browsing session.

## Goal

- Reduce annoying ad popups and forced new-tab behavior.
- Keep normal browsing simple and predictable.
- Start with a minimal extension that can be expanded later.

## Load locally in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select this project folder.

Use the AntiTabs toolbar button to enable or disable protection for the current website.

When protection is on, AntiTabs also runs inside embedded frames and neutralizes suspicious full-page iframe overlays that are commonly used to catch clicks for ad popups.

# AntiTabs

AntiTabs is a browser extension that helps stop websites from opening unwanted tabs while you click around a page.

Current Safari version: **0.1.14**. This branch ports the Edge 0.1.14 behavior to Safari for macOS.

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

## Build And Enable In Safari

Requires Safari **18.4 or later** and Xcode. The Xcode project is in `safari-app/AntiTabs.xcodeproj` and references the extension files at the repository root. Edit those root files; there is no second copy in the app project.

1. Open `safari-app/AntiTabs.xcodeproj` in Xcode.
2. Select your Apple development team and replace the `com.example.AntiTabsSafari` bundle identifiers for both the app and extension targets with identifiers you own.
3. Build and run the **AntiTabs** macOS scheme.
4. In Safari, open **Settings → Extensions**, enable **AntiTabs**, and grant it access to **All Websites**. If you grant access to individual websites instead, protection works only on those websites.
5. Reload any website that was already open, then enable protection for that website from the AntiTabs toolbar popup.

The app is a required Safari wrapper. The protection logic, popup, and icons are the same extension resources used by Edge. Safari registers the page guard and content script persistently at document start so they can run in their required execution worlds and in matching frames. Pending decisions are also saved in session storage and backed by alarms so they can expire if Safari unloads the background worker.

## Tests

Run `node --test tests/*.test.js` from the project folder.

## Notes

Safari controls website access separately from AntiTabs's per-website protection switch. Granting website access in Safari permits the extension to run; turning on protection in the AntiTabs popup determines where it actively blocks popups.

The Safari app project builds without signing for local verification. Running it in Safari requires signing and a development team. Automated tests cover extension behavior, Safari script registration, and worker-restored decisions; a live Safari website pass is still needed before distributing this branch. Safari may deliver an alarm late when the browser or Mac is sleeping, so a pending prompt can outlast its nominal 20-second timeout in that case.

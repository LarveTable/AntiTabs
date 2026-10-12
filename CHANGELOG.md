# Changelog

## 0.1.14 Safari port — 2026-10-13

- Added a macOS Safari app and web extension project that uses the extension files at the repository root.
- Registered the page guard and content script through Safari's scripting API to preserve early injection, execution worlds, and matching frames.
- Preserved pending tab and decision state across background worker restarts, with alarms backing up the existing timeouts.
- Required Safari 18.4 or later and documented Safari website access and signing steps.

## 0.1.14 — 2026-10-13

- Added global settings for new-tab links: ask first, or open automatically in the current tab.
- Added an optional confirmation for detected popup tabs. A tab waits in the background while the user decides whether to allow or close it.
- Made **Allow once** consume exactly one new-tab allowance, including when tabs open together.
- Updated overlay detection to scan changed content and tracked viewport candidates instead of repeatedly scanning the entire page.
- Shortened long destination URLs in decision dialogs while retaining the complete URL for the chosen action.
- Added unit tests for tab decisions, popup settings, overlay scanning, and Allow once.
- Ignored macOS `.DS_Store` files in the repository.

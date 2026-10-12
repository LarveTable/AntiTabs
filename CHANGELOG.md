# Changelog

## 0.1.14 — 2026-10-13

- Added global settings for new-tab links: ask first, or open automatically in the current tab.
- Added an optional confirmation for detected popup tabs. A tab waits in the background while the user decides whether to allow or close it.
- Made **Allow once** consume exactly one new-tab allowance, including when tabs open together.
- Updated overlay detection to scan changed content and tracked viewport candidates instead of repeatedly scanning the entire page.
- Shortened long destination URLs in decision dialogs while retaining the complete URL for the chosen action.
- Added unit tests for tab decisions, popup settings, overlay scanning, and Allow once.

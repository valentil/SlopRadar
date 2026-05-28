# SlopRadar — Privacy Policy

_Last updated: 2026-05-28_

## Summary

SlopRadar does not collect, transmit, sell, or share any of your data. Everything
the extension does happens locally inside your own browser. There are no servers,
no analytics, no tracking, and no third parties.

## What the extension processes

To detect AI-generated "slop" in your social feeds, SlopRadar reads the text of
posts on the supported sites (LinkedIn, X/Twitter, Reddit, and Threads) and
classifies each post using Chrome's built-in, on-device Gemini Nano model. This
classification runs entirely on your device. Post text is never sent over the
network by this extension.

## What is stored, and where

The extension stores the following using Chrome's local extension storage
(`chrome.storage.local`), which lives only on your device:

- Your settings (display mode, confidence threshold, theme, excluded sites).
- The slop-detection pattern list, including patterns you add or that are
  learned from your "confirm" / "not slop" feedback.
- Short text fingerprints created when you right-click a post to flag it.
- Aggregate counters (how many posts were checked and hidden) for the stats
  panel.
- A rolling local log used by the in-extension Logs panel for debugging.

None of this is transmitted anywhere. Uninstalling the extension removes it.

## What is NOT collected

- No personal information, account details, or credentials.
- No browsing history.
- No data sent to the developer or any third party.
- No advertising or tracking identifiers.

## Permissions and why they are requested

- **Host access (LinkedIn, X/Twitter, Reddit, Threads):** to read post text on
  those sites and visually hide detected slop.
- **storage:** to save your settings and patterns locally.
- **scripting / tabs / contextMenus:** to run the detector on supported tabs,
  reflect the on/off state in the toolbar icon, and provide the right-click
  "mark as slop" menu.

## Contact

Questions about this policy: sales@featureboard.ai

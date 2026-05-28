# SlopRadar — Release Checklist (Chrome Web Store)

Status legend: ✅ done · ⬜ to do by you · 🔁 automated test guards it

## 1. Manifest & permissions
- ✅ `manifest_version: 3`
- ✅ Removed `<all_urls>` — scoped to LinkedIn, X/Twitter, Reddit, Threads 🔁
- ✅ `host_permissions` == `content_scripts.matches` 🔁
- ✅ Minimal permissions: `scripting, tabs, storage, contextMenus` 🔁
- ✅ Dropped unused `windows` permission 🔁
- ✅ Icons declared at 16/32/48/128 🔁
- ✅ Service worker is classic (no unused `type: module`)
- ✅ Version bumped to 1.5

## 2. Assets
- ✅ Icon set generated (`icons/icon{16,32,48,128}.png`) — radar/scope design
- ⬜ Store listing screenshots (1280×800 or 640×400) — capture LinkedIn + X
      with slop banners visible. Need at least 1, up to 5.
- ⬜ Small promo tile (440×280) — optional but recommended.
- ⬜ Store description text (short + detailed). Draft below.

## 3. Privacy & policy
- ✅ `PRIVACY.md` written (everything is local, nothing transmitted)
- ⬜ Host the privacy policy at a public URL (e.g. featureboard.ai/slopradar/privacy)
      and paste that URL into the store listing.
- ⬜ Fill the store's data-usage disclosure form: select "does not collect" for
      every category (true — all processing is on-device).

## 4. Functionality verification (manual smoke test before submit)
- ⬜ Load unpacked from `dist/` → no console errors on service worker.
- ⬜ LinkedIn feed: slop posts get the red banner; "Show anyway" works.
- ⬜ X feed: same, including short-reply leniency (replies under ~80 chars
      shouldn't be flagged unless obviously slop).
- ⬜ Reddit + Threads: beta detector runs (chips show "beta" in settings).
      Confirm it at least finds post text and doesn't error.
- ⬜ Pause button toggles + badge shows OFF/ON correctly on the pinned icon.
- ⬜ Settings save without scrolling; all toggles persist after reload.
- ⬜ Right-click "mark as slop" → creates a fingerprint (Patterns tab).
- ⬜ "Confirm slop" / "Not slop" → inline feedback toast + pattern updates.
- ⬜ Upgrade path: install old build, then load 1.5 → legacy right-click
      patterns get cleared once (check service worker log for migration line).

## 5. Build & tests
- ✅ 80 automated tests passing (`npm test`)
- ✅ Packager excludes dev files (admin.html, tests, make_icons.py) 🔁
- ✅ `npm run package` produces `dist/slopradar-v1.5.zip`
- ⬜ Final: run `npm run ship` (test → report → package).

## 6. Submission
- ⬜ Create/confirm Chrome Web Store developer account ($5 one-time fee).
- ⬜ Upload `dist/slopradar-v1.5.zip`.
- ⬜ Paste description, privacy URL, screenshots; set category = Productivity.
- ⬜ Justify each permission in the review notes (see PRIVACY.md wording).
- ⬜ Single distribution? Mark visibility (Public / Unlisted) as desired.

---

## Draft store description

**Short (132 chars max):**
> Hide AI-generated marketing slop in your social feeds. 100% on-device with
> Gemini Nano — nothing leaves your browser.

**Detailed:**
> SlopRadar quietly filters out generic, AI-generated "engagement bait" and
> marketing slop from your LinkedIn, X, Reddit, and Threads feeds.
>
> It uses Chrome's built-in Gemini Nano model, so every post is classified
> right on your device — no servers, no tracking, no data ever leaves your
> browser.
>
> • Flagged posts are blurred behind a clear banner — one click to reveal.
> • Teach it: confirm correct catches or mark false positives, and the filter
>   adapts to your taste.
> • Choose how aggressive it is, or switch to a quiet "non-intrusive" mode
>   once it's trained.
> • Short replies and genuine conversation are given the benefit of the doubt.
>
> LinkedIn and X are fully tuned; Reddit and Threads are in beta.

## Things intentionally NOT shipped
- `admin.html` — local dev prompt inspector
- `make_icons.py`, `package.js`, `serve-report.js`, `build-report.js`
- the `slopradar-tests/` suite
- `PRIVACY.md` / this checklist (host privacy separately; checklist is internal)

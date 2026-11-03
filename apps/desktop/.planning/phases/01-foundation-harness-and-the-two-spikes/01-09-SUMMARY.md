---
phase: 01-foundation-harness-and-the-two-spikes
plan: 09
subsystem: browser
tags: [electron, chrome-extensions, bitwarden, arc-import, cookies]
requires: [01-07, 01-08, 01-02]
provides:
  - Chrome extension host (electron-chrome-extensions) and Web Store installer bound to persist:browser
  - Checked-in MV3 test extension proven in the default e2e (content script and toolbar popup)
  - Live Bitwarden install verified once (opt-in spec)
  - Import Arc logins flow (modal, exporter spawn, cookie mapping) with fixture exporter
affects: [01-10]
key-files:
  created:
    - apps/desktop/src/main/browser/extensions.ts
    - apps/desktop/src/main/browser/arc-import.ts
    - packages/browser-core/src/arc-cookies.ts
    - apps/desktop/src/renderer/browser/ImportArcModal.tsx
    - apps/desktop/src/renderer/browser/ExtensionActions.tsx
    - apps/desktop/e2e/browser-extensions.spec.ts
    - apps/desktop/e2e/browser-bitwarden.live.spec.ts
    - apps/desktop/e2e/browser-arc.spec.ts
    - apps/desktop/e2e/fixtures/test-extension/
    - fixtures/arc-cookies.fixture.json
    - fixtures/arc-export-fixture.mjs
  modified:
    - packages/contract/src/browser.ts
    - apps/desktop/src/main/browser/{browser-host,browser-ipc,index}.ts
    - apps/desktop/src/preload/index.ts
    - apps/desktop/electron.vite.config.ts
    - apps/desktop/src/renderer/{index.html,main.tsx,browser/AddressRow.tsx}
requirements-completed: [BROW-08, BROW-09]
completed: 2026-10-15
---

# Phase 1 Plan 09: Chrome extensions and Arc login import Summary

**Real Chrome extensions (Bitwarden from the Web Store) run in `persist:browser`, the extension toolbar and popup work, and Import Arc logins copies Arc cookies into the browser partition only, on explicit confirm.**

## Accomplishments
- Extension host: `ElectronChromeExtensions` (GPL-3.0) on `persist:browser`, tabs registered through new `BrowserHost.onTabCreated/onTabActivated/onTabClosed` hooks, Web Store installer with `allowlist: [Bitwarden]`, extensions stored under `<configDir>/extensions`. IPC navigation waits on `host.ready` so the first page already receives content scripts. `browser.extensions` and `browser.importArc` added to the contract.
- Default e2e: the MV3 test extension's content script writes `EXT OK` into a guest page and is absent from the shell; the toolbar button renders and its popup opens with `TEST POPUP` (stretch succeeded, `extensionPopup: 'ok'`).
- Arc import: `toElectronCookie` mirrors Rust `arc_cookie` (host-only keeps no domain, `expires <= 0` is a session cookie, sameSite mapping); exporter run with argv array, no shell, 30 s cap, only stderr's last line on failure; cookies go to `persist:browser` only, return value is `{ count }`.
- `pnpm gate`: GATE GREEN (24 Playwright tests, 23 passed, 1 skipped live spec; unit tests green; sentinel no changes).

## Task Commits
1. Extension host and MV3 test extension: `cf85ce0`
2. Live Bitwarden spec and toolbar popup: `abcbe85`
3. Import Arc logins: `2b85b0a`

## Live verification outcomes (run once, EVAOS_LIVE=1)
- **Bitwarden install from the Chrome Web Store: PASSED.** `bitwardenInstalled: true`, `bitwardenVersion: 2026.9.3`, `bitwardenContentScript: true`. Runtime contexts on `form.html` included an isolated world named `Bitwarden Password Manager` with origin `chrome-extension://nngceckbapebfimnlniiiahkandclblb`. Console noise: `Permission 'contextMenus|sidePanel|webNavigation|notifications|privacy' is unknown` and one benign `Could not establish connection` background error (matches research). The first live attempt failed because my spec awaited `Runtime.enable`, which stalled `app.evaluate`; fixed by not awaiting it (spec bug, not an app bug); the passing run is the recorded result.
- **Arc live exporter (agent-verified):** ran Eva's real exporter once from a shell with output reduced to a count: 95 cookies, no Keychain prompt (key cache present), no changes to the Eva tree. Nothing was granted or written, no values were printed.
- **Arc live import through the app UI:** not run with real cookies (would put Isaac's real sessions into a persistent profile). Exporter contract and cookie mapping are verified against fixtures. Status: still-needs-isaac.

## still-needs-isaac
- Bitwarden sign-in and autofill on a real site (needs his vault).
- Clicking Import Arc logins in the real app with his real Arc profile and confirming sign-ins work (Keychain behavior on his session).
- Feel check that the extension popup anchors sensibly beside the panel.

## Deviations from Plan
1. **[Rule 3] browser-core gained a `zod` dependency (4.6.7, already used by contract and chat-core)** and a lockfile update, so `ArcCookieSchema` is Zod as specified. browser-core has no URL global, so host-only URLs are split with a regex.
2. **[Rule 3] eslint ignores `apps/desktop/e2e/fixtures/test-extension/**`** (browser-context JS with `document`); prettier applied to new files for the gate.
3. `Notifications` provider is mounted in `main.tsx` (next to `MantineProvider`) rather than `App.tsx`, positioned `bottom-left` so toasts are not hidden under the native browser view.
4. Extension setup is not awaited in `registerBrowser`; instead `host.ready` gates IPC navigation and tab creation, so test hooks and IPC are registered synchronously as before.
5. Added an `import-arc-modal` proof screenshot via `proofShot`.

## Deferred gaps
None. The popup stretch worked, so no popup deferral is needed.

## Known Stubs
None.

## Self-Check: PASSED

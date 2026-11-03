# ADR 0002: Clipboard exception to the guest deny-all permissions

Status: Accepted (2026-10-27). Amends BROW-06 and research assumption A6 (Phase 1).

## Context

BROW-06 runs browser-panel pages in `persist:browser` with every permission request and check denied. A6 assumed no site needed a grant, and named clipboard writes as the likely exception. It was: copy buttons in web apps (`navigator.clipboard.writeText`) failed in the panel, because Chromium asks the permission handlers for `clipboard-sanitized-write` and the deny-all answer rejected the write.

## Decision

`apps/desktop/src/main/browser/guest-permissions.ts` decides every request and check on the guest partition:

- `clipboard-sanitized-write`: allowed on every page. It only puts sanitized data on the clipboard, and Chromium grants it to any focused page in a normal browser.
- `clipboard-read`: allowed only on trusted origins (`localhost`, `127.0.0.1` and `[::1]` on http or https, `dev.platform.ecardsystems.com` and `stage.platform.ecardsystems.com` on https, `*.ts.net` tailnet hosts) and only within 5 s of a mouse, key or touch press in that tab. Electron's permission details carry no user-gesture flag, so `guest-session.ts` records the last `input-event` per guest webContents.
- Everything else, including `deprecated-sync-clipboard-read`: denied, as before. The device handler still denies all.

## Consequences

- Copy buttons work on any site in the panel.
- An arbitrary page cannot read what Isaac copied; only his own dev servers, the eCard dev and stage apps and tailnet hosts can, and only right after he interacts with them.
- `guest-permissions.test.ts` pins the decisions (write anywhere, read on trusted origins with a recent gesture, all else denied).

# Phase 1: Foundation, Harness and the Two Spikes - Research

**Researched:** 2026-10-15
**Domain:** Electron 44 desktop workspace; omp rpc-ui streaming into a virtualized log; WebContentsView browser panel; Playwright-for-Electron proof harness
**Confidence:** HIGH on protocol, toolchain and the Electron/Playwright composition (all re-verified by running spikes on this Mac); MEDIUM on Bitwarden autofill and Arc Keychain behaviour (cannot be exercised unattended)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** pnpm workspace monorepo from day one: `apps/desktop` (electron-vite app: main, preload, renderer) plus Electron-free packages `packages/contract` (IPC channel names and Zod schemas), `packages/chat-core` (line framer, session-file parser, transcript reducer), `packages/eva-core` (Eva checkout readers and the `EvaFs` write gateway). Later phases add `packages/widgets`, `packages/theme-core`. Rationale: research ARCHITECTURE, pure packages hold most unit coverage.
- **D-02:** Versions per `.planning/research/STACK.md`: Electron 44 stable, electron-vite 6 (fall back to 5.x if it fails to boot under Playwright), Vite 8, React 19, TypeScript ~6.0, Mantine 9.7 (all Mantine packages one exact version), zustand 5, Zod 4, virtua, pnpm 12 via corepack. Verify each version with `npm view` at install time; do not downgrade silently, record any deviation in the plan SUMMARY.
- **D-03:** pnpm `onlyBuiltDependencies` lists `electron` (and `node-pty` later); `.npmrc` keeps isolated node-linker. Replace the placeholder root `package.json` (it only pins get-shit-done-cc as a devDependency; keep that devDependency in the root workspace package so `run-gsd.sh` still finds `gsd-sdk` on `node_modules/.bin`).
- **D-04:** Lint is ESLint + typescript-eslint + Prettier, plus a custom `scripts/lint-em-dash.ts` that fails on U+2014 inside string literals and JSX text under `apps/desktop/src/renderer` and `packages/*/src` (planning docs are exempt).
- **D-05:** Green gate is one script, `pnpm gate`: install check, typecheck, lint, em-dash lint, Vitest, build, Playwright e2e launch asserting zero renderer console errors. Phases close only on a green gate.
- **D-06:** `BaseWindow` plus one full-window shell `WebContentsView` for the React app, plus one child `WebContentsView` per browser tab layered above it. First e2e test on day one checks Playwright `electronApp.firstWindow()` sees the shell view. If it cannot, fall back to `BrowserWindow` with child views; record the outcome in the plan SUMMARY.
- **D-07:** The renderer renders an empty slot `div` for the browser; a `ResizeObserver` sends integer rects once per animation frame over IPC; main calls `setBounds` and `setVisible`. Bounds sync is asserted in e2e (view bounds equal slot rect after a resize).
- **D-08:** One overlay mechanism: a renderer `OverlayStack` store with a `useOccludeBrowser()` hook; while any full-window overlay is mounted the active browser view is hidden (`setVisible(false)`). Bitmap swap (`capturePage` placeholder) is polish, not required in Phase 1. Phase 2 wraps Mantine Modal, Drawer, Menu and Popover with this hook; Phase 1 ships the store and proves it with one test overlay.
- **D-09:** Guest pages use a dedicated persistent partition (`persist:browser`) with `sandbox: true`, `contextIsolation: true`, no preload, `setWindowOpenHandler` denying popups by default (OAuth popup support is a later refinement), and a permission request handler that denies everything except what the README's browser allows. App hotkeys arriving in a guest are forwarded to the shell via `before-input-event`.
- **D-10:** DevTools opens detached by default. CDP page control lives in a main-process `PageControl` module over `webContents.debugger` that lazily re-attaches after DevTools detaches it. Exposed operations in Phase 1: navigate, read document text, click a selector, evaluate expression. The spike verifies whether DevTools and `debugger.attach` coexist and records the answer.
- **D-11:** Address bar resolution: `http(s)://` or host-like text navigates; a bare integer opens `http://127.0.0.1:<port>/`; anything else searches with the README's default engine. Tab title follows `page-title-updated`; in-app history for suggestions is kept in the app config dir (SQLite via `node:sqlite` or JSON, planner's call); Arc history import stays v2.
- **D-12:** Chrome extensions (BROW-08): load `electron-chrome-extensions` and `electron-chrome-web-store` into the `persist:browser` session; the Bitwarden extension id is installed from the Chrome Web Store on first launch when network is available. Automated e2e verifies extension loading with a tiny unpacked test extension checked into the repo; a live Bitwarden install and autofill is an opt-in e2e (`EVAOS_LIVE=1`) and otherwise recorded as `still-needs-isaac` in VERIFICATION.md.
- **D-13:** Arc login import (BROW-09): reuse the Eva-side exporter exactly as the Rust app does, running `bun .omp/tools/arc-cookies.ts .omp/tools/lib/evaos-arc-sites.txt` in the Eva root (read-only use of Eva tooling), parse its cookie output, and insert into the browser partition with `session.cookies.set`, then reload. It runs only from an explicit "Import Arc logins" button; never on launch. Tests use a fixture cookie export; the live path needs Keychain access and is `still-needs-isaac`. The imported cookies stay inside the `persist:browser` partition, never the shell session.
- **D-14:** Transport in Phase 1 is resume-only: `omp --mode rpc-ui --resume <session file>` spawned in the Eva root with stdin/stdout pipes. New-chat creation (herdr plus Relay versus direct child) is the Phase 4 ADR; Phase 1 still defines the `Transport` interface (`start`, `send`, `abort`, `steer`, `close`, event stream) so Phase 4 adds implementations without touching the view.
- **D-15:** Frame handling per research: a `LineFramer` in main (StringDecoder, split on `\n` only, carry-over, per-line JSON try/catch, stderr kept separate as `_stderr` frames, `_eof` synthetic frame). Main runs the `chat-core` reducer and assigns a per-session monotonically increasing `seq`; ops are flushed to the renderer every ~16 ms. The renderer drains once per animation frame into a zustand store outside React, asserts `seq` contiguity, and requests a snapshot on any gap.
- **D-16:** Streaming semantics follow `chat.rs`: `message_update` carries full content and replaces the in-progress text; `message_end` is authoritative; coalescing keeps the last update per message id. No delta protocol unless profiling demands it.
- **D-17:** Lifecycle: closing a chat or quitting ends stdin and awaits exit (bounded wait, then log, never SIGKILL a session process). A single-writer guard refuses to spawn a second omp on a session file this app already owns. `ps`-style process-name matching is forbidden.
- **D-18:** The virtualized log uses virtua first, measured on a checked-in 5,000-message fixture session; fall back to `@tanstack/react-virtual` only on a measured failure (pin or jump bugs, or frame-time p95 over 16 ms during streaming on the fixture). Pin-to-bottom, Jump to latest and New reply pills are part of the spike.
- **D-19:** Spike rendering is plain streaming text with monospace code fences and preserved whitespace; full markdown, mermaid and widgets are Phase 5. Thinking blocks and tool calls render as collapsed rows with a label so the transcript parser is exercised.
- **D-20:** Spike UI layout: a minimal two-pane page (chat in main, browser panel on the right, placeholder left rail) built with Mantine primitives, dark color scheme by default. Not the real shell; Phase 2 replaces the frame and keeps the chat and browser components.
- **D-21:** `EvaFs` in `packages/eva-core` is the only module allowed to write under the Eva root. Phase 1 exposes no writes at all (the first sanctioned write, todos append, is Phase 3); it ships the gateway, the allowlist shape, and a unit test that scans `apps/desktop/src/main` and `packages/*` for `fs.write*`, `writeFile`, `rename`, `rm` calls outside `eva-core/src/fs`.
- **D-22:** Environment contract: `EVAOS_EVA_ROOT` (default in dev and test: `fixtures/eva-root` in this repo), `EVAOS_OMP_BIN` (default in dev and test: `fixtures/fake-omp/fake-omp.ts` run with bun or node), `EVAOS_CONFIG_DIR` (default in dev and test: a temp dir; in a packaged run: `~/Library/Application Support/EvaOS Electron`). `pnpm dev:live` sets the real Eva root and real omp and prints a warning; CI-style runs never set it.
- **D-23:** The fake omp replays a recorded JSONL frame log with configurable chunk sizes and delays (1 byte, glued lines, split multibyte characters, bursts) and honors `prompt`, `abort` and stdin close so lifecycle tests are deterministic. The recording is captured once from a real omp session on a throwaway session file under the fixture root, scrubbed, and checked in.
- **D-24:** The fixture Eva root contains two workspaces, a short journal, a todos file, one small session and the 5,000-message benchmark session, all synthetic. No real Eva data is copied into the repo.
- **D-25:** A `git status --porcelain` sentinel on `/Users/ike/Eva`, `/Users/ike/Eva/apps/evaos` and `/Users/ike/Eva/work/relay` runs before and after every e2e run and fails the run on any new change.
- **D-26:** Playwright `_electron` launches the electron-vite build output (`apps/desktop/out`), workers 1, with the env from D-22. One extra smoke test launches the electron-builder `dir` output (`.app`, `identity: null`, arm64) to catch asar issues early.
- **D-27:** `proofShot(name)` in `e2e/helpers` composites `page.screenshot()` with `webContents.capturePage()` of every visible browser view at its bounds, rejects images whose pixel variance is near zero, and writes `proof/phase-1/<name>.png`. Every proof call is paired with at least one state assertion.
- **D-28:** PROF-02 numbers recorded in `proof/phase-1/metrics.json`: gapless `seq` count over the benchmark replay, frame-time p50 and p95 while streaming into the 5,000-message fixture (budget: p95 under 16 ms on this Mac), browser bounds delta (0 px), overlay hide check, CDP text probe result.
- **D-29:** Vitest uses three projects (main: node environment; preload: node; renderer: jsdom) plus the packages. Virtualized scroll is never tested in jsdom; that is e2e only.

### Claude's Discretion
Exact directory names inside `apps/desktop/src`, IPC channel naming scheme, the shape of the zustand stores, Prettier settings, whether in-app browser history is SQLite or JSON, the test extension used to prove extension loading, and how the benchmark fixture is generated.

### Deferred Ideas (OUT OF SCOPE)
- New-chat transport (herdr plus Relay versus direct omp child): Phase 4 ADR (CHTP-14).
- OAuth popup windows sharing the guest partition (README line ~114): Phase 6 browser polish or a Phase 1 stretch if trivial with `setWindowOpenHandler` allow-list.
- Bitmap placeholder while the browser view is occluded: polish after Phase 2.
- Arc history import for address suggestions: v2 (BROW-10).
- Safari user-agent synthesis: not planned (anti-feature; Chromium UA is the point).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-01 | `pnpm install/dev/build` on Electron + electron-vite + React + TS + Mantine | "Toolchain Findings": CJS output rule, pnpm 12 `allowBuilds`, corepack shim, electron-vite 6 layout (verified build + launch) |
| FOUND-02 | `pnpm test` (Vitest projects) and `pnpm e2e` (Playwright `_electron`) pass | Vitest 5 `projects` verified; Playwright launch of built output verified; separate include globs |
| FOUND-03 | Every Eva write via `EvaFs` closed allowlist; test fails otherwise | "EvaFs Allowlist" section mirrors the Rust writers exactly |
| FOUND-04 | Dev/test default to fixture root, fake omp, temp config dir | "Environment Contract" and "Fake omp" sections |
| FOUND-05 | App state in own config dir, `$EVAOS_CONFIG_DIR` override | Environment Contract; `app.setPath('userData', ...)` |
| FOUND-06 | `proofShot` composite with blank check | "Proof Harness" (verified: `page.screenshot()` excludes native views; capturePage works) |
| FOUND-07 | Green-gate script incl. em-dash lint, zero console errors | "Em-dash lint" and "Console errors" sections |
| FOUND-08 | Typed IPC contract with Zod at boundary | "Typed IPC" pattern; electron-vite CJS preload verified under `sandbox: true` |
| CHAT-01 | Open past session, parse transcript | "Session file format" (active branch walk, record types counted from 107 real sessions) |
| CHAT-02 | Resume over `omp --mode rpc-ui --resume` and stream | "omp RPC protocol" (recorded real frames, handshake, v1 vs v2) |
| CHAT-03 | Ordered, no-drop framing; resync on seq gap | LineFramer + seq design; real frame sizes and `maxFrameBytes` |
| CHAT-04 | Virtualized log smooth on 5,000 messages | virtua prototype measured on 5,000 items (verified) and the frame-time metric caveat |
| CHAT-05 | Pin-to-bottom, Jump to latest, New reply | Verified virtua pin pattern |
| CHAT-06 | Abort and steer | Recorded abort and steer sequences |
| CHAT-07 | Close = stdin close, never SIGKILL | Verified: real omp exits code 0 about 1.5 s after stdin end |
| CHAT-08 | Transport interface | `Transport` interface sketch |
| BROW-01..03 | Browser tool, address bar, subtabs | Address-bar rules ported from `normalize()`; WebContentsView lifecycle |
| BROW-04 | Bounds track slot; hide under overlay | Bounds sync + `OverlayStack` pattern |
| BROW-05 | DevTools + CDP `PageControl` | Verified: DevTools and `debugger.attach` coexist on Electron 44.7.2 in both orders |
| BROW-06 | Sandboxed guest partition, no preload, deny popups/permissions | Guest hardening checklist |
| BROW-07 | Up to six history suggestions | Ported `history.rs` ranking |
| BROW-08 | Chrome extensions + Bitwarden | Verified: both libraries work on Electron 44.7.2 with `BaseWindow`; Bitwarden 2026.9.3 installs and loads |
| BROW-09 | Arc login import | Exporter contract, cookie mapping, headless feasibility |
| PROF-01 | Screenshots with assertions under `proof/phase-1/` | Proof Harness |
| PROF-02 | Recorded numbers | `metrics.json` shape and metric definitions |
</phase_requirements>

## Summary

Every high-risk assumption in CLAUDE.md and CONTEXT.md was exercised in throwaway spikes under `/tmp` (outside this repo, Eva checkout untouched). Results: `BaseWindow` + shell `WebContentsView` works with Playwright `_electron` (`firstWindow()` returns the shell; `app.windows()` also returns every guest `WebContentsView` as its own `Page`); DevTools and `webContents.debugger` coexist in both attach orders; `electron-chrome-extensions` 4.9.0 + `electron-chrome-web-store` 0.13.0 work on Electron 44.7.2 with a `BaseWindow`, a test MV3 extension ran its content script in the `persist:browser` partition, and the real Bitwarden extension (2026.9.3, MV3) installed from the Web Store and loaded; virtua `VList` held pin-to-bottom with 5,000 variable-height rows while the last row streamed every 16 ms; electron-vite 6.0.0 + Vite 8.3.4 built and launched under Playwright; electron-builder produced a `dir` `.app` that Playwright launched.

The omp protocol is better documented than expected: omp 18.8.5 embeds its wire schema, and I recorded real frames from throwaway sessions. Three things CONTEXT does not know: omp now emits a first `ready` frame advertising protocol v1 and v2 (`maxFrameBytes` 1 MiB; v2 adds base64 `rpc_chunk` reassembly), it has first-class `subagent_*` frames (the data source for Phase 4 chips), and `message_update` still carries a full accumulated snapshot (confirmed, so D-16 holds). Real omp exits cleanly with code 0 after stdin end.

Four findings change plan details: (1) the electron-vite output must be CommonJS (no `"type":"module"` in `apps/desktop/package.json`) because an ESM `.mjs` preload cannot run under `sandbox: true`; (2) pnpm 12 does not use `onlyBuiltDependencies`: it uses `allowBuilds` in `pnpm-workspace.yaml`, makes unreviewed build scripts a hard install error, and auto-writes `minimumReleaseAgeExclude` for freshly published pins; Electron 44 has no postinstall at all (binary downloads on first run); (3) electron-builder shells out to `pnpm`, so a real `pnpm` must be on `PATH` (use `corepack enable pnpm --install-directory <repo-local dir>` and prepend it, no global change); (4) rAF frame deltas on this 120 Hz Mac are quantized at 8.3 ms and an idle page already shows p95 = 17 ms under Playwright, so the literal "p95 under 16 ms" budget (D-28) must be expressed relative to an idle baseline or it will flake.

**Primary recommendation:** Build the harness first (env contract, EvaFs, fake omp with a recorded real frame log, proofShot, gate), then the chat spike and browser spike as independent plans, all on the verified patterns below. Keep `BaseWindow`; do not fall back to `BrowserWindow`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| omp child process, line framing, reducer, seq stamping | Main process (`SessionManager`) | `packages/chat-core` (pure) | Process that owns stdin knows truth; survives renderer reload |
| Transcript parse from session file | `packages/chat-core` (pure) | Main (does the `fs` read) | Pure function over text; Vitest-portable from Rust tests |
| Virtualized log, pin logic, pills | Renderer | zustand store outside React | Needs DOM scroll geometry; never tested in jsdom |
| Browser views, bounds, visibility, CDP, DevTools | Main (`BrowserHost`, `PageControl`) | Renderer (slot rect + chrome UI) | WebContentsView is a native layer above the DOM; main is sole owner |
| Overlay occlusion | Renderer (`OverlayStack` store) | Main applies `setVisible` | Renderer knows which overlays are mounted; main owns the views |
| Address-bar resolution, history ranking | `packages/*` pure TS | Renderer displays | Pure functions, unit-tested against the Rust cases |
| Chrome extensions, Web Store install | Main | Renderer (`<browser-action-list>` later) | Extension host binds to the guest session in main |
| Arc cookie import | Main (spawns bun in Eva root, `session.cookies.set`) | Renderer (button + confirm) | Secrets stay in main; never cross IPC |
| EvaFs write gateway | `packages/eva-core` | Main wires it | Single closed module, statically scannable |
| Env contract, config dir | Main bootstrap | `packages/contract` (schema) | Must be resolved before any service starts |
| Proof composite, metrics | Playwright test process (Node) | Main test hooks (`EVAOS_E2E=1` only) | `page.screenshot()` excludes native views; capture needs main |

## Standard Stack

All versions pinned by CLAUDE.md; I re-ran `npm view` today (2026-10-15) and every pin is still the `latest` dist-tag.

### Core
| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| electron | 44.7.2 | Shell, BaseWindow, WebContentsView | [VERIFIED: npm registry + local run] Electron 44 has **no postinstall**; the binary downloads on first `electron` run |
| electron-vite | 6.0.0 | Build/dev for main, preload, renderer | [VERIFIED: local build + Playwright launch] output `out/main/index.js`, `out/preload/index.js`, `out/renderer/` when package is CJS |
| vite | 8.3.4 | Renderer bundler | [VERIFIED: local build] |
| @vitejs/plugin-react | 6.1.2 | JSX | [VERIFIED: local build] |
| react / react-dom | 19.3.1 | UI | [VERIFIED: local build] |
| typescript | ~6.0.3 | Language | [VERIFIED: npm registry]; 7.0.2 is `latest`, do not take it (typescript-eslint peer) |
| @mantine/core, hooks, notifications | 9.7.2 | UI primitives | CLAUDE.md pin; `@mantine/notifications` is needed for the import-result toast |
| @tabler/icons-react | 3.49.0 | Icons | UI-SPEC |
| zustand | 5.0.15 | Stores outside React | CLAUDE.md pin |
| zod | 4.6.7 | IPC and RPC validation | CLAUDE.md pin |
| virtua | 0.53.5 | Virtualized log | [VERIFIED: local prototype, 5,000 rows] has no `reverse` prop; `VList` props are `data, bufferSize, itemSize, shift, horizontal, cache, ssrCount, item, onScroll, onScrollEnd, onResize, keepMounted`; handle has `scrollToIndex(i,{align,smooth,offset})`, `scrollTo`, `scrollBy`, `scrollOffset`, `scrollSize`, `viewportSize`, `cache`, `findItemIndex`, `getItemOffset`, `getItemSize` [CITED: virtua 0.53.5 `lib/react/*.d.ts`] |
| electron-chrome-extensions | 4.9.0 | Chrome extension host (`chrome.*` APIs) | [VERIFIED: local spike on Electron 44.7.2 with BaseWindow]. License `GPL-3.0` must be passed as the `license` option; last published 2025-07-02 |
| electron-chrome-web-store | 0.13.0 | Install extensions from the Chrome Web Store | [VERIFIED: local spike] MIT; last published 2025-07-02 |
| node-pty | 1.1.0 | Not used in Phase 1 | Installed later (Phase 6). See pitfall P9 (spawn-helper mode) |

### Supporting (test and tooling)
| Library | Version | Purpose |
|---------|---------|---------|
| @playwright/test | 1.64.1 | `_electron`, proof screenshots [VERIFIED: local spike] |
| vitest | 5.0.4 | Unit tests; `test.projects` verified |
| jsdom | latest at install | Renderer Vitest project; plus `@testing-library/react`, `@testing-library/user-event` |
| pngjs | 7.0.0 | Pure-JS PNG decode/encode for `proofShot` composite and variance check | [ASSUMED] new addition, see audit |
| electron-builder | 26.15.3 | `dir` smoke build [VERIFIED: local build + Playwright launch of the `.app`] |
| eslint, typescript-eslint ^8.35, prettier ^3.6 | per STACK.md | Lint (D-04) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pngjs composite | Playwright `guestPage.screenshot()` | `app.windows()` exposes each guest view as a Page and `page.screenshot()` of it works (400x300 for a 400x300 view, verified). Simpler, but FOUND-06 specifies `capturePage`; keep `capturePage` as primary, use the guest-Page screenshot as a cross-check only |
| `@tanstack/react-virtual` | virtua | Only on measured failure (D-18). The virtua prototype passed, so expect no fallback |

**Installation (apps/desktop):**
```bash
# run through the repo-local pnpm shim (see Toolchain Findings)
pnpm add -D electron@44.7.2 electron-vite@6.0.0 vite@8.3.4 @vitejs/plugin-react@6.1.2 typescript@~6.0.3 \
  react@19.3.1 react-dom@19.3.1 @types/react @types/react-dom \
  @mantine/core@9.7.2 @mantine/hooks@9.7.2 @mantine/notifications@9.7.2 @tabler/icons-react@3.49.0 \
  zustand@5.0.15 zod@4.6.7 virtua@0.53.5 vitest@5.0.4 jsdom @playwright/test@1.64.1 pngjs@7.0.0 electron-builder@26.15.3
# NOT bundled: keep as runtime dependencies so electron-vite externalizes them and their preload file resolves
pnpm add electron-chrome-extensions@4.9.0 electron-chrome-web-store@0.13.0
```
**Version verification:** `npm view <pkg> version time.modified` run 2026-10-15; all match the pins above. electron-vite 6.0.0 was published 2026-10-14 16:05Z and Playwright 1.64.1 on 2026-10-14 23:54Z, so pnpm 12's one-day `minimumReleaseAge` applies (handled automatically, see Toolchain Findings).

## Package Legitimacy Audit

slopcheck could not be installed here (`pip install` blocked by PEP 668 in the system Python, and no `slopcheck` binary). Per protocol, packages are tagged `[ASSUMED]` where not fixed by CLAUDE.md. All were checked against the npm registry (age, downloads, repo, install scripts).

| Package | Registry | Age | Weekly downloads | Source repo | slopcheck | Disposition |
|---------|----------|-----|------------------|-------------|-----------|-------------|
| electron-chrome-extensions | npm | 6 yrs (2020-10) | 19,849 | github.com/samuelmaddock/electron-browser-shell | unavailable | Named by Isaac in CLAUDE.md; no install scripts; [ASSUMED] tag retained, treat as approved |
| electron-chrome-web-store | npm | 1 yr (2024-11) | 6,332 | same repo | unavailable | Named by Isaac in CLAUDE.md; no install scripts; MIT; treat as approved |
| virtua | npm | 4 yrs (2022-10) | 1,140,697 | github.com/inokawa/virtua | unavailable | CLAUDE.md pin; no install scripts |
| pngjs | npm | 14 yrs (2012-08) | 71,209,674 | github.com/pngjs/pngjs | unavailable | [ASSUMED] new in this phase; no install scripts; planner may gate it with a `checkpoint:human-verify` or approve on the age and downloads evidence |
| All other pins (electron, vite, react, Mantine, zustand, zod, vitest, Playwright, electron-builder) | npm | years | very high | official orgs | unavailable | Fixed by CLAUDE.md, registry-verified today |

**Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** none. Note: `electron-chrome-extensions` is GPL-3.0 (or a paid Patron licence). It is installed for a personal local app and never distributed; pass `license: 'GPL-3.0'`. [CITED: electron-chrome-extensions README]

## Architecture Patterns

### System Architecture Diagram

```
 Playwright test process (Node)                      pnpm dev / built app
 e2e/*.spec.ts, proofShot, sentinel                  ----------------------------------------------
        | _electron.launch(args:[apps/desktop], env)  BaseWindow (one window)
        v                                             |
 +-------------------------------+   IPC (contract)   |  Shell WebContentsView (sandbox, preload, React)
 | MAIN PROCESS                  | <----------------> |   rail | chat log + composer | browser chrome
 |  env.ts  (EVAOS_* contract)   |  invoke / events   |                                  [ slot div ]
 |  ipc/    (Zod validated)      |                    |  Guest WebContentsViews (persist:browser,
 |  sessions/ SessionManager     |                    |   sandbox, no preload) one per tab,
 |    spawn omp --mode rpc-ui    |                    |   ABOVE shell in z-order, setBounds(slot)
 |    LineFramer -> reducer      |                    +----------------------------------------------
 |    seq + 16ms flush --------->+--- {sessionId,seq,ops[]} ---> renderer queue -> rAF drain -> zustand
 |  browser/ BrowserHost         |
 |    views, bounds, visibility  |<--- slot rects (rAF-coalesced), overlayCount ---- renderer
 |    PageControl (CDP) + DevTools (detached)
 |    ElectronChromeExtensions + Web Store installer (persist:browser)
 |    Arc import: spawn bun in Eva root -> session.cookies.set
 |  eva/    EvaFs (closed allowlist; zero writes in Phase 1)
 +--------+----------------------+
          |                      |
   child: omp --mode rpc-ui      child: bun .omp/tools/arc-cookies.ts (button only)
   (real, or fixtures/fake-omp)  disk: fixtures/eva-root | $EVAOS_CONFIG_DIR | ~/.omp/agent/sessions
```

### Recommended Project Structure
```
package.json                 # root workspace: get-shit-done-cc devDependency only (D-03), packageManager pnpm@12.11.2
pnpm-workspace.yaml          # packages: [apps/*, packages/*]; allowBuilds; minimumReleaseAgeExclude (auto-written)
.npmrc                       # node-linker=isolated (default; leave explicit)
.tools/bin/                  # corepack shim dir (gitignored), prepended to PATH by scripts/env.sh
scripts/                     # gate.sh, lint-em-dash.ts, sentinel.ts, record-omp.mjs, gen-benchmark-session.ts
apps/desktop/
  package.json               # NO "type":"module"; main ./out/main/index.js; dependencies: electron-chrome-*
  electron.vite.config.ts
  electron-builder.yml
  src/main/{index.ts,env.ts,ipc/,sessions/,browser/,eva/}
  src/preload/index.ts       # contextBridge.exposeInMainWorld('eva', {invoke,on})
  src/renderer/{index.html,main.tsx,app/,chat/,browser/,state/,styles/tokens.css}
  e2e/{playwright.config.ts,fixtures.ts,helpers/proofShot.ts,*.spec.ts}
  e2e/fixtures/test-extension/   # tiny MV3 extension (content script)
packages/contract/           # channel names + Zod
packages/chat-core/          # LineFramer, frame schemas, reducer, session-file parser, tagged()
packages/eva-core/           # EvaFs + allowlist (src/fs/), readers later
fixtures/
  eva-root/                  # workspaces/, memory/{journal,todos,todos-done}.md, jobs/ (empty ok)
  agent/sessions/-fixture/   # small.jsonl + bench-5000.jsonl (generated, checked in)
  fake-omp/{fake-omp.mjs,recordings/*.jsonl}
  arc-cookies.fixture.json
proof/phase-1/               # PNGs + metrics.json
```

### Pattern 1: omp RPC transport (verified against omp 18.8.5)

**Spawn:** `omp --mode rpc-ui --resume <session.jsonl> [--session-dir ...]`, cwd = Eva root, stdio all piped. `EVAOS_OMP_BIN` replaces the `omp` binary. Resolve the binary like Rust `binary()`: `PATH`, then `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin` (here `omp` is `/Users/ike/.local/bin/omp`, v18.8.5).

**Handshake (observed, real omp):**
1. First stdout frame, about 230 ms after spawn: `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`. Older servers omit the transport fields (schema marks them optional). [VERIFIED: recorded + embedded schema]
2. Then unsolicited `extension_ui_request {method:"setWidget",widgetKey:"autoresearch"}`, `available_commands_update {commands:[...]}` (about 26 KB), `advisor_cost_changed`. Ignore unknown types.
3. Client sends (Rust does this immediately after spawn, no need to wait for `ready`): `{"type":"set_ask_dialog","enabled":true,"id":"evaos-N"}` then `{"type":"get_state","id":"evaos-N"}`.
4. Resume does **not** replay history frames: the transcript comes from the file only. `get_state` returns `sessionFile`, `sessionId`, `isStreaming`, `model`, `thinkingLevel`, `contextUsage {tokens,contextWindow,percent}`, `messageCount`, `isSettled`, etc. [VERIFIED: ran against a throwaway session]

**Commands the spike needs** (all `{type, id?, ...}`, one JSON object per line, ids `evaos-<n>`; `extension_ui_response` carries no `id` of its own, it echoes the request id):
| Command | Shape | Notes |
|---------|-------|-------|
| `prompt` | `{type:"prompt",message,streamingBehavior:"steer",images?}` | Acked by `{type:"response",command:"prompt",success:true}`; completion is a separate `prompt_result {id,agentInvoked,status:"completed"\|"aborted"\|"error",sessionSettled}`. Wrap text with `tagged()` (`<surface>machine - EvaOS</surface>\n` prefix; slash commands untagged) |
| steer | the same `prompt` with `streamingBehavior:"steer"` while a turn runs | Real omp queues it: `queue_update {steering:[text],followUp:[]}`; it is delivered at the next turn boundary (recorded: queued during a 28 s run), then echoed as `message_start/message_end` role `user`. `steer` and `abort_and_prompt` commands also exist in 18.8.5; keep the Rust behaviour (`prompt`+`steer`) |
| `abort` | `{type:"abort"}` | Recorded sequence: `message_end(assistant, stopReason aborted)`, `turn_end`, `agent_end`, `response{command:abort,success:true}`, `prompt_result{status:"aborted"}`, `session_settled` |
| `get_state` | `{type:"get_state"}` | Response frame has `id` echoing the request |
| `set_ask_dialog` | `{enabled:true}` | Enables `ask` UI requests (Phase 4 consumes them) |
| `extension_ui_response` | `{type:"extension_ui_response",id:<request id>,value\|confirmed\|answers\|cancelled}` | Phase 4; Phase 1 only needs to cancel unknown dialogs so omp does not hang |

**Event frames the reducer must handle** (shapes from the recorded stream and omp's embedded `wire/events.ts`):
- `agent_start`, `turn_start`, `turn_end {message,toolResults}`, `agent_end {messages, messageCount?, isTerminal?, yielded?, awaitingAsyncWork?}`, `prompt_result`, `session_settled`.
- `message_start {message, messageId}` / `message_update {message, assistantMessageEvent, messageId}` / `message_end {message, messageId}`. **`message_update.message` is the full accumulated assistant message** (content array of `text`/`thinking`/`toolCall` blocks plus `usage`, `provider`, `model`, `stopReason`); `assistantMessageEvent` is the delta (`text_start`, `text_delta {contentIndex, delta, partial}`, ...). The user prompt is echoed as `message_start`+`message_end` role `user` with a `messageId` (`msg-1`, `msg-2`, unique per process). D-16 holds: replace the streaming text from `message.content`, ignore `assistantMessageEvent`. [VERIFIED: recorded]
- `tool_execution_start {toolCallId, toolName, args?, intent?}`, `tool_execution_update`, `tool_stream_update`, `tool_execution_end {toolCallId, toolName, result?, isError?}`.
- `response {id, command, success, data?|error}` for every command; `success:false, error:"Unknown command: x"` for bad ones.
- `extension_ui_request {id, method: select|confirm|input|editor|ask|cancel|notify|setStatus|setWidget|setTitle|set_editor_text|open_url...}`: Phase 1 reducer ignores all but may log; `cancel {targetId}` closes a dialog.
- `queue_update {steering[], followUp[]}`, `model_changed`, `thinking_level_changed`, `auto_compaction_*`, `auto_retry_*`, `notice {level,message}`, `session_info_update`, `config_update`, `command_output`.
- **New since the Rust app was written** (all optional for Phase 1, record the names): `subagent_lifecycle {payload:{id,agent,description?,status:"started"|"completed"|"failed"|"aborted",sessionFile?,parentToolCallId?,detached?}}`, `subagent_progress`, `subagent_event` (gated by `set_subagent_subscription {level:"off"|"progress"|"events"}`), `btw_delta`, `btw_record`, `host_tool_call`, `host_tool_cancel`, `rpc_frame_error`, `rpc_chunk`. This resolves the STATE gap "subagent-chip data source": it is `subagent_lifecycle`/`subagent_progress` after `set_subagent_subscription` (Phase 4).
- Synthetic, created by the app: `_stderr {line}` and `_eof`.

**Frame size and protocol v2:** Lines can reach 1 MiB (`maxFrameBytes`). The `get_state` response alone is about 33 KB and `get_available_models` 67 KB; `message_update` frames grow with the reply (each carries the whole text and usage). Under v1 (the default, and what the Rust app uses) oversize frames are compacted or replaced by `rpc_frame_error`/a failed `response` with `"RPC response exceeded the transport limit"`, and `agent_end.messages` can be trimmed (`messageCount` records the original). Under v2 (`negotiate_protocol {protocolVersion:2}`) oversize frames arrive as `{type:"rpc_chunk",chunkId,index,count,byteLength,data:<base64>}` and must be reassembled in order. **Recommendation:** stay on v1 in Phase 1 (parity with Rust), make `LineFramer` unbounded-safe up to at least 1 MiB per line, surface `rpc_frame_error` as a notice, and add a note in the `Transport` docs that v2 is available. Do not rely on `agent_end.messages` for transcript content; use `message_end`. [VERIFIED: embedded wire schema + chunk code in the omp binary; v2 not exercised live]

**Lifecycle:** closing stdin makes real omp exit with code 0 (recorded: stdin end at 5.4 s after settle, exit at 6.9 s). Never signal it. Bounded wait (suggest 10 s), then log and leave the process alone (D-17). Spawn only for a session file this app does not already own (in-memory registry keyed by realpath).

### Pattern 2: LineFramer and seq batching
```ts
// packages/chat-core/src/line-framer.ts  (Source: design from ARCHITECTURE.md, verified vs recorded frames)
import { StringDecoder } from 'node:string_decoder'
export type Frame = Record<string, unknown> & { type: string }
export class LineFramer {
  private dec = new StringDecoder('utf8'); private carry = ''
  constructor(private onFrame: (f: Frame) => void, private onBadLine?: (line: string, err: unknown) => void) {}
  push(chunk: Buffer | string) {
    this.carry += typeof chunk === 'string' ? chunk : this.dec.write(chunk)
    let i: number
    while ((i = this.carry.indexOf('\n')) >= 0) {       // split on \n ONLY (not readline: U+2028/2029)
      const line = this.carry.slice(0, i).replace(/\r$/, ''); this.carry = this.carry.slice(i + 1)
      if (line.trim() === '') continue
      try { const f = JSON.parse(line); if (f && typeof f === 'object' && typeof f.type === 'string') this.onFrame(f) } catch (e) { this.onBadLine?.(line, e) }
    }
  }
  end() { const tail = this.carry + this.dec.end(); this.carry = ''; if (tail.trim()) { try { this.onFrame(JSON.parse(tail)) } catch (e) { this.onBadLine?.(tail, e) } } }
}
```
Note: responses carry `type:"response"`, so the `typeof f.type === 'string'` filter is safe for all real frames. Required tests (CHAT-03): feed the recorded log as (a) 1-byte chunks, (b) all lines glued into one chunk, (c) chunk boundaries inside a multibyte character and inside an emoji surrogate pair (use an emoji-bearing recorded message), (d) a 900 KB line, (e) a non-JSON line between frames, and assert identical frame sequences.

Main-side batching: reducer applies each frame synchronously in arrival order (no `await` between read and apply), marks dirty message ids; a 16 ms `setInterval` per active session emits `{sessionId, seq, ops[]}` with `seq` incrementing by exactly 1 per emitted batch; ops are `upsert(message)`, `remove(id)`, `meta(patch)`; within one flush only the last upsert per message id is kept. Renderer: IPC listener pushes into an array, a single `requestAnimationFrame` drains it into the zustand store; `seq !== last+1` sets `reconnecting` (UI copy "Reconnecting to the stream.") and calls `chat.snapshot(sessionId)`.

### Pattern 3: virtua pinned log (verified prototype, 5,000 rows)
```tsx
// Source: spike prototype /tmp/spike2 run under Playwright on Electron 44.7.2; virtua 0.53.5 d.ts
const ref = useRef<VListHandle>(null); const pinned = useRef(true)
useLayoutEffect(() => { if (pinned.current) ref.current?.scrollToIndex(data.length - 1, { align: 'end' }) }, [data])
<VList ref={ref} data={data} style={{ height: '100%' }}
  onScroll={() => { const h = ref.current!; const p = h.scrollSize - h.scrollOffset - h.viewportSize <= 24; pinned.current = p; setUnpinned(!p) }}>
  {(m) => <Row key={m.id} m={m} />}   {/* Row = React.memo, stable key = message id */}
</VList>
```
Measured: while streaming 40 chars every 16 ms into the last of 5,000 variable-height rows, the distance to the bottom stayed 0; after scrolling up 3,000 px and streaming more for 3 s, `scrollTop` was unchanged (no jump) and the Jump pill appeared; clicking it re-pinned (gap 0). Rules: pass `data` (array identity changes only for the streaming row), memoize rows, use message id keys, `scrollToIndex(...,{align:'end'})` instant (not smooth), never set `shift` except when prepending older messages (README "Show earlier" is a later phase). "New reply" is a flag set when a `meta`/`upsert` arrives while unpinned, cleared on re-pin. Initial mount: scroll to the end in a layout effect once. Do not test this in jsdom (D-29).

### Pattern 4: BaseWindow composition and bounds sync
- Create `new BaseWindow({ width:1280, height:800, minWidth:760, minHeight:720, titleBarStyle:'hiddenInset', show:false })`, add the shell `WebContentsView` first (index 0), set its bounds to `win.getContentBounds()` size, and on `win` `resize` update it. In e2e use `win.showInactive()` (hidden windows stop painting and break `capturePage`/rAF) and set `backgroundThrottling:false` in the shell `webPreferences`.
- Each tab: `new WebContentsView({ webPreferences:{ partition:'persist:browser', sandbox:true, contextIsolation:true } })` (no preload), `win.contentView.addChildView(view)`; all guests stay children, only the active one is visible. Closing a tab: `win.contentView.removeChildView(view)` then `view.webContents.close()` (views are not destroyed with the window; leak otherwise).
- Renderer: `ResizeObserver` on `[data-testid=browser-slot]` plus window `resize`, panel drag and sidebar events, coalesced to one `rAF` send of `{x,y,width,height}` rounded with `Math.round`. Slot div has no padding, border or margin (UI-SPEC) so rect equals bounds. The renderer coordinates are relative to the shell view, which fills the content area, so they equal window content coordinates.
- Occlusion: renderer `OverlayStack` (a Set of overlay ids in zustand); `useOccludeBrowser(open)` registers/unregisters; one effect sends `browser.setVisible(count === 0)`. Mount order matters: on hide also call `shellView.webContents.focus()`.
- Guest-to-app hotkeys: `guest.webContents.on('before-input-event', (e, input) => { if (input.type==='keyDown' && matchesAppChord(input)) { e.preventDefault(); shell.webContents.send('hotkey', chord) } })`. `input` has `key, code, shift, control, alt, meta, isAutoRepeat`. [CITED: electronjs.org web-contents docs]
- e2e hook: when `process.env.EVAOS_E2E === '1'`, main sets `globalThis.__evaosTest = { views(), shell }` so tests can `electronApp.evaluate(() => __evaosTest.views().map(v => ({id, bounds: v.getBounds(), visible: v.getVisible()})))`. Never ship this when the var is unset. Note `electronApp.evaluate`'s function receives the `electron` module as its first argument; `require` is **not** defined inside it.

### Pattern 5: PageControl (CDP) with DevTools
Verified on Electron 44.7.2: `wc.debugger.attach('1.3')` succeeded, `wc.openDevTools({mode:'detach'})` opened, the debugger stayed attached (`isAttached()` true, **no `detach` event**) and `Runtime.evaluate` kept working; opening DevTools first and attaching afterwards also worked. So no re-attach juggling is required, but still implement the lazy `ensureAttached()` wrapper (`if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')`) and treat a `detach` event as normal state. Operations: `navigate(url)` (`wc.loadURL`), `readText()` (`Runtime.evaluate {expression:'document.body.innerText', returnByValue:true}` returned `"guest page TEXT\nbtn"`), `click(selector)` (evaluate `document.querySelector(sel)?.click()` or `DOM.querySelector`+`Input.dispatchMouseEvent`), `evaluate(expr)`. A detached DevTools window shows up in Playwright's `app.windows()` as `devtools://devtools/bundled/devtools_app...`; filter windows by URL in tests.

### Pattern 6: Chrome extensions (BROW-08)
```ts
// main, after creating the guest session; Source: spike on Electron 44.7.2 + README
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension } from 'electron-chrome-web-store'
const ses = session.fromPartition('persist:browser')
const extensions = new ElectronChromeExtensions({ license: 'GPL-3.0', session: ses, createTab: ..., selectTab: ..., removeTab: ... })
extensions.addTab(guest.webContents, win)           // BaseWindow accepted (library lists BaseWindow.getAllWindows())
await installChromeWebStore({ session: ses, extensionsPath: join(configDir, 'extensions'), autoUpdate: false })
await ses.extensions.loadExtension(testExtDir)       // unpacked test extension (e2e)
await installExtension('nngceckbapebfimnlniiiahkandclblb', { session: ses, extensionsPath })  // Bitwarden, live only
```
Verified results: unpacked MV3 test extension (content script on `http://127.0.0.1/*`) loaded into `persist:browser` and modified the page (`document.body.innerText` = `served\nEXT OK`, `data-ext="loaded"`); identical with `BaseWindow` and `BrowserWindow`. Bitwarden (`nngceckbapebfimnlniiiahkandclblb`, version 2026.9.3, manifest v3, service-worker background) downloaded and loaded in 3.7 s with warnings `Permission 'contextMenus|sidePanel|webNavigation|notifications|privacy' is unknown` and one benign `Could not establish connection` background error; `ses.extensions.getAllExtensions()` listed it. Autofill itself could not be asserted unattended (Bitwarden injects only after sign-in/unlock). Rules:
- List both extension packages under `dependencies` so electron-vite externalizes them (verified: bundled-as-external build loaded the extension; bundling would break the library's preload path resolution).
- Run installs only on explicit action or first launch with network, never in the default test run; the default e2e uses the checked-in test extension. `EVAOS_LIVE=1` opt-in test installs Bitwarden into a temp `extensionsPath` and asserts `getAllExtensions()` contains it; sign-in/autofill goes to VERIFICATION.md as `still-needs-isaac`.
- The extension toolbar UI (`<browser-action-list partition="persist:browser">`, injected by `electron-chrome-extensions/browser-action` in the shell preload, and `ElectronChromeExtensions.handleCRXProtocol(shellSession)`) is needed to open Bitwarden's popup; budget it as a stretch task and record as `still-needs-isaac` if it is not finished. The popup class is BaseWindow-aware in the library source but I did not exercise it. [ASSUMED]
- Known unsupported `chrome.*`: `commands`, `tabs.captureVisibleTab`, `tabs.duplicate/highlight/move`, `webNavigation.onErrorOccurred`, `action.enable/disable`; and `offscreen`/`sidePanel` are not provided, which may limit some Bitwarden features. [CITED: README]

### Pattern 7: Arc login import (BROW-09)
- Exporter contract (read from `/Users/ike/Eva/.omp/tools/arc-cookies.ts` and `lib/arc-cookies.mjs`): `bun .omp/tools/arc-cookies.ts .omp/tools/lib/evaos-arc-sites.txt`, cwd = Eva root, stdout = JSON array of Playwright cookies; exits quietly with `[]` and a stderr note if Keychain did not answer within 8 s. It decrypts Arc's `Cookies` DB (a temp copy) with the "Arc Safe Storage" key, **cached at `/Users/ike/Eva/secrets/arc-safe-storage.key`**, so after the first Keychain approval it runs headless.
- Headless feasibility on this machine: Arc `Cookies` DB exists and `secrets/arc-safe-storage.key` exists, so the live path should run without a Keychain prompt. I did not run it (it would decrypt Isaac's real cookies); verification stays `still-needs-isaac` or an `EVAOS_LIVE=1` test that only counts cookies and asserts at least one for an allowlisted domain.
- The exporter lives under the Eva root and its key cache path is relative to the script, so it cannot be pointed at the fixture root. Tests inject a fixture instead: `EVAOS_ARC_EXPORT_CMD` (default: bun + the Eva script) overridden in tests by a script that prints `fixtures/arc-cookies.fixture.json`.
- Mapping to Electron (mirror Rust `arc_cookie`): Playwright cookie `url` (host-only) or `domain`+`path`; `expires` -1 means session cookie. `session.cookies.set({ url: <derived>, name, value, domain?, path, secure, httpOnly, expirationDate?, sameSite })` where `url = (secure?'https':'http') + '://' + domain.replace(/^\./,'') + path`; omit `domain` when the cookie came with `url` (host-only; `__Host-` cookies are rejected if they carry a domain); `expirationDate = expires` only when `> 0`; sameSite map `Lax→'lax'`, `Strict→'strict'`, `None→'no_restriction'`, else `'unspecified'`. Insert into `session.fromPartition('persist:browser').cookies` only, then `webContents.reload()`. Never log cookie values; return only `{count}` over IPC.
- The exporter only reads Eva files, but note it writes the key cache inside the Eva checkout (`secrets/`, gitignored upstream); this is the Eva tool's own write, not an EvaFs write, and is why the real run is opt-in.

### Pattern 8: Address bar and history suggestions (port, do not redesign)
Port Rust `normalize()` and its test table exactly (CONTEXT D-11 says "bare integer"; the Rust rule is **2 to 5 digits**):
- empty or whitespace: nothing; 2..5 ASCII digits: `http://127.0.0.1:<n>/` (`3000` ok; `123456` is a search; `7` is a search);
- contains `://`: as typed; host `localhost`, `127.0.0.1`, `[::1]` (optionally with `:port`): `http://<typed>`;
- no whitespace and host contains `.` and does not end with `.`: `https://<typed>` (`v1.2` becomes `https://v1.2`);
- otherwise: `https://www.google.com/search?q=` + whitespace-split words joined with `+` (README default engine; the Rust app does not URL-encode beyond joining with `+`, so use `encodeURIComponent` per word for correctness and keep the `+` joins).
Suggestions (BROW-07, in-app history only): `Visit{url,title,visits,key,titleKey}` with `key = url sans scheme, sans leading "www.", sans trailing "/", lowercased`; `add()` folds duplicate keys (visits add, non-empty title replaces); `suggest(history, typed, 6)`: every whitespace-separated word of the typed text (scheme and `www.` stripped) must appear in `key` or `titleKey`; rank 0 = key starts with typed text, rank 1 = a `.`,`/`,`-`-split part of key starts with the first word, rank 2 = rest; sort by rank, then visits desc, then shorter key. Store in `$EVAOS_CONFIG_DIR/browser-history.json` (JSON, atomic write, capped), record on `did-navigate` and on `page-title-updated`. Port the six Rust unit tests from `history.rs`.

### Pattern 9: Typed IPC under `sandbox: true`
`packages/contract` exports `Invoke` and `Events` maps with Zod schemas; main `handle(channel, schema, fn)` validates and returns `{ok:true,value}|{ok:false,error}`; preload exposes exactly `window.eva = { invoke, on }`. Preload must be CJS (verified: electron-vite 6 emits `out/preload/index.js` for a non-module package and the sandboxed shell used it successfully via `contextBridge`; with `"type":"module"` it emits `index.mjs`, which a sandboxed preload cannot load). Validate `event.senderFrame.url` starts with the app origin in every handler. Per-session event streams use `webContents.send`; high-frequency chat batches are plain `send` for now (MessagePort is a later optimization).

### Anti-Patterns to Avoid
- **`"type":"module"` in `apps/desktop/package.json`:** breaks the sandboxed preload (see above). Config files that must be ESM use `.mts`.
- **`readline` for omp stdout:** splits on U+2028/2029; use `LineFramer`.
- **Bundling `electron-chrome-extensions`:** its preload file is resolved relative to the module; keep it external via `dependencies`.
- **Relying on `page.screenshot()` for browser proof:** it excludes native views (verified: the shell screenshot showed only the shell colour where the guest sat).
- **`ps`-based process matching, signals to omp:** forbidden (D-17).
- **Using the literal `p95 < 16 ms` on a 120 Hz display without a baseline:** see P4.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Variable-height virtualization | Custom windowing + measurement | virtua `VList` | Verified on 5,000 rows with streaming growth |
| Chrome extension host | Own `chrome.*` shims | electron-chrome-extensions | Large API surface, MV3 service workers |
| Web Store download/unpack/CRX3 | CRX parser | electron-chrome-web-store | Verified Bitwarden install in 3.7 s |
| PNG decode/encode for composite | Hand-written PNG codec | pngjs (or guest-Page screenshot) | Compression, filters, palette |
| Schema validation | `typeof` checks | Zod 4 | Same schemas give types and runtime checks |
| Atomic writes | ad hoc `writeFile` | one `atomicWrite` helper in `eva-core/src/fs` | Phase 3 relies on it; only module allowed to write |
| UTF-8 stream decoding | manual byte slicing | `StringDecoder` | Split multibyte and emoji |
| Em-dash detection | grep over source | TypeScript-AST script (below) | Must ignore comments, only strings, template text, JSX text |

**Key insight:** the only genuinely custom code in this phase is the reducer (a port of `Live::apply`), the pin logic, the occlusion store and the harness glue. Everything else has a verified library.

## Session file format (CHAT-01)

- Location: `$PI_CODING_AGENT_DIR` else `~/.omp/agent`, then `sessions/<dir>/<ISO-timestamp>_<id>.jsonl`; the dir name encodes the cwd (here `-Eva`). The Rust app picks the sessions dir whose newest session records the Eva root as `cwd`. [VERIFIED: `chat.rs` + `ls`] Add `EVAOS_SESSIONS_DIR` (default in dev/test: `fixtures/agent/sessions/-fixture`) because a fixture checkout path will never match a recorded `cwd`. 107 real sessions in `-Eva` (largest 2,661 lines), so the 5,000-message benchmark must be synthetic.
- Record types seen (counts across the 107 real files): `message` 12,152; `custom` 5,788 (`tool_execution_start`, `session_exit`, `todo_hud_state`, ...); `custom_message` 456; `model_change`; `credential_pin`; `title`; `session`; `thinking_level_change`; `title_change`; `mode_change`; `ttsr_injection`; `compaction`; `model_usage`; `service_tier_change`. All but `title`/`session` carry `id` and `parentId`.
- Line 1 is `{"type":"title","v":1,"title":"","updatedAt":...,"pad":"<spaces>"}` (padded so omp rewrites the title in place; handle empty `title`); line 2 is `{"type":"session","version":3,"id","timestamp","cwd"}`.
- Active branch (port exactly): take all records that have a string `id`, start at the **last** such record, follow `parentId` through an id map until none, reverse; only `type:"message"` records become messages. Meta: `model_change.model` is `"provider/id"`, `thinking_level_change.thinkingLevel`, assistant `message.provider/model/usage` for context tokens (`contextSnapshot.promptTokens` else `usage.input+cacheRead+cacheWrite`).
- `message` shapes: roles `user` (`content` string or blocks, `attribution` `"user"|"agent"`; only `"user"` shows; strip a leading `<surface>...</surface>` tag), `assistant` (`content` blocks `text`, `thinking`, `toolCall {id,name,arguments}`; `stopReason`, `errorMessage`), `toolResult {toolCallId, toolName, content[], details, isError}` (attach to the tool row by `toolCallId`), `developer` (8 seen, show nothing). Images in `content` have `data` that is inline base64 or `blob:sha256:<hash>` resolved in `<agentDir>/blobs/<hash>` (Phase 4, render as placeholder text now).
- Port the Rust `session()` tests (`chat.rs` lines ~2600-2900): abandoned-branch, hidden handoff, tool result attach, and the live `apply` tests (`message_start/update/end`, unconfirmed prompt reconciliation, `prompt_result` error, `_eof`, `_stderr`).

## EvaFs Allowlist (FOUND-03, mirrors Rust exactly)

The Rust app writes into the Eva checkout in exactly four places; everything else it writes lives in its own config dir or omp's agent dir. [VERIFIED: grep of `/Users/ike/Eva/apps/evaos/src`]
| Operation | Rust source | Allowed target | Mechanism |
|-----------|-------------|----------------|-----------|
| Todo append | `eva.rs::append_todo` | `memory/todos.md` only (reads `todos-done.md` for the next id) | re-read then write whole file |
| Files save | `panel/files.rs::save_staged` | any file inside the root, explicit Save only | `openat` with `O_NOFOLLOW`, staged temp in the same directory, `renameat`, mtime conflict check |
| Job edit/create/delete | `jobs.rs::write_atomic`, `remove_dir_all` | `jobs/<name>/job.md`; delete removes `jobs/<name>/` | temp `.<file>.<pid>.tmp` then rename |
| Meeting status | `meetings.rs` | `work/meetings/<stem>.json` | temp then rename |

Phase 1 ships: `WriteKind = 'todo-append' | 'file-save' | 'job-md' | 'job-delete' | 'meeting-status'` with a path matcher per kind (realpath-contained in the root, no `..`, no symlink escape), a single `atomicWrite` helper, and **no callers**. Tests: (1) every non-allowlisted path and every matcher violation throws; (2) a static scan test reads `apps/desktop/src/main/**` and `packages/*/src/**` and fails on `writeFile|writeFileSync|appendFile|rename|rmSync|rm(|unlink|createWriteStream|copyFile|mkdir` outside `packages/eva-core/src/fs` (allow an explicit, reviewed exception list for the config-dir module, which writes only under `EVAOS_CONFIG_DIR`); (3) a runtime trap in test mode (`EVAOS_E2E`) that wraps `fs.promises.writeFile` etc. and records any resolved path under the real `/Users/ike/Eva` roots, asserted empty at exit. The sentinel (D-25) is defence in depth; see Open Question 3 on the live tree being dirty.

## Environment Contract (FOUND-04, FOUND-05)
`env.ts` resolves once at startup: `EVAOS_EVA_ROOT`, `EVAOS_OMP_BIN`, `EVAOS_CONFIG_DIR`, `EVAOS_SESSIONS_DIR`, `EVAOS_ARC_EXPORT_CMD`, `EVAOS_E2E`, `EVAOS_LIVE`. Rule: `app.isPackaged` false (dev, test) and `EVAOS_LIVE !== '1'` means fixture defaults; refuse to start with the real root unless `EVAOS_LIVE=1`. Apply `app.setPath('userData', configDir)` before `app.whenReady()` so Chromium profiles, the guest partition (`persist:browser`) and extension storage live under the temp dir in tests. Packaged default: `~/Library/Application Support/EvaOS Electron`. Fixture omp default: `fixtures/fake-omp/fake-omp.mjs` with a `#!/usr/bin/env node` shebang (mode 0755) so `spawn(EVAOS_OMP_BIN, args)` works without knowing node's path in a GUI launch; fall back to `process.execPath` with `ELECTRON_RUN_AS_NODE=1` if `node` is not found (RunAsNode fuse is on by default).

## Fake omp (D-23)
Contract it must honour (matches real omp 18.8.5): accept `--mode rpc-ui --resume <file> [--session-dir ...]`; print `ready` first; answer `set_ask_dialog`, `get_state` (with `sessionFile` echoing the resume path), `prompt` (ack, `agent_start`, replay a recording, `prompt_result`, `session_settled`), `abort` (stop replay, emit the recorded abort tail), steer (`queue_update` then deferred echo); end cleanly with exit 0 when stdin closes; never write to the session file (or append to a temp copy). Replay modes via env or a control frame: `chunk=1`, `chunk=glued`, `chunk=emoji-split` (split inside a multibyte char), `burst` (no delays), `slow` (real timings). **Recording:** I captured real frames with a 30-line Node script that spawns `omp --mode rpc-ui --session-dir <tmp> --model haiku --thinking off --no-tools --no-extensions --no-skills --no-rules --no-lsp --no-title` in a temp cwd and logs `{t, line}`; a one-turn reply costs well under a cent. Check in `scripts/record-omp.mjs` and a scrubbed recording (assistant text only, no real Eva data). Recorded sequence for one turn: `ready`, `response(set_ask_dialog)`, `response(get_state)`, `response(prompt)`, `agent_start`, `turn_start`, `message_start/end` (user, `msg-1`), `message_start` + about 20 `message_update` (assistant `msg-2`, text grows, each frame about 1.2 to 1.6 KB) + `message_end`, `turn_end`, `agent_end`, `prompt_result{completed}`, `session_settled`. Use the extra reply text with a code fence and an emoji so the framer tests are meaningful.

## Proof Harness (FOUND-06, PROF-01, PROF-02)

**Playwright facts (verified on 1.64.1 + Electron 44.7.2):**
- `_electron.launch({ args:[appDir], cwd, env })`; `firstWindow()` returns the shell `WebContentsView` page under `BaseWindow` (about 100 ms); `app.windows()` also lists each guest view (`file://.../guest.html`) and any DevTools window. Find pages by URL, never by index.
- `page.screenshot()` of the shell is the shell only. `view.webContents.capturePage()` returns the guest at device pixels (400x300 for a 400x300 view at scale 1) and works for visible views; `capturePage` on the BaseWindow's own `webContents` is not available (`global.__win.webContents` undefined for BaseWindow). Composite = shell shot + guest shots blitted at `bounds * scale`.
- Console errors: register `page.on('console')`/`page.on('pageerror')` and `app.process().stderr`; also in main attach `shell.webContents.on('console-message', (details) => ...)` (Electron 44 passes one `details` object with `level`, `message`, `lineNumber`, `sourceId`) and buffer level `error` entries on `__evaosTest.errors`; the gate asserts both are empty after `page.reload()`-free navigation. Ship a strict CSP in `index.html` for the built app (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'`) so Electron's "Insecure Content-Security-Policy" warning does not appear; relax only under the Vite dev server.
- The `EnableNodeCliInspectArguments` fuse is on by default; Playwright launches of the built app and of the packaged `.app` both worked, so do not flip fuses in Phase 1.
- Native dialogs are not intercepted; stub with `electronApp.evaluate(({dialog}) => ...)`.

```ts
// e2e/helpers/proofShot.ts (design; Source: spike measurements + pngjs API)
import { PNG } from 'pngjs'
export async function proofShot(app: ElectronApplication, shell: Page, name: string) {
  const base = PNG.sync.read(await shell.screenshot())
  const views = await app.evaluate(async () => Promise.all(__evaosTest.views().filter(v => v.getVisible()).map(async v => {
    const b = v.getBounds(); const img = await v.webContents.capturePage(); return { b, png: img.toPNG().toString('base64') } })))
  const scale = base.width / (await shell.evaluate(() => window.innerWidth))   // 1 on this Mac, 2 on Retina
  for (const v of views) blit(base, PNG.sync.read(Buffer.from(v.png, 'base64')), Math.round(v.b.x*scale), Math.round(v.b.y*scale))
  assertNotBlank(base)                       // variance of luminance over the whole image and over each view rect > threshold
  fs.mkdirSync('proof/phase-1', { recursive: true }); fs.writeFileSync(`proof/phase-1/${name}.png`, PNG.sync.write(base))
}
```
The blank check: compute mean and variance of luminance (sample every 8th pixel); reject if variance < 4 (on a 0..255 scale) overall **or** inside any visible view rect (a white or black page rectangle is the exact failure this exists to catch). A guest that is `setVisible(false)` is excluded from the composite, and the test asserts the hidden state separately. Pair every `proofShot` with an explicit assertion in the same test (title text, bounds, `getVisible()`, row count).

**Frame-time metric (CHAT-04, PROF-02) - the budget needs a baseline.** This Mac's display reports 119.97 Hz at scale 1 (size 3840x1080). rAF deltas therefore have p50 about 8.3 ms, and even an idle Electron page under Playwright shows p95 = 17.0 ms and max 28.8 ms (599 samples, no streaming). My streaming prototype (5,000 rows, last row grows every 16 ms, memoized rows, no markdown) measured p50 8.3, p95 16.4, p99 17.0, max 18.5 over 1,096 frames, i.e. indistinguishable from idle. A literal `p95 < 16` would therefore flake on measurement noise, not on the app. Recommendation (record in the plan SUMMARY as a deviation from D-28's wording): measure an idle baseline in the same run, define the gate as `streamP95 <= max(16.7, idleP95 * 1.25)` and `frames over 50 ms == 0`, and record all of `{idle, stream}` p50/p95/p99/max plus the display refresh rate in `metrics.json`. Also collect `PerformanceObserver({type:'long-animation-frame'})` entries and a React `<Profiler>` commit-duration p95 for the streaming row (target under 8 ms) as the more direct signals. Sampler: `requestAnimationFrame` loop pushing `t - last` into an array, discarding the first 10 frames; keep `backgroundThrottling:false` and the window shown.

**`metrics.json` shape (PROF-02):** `{ display:{hz,scale}, chat:{ messages:5000, framesReplayed, seqGaps:0, seqContiguous:true, idle:{p50,p95,p99,max}, stream:{p50,p95,p99,max, longFrames}, pinnedGapPx:0, jumpPillShown, newReplyShown }, browser:{ boundsDeltaPx:0, overlayHidesView:true, boundsRestoredAfterOverlay:true, cdpText:"...", devtoolsCoexist:true, extensionLoaded:true } , gate:{ ... } }`.

## Toolchain Findings

- **Output module format:** electron-vite 6.0.0 emits ESM for a `"type":"module"` package (`out/main/index.js`, `out/preload/index.mjs`) and CJS otherwise (`out/main/index.js`, `out/preload/index.js`). Use CJS (omit `"type"`), keep `"main": "./out/main/index.js"`. Config file: `electron.vite.config.ts` works as-is in a CJS package; Vitest and other Vite-loaded configs should be `.mts` to avoid the "ESM syntax in a CommonJS file" native-loader warning (seen with `vitest.config.ts`). Provide `input` entries explicitly if the layout differs from the default `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`. In dev, `process.env.ELECTRON_RENDERER_URL` is set; load it, else `loadFile(out/renderer/index.html)`. `node:sqlite` imports bundle as externals and ran inside the Electron 44 main process (verified: in-memory DB create/insert/select).
- **pnpm 12.11.2:** run it without a global install as `corepack pnpm@12.11.2 ...` (works with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`). Because electron-builder spawns the bare command `pnpm` (`spawn pnpm ENOENT` without it), create a repo-local shim: `corepack enable pnpm --install-directory "$PWD/.tools/bin"` and `export PATH="$PWD/.tools/bin:$PATH"` in `scripts/env.sh` (sourced by `gate.sh` and docs); gitignore `.tools/`. This avoids touching global config.
- **Build-script policy:** pnpm 12 fails the install with `ERR_PNPM_IGNORED_BUILDS` when any dependency has an unreviewed build script, and `onlyBuiltDependencies` is replaced by an `allowBuilds` map in `pnpm-workspace.yaml`. Observed: `node-pty` needs `allowBuilds: { node-pty: true }` (when added); `electron-builder` pulls `electron-winstaller` which must be denied `electron-winstaller: false`; **`electron` itself needs no entry** (Electron 44 ships no install script). D-03's `onlyBuiltDependencies` wording is therefore obsolete; record that in the SUMMARY. Commit the generated `pnpm-workspace.yaml`.
- **Release-age gate:** pnpm 12 defaults `minimumReleaseAge` to 1440 minutes; for freshly published exact pins it auto-appended `minimumReleaseAgeExclude` entries (`electron-vite@6.0.0`, `react@19.3.1`, `@playwright/test@1.64.1`, ...) during `pnpm install/add` and continued. Commit the resulting list; do not disable the gate. [VERIFIED: local installs]
- **Workspace:** `pnpm-workspace.yaml` needs `packages: ['apps/*','packages/*']`. Keep `get-shit-done-cc` as the root `devDependency` so `node_modules/.bin/gsd-sdk` still exists (D-03). Internal packages are consumed as TS source via `workspace:*`, listed in `devDependencies` of the app so Vite bundles them (only runtime-resolved packages go in `dependencies`).
- **Vitest 5.0.4 `projects`** (verified): inline `projects: [{ test:{ name:'main', environment:'node', include:['src/main/**/*.test.ts'] } }, { test:{ name:'renderer', environment:'jsdom', include:['src/renderer/**/*.test.{ts,tsx}'] } }, ...]` ran both; the Playwright spec in `e2e/` was not picked up because `include` is explicit. Keep Playwright specs as `*.spec.ts` under `e2e/` and Vitest tests as `*.test.ts(x)` next to source, `exclude: ['e2e/**', 'out/**']`. Add `packages/*/vitest.config.mts` projects for the pure packages.
- **Playwright config:** `testDir: 'e2e'`, `workers: 1`, `timeout: 60_000`, `retries: 0`, traces on first retry; a worker-scoped fixture launches the built app with the env contract and a per-run temp config dir, then `app.close()`.
- **Packaging smoke (D-26):** `electron-builder.yml` with `appId`, `files: ['out/**','package.json']`, `asarUnpack: ['**/node_modules/node-pty/**']` (harmless now), `mac: { target: [{target: dir, arch: arm64}], identity: null, hardenedRuntime: false, gatekeeperAssess: false }`, run with the pnpm shim on `PATH`. Verified: produced `release/mac-arm64/<Name>.app` in about 90 s including the Electron zip download and Playwright launched it by `executablePath` (`.../Contents/MacOS/<Name>`), `app.isPackaged` true. `@electron/rebuild` ran automatically and finished for node-pty. electron-builder prints "Implicit publishing triggered by CI detection": pass `--publish never`.
- **Em-dash lint (D-04):** a TypeScript-AST script is more reliable than regex. Run with `node scripts/lint-em-dash.ts` (Node 24.22 strips types natively, verified).
```ts
// scripts/lint-em-dash.ts  (Source: design; ts API is stable)
import ts from 'typescript'; import { readFileSync } from 'node:fs'; import { globSync } from 'node:fs'
const DASH = /—/
export function findEmDashes(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: { line: number; text: string }[] = []
  const visit = (n: ts.Node) => {
    const isStr = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)
    if (isStr && DASH.test(n.getText(sf))) hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).slice(0, 80) })
    ts.forEachChild(n, visit)
  }
  visit(sf); return hits
}
// main: glob apps/desktop/src/renderer/**/*.{ts,tsx} and packages/*/src/**/*.{ts,tsx}, exit 1 on any hit. Unit-test findEmDashes with fixtures (string, template, JSX text, JSX attribute; comment must NOT hit).
```
`fs.globSync` is stable in Node 24; no new dependency. The rule intentionally ignores comments (the project style rule is for UI strings). Also add the same check over `fixtures/**/*.md` transcript text? No: fixtures are data, not UI.

- **Gate script:** `scripts/gate.sh`: `set -euo pipefail`; `source scripts/env.sh`; `pnpm install --frozen-lockfile`; `pnpm -r typecheck`; `pnpm lint` (eslint + `node scripts/lint-em-dash.ts`); `pnpm test` (vitest run); `pnpm -C apps/desktop build`; `node scripts/sentinel.ts before`; `pnpm -C apps/desktop e2e`; `node scripts/sentinel.ts after`. Phase close requires exit 0.

## Common Pitfalls

### P1: ESM main/preload under a sandboxed shell
**What goes wrong:** blank shell, `window.eva` undefined, "Unable to load preload script". **Why:** `"type":"module"` makes electron-vite emit `index.mjs`, and sandboxed preloads cannot be ESM. **Avoid:** CJS package, assert in e2e that `window.eva.invoke` exists. **Detect:** first e2e test.

### P2: Treating `windows()[0]` as the shell
**What goes wrong:** flaky tests once guest views or DevTools exist. **How to avoid:** locate pages by URL (`app.windows().find(w => w.url().startsWith('file://') && w.url().endsWith('/renderer/index.html'))`), and use `firstWindow()` only at boot.

### P3: Native view proof is blank
**What goes wrong:** screenshots show an empty rectangle where the page is. **Avoid:** `proofShot` composite and the per-rect variance check; assert text through CDP or `webContents.executeJavaScript` in the same test.

### P4: Frame-time budget measured against a noisy clock
See Proof Harness. Idle p95 is 17 ms on this display under Playwright. Gate on the idle baseline plus zero frames over 50 ms; record absolute numbers.

### P5: Dropped or reordered frames from chunk-as-line parsing
**Avoid:** `LineFramer` plus the five chunking tests; assert `seq` contiguity in the e2e replay and in a Vitest unit over the batcher.

### P6: Two writers on one session file
**Avoid:** realpath-keyed owner registry in main; refuse with the UI-SPEC copy "This session is already open in another EvaOS window or pane. Close it there first."; tests always use fake omp and fixture sessions, never Isaac's live sessions. Real omp has no visible lock, so this guard is app-level only. [ASSUMED]

### P7: WebContentsView leaks and z-order surprises
Views are not destroyed with the window or on tab close: `removeChildView` + `webContents.close()`. The guest view always overlays the shell DOM, so every Mantine overlay (Modal, Popover, Menu, the suggestions list, the import confirmation) must call `useOccludeBrowser()`; otherwise the suggestions list renders under the page. Re-adding a child with `addChildView` moves it to the top; avoid doing that to the shell.

### P8: Extension install in the default test run
Hits the network, writes to the profile, can flake. Default tests use the checked-in test extension and a temp `userData`; Bitwarden is `EVAOS_LIVE=1` only.

### P9: node-pty `spawn-helper` not executable under pnpm (carry to Phase 6)
**Verified here:** with pnpm 12 the file `node_modules/.pnpm/node-pty@1.1.0/.../prebuilds/darwin-arm64/spawn-helper` had mode `0644`, so `pty.spawn` threw `posix_spawnp failed`; `chmod +x` fixed it. In the electron-builder `.app`, the unpacked `spawn-helper` must also be executable. Add a chmod step (postinstall script or `afterPack`) when node-pty lands; not needed in Phase 1.

### P10: Live Eva tree is dirty during runs
The D-25 sentinel can false-fail because Isaac and Eva write to `/Users/ike/Eva` all the time. See Open Question 3.

### P11: Hidden or occluded windows stop painting
`show:false` windows and `backgroundThrottling` skew rAF and break `capturePage`. Use `showInactive()` and `backgroundThrottling:false` under `EVAOS_E2E`.

### P12: Steered messages appear late
Real omp delivers a steer at the turn boundary, so the optimistic user message must stay last and be reconciled on the later `message_end` echo (Rust `unconfirmed()` logic). Do not expect the echo immediately.

## Code Examples

### electron.vite.config.ts and workspace files
```ts
// apps/desktop/electron.vite.config.ts (Source: verified spike config)
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: { build: { rollupOptions: { input: { index: 'src/main/index.ts' } } } },
  preload: { build: { rollupOptions: { input: { index: 'src/preload/index.ts' } } } },
  renderer: { root: 'src/renderer', plugins: [react()], build: { rollupOptions: { input: 'src/renderer/index.html' } } },
})
```
```yaml
# pnpm-workspace.yaml (pnpm 12 shape; minimumReleaseAgeExclude is auto-maintained by pnpm)
packages: ['apps/*', 'packages/*']
allowBuilds:
  electron-winstaller: false
  # node-pty: true     # add in Phase 6
```

### Playwright fixture
```ts
// e2e/fixtures.ts (Source: verified launch pattern)
export const test = base.extend<{ app: ElectronApplication; shell: Page }>({
  app: async ({}, use) => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'evaos-e2e-'))
    const app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env,
      EVAOS_E2E: '1', EVAOS_CONFIG_DIR: tmp, EVAOS_EVA_ROOT: fixtureRoot, EVAOS_OMP_BIN: fakeOmp, EVAOS_SESSIONS_DIR: fixtureSessions } })
    await use(app); await app.close(); fs.rmSync(tmp, { recursive: true, force: true })
  },
  shell: async ({ app }, use) => { const p = await app.firstWindow(); await p.waitForSelector('[data-testid=rail]'); await use(p) },
})
```

### Frame-time sampler
```ts
await page.evaluate(() => { (window as any).__fr = []; let last = performance.now()
  const f = (t: number) => { (window as any).__fr.push(t - last); last = t; requestAnimationFrame(f) }; requestAnimationFrame(f) })
// after the replay: sort, drop first 10, p = fr[Math.floor(n * q)]
```

### Bounds assertion
```ts
const slot = await shell.locator('[data-testid=browser-slot]').boundingBox()
const view = await app.evaluate(() => __evaosTest.views()[0].getBounds())
expect(view).toEqual({ x: Math.round(slot!.x), y: Math.round(slot!.y), width: Math.round(slot!.width), height: Math.round(slot!.height) })
```

## State of the Art

| Old approach | Current approach | Impact |
|--------------|------------------|--------|
| `BrowserView` | `WebContentsView` in `BaseWindow` | Documented; verified working with Playwright and extensions |
| `onlyBuiltDependencies` (pnpm 10) | `allowBuilds` in `pnpm-workspace.yaml` (pnpm 12) | D-03 wording obsolete |
| Electron postinstall binary download | Lazy download on first run (Electron 44) | No `electron` build-script approval needed |
| omp v1 raw frames | `ready` + optional v2 `rpc_chunk` framing | Keep v1; note limits |
| `webContents.on('console-message', (e, level, msg))` | `(details)` object | Use `details.level/message` |
| `webContents.canGoBack()` | `webContents.navigationHistory.canGoBack()/goBack()` | Use the `NavigationHistory` API (`canGoBack, canGoForward, goBack, goForward, getActiveIndex, getAllEntries...`) [CITED: electronjs.org navigation-history]; confirm the old method is deprecated in the spike |

**Deprecated/outdated:** `onlyBuiltDependencies`; `@dnd-kit/react` (not used here); `electron-trpc`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `<browser-action-list>` toolbar and Bitwarden popup work with a `BaseWindow` host (library source is BaseWindow-aware but the popup path was not run) | Pattern 6 | Bitwarden popup unusable until fixed; Bitwarden still loads. Mitigation: if it fails, parent popups to a hidden `BrowserWindow` or fall back to `BrowserWindow` + child views (D-06 fallback) |
| A2 | Bitwarden autofill works once signed in, with the listed unsupported APIs | Pattern 6 | Isaac's Bitwarden requirement not met; recorded `still-needs-isaac` |
| A3 | Real omp has no session-file lock, so the single-writer guard is app-level only | P6 | Double writers if another process resumes the same file; mitigated by the guard plus fake omp in tests |
| A4 | `-webkit-app-region: drag` on the chat header works for a `WebContentsView` inside a `BaseWindow` (UI-SPEC assumes it) | UI note | No window dragging; fallback: add a thin native drag strip via a transparent `View` or `titleBarStyle:'hiddenInset'` with a titlebar overlay; not tested |
| A5 | pngjs 7.0.0 is safe to add (slopcheck unavailable; 14 yrs, 71M weekly, no install scripts) | Package audit | Supply-chain risk is low; alternative is guest-Page screenshots |
| A6 | Allow-list of guest permissions can be deny-all for Phase 1 (README lists no browser permission grants) | BROW-06 | A site needing clipboard-write or fullscreen fails; allow `clipboard-sanitized-write` and `fullscreen` if needed |
| A7 | omp v2 `rpc_chunk` and `negotiate_protocol` behave as the embedded source suggests (not run live) | Pattern 1 | Only relevant if v2 is adopted later |
| A8 | `webContents.canGoBack()` is deprecated in Electron 44 in favour of `navigationHistory` | State of the Art | Minor; use `navigationHistory` either way |

## Open Questions

1. **Frame-time budget wording (D-28, D-18):** "p95 under 16 ms" is not measurable on a 120 Hz display driven by Playwright (idle p95 is 17 ms). Recommendation: planner adopts the baseline-relative gate above and records raw numbers; this is a recorded deviation, not a silent downgrade. If a virtua failure is claimed, it must be shown against the baseline, not the literal 16.
2. **`ready` frame and v2 chunking:** Should Phase 1 negotiate protocol v2 to avoid elided oversize frames? Recommendation: no (Rust parity, v1 works); handle `rpc_frame_error` as a notice and revisit in Phase 4 if real sessions hit the 1 MiB limit.
3. **Sentinel on a live, dirty tree:** `/Users/ike/Eva` is Isaac's working tree and `git status --porcelain` currently prints nothing, but Eva's own jobs write there. Recommendation: capture the porcelain output before and after, fail only on a difference, print the diff, and allow an `EVAOS_SENTINEL_IGNORE` glob list; rely on the EvaFs runtime trap (writes under the real root) as the authoritative assertion. In the default fixture mode the app never opens the real root.
4. **Bitwarden popup UI (`<browser-action-list>`):** in scope for BROW-08 or a stretch? Recommendation: stretch task at the end of the browser plan; if it is not done, BROW-08 is satisfied by "loads in the session" and the autofill/popup check is `still-needs-isaac`.
5. **Window drag region (A4):** verify with a 5-minute check in the harness plan; fall back as noted.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | tooling, Vitest, scripts | yes | v24.22.0 (native TS type stripping works) | none needed |
| corepack / pnpm | install, gate | corepack 0.36.0; `pnpm` not on PATH | pnpm 12.11.2 via `corepack pnpm@12.11.2` | repo-local shim with `corepack enable pnpm --install-directory .tools/bin` |
| Electron binary | dev, e2e | downloads on first run (network ok) | 44.7.2 | none |
| omp | live opt-in only | yes, `/Users/ike/.local/bin/omp` | 18.8.5 | fake omp (default) |
| bun | Arc exporter, live tools | yes, `/Users/ike/.bun/bin/bun` | 1.4.2 | fixture exporter in tests |
| Arc + key cache | live BROW-09 | Arc Cookies DB present; `/Users/ike/Eva/secrets/arc-safe-storage.key` present | n/a | `still-needs-isaac` |
| Network | extension install, Electron download | yes | n/a | skip live tests |
| GUI session / display | Playwright Electron | yes, display 3840x1080 at 119.97 Hz, scale 1 | n/a | none (windows must be shown) |
| git | commits, sentinel | yes | 2.54.0 | none |
| slopcheck | package audit | no (PEP 668) | n/a | packages tagged `[ASSUMED]` above |

**Missing with no fallback:** none. **Missing with fallback:** pnpm on PATH (shim), slopcheck (audit table).

## Validation Architecture

Nyquist validation is disabled for this project (`workflow.nyquist_validation: false`); a short layer map only.

| Layer | Tool | Scope | Command |
|-------|------|-------|---------|
| Unit (pure) | Vitest `node` projects | framer, reducer, session parser, `normalize`, history `suggest`, EvaFs matchers, em-dash lint, write-scan | `pnpm test` |
| Component | Vitest `jsdom` | pill logic helpers, overlay store, address bar component (no virtualization) | `pnpm test` |
| E2E | Playwright `_electron` on `apps/desktop/out` | chat replay, abort, steer, close lifecycle, 5,000-row pin/pills, bounds, overlay hide, CDP probe, test extension, fixture Arc import, `proofShot` | `pnpm -C apps/desktop e2e` |
| Packaged smoke | Playwright `executablePath` | `.app` boots, shell visible, IPC works | `pnpm -C apps/desktop e2e:packaged` |
| Gate | `scripts/gate.sh` | all of the above plus build and sentinel | `pnpm gate` |

Wave 0 gaps: the whole harness (none of it exists). Quick commands for per-task feedback: `pnpm -C packages/chat-core test`, `pnpm -C apps/desktop e2e --grep <name>`.

## Security Domain

| ASVS category | Applies | Control |
|---------------|---------|---------|
| V2/V3 Authentication, Session | no (single user, no sign-in in app) | n/a |
| V4 Access Control | yes | EvaFs closed allowlist, realpath containment; IPC `senderFrame` URL check |
| V5 Input Validation | yes | Zod on every IPC payload and every omp frame; per-line JSON try/catch |
| V6 Cryptography | no (Arc decryption is the Eva tool's job) | never hand-roll; do not log cookie values |
| V12 Files / V14 Config | yes | atomic writes, temp config dir in tests, strict CSP, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| Guest page reaches app IPC | Elevation | guests have no preload and a separate partition; handlers verify `senderFrame.url` |
| Popup or permission abuse by guest | Tampering | `setWindowOpenHandler` deny, deny-all permission handler, `shell.openExternal` only for `http(s)` |
| Arc cookies leak | Info disclosure | cookies set only in `persist:browser`, values never logged or sent over IPC, import only on button |
| Model output renders HTML | Tampering | plain text rendering in Phase 1 (no `dangerouslySetInnerHTML`, no `rehype-raw` later) |
| Writes to live Eva data | Tampering | EvaFs, fixture root default, runtime write trap, sentinel |
| Killing a live omp | DoS | no signals to session processes; stdin close only; tests use fake omp |
| Extension supply chain (Bitwarden via Web Store) | Tampering | explicit install action, extension id allowlist (`allowlist: [bitwarden id]`) in `installChromeWebStore` |

## Project Constraints (from CLAUDE.md)

- Unattended: never wait for input; every decision takes the recommended default; `human_needed` items are driven with Playwright for Electron and recorded as `agent-verified` (with screenshot path under `proof/phase-1/`) or `still-needs-isaac` in VERIFICATION.md; `gaps_found` after retry go under `## Deferred gaps`.
- A phase is not done unless the app still builds and launches; run tests before marking complete.
- Read-only: `/Users/ike/Eva/apps/evaos`, `/Users/ike/Eva/work/relay`, everything outside this repo except exact current EvaOS Eva data writes. No global config changes, no remote, no push.
- Isaac's decision: Bitwarden through real Chrome extensions (`electron-chrome-extensions` + `electron-chrome-web-store`), Arc login import stays.
- Stack pins (Electron 44.7.2, electron-vite 6.0.0, Vite 8.3.4, React 19.3.1, Mantine 9.7.2, TypeScript ~6.0.3 not 7, zustand, Zod, virtua, Vitest 5, Playwright 1.64.1, pnpm 12). Fixed by Isaac: Electron, React, TypeScript, Mantine, Vite, pnpm, Vitest, Playwright.
- No em dashes in UI strings; commit per completed plan on `main`; GSD workflow enforcement (no direct edits outside a GSD flow). IPC: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, validate `senderFrame`. Guest partition `persist:eva-browser` in CLAUDE.md vs `persist:browser` in D-09: CONTEXT D-09 is the later decision; use `persist:browser`.
- Browser: `WebContentsView`, never `<webview>` or `BrowserView`; permissions deny-by-default; `shell.openExternal` allow-lists `http/https`.
- Playwright: keep the `EnableNodeCliInspectArguments` fuse enabled; stub native dialogs; launch the built app with `workers: 1`.

## Suggested Plan Decomposition (for the planner)

1. **Workspace and toolchain (FOUND-01, 02, 08 partial):** root + workspace files, pnpm shim, electron-vite app that boots a `BaseWindow` shell with `window.eva` preload, Vitest projects, Playwright config, first e2e: `firstWindow()` sees the shell, `window.eva` exists, zero console errors. Record the BaseWindow outcome (it works; no fallback).
2. **Safety and env (FOUND-03, 04, 05):** `env.ts`, `EvaFs` + matcher tests + write-scan + runtime trap, fixture Eva root, sentinel script.
3. **Fake omp, recording and fixtures (CHAT test infra):** `record-omp.mjs`, recorded frame log, `fake-omp.mjs`, 5,000-message generator and fixture session.
4. **chat-core (CHAT-01, 03, 08):** `LineFramer`, frame schemas, reducer ported from `chat.rs` with its tests, session parser, `tagged()`, `Transport` interface; all pure Vitest.
5. **SessionManager and chat IPC (CHAT-02, 06, 07):** spawn, handshake, prompt/abort/steer, seq batching, snapshot, single-writer guard, stdin-close lifecycle; e2e with fake omp.
6. **Chat view (CHAT-04, 05):** virtua log, pills, composer stub, thinking/tool rows, benchmark e2e with frame-time metrics.
7. **BrowserHost (BROW-01..07):** views, bounds sync, `OverlayStack`, tab strip, address bar, history suggestions, DevTools, `PageControl`, hotkey forwarding, hardening; e2e for bounds, overlay hide, CDP probe.
8. **Extensions and Arc import (BROW-08, 09):** libraries, test extension e2e, live opt-in Bitwarden install, Arc import button with fixture exporter, `still-needs-isaac` records.
9. **Proof and gate (FOUND-06, 07, PROF-01, 02):** `proofShot`, blank check, `metrics.json`, `gate.sh`, packaged smoke, VERIFICATION.md with `agent-verified` / `still-needs-isaac` items.

Plans 3, 4 and 7 can run in parallel after plan 1. Plan 9's helpers (`proofShot`) should land early (right after plan 1) because every later plan uses them.

## Sources

### Primary (HIGH confidence)
- Local spikes on this Mac, 2026-10-15 (Electron 44.7.2, Playwright 1.64.1, electron-vite 6.0.0, pnpm 12.11.2, virtua 0.53.5, electron-chrome-extensions 4.9.0, electron-chrome-web-store 0.13.0, electron-builder 26.15.3, Vitest 5.0.4): BaseWindow + Playwright visibility, `capturePage`, DevTools/CDP coexistence, extension load, Bitwarden install, node:sqlite in main, virtua pin behaviour, frame-time baseline, packaging, pnpm install behaviours.
- omp 18.8.5 binary: embedded `wire/commands.ts`, `wire/events.ts`, `wire/frames.ts`, `wire/state.ts` strings and live recorded rpc-ui frames (spawned only against throwaway `--session-dir` temp sessions; no live sessions touched).
- `/Users/ike/Eva/apps/evaos/src/chat.rs`, `panel/browser.rs`, `panel/browser/history.rs`, `panel/browser/logins.rs`, `eva.rs`, `jobs.rs`, `meetings.rs`, `panel/files.rs`, `README.md` (read-only).
- `/Users/ike/Eva/.omp/tools/arc-cookies.ts` and `lib/arc-cookies.mjs` (read-only).
- virtua `lib/react/VList.d.ts`, `Virtualizer.d.ts`, `core/scroll-to.d.ts` from the installed 0.53.5 package.
- npm registry (`npm view`, weekly downloads API) 2026-10-15.

### Secondary (MEDIUM confidence)
- electron-chrome-extensions README and electron-chrome-web-store README (raw GitHub, samuelmaddock/electron-browser-shell).
- electronjs.org docs: web-contents (console-message details, before-input-event, capturePage, openDevTools), navigation-history.
- pnpm.io settings pages (`minimumReleaseAge` default 1440 minutes; `allowBuilds`).

### Tertiary (LOW confidence)
- Bitwarden autofill working under electron-chrome-extensions: no source found, only the install/load verified.
- `-webkit-app-region` in `BaseWindow` child views: not tested.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, every pin re-verified and built.
- Architecture: HIGH for window composition, CDP, extensions loading, virtua pin, packaging (all run); MEDIUM for Bitwarden popup/autofill and drag region.
- Protocol: HIGH (live recordings + embedded schema); v2 chunking MEDIUM (not exercised).
- Pitfalls: HIGH for items marked verified; P6 and P10 are design judgements.

**Research date:** 2026-10-15
**Valid until:** about 2026-10-29 (electron-vite 6.0.0 and Playwright 1.64.1 are hours old; omp updates frequently, re-run `omp --version` and the recorder before checking in the recording)

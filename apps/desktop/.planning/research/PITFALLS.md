# Domain Pitfalls

**Domain:** Electron port of a native AI-assistant workbench (EvaOS: omp RPC chat, WebContentsView browser, node-pty terminal, Eva-checkout data, ~68k-line Rust reference)
**Researched:** 2026-10-14
**Overall confidence:** MEDIUM. Pitfalls derive from the EvaOS README (HIGH for app-specific lifecycle and data rules) plus well-known Electron, node-pty, pnpm and Playwright behavior (MEDIUM, from experience and docs; web verification was not run in this pass, so version-specific claims are flagged for confirmation in the owning phase).

Phase names below are provisional labels for the roadmapper: **P0 Scaffold/Toolchain**, **P1 Chat Spike**, **P2 Browser Spike**, **P3 Shell/Data/Dashboard**, **P4 Chat Parity**, **P5 Side Panel (Terminal/Files)**, **P6 Inbox/Jobs/Habits/Meetings**, **P7 Rich Widgets**, **P8 Theme/Settings/Polish**. Map to the real roadmap as needed.

---

## Critical Pitfalls

### 1. Parsing omp RPC stdout as "one chunk = one message"
**What goes wrong:** `child.stdout.on('data')` chunks split JSON lines mid-object or glue several together. Naive `JSON.parse(chunk)` drops or throws on frames; a single bad line kills the stream handler.
**Why it happens:** Node stream chunks are arbitrary byte slices; multibyte UTF-8 characters can also split across chunks.
**Consequences:** "Dropped tokens", the headline Core Value failure. Looks like an rendering bug, is a framing bug.
**Prevention:** One `LineFramer` in the main process: `StringDecoder('utf8')` plus a carry-over buffer split on `\n` (tolerate `\r\n`), parse per complete line inside try/catch, log-and-continue on a bad line (never throw out of the handler), emit a counted `malformed` metric. Keep stderr separate from stdout (never merge). Unit-test with a fixture fed in 1-byte, random-size and glued chunks, including an emoji split across chunks.
**Detection:** Frame count in main (parsed) vs line count in the raw tee differs; any `SyntaxError` in logs.
**Phase:** P1.

### 2. No ordering/sequence guarantee between main and renderer, and renderer re-render storms
**What goes wrong:** Each token frame sent over `webContents.send` becomes a React state update; hundreds per second pin the renderer, and if state is derived from several IPC channels (delta events vs `message_end`), reorder or double-apply happens. A busy renderer queues IPC, and a naive "latest wins" coalescer drops frames.
**Why it happens:** Treating the wire protocol as UI events; per-token `setState`; using separate channels for related events; coalescing by overwrite instead of by concatenation.
**Consequences:** Jank, stale tails, duplicated or missing text, final message differing from streamed text.
**Prevention:**
- Main owns the session state machine and assigns a monotonically increasing `seq` per session to every normalized event; renderer asserts `seq === last+1` and, on a gap, requests a resync snapshot (`getSessionState(sessionId, fromSeq)`).
- One ordered channel per app (not per session type), batch in main on a ~16 ms timer or per frame: send arrays of events, concatenating adjacent text deltas for the same block. Never overwrite; always append.
- Renderer keeps the streaming message in a mutable store outside React (e.g. external store or zustand with `useSyncExternalStore`, a ref-backed text buffer flushed by `requestAnimationFrame`); only the active streaming row re-renders; finished rows are `React.memo` with stable props.
- The finished message from `message_end` or the session file is authoritative and replaces the streamed text (reconcile, do not append).
- Keep the canonical transcript in main (or the file), so a reloaded renderer (DevTools reload, crash) can rebuild without losing frames.
**Detection:** Playwright check that concatenated streamed deltas equal the final message byte for byte across a scripted fake-omp run of 10k tokens; React Profiler commit counts per second during stream above ~60; a `seq` gap counter in a debug overlay.
**Phase:** P1 (design the protocol and seq at the spike, retrofitting is costly).

### 3. Killing or corrupting live omp sessions (process lifecycle)
**What goes wrong:** `child.kill()` / SIGKILL on quit, on window close, on test teardown or on a crash handler; omp does not save the session; or the Electron main exits before stdin closes; or a second omp is started on the same session file while Relay, herdr or the Rust app has it open.
**Why it happens:** Default Node/Electron instincts and Playwright teardown (`electronApp.close()`) kill processes. README: "Closing EvaOS closes their stdin, and omp exits after saving"; continuing a past chat "starts a second omp on the same session, so EvaOS asks first when another may be running it".
**Consequences:** Lost or truncated session JSONL on Isaac's real sessions; dual writers corrupting one file.
**Prevention:**
- `SessionSupervisor` in main is the only code that spawns or ends omp. API: `stop(id)` = `stdin.end()`, wait for `exit` with a generous timeout, surface "still saving" UI; there is no SIGKILL path for live sessions in the code base at all (lint or a grep test enforcing no `.kill('SIGKILL')` outside the terminal module). Escalation beyond stdin close only SIGTERM after a long timeout and only for processes this app spawned.
- On `before-quit`: `event.preventDefault()`, close all stdins, await exits (cap, then SIGTERM only), then `app.exit()`. Handle `window-all-closed` on macOS, `SIGINT`/`SIGTERM` to Electron itself, and `uncaughtException` the same way.
- Spawn omp with `detached:false` and stdio `['pipe','pipe','pipe']`; never `unref` a session. (Job runs are the opposite: detached, no stdio, own process group, not killed on quit, per README.)
- Single-writer guard: replicate the README rule (ask first when the file changed in the last 10 minutes, or Relay hears it and cannot take replies); until implemented, default to read-only for any session not started by this app.
- Test and proof runs use a fake omp executable (a script speaking rpc-ui) or `--no-session` against a throwaway sessions dir, never Isaac's live sessions. Put `OMP_*`/session dir overrides in the test harness and assert the path is under a temp dir before spawn.
- "Access mode restart" (README: switching approval mode restarts omp on the same session) must be stdin-close, wait, respawn, never kill.
**Detection:** Session file mtime stops advancing at quit; zombie `omp` in `ps` after app exit; JSONL last line truncated; test that spawns fake omp and asserts it received EOF and exited 0.
**Phase:** P1 (supervisor), P4 (restart flow, second-writer guard), every phase's test harness.

### 4. Backpressure and many concurrent sessions
**What goes wrong:** Writing prompts to a stdin whose pipe is full blocks or drops; ignoring `drain`; unbounded buffers per session; N live sessions each streaming to one renderer; stderr unread fills the pipe and omp stalls.
**Prevention:** Always consume stderr (ring buffer last N KB for diagnostics). Respect `write()` return and `drain`; queue outbound commands per session with ordering (steer, stop and prompt are order-sensitive; a stop must jump the queue only if protocol-safe). Per-session event batching; background (not visible) sessions get lower-frequency coalesced flushes or only a status summary, with full transcript rebuilt from file/seq on focus. Cap in-memory transcript per session and page the rest from the session file. Child lifetime keyed by session id, never by view mount (side chats, Eregon tabs and the main chat unmounting must not end the process).
**Detection:** Memory growth over a 30-minute multi-session soak; a stalled omp with stderr unread.
**Phase:** P1 (single), P4 (multi: side chats, Eregon, jobs).

### 5. Dual-view of session state: stream plus session file watcher disagree
**What goes wrong:** The app both streams RPC events from its own omp and watches `~/.omp/agent/sessions` files for external changes, then shows duplicates or flicker. README notes FSEvents only reports writes after a file closes, so the Rust app polls file times every 500 ms; chokidar or `fs.watch` on macOS will look fine in tests and miss live writes.
**Prevention:** Per session, one source of truth at a time: owned live session uses RPC; non-owned sessions use file polling (stat mtime/size every 500 ms, as README does), not `fs.watch`. Dedupe by message id on handoff. Never write to a session file.
**Phase:** P4.

### 6. WebContentsView bounds drift and z-order (the Core Value browser)
**What goes wrong:** `WebContentsView` is a native view composited above the renderer's DOM. Consequences: (a) HTML overlays (the `⌘K` global search, dialogs, menus, popovers, toasts, Eregon, drag handles, the habit gate overlay) cannot render over the browser rect, they are covered; (b) bounds set once go stale on window resize, column drag, sidebar fold, entrance animation, zoom/DPI change, devtools dock, fullscreen, display move; (c) wrong coordinate space (DIP vs CSS px, title bar offset, `titleBarStyle: hiddenInset`).
**Why it happens:** Assuming it is a DOM element. This is precisely the gpui "stacking, focus and position-sync seam" the port wants to leave; it can reappear if bounds sync is ad hoc.
**Prevention:**
- A placeholder `<div data-browser-slot>` in React is the layout truth; a `ResizeObserver` plus window `resize`/`move` plus transitionend/animation listeners report `getBoundingClientRect()` to main, throttled to rAF; main calls `view.setBounds(Math.round(...))`. During column drag or animations, sample every frame. Verify with a Playwright assertion comparing the slot rect to `view.getBounds()`.
- Overlay strategy decided up front and uniform: when any overlay/dialog/menu/search/gate/Eregon expands over the panel, main hides the view (`setVisible(false)`) or swaps it for a captured `capturePage()` bitmap shown in the slot. Implement as a single `OverlayStack` counter in the renderer that drives `browser:suspend`; do not special-case per overlay. Alternative: render overlays in their own top `WebContentsView` added last (view order is z-order). Pick one in P2 and apply to all.
- Remember to remove/re-add or `setVisible` for inactive subtabs, and destroy on tab close.
- Entrance animation and responsive shrink order must freeze the browser until layout settles.
**Detection:** Screenshot diff showing the page offset from the card edge; search box rendering behind the page; mismatch assertion in tests; visible lag trailing a column drag.
**Phase:** P2 (mechanism), P3 (shell resize, auto-fold), P6 (gate overlay, global search), P8 (animation).

### 7. Focus stealing and keyboard-shortcut leaks with the embedded page
**What goes wrong:** Once the guest page has focus, renderer `keydown` handlers (`⌘K`, `⌘J`, `⌘B`, `⌘⇧B`, `⌘F`, Esc ladder) never fire; clicking the address bar vs page toggles focus unpredictably; the guest page grabs focus on navigation (autofocus) and steals typing from chat composer or terminal; menu accelerators fire inside xterm.
**Prevention:** Register app hotkeys as native Menu accelerators or via `before-input-event` on both the main webContents and each guest webContents, forwarding matches to the renderer over IPC; keep one hotkey router with a context (page focus, terminal focus, composer focus, overlay open) so terminal focus isolation (README requirement) is a single table. Explicitly `webContents.focus()` the correct target on panel open/close; blur the guest when an overlay opens. Disallow guest `autofocus` stealing when the app is not intending to focus the view (focus only on user click or navigate-with-intent).
**Detection:** Playwright: focus the guest page, press `⌘K`, assert search opens; type in composer while page loads, assert no characters lost.
**Phase:** P2 (guest forwarding), P3 (hotkey router), P5 (terminal isolation).

### 8. Browser security: guest content with app privileges
**What goes wrong:** Loading arbitrary sites (or a local dev server) in a view that shares the preload/bridge or session with the app UI; `nodeIntegration` on; missing `sandbox`; `window.open`/`target=_blank` spawning raw BrowserWindows with the app's preload; permission prompts auto-granted; navigation of the app's own renderer to an external URL; custom protocol or `file://` loaded content trusted.
**Prevention:** Guest `WebContentsView`: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity` default, no preload at all, separate `partition` (e.g. `persist:browser`) so cookies are not shared with the app UI session. App renderer: strict CSP, `will-navigate` and `setWindowOpenHandler` deny-all (route external URLs to the browser panel or `shell.openExternal` after allowlisting `http(s)`), `session.setPermissionRequestHandler`/`setPermissionCheckHandler` deny by default (grant per prompt UI for clipboard, notifications as designed), block `webview` tag and `will-attach-webview`. `window.open` and `target=_blank` from the guest: `setWindowOpenHandler` returns `{action:'deny'}` and opens a new subtab (the spec has subtabs). Treat localhost dev servers as untrusted too. Expose a minimal typed preload API to the app renderer only, validate every IPC arg and check `event.senderFrame.url` origin. CDP page control must attach only to guest views (`debugger.attach`), never expose a general `executeJavaScript` bridge to guest content.
**Detection:** Test page with `window.open`, `target=_blank`, `window.require` probe, permission requests; assert nothing escapes and `require` is undefined.
**Phase:** P2 (non-negotiable at birth), re-audit P8.

### 9. DevTools docking and per-tab memory
**What goes wrong:** `openDevTools({mode:'right'})` on a WebContentsView docks inconsistently or opens detached; devtools steals focus and breaks bounds; every subtab keeps a live renderer process (hundreds of MB) and background tabs are never discarded; closing a tab without `webContents.close()` leaks.
**Prevention:** Decide devtools UX in P2: detached window by default (reliable), docked only if verified with the pinned Electron version (flag LOW confidence; test). Explicit lifecycle: `view.webContents.close()` on tab close, remove from `contentView`, drop references; cap live tabs and suspend idle subtabs (discard to URL plus screenshot); throttle background tabs via `setBackgroundThrottling`/`setVisible(false)`. Measure RSS per tab in a proof test.
**Phase:** P2.

### 10. Writing to the Eva checkout beyond the sanctioned writes
**What goes wrong:** A file watcher or dev tool writes on its own (editor-like formatters, Vite writing caches/`.vite` or logs inside `/Users/ike/Eva`, electron `userData`, Playwright traces/screenshots resolving relative to the wrong cwd, `electron-store` defaulting under a surprising path); Files panel "preview" saving; a theme/layout save going to the checkout instead of `$EVAOS_CONFIG_DIR`; reading `todos.md` then writing a stale copy back over a concurrent edit by Eva or omp.
**Why it happens:** Defaults and cwd. The Rust app and omp/Eva edit the same files (`memory/todos.md`, `jobs/*/job.md`, `habits.yml`) concurrently.
**Consequences:** Lost todo rows, corrupted job definitions, an agent confused by a changed repo, in the worst case lost Isaac data.
**Prevention:**
- One `EvaFs` module in main; every path passes through `resolveRead(path)`/`resolveWrite(kind, path)`. Writes only via a closed enum of sanctioned operations (`appendTodo`, `saveFile(explicit)`, `saveJob`, `acceptMeetingProposal`, `inbox.jsonl`/`layout.json`/`chat.json`/`digest.json` in config dir). Any other write throws. Runtime guard plus a unit test that greps the code base for `fs.write*`/`rename`/`appendFile` outside that module.
- Dev/test default `EVAOS_CONFIG_DIR` and the Eva root to a fixture copy (`fixtures/eva-root`), not `/Users/ike/Eva`; the live root only via an explicit `EVA_ROOT` opt in and the `--read-only` flag making `EvaFs` write-deny in all non-fixture runs. Autonomous phases run against fixtures by default.
- Read-modify-write races (todos, job.md): re-read immediately before write, apply the minimal edit (append a row after the last open row; change only edited lines), write via sibling temp file plus `rename` (same dir, same filesystem), refuse if mtime/hash changed since open (the README's own rule for job.md), retry once on conflict. Do not use `fs.writeFile` truncating in place. Match the Rust app's todo id rule: next id from both todos files, contiguous.
- `inbox.jsonl` is append-only: use `appendFile` with `O_APPEND` of whole lines ending in `\n`, tolerate a torn last line on replay (skip it), and compaction (rewrite when twice the rows) via temp plus rename; only one app instance should compact. Running beside the Rust app means both may append: never compact the shared file in a mode where the Rust app is also live, or give this app its own config dir (`EVAOS_CONFIG_DIR`) by default during parity so the two apps never share state files. Decide this explicitly (recommended: separate config dir until cutover; read-only import of the Rust app's state).
- Watchers read-only, with polling for session files and `work/*` (README polls every 2 s); watcher callbacks must never trigger a save path. Beware self-triggered loops (own write fires own watcher, triggers reconcile, triggers write).
- Redirect Vite cache, Playwright output, electron `userData`, logs to the repo or temp dir (`cacheDir`, `outputDir`, `app.setPath('userData', ...)` for dev/test).
- Provide a `git status` sentinel in the proof harness: before and after each Playwright run, `git -C /Users/ike/Eva status --porcelain` diff must be empty (excluding fixture-approved paths). Also hash `apps/evaos` and `work/relay` trees untouched.
**Detection:** The sentinel shows any change; unexpected files in the Eva root; mtime changes on `memory/todos.md` without a New Todo action.
**Phase:** P0 (EvaFs, fixture root, sentinel), P3 (todos), P5 (Files save), P6 (jobs, meetings, inbox). Every later phase inherits the guard.

### 11. Native modules (node-pty, better-sqlite3) under pnpm and electron-builder
**What goes wrong:** Module compiled against system Node ABI instead of Electron's, giving `NODE_MODULE_VERSION` mismatch at runtime; pnpm's isolated `node_modules/.pnpm` layout hides the module from `@electron/rebuild` or from electron-builder's dependency collection; build scripts skipped because pnpm 10 blocks dependency lifecycle scripts by default (`onlyBuiltDependencies`/`pnpm approve-builds`); `spawn-helper` (node-pty on macOS) loses its executable bit or is left inside the asar, so `posix_spawn` fails; native `.node` files inside asar fail to load; Vitest (Node ABI) and Electron (Electron ABI) need different builds of the same module, so rebuilding for one breaks the other.
**Prevention:**
- Root `.npmrc`: `node-linker=hoisted` for the Electron app package (simplest and most documented path for electron-builder) or, at minimum, `public-hoist-pattern` plus verify; decide in P0 and record it. Declare `pnpm.onlyBuiltDependencies` (`electron`, `esbuild`, `node-pty`, `better-sqlite3`) so installs actually build.
- `postinstall`: `electron-builder install-app-deps` or `@electron/rebuild -f -w node-pty,better-sqlite3`. Prefer prebuilt binaries: node-pty ships prebuilds in newer versions (confirm for the pinned version; LOW). Consider `node:sqlite` (built into recent Node/Electron) or reading bank DBs read-only to avoid better-sqlite3 entirely; the project only needs SQLite if it reads mnemopi, which CLAUDE.md marks as not for this app. Prefer dropping better-sqlite3 unless a module concretely needs it.
- Keep native modules out of Vitest: unit-test through interfaces with fakes; run native integration only inside Electron (Playwright). Never share one `node_modules` build for both ABIs.
- electron-builder: `asarUnpack: ["**/node_modules/node-pty/**"]` (and better-sqlite3), `files` filter, and in the packaged-app smoke test spawn a PTY and run `echo`; check `chmod +x spawn-helper` after unpack. Keep Electron version pinned exactly (no caret), since ABI follows it.
- Packaging is not required by the project (no release packaging), but a packaged-build smoke test is the only way to catch asar and unpack issues and Playwright `_electron` on packaged builds; schedule one in P5 rather than discovering at the end.
**Detection:** First run after a clean `pnpm install` that loads node-pty in Electron; `ERR_DLOPEN_FAILED`; `posix_spawn failed`.
**Phase:** P0 (toolchain decision and `pnpm install` from clean in CI loop), P5 (PTY).

### 12. Terminal: PTY lifecycle, resize storms, escape sequences
**What goes wrong:** Closing a tab kills only the shell, leaving children (`bun`, dev servers) orphaned, or kills a process group it does not own; no HUP then KILL ladder (README: "clean HUP then KILL of owned process groups only"); `pty.resize` called on every ResizeObserver tick (flooding, flicker, SIGWINCH storms); zero-size resize (hidden tab, `cols=0`) throws or corrupts; xterm and pty sizes drift (use `@xterm/addon-fit` and send the fitted `cols/rows`, not CSS); output flood from `yes`/big `cat` stalls the renderer (no flow control); OSC 52 clipboard sequences let programs read/write the clipboard; shell started without login env (missing PATH for `bun`/`omp`; the Electron app launched from Finder has a minimal PATH); mixed-up `$SHELL` args; xterm in a hidden (display:none) container measures 0.
**Prevention:** Spawn with `name:'xterm-256color'`, `cwd` = Eva root, `env` including `TERM`, `COLORTERM=truecolor`, login-shell args as the Rust app does. Track the PTY's pid and process group; close = `SIGHUP` to the group, short grace, then `SIGKILL` only to that group, never to pids not spawned by this app and never to omp sessions (separate module). Also close all PTYs on `before-quit`. Debounce resize (~50-100 ms trailing) and skip when unchanged or zero. Flow control: batch PTY output on a frame timer in main, apply watermark pause/resume (`pty.pause()` or ack-based) with xterm write callbacks. Disable OSC 52 write (and always block read) unless explicitly enabled; handle `windows`/ConPTY differences are out of scope (macOS only, so state that and do not add Windows code paths). Do not let app hotkeys swallow terminal keys: only `⌘`-modified shortcuts are intercepted while xterm is focused, per the isolation table. Fix PATH at startup (e.g. derive login-shell env once) so `bun` and `omp` resolve, since README lists explicit PATH fixups for jobs.
**Detection:** `ps` shows orphan children after closing a terminal; `yes` freezes UI; `cols` of 0 in logs.
**Phase:** P5.

### 13. Playwright `_electron` tests: wrong target, flakiness, fake proof
**What goes wrong:** (a) Tests launch the dev (Vite) build in one phase and the packaged build in another; behavior differs (paths, native modules, `app.isPackaged`, CSP), so "passes in dev" proves nothing about the shipped build. (b) Electron fuses (`EnableNodeCliInspectArguments` disabled, common in hardened builds) break `electron.launch`. (c) Fixed `waitForTimeout` sleeps, racing animations and streaming. (d) The WebContentsView guest is not in `electronApp.windows()`/page list in the way DOM is; people screenshot only the main page, which excludes (or shows blank where) the native view, so the browser panel "screenshot proof" shows an empty rectangle. (e) macOS `page.screenshot` of the BrowserWindow does not include native views; need `electronApp.evaluate` with `win.webContents.capturePage()` or `view.webContents.capturePage()`, or OS-level screencapture. (f) Non-deterministic pixels: system font fallback, animations, caret blink, scrollbars, Retina scale, streaming text. (g) Unattended runs pop windows over Isaac's screen and steal focus.
**Prevention:**
- Define two named launch fixtures, `launchDev` (Vite dev server URL passed via env, `main` built) and `launchBuilt` (production build output, no Vite), both starting from the same `fixtures` root and tmp `userData`; the default test and proof target is the built (non-dev-server) output, run `launchPackaged` once per milestone. Keep default fuses compatible with Playwright in dev/test builds.
- Wait on conditions only: `expect.poll`, `locator` auto-waits, app-emitted `data-ready`/`window.__evaReady` markers and an idle-state flag (`data-streaming="false"`). Zero fixed sleeps, enforced by lint rule on `waitForTimeout`.
- Proof must assert, not only capture: every screenshot is paired with DOM or state assertions (token count equals expected, browser `getURL()` equals target, `view.getBounds()` equals slot rect, page title read from the guest's webContents) and for the browser panel, a content probe (e.g. `capturePage` pixel sample or reading guest DOM text via CDP) proving a real page rendered. Reject proofs where the image is a blank/near-uniform rectangle (pixel variance check), and require the fixture page to contain unique text asserted via CDP.
- Streaming proof: scripted fake omp emitting a known token sequence at a fixed rate; assert zero loss and order, measure frame time (long-task count, rAF delta p95) and compare to a recorded baseline of the Rust app (the "beats current EvaOS" claim needs a stated metric and a numeric baseline, else it is unfalsifiable).
- Determinism: bundle and load a fixed web font in the app (do not rely on system fonts), `prefers-reduced-motion`/an `E2E=1` flag disabling the entrance animation and caret blink, fixed window size and `deviceScaleFactor`, freeze time and randomness, mask volatile regions, `toHaveScreenshot` with a tolerance. Baselines live in repo; first-run baselines are reviewed by an assertion, not blindly accepted (a missing baseline must fail in the loop, not auto-write).
- Unattended macOS: create windows with `show:false` unless `E2E_SHOW=1`, `showInactive()` otherwise, no `app.focus()` in test mode; `capturePage` works offscreen. Run under a dedicated tmp `userData` and a tmp `HOME` for config isolation where possible. Beware Keychain prompts (README mentions Keychain use for Bitwarden) and any native dialog (`dialog.showMessageBox`) blocking headless; stub dialogs in test mode.
- Playwright teardown must go through the supervisor's graceful stop (close stdins) rather than killing the Electron process mid-session.
**Detection:** Test green but screenshots show a blank browser area; test passes only on second run; screenshots differ between runs on the same commit.
**Phase:** P0 (harness, two launch modes, pixel-variance and state-assertion helpers), every phase for proof rules.

### 14. Unattended autonomous build: phases that end without a runnable app, vacuous proof, scope sprawl
**What goes wrong:** (a) A phase ends mid-refactor with a red `pnpm dev`; the next phase builds on sand. (b) "Screenshot proof" is a screenshot of a static mock, an error page, a blank view, or a skeleton that looks right while the data layer is stubbed; verifier trusts file existence. (c) With a ~68k-line reference and ~30 widget types, agents attempt line-by-line translation of Rust files, produce huge uncompilable diffs, or drift into features out of scope (experimental builds, voice, release packaging). (d) Every module hits the "Rust sidecar vs TypeScript rewrite" decision again and agents burn a phase on sidecar plumbing (cargo builds, IPC protocol, binary packaging). (e) Unattended loops hang on interactive prompts (pnpm approve-builds, macOS permission dialogs, Playwright browser download, Keychain) or spin on a failing step without progress (the repo already added a "stop loop on no-progress pass").
**Prevention:**
- A hard "green gate" before any phase can close: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, build, `pnpm e2e` launch of the built app with assertion that the main window reaches `data-ready` and no uncaught `console.error`/main-process errors occurred (fail on any). Commit only on green; failed plan leaves previous commit intact (git is the rollback).
- Proof contract in each phase's plan: list the exact DOM/state assertions plus the screenshot names; verifier checks those assertions ran (assert count > 0, test IDs present), not the images' existence. Include a negative control (a deliberately broken run must fail the proof test).
- Use README feature text as the checklist, with a traceability table (README bullet -> requirement -> test id); parity work is feature-sliced (vertical slice per bullet group), not file-by-file Rust translation; never port `src/` structure. Read Rust only for behavior and edge rules (e.g. todo id contiguity, 30-minute stale thresholds, job.md write rules), and encode those as unit tests on pure TS modules first (digest clock, inbox reconcile, todo numbering, duration parsing, habit gate) since the Rust unit tests and fixtures are portable specs.
- Default backend rule to stop re-litigation: TypeScript rewrite unless the module is large, stateful and already pure-Rust-tested with no UI coupling; record a one-line ADR per module. Recommend a TS rewrite for everything in this port (all logic is file parsing, polling and process spawning, all of which are simple in Node); a sidecar adds packaging, ABI and lifecycle risk for little gain. Reuse Relay's `packages/protocol` TypeScript types directly (read-only copy or workspace link, never edit Relay).
- Phase sizing: no phase contains more than one risky integration (omp stream, WebContentsView, PTY, inbox sources) plus its proof. The spike must finish first and its proof be real before parity begins.
- Make all setup noninteractive (`CI=1`, `pnpm approve-builds` encoded in `package.json`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` since Electron is used, no `electron-builder` code signing prompts).
**Detection:** Phase summary claims done without a green gate log; proofs with identical file hashes across phases; a diff size beyond reason; verifier cannot name the asserting test.
**Phase:** P0 (gate and proof helpers), enforced in every phase plan and verification.

---

## Moderate Pitfalls

### 15. Virtualized chat with variable-height markdown
**What goes wrong:** Row heights unknown until markdown, images, mermaid, widgets and syntax highlighting render; estimated heights make the scrollbar jump, scroll anchoring breaks, "pin to bottom" fights with virtualizer measurement, content growing above the viewport shifts the view; streaming row grows every frame causing re-measure thrash; Jump to latest / New reply pill logic wrong (should show only when not pinned and new content arrived); code blocks and `ui` widgets with async rendering change height after measure.
**Prevention:** Use `@tanstack/react-virtual` (dynamic `measureElement` with `ResizeObserver`) or `react-virtuoso` (built-in follow-output and variable heights; strong fit for chat). Pick Virtuoso unless profiling says otherwise, and prototype both against a 5k-frame fixture in P1 (LOW confidence on which wins; measure). Explicit pinned state machine (`pinned` true if within ~24 px of bottom; programmatic scroll does not clear it; user wheel-up clears it). Stable item keys by message id, never index; cache measured heights per id and width bucket; invalidate on container width change only. Reserve fixed-aspect space for images and mermaid before render (`aspect-ratio`, placeholders), render finished heavy blocks lazily when near viewport. Keep the streaming row non-virtualized at the tail or special-cased so growth does not re-layout everything. Use `overflow-anchor` carefully.
**Detection:** Scrollbar thumb jumps while scrolling up; pill flicker; scroll position drifts after image load.
**Phase:** P1 (spike), P4 (images, widgets, subagent chips).

### 16. Markdown, shiki and mermaid cost during streaming
**What goes wrong:** Re-parsing the entire message and re-highlighting every code block on every token (O(n^2)); mermaid re-rendering an incomplete diagram on each delta (throws, flashes errors, blocks main thread, plus bundles ~1 MB+); shiki loading all grammars/themes (large startup, hundreds of ms); mermaid injecting global styles and ids that collide, ignoring app theme; HTML in markdown (XSS) rendered with `dangerouslySetInnerHTML`; mermaid SVG sanitization.
**Prevention:** Stream-safe markdown: parse incrementally by block (split at stable block boundaries, memoize completed blocks, re-render only the trailing open block; check for a streaming-aware renderer such as `streamdown` or similar (LOW, verify) or implement with `marked` lexer plus block memo). Render plain text for unfinished fenced blocks; highlight and diagram only when the fence closes or after a debounce/idle. Shiki: single lazily created highlighter with the limited language set README lists (bash, rust, python, js/ts/tsx, json, yaml, toml, diff) using `shiki/core` with fine-grained imports and the JS regex engine; map shiki colors to the app theme tokens (CSS variables) so theme edits recolor without re-highlighting (use `--shiki-*` variables or class-based tokens). Mermaid: dynamic import, `securityLevel:'strict'`, theme from CSS variables via `themeVariables`, unique ids, render in idle callback, run error parse (`mermaid.parse`) before render, cache SVG by (source, theme hash), re-render on theme change only. Sanitize any raw HTML (DOMPurify or disallow). Optionally do heavy work in a Worker; keep it off the streaming path regardless.
**Phase:** P1 (block memoization), P7 (mermaid, widgets).

### 17. Mantine and a runtime-editable theme with 139 color keys
**What goes wrong:** Pushing the edited theme through `MantineProvider theme={...}` re-creates the theme object on each color-picker drag, re-rendering the entire tree; Mantine's palette model is 10-shade color arrays plus `primaryShade`, not 139 semantic keys (surface, border, accent, syntax tokens...), so people try to force them in and lose fidelity; hex typing mid-edit produces invalid values; light and dark variants handled via two providers/remounts; flash of default theme at startup; CSS variable generation (`cssVariablesResolver`) runs on theme change and rewrites a large `<style>`; color pickers firing 60 updates/s.
**Prevention:** Make the 139 keys CSS custom properties owned by the app (`--eva-<group>-<key>` per light and dark under `[data-mantine-color-scheme]`), written by one `ThemeApplier` that sets properties on `document.documentElement` (or a single `<style>` element) imperatively, with no React re-render. Mantine consumes them through a static theme (`MantineProvider` theme created once; map Mantine variables to app variables in CSS/`cssVariablesResolver` once; use `defaultColorScheme` and `forceColorScheme` via the color-scheme manager, not provider remount). Edit state lives in a store; the preview updates by CSS variables only; coalesce picker drags with rAF; validate hex with a parser and keep the last valid value while typing; undo/redo as a snapshot stack of key diffs; persist debounced to the config dir. Native pieces (xterm theme, mermaid themeVariables, shiki tokens, WebContentsView-adjacent chrome, titlebar overlay color, `nativeTheme.themeSource`) are separate subscribers that read the variables and update imperatively. Avoid first-paint flash: apply saved theme in a blocking script before React mounts (preload sends theme synchronously, or `index.html` inline). Define the 139 keys as a typed schema from the Rust `theme.rs` list once, generate defaults for both modes, and test completeness (every key defined in light and dark, no undefined fallthrough).
**Detection:** React Profiler shows full-tree commit during a picker drag; flash of white on dark startup; a key missing in one mode.
**Phase:** P0/P3 (variable architecture decided at shell time; retrofitting is a rewrite), P8 (editor).

### 18. IPC design drift (stringly typed channels, trust boundary)
**What goes wrong:** Hundreds of ad hoc `ipcMain.handle` channels with `any` payloads; renderer given raw `ipcRenderer`, `fs` or `shell` through preload; events leak listeners on HMR; big payloads (images, base64 clipboard) cloned across IPC repeatedly.
**Prevention:** One typed contract module shared by main/preload/renderer (e.g. channel map plus zod validation at the boundary), preload exposes only namespaced methods and returns unsubscribe functions, `contextBridge` objects with no raw `ipcRenderer`. Large blobs go to temp files (the README already uses `$TMPDIR/evaos-images`) and pass paths. Clean listeners on unmount; guard HMR.
**Phase:** P0.

### 19. Clipboard images, drag and drop, file URLs
**What goes wrong:** `⌘V` of a screenshot or Finder-copied files; Electron `clipboard.readImage()` vs web paste events differ; File objects lost `path` (use `webUtils.getPathForFile` in recent Electron); 20 MB image cap, MIME check, base64 inflation over IPC.
**Prevention:** Handle paste in main-assisted path (`clipboard.readImage`, `clipboard.read('NSFilenamesPboardType')` equivalents, verify) and validate type/size; store under `$TMPDIR/evaos-images`; match README limits.
**Phase:** P4.

### 20. Polling loops and background work on the UI thread
**What goes wrong:** Global search index, inbox reconcile, habit gate polling (every 4 s `bun` spawn), digest clock (10 s), `ioreg` idle checks, GitHub/Linear sources all landing in the renderer or in the main process event loop, causing stutter during streaming; spawning `bun` every 4 s without overlap protection piles up.
**Prevention:** Main-process services with single-flight (skip tick if previous running), exponential backoff as README specifies (2, 4, 8, 16 min cap), timeouts and `AbortController`; heavy work (search index, large JSONL replay) in a `utilityProcess` or `worker_threads`; only deltas cross to the renderer. Pause polling when the window is hidden except where README requires (watchers while closed are not possible in the Rust app either; reconcile on launch as README describes). Child spawns resolve `bun`/`omp` PATH like README (`/opt/homebrew/bin`, `~/.bun/bin`, `~/.local/bin`).
**Phase:** P3 (search), P6.

### 21. Two apps side by side: single-instance, notifications and shared external state
**What goes wrong:** Both the Rust app and the port send toasts/phone escalations (Relay) for the same inbox event, double-answering approvals or double-pinging the phone; both start omp for the same chat; both compact `inbox.jsonl`; Relay "hears" sessions from both; global shortcuts registered by both; Keychain item shared.
**Prevention:** During parity, the port runs notification and escalation sinks in dry-run (log only) unless `EVAOS_PORT_LIVE=1`; separate config dir by default; never respond to approvals (writes into omp stdin of a session not owned) unless owned; use `app.requestSingleInstanceLock()` for itself. Do not register OS-global shortcuts (not in README).
**Phase:** P6, cutover decision.

### 22. Electron main/renderer split of file watching and Vite HMR with native views
**What goes wrong:** HMR full reload recreates the renderer but main still holds WebContentsViews, PTYs and omp children: duplicated views, orphaned sessions, stale IPC listeners; developers think the app "leaks" and add kills.
**Prevention:** Renderer reload resubscribes to existing main-owned state (resync snapshot, see pitfall 2); treat renderer as disposable and main as owner of sessions, PTYs, views; on `did-start-loading` of the app webContents, re-attach rather than recreate. Never kill omp on renderer reload.
**Phase:** P1, P2.

---

## Minor Pitfalls

### 23. Window chrome and layout minimums
Minimum window 760x720, `hiddenInset` title bar drag regions blocking clicks, `-webkit-app-region` swallowing mouse events over the browser view, double-click-to-reset on column edges conflicting with window drag. Prevention: drag only on a dedicated strip; set `minWidth/minHeight`; test column drag with the browser view present. Phase P3.

### 24. em dashes in UI strings
Project rule. Prevention: a lint test that scans the renderer sources and i18n strings for U+2014 and U+2013 in string literals and JSX text. Phase P0 (cheap), runs always.

### 25. Fonts, scrollbars, text rendering parity
Rust app used native text; port loads web fonts late causing layout shift that breaks pinned-bottom measurement and screenshots. Prevention: bundle fonts locally, `font-display: block` plus `document.fonts.ready` before ready marker. Phase P3.

### 26. Time, locale and date parsing from journal headings
Dashboard activity derives from journal headings and dated bullets; local timezone/DST and week boundaries (7D/30D/90D) must match the Rust app. Prevention: pure functions with fixtures from the real files, tested against the Rust app output for the same snapshot. Phase P3.

### 27. Reload on window activation
`⌘R` and reload on activate can re-read stale files mid-edit or reset scroll; debounce and diff. Phase P3.

### 28. Entrance animation vs measurement
Animation (transform/scale) skews `getBoundingClientRect` for the browser slot and screenshot timing. Prevention: use layout-neutral properties and freeze view until `animationend`; disable under `E2E`. Phase P8.

### 29. Eregon floating chats, side chats and the Esc ladder
Several chat panes means multiple sessions and focus owners; Esc must close in the correct order (overlay, then popover, then Eregon, etc.). Prevention: central focus/overlay stack (same `OverlayStack` as pitfall 6), tested as a table. Phase P4/P8.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| P0 Scaffold | pnpm hoisting vs native modules (11); no `EvaFs` guard (10); two ABIs (11); IPC untyped (18) | `.npmrc` decision, `onlyBuiltDependencies`, typed IPC contract, fixture root plus git-status sentinel, green-gate script |
| P0 Test harness | Playwright proof is vacuous (13, 14) | Dev vs built launch fixtures, state assertions plus pixel variance, `capturePage` for native views, no sleeps |
| P1 Chat spike | Partial JSON lines (1); reorder and re-render storm (2); SIGKILL (3); stderr and backpressure (4) | `LineFramer`, `seq` plus resync, supervisor with stdin-close only, fake omp fixture, soak test |
| P1 Virtual log | Height jumps, pin logic (15); O(n^2) markdown (16) | Prototype Virtuoso vs TanStack on 5k frames, block-memoized markdown, pinned state machine |
| P2 Browser spike | Bounds drift, z-order over overlays (6); focus and shortcut leaks (7); guest security (8); devtools and memory (9) | Slot-rect sync, uniform `OverlayStack` suspend, `before-input-event` forwarding, sandboxed partition plus deny-all handlers, tab lifecycle |
| P2 Proof | Screenshot excludes native view (13) | Capture via `view.webContents.capturePage()`, CDP text probe |
| P3 Shell, dashboard, todos | Todo write race (10); watcher self-trigger (10); theme architecture (17); drag edges vs window drag (23); fonts (25) | Minimal-edit atomic write with re-read and hash check, CSS-variable theme applier, bundled fonts |
| P4 Chat parity | Second-writer on a session (3, 5); access-mode restart (3); multi-session (4); question cards; clipboard images (19) | Ownership model, stdin-close restart, session ownership guard, tmp image dir |
| P5 Terminal and Files | node-pty ABI and asar unpack (11); orphan processes, resize storms, OSC 52 (12); Files save writes (10) | Packaged smoke test, process-group HUP then KILL for owned groups, debounce resize, explicit-save-only |
| P6 Inbox, jobs, habits, meetings | Dual apps notify and compact shared files (21); polling overlap (20); `inbox.jsonl` torn lines (10); gate overlay over native view (6) | Separate config dir, dry-run sinks, single-flight pollers, tolerant replay, view suspend |
| P7 Rich widgets | Mermaid streaming and theme (16); ~30 widgets scope sprawl (14); widget actions as replies | Widget schema from Relay protocol types, one fixture per `showcase.md` block with assertion, lazy mermaid |
| P8 Theme editor, polish | 139-key live apply (17); entrance animation measurement (28); Esc ladder (29) | Imperative CSS variables, completeness test, E2E animation off flag |
| Every phase | Phase ends not runnable; scope sprawl; sidecar debate (14) | Green gate, README traceability table, TS-by-default ADR |

## Research Flags For Roadmap

- **Needs deeper phase research:** P2 (WebContentsView z-order approach: hide vs bitmap vs overlay view; devtools docking on pinned Electron; verify against current Electron docs), P5 (node-pty prebuild support and pnpm 10 build-script gating on the pinned versions), P1 (Virtuoso vs TanStack Virtual measured), P7 (streaming-safe markdown library choice).
- **Standard patterns, low research need:** IPC contract, EvaFs guard, atomic writes, polling services.

## Sources and Confidence

- `/Users/ike/Eva/apps/evaos/README.md` (Chat section: stdin close on quit, second-omp rule, 500 ms session polling because FSEvents only reports closed files; Inbox: append-only `inbox.jsonl`, 2 s watcher, backoff; Jobs: atomic temp-then-rename, refuse changed job.md, detached Run now). HIGH.
- `.planning/PROJECT.md`, `IDEA.md`. HIGH.
- Electron docs on `WebContentsView`, `setWindowOpenHandler`, security checklist, fuses, ASAR and native modules; `@electron/rebuild`; node-pty README (spawn-helper, resize, flow control); xterm.js flow control guide; pnpm docs (`node-linker`, `onlyBuiltDependencies`); Playwright Electron API docs. MEDIUM, from prior knowledge not re-fetched in this pass; confirm version-specific details (devtools docking in WebContentsView, node-pty prebuilds, `webUtils.getPathForFile`, Playwright vs fuses) when the owning phase is researched.
- Library suggestions (Virtuoso, `streamdown`, shiki fine-grained bundle) are LOW until measured.

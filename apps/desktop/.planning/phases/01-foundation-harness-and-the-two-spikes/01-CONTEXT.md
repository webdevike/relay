# Phase 1: Foundation, Harness and the Two Spikes - Context

**Gathered:** 2026-10-14
**Status:** Ready for planning
**Mode:** auto (Isaac unavailable; every gray area resolved with the research-recommended option, logged in 01-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

Deliver a runnable, safe Electron workspace in which (a) a past omp session resumes over stdio and streams gaplessly into a virtualized chat log, and (b) a real Chromium browser panel (WebContentsView) sits beside it with DevTools, CDP page control, Chrome extensions (Bitwarden) and Arc login import. Everything is wrapped in a test and proof harness: Vitest, Playwright `_electron`, fake omp, fixture Eva root, `EvaFs` write guard, `proofShot` composite capture, green-gate script. Requirements: FOUND-01..08, CHAT-01..08, BROW-01..09, PROF-01, PROF-02.

Not in this phase: the real three-column shell, sidebar, tabs, hotkey router beyond what the spike needs (Phase 2); chat list, categories, composer parity, new-chat transport ADR (Phase 4); markdown widgets beyond plain streaming text with code fences (Phase 5); terminal, files, Eregon, search (Phase 6); inbox, Relay, theme editor (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Workspace shape and toolchain
- **D-01:** pnpm workspace monorepo from day one: `apps/desktop` (electron-vite app: main, preload, renderer) plus Electron-free packages `packages/contract` (IPC channel names and Zod schemas), `packages/chat-core` (line framer, session-file parser, transcript reducer), `packages/eva-core` (Eva checkout readers and the `EvaFs` write gateway). Later phases add `packages/widgets`, `packages/theme-core`. Rationale: research ARCHITECTURE, pure packages hold most unit coverage.
- **D-02:** Versions per `.planning/research/STACK.md`: Electron 44 stable, electron-vite 6 (fall back to 5.x if it fails to boot under Playwright), Vite 8, React 19, TypeScript ~6.0, Mantine 9.7 (all Mantine packages one exact version), zustand 5, Zod 4, virtua, pnpm 12 via corepack. Verify each version with `npm view` at install time; do not downgrade silently, record any deviation in the plan SUMMARY.
- **D-03:** pnpm `onlyBuiltDependencies` lists `electron` (and `node-pty` later); `.npmrc` keeps isolated node-linker. Replace the placeholder root `package.json` (it only pins get-shit-done-cc as a devDependency; keep that devDependency in the root workspace package so `run-gsd.sh` still finds `gsd-sdk` on `node_modules/.bin`).
- **D-04:** Lint is ESLint + typescript-eslint + Prettier, plus a custom `scripts/lint-em-dash.ts` that fails on U+2014 inside string literals and JSX text under `apps/desktop/src/renderer` and `packages/*/src` (planning docs are exempt).
- **D-05:** Green gate is one script, `pnpm gate`: install check, typecheck, lint, em-dash lint, Vitest, build, Playwright e2e launch asserting zero renderer console errors. Phases close only on a green gate.

### Window composition and browser hosting
- **D-06:** `BaseWindow` plus one full-window shell `WebContentsView` for the React app, plus one child `WebContentsView` per browser tab layered above it. First e2e test on day one checks Playwright `electronApp.firstWindow()` sees the shell view. If it cannot, fall back to `BrowserWindow` with child views; record the outcome in the plan SUMMARY.
- **D-07:** The renderer renders an empty slot `div` for the browser; a `ResizeObserver` sends integer rects once per animation frame over IPC; main calls `setBounds` and `setVisible`. Bounds sync is asserted in e2e (view bounds equal slot rect after a resize).
- **D-08:** One overlay mechanism: a renderer `OverlayStack` store with a `useOccludeBrowser()` hook; while any full-window overlay is mounted the active browser view is hidden (`setVisible(false)`). Bitmap swap (`capturePage` placeholder) is polish, not required in Phase 1. Phase 2 wraps Mantine Modal, Drawer, Menu and Popover with this hook; Phase 1 ships the store and proves it with one test overlay.
- **D-09:** Guest pages use a dedicated persistent partition (`persist:browser`) with `sandbox: true`, `contextIsolation: true`, no preload, `setWindowOpenHandler` denying popups by default (OAuth popup support is a later refinement), and a permission request handler that denies everything except what the README's browser allows. App hotkeys arriving in a guest are forwarded to the shell via `before-input-event`.
- **D-10:** DevTools opens detached by default. CDP page control lives in a main-process `PageControl` module over `webContents.debugger` that lazily re-attaches after DevTools detaches it. Exposed operations in Phase 1: navigate, read document text, click a selector, evaluate expression. The spike verifies whether DevTools and `debugger.attach` coexist and records the answer.
- **D-11:** Address bar resolution: `http(s)://` or host-like text navigates; a bare integer opens `http://127.0.0.1:<port>/`; anything else searches with the README's default engine. Tab title follows `page-title-updated`; in-app history for suggestions is kept in the app config dir (SQLite via `node:sqlite` or JSON, planner's call); Arc history import stays v2.
- **D-12:** Chrome extensions (BROW-08): load `electron-chrome-extensions` and `electron-chrome-web-store` into the `persist:browser` session; the Bitwarden extension id is installed from the Chrome Web Store on first launch when network is available. Automated e2e verifies extension loading with a tiny unpacked test extension checked into the repo; a live Bitwarden install and autofill is an opt-in e2e (`EVAOS_LIVE=1`) and otherwise recorded as `still-needs-isaac` in VERIFICATION.md.
- **D-13:** Arc login import (BROW-09): reuse the Eva-side exporter exactly as the Rust app does, running `bun .omp/tools/arc-cookies.ts .omp/tools/lib/evaos-arc-sites.txt` in the Eva root (read-only use of Eva tooling), parse its cookie output, and insert into the browser partition with `session.cookies.set`, then reload. It runs only from an explicit "Import Arc logins" button; never on launch. Tests use a fixture cookie export; the live path needs Keychain access and is `still-needs-isaac`. The imported cookies stay inside the `persist:browser` partition, never the shell session.

### Chat streaming spike
- **D-14:** Transport in Phase 1 is resume-only: `omp --mode rpc-ui --resume <session file>` spawned in the Eva root with stdin/stdout pipes. New-chat creation (herdr plus Relay versus direct child) is the Phase 4 ADR; Phase 1 still defines the `Transport` interface (`start`, `send`, `abort`, `steer`, `close`, event stream) so Phase 4 adds implementations without touching the view.
- **D-15:** Frame handling per research: a `LineFramer` in main (StringDecoder, split on `\n` only, carry-over, per-line JSON try/catch, stderr kept separate as `_stderr` frames, `_eof` synthetic frame). Main runs the `chat-core` reducer and assigns a per-session monotonically increasing `seq`; ops are flushed to the renderer every ~16 ms. The renderer drains once per animation frame into a zustand store outside React, asserts `seq` contiguity, and requests a snapshot on any gap.
- **D-16:** Streaming semantics follow `chat.rs`: `message_update` carries full content and replaces the in-progress text; `message_end` is authoritative; coalescing keeps the last update per message id. No delta protocol unless profiling demands it.
- **D-17:** Lifecycle: closing a chat or quitting ends stdin and awaits exit (bounded wait, then log, never SIGKILL a session process). A single-writer guard refuses to spawn a second omp on a session file this app already owns. `ps`-style process-name matching is forbidden.
- **D-18:** The virtualized log uses virtua first, measured on a checked-in 5,000-message fixture session; fall back to `@tanstack/react-virtual` only on a measured failure (pin or jump bugs, or frame-time p95 over 16 ms during streaming on the fixture). Pin-to-bottom, Jump to latest and New reply pills are part of the spike.
- **D-19:** Spike rendering is plain streaming text with monospace code fences and preserved whitespace; full markdown, mermaid and widgets are Phase 5. Thinking blocks and tool calls render as collapsed rows with a label so the transcript parser is exercised.
- **D-20:** Spike UI layout: a minimal two-pane page (chat in main, browser panel on the right, placeholder left rail) built with Mantine primitives, dark color scheme by default. Not the real shell; Phase 2 replaces the frame and keeps the chat and browser components.

### Data safety and fixtures
- **D-21:** `EvaFs` in `packages/eva-core` is the only module allowed to write under the Eva root. Phase 1 exposes no writes at all (the first sanctioned write, todos append, is Phase 3); it ships the gateway, the allowlist shape, and a unit test that scans `apps/desktop/src/main` and `packages/*` for `fs.write*`, `writeFile`, `rename`, `rm` calls outside `eva-core/src/fs`.
- **D-22:** Environment contract: `EVAOS_EVA_ROOT` (default in dev and test: `fixtures/eva-root` in this repo), `EVAOS_OMP_BIN` (default in dev and test: `fixtures/fake-omp/fake-omp.ts` run with bun or node), `EVAOS_CONFIG_DIR` (default in dev and test: a temp dir; in a packaged run: `~/Library/Application Support/EvaOS Electron`). `pnpm dev:live` sets the real Eva root and real omp and prints a warning; CI-style runs never set it.
- **D-23:** The fake omp replays a recorded JSONL frame log with configurable chunk sizes and delays (1 byte, glued lines, split multibyte characters, bursts) and honors `prompt`, `abort` and stdin close so lifecycle tests are deterministic. The recording is captured once from a real omp session on a throwaway session file under the fixture root, scrubbed, and checked in.
- **D-24:** The fixture Eva root contains two workspaces, a short journal, a todos file, one small session and the 5,000-message benchmark session, all synthetic. No real Eva data is copied into the repo.
- **D-25:** A `git status --porcelain` sentinel on `/Users/ike/Eva`, `/Users/ike/Eva/apps/evaos` and `/Users/ike/Eva/work/relay` runs before and after every e2e run and fails the run on any new change.

### Proof and testing
- **D-26:** Playwright `_electron` launches the electron-vite build output (`apps/desktop/out`), workers 1, with the env from D-22. One extra smoke test launches the electron-builder `dir` output (`.app`, `identity: null`, arm64) to catch asar issues early.
- **D-27:** `proofShot(name)` in `e2e/helpers` composites `page.screenshot()` with `webContents.capturePage()` of every visible browser view at its bounds, rejects images whose pixel variance is near zero, and writes `proof/phase-1/<name>.png`. Every proof call is paired with at least one state assertion.
- **D-28:** PROF-02 numbers recorded in `proof/phase-1/metrics.json`: gapless `seq` count over the benchmark replay, frame-time p50 and p95 while streaming into the 5,000-message fixture (budget: p95 under 16 ms on this Mac), browser bounds delta (0 px), overlay hide check, CDP text probe result.
- **D-29:** Vitest uses three projects (main: node environment; preload: node; renderer: jsdom) plus the packages. Virtualized scroll is never tested in jsdom; that is e2e only.

### Claude's Discretion
- Exact directory names inside `apps/desktop/src`, IPC channel naming scheme, the shape of the zustand stores, Prettier settings, whether in-app browser history is SQLite or JSON, the test extension used to prove extension loading, and how the benchmark fixture is generated.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project and research
- `.planning/PROJECT.md` — scope, constraints, key decisions (including Isaac's Bitwarden and Arc decision)
- `.planning/REQUIREMENTS.md` — FOUND-01..08, CHAT-01..08, BROW-01..09, PROF-01..02 are this phase's requirements
- `.planning/research/SUMMARY.md` — reconciled stack, architecture, pitfalls and the config-dir and transport policies
- `.planning/research/STACK.md` — pinned versions, install commands, spike checklist
- `.planning/research/ARCHITECTURE.md` — component boundaries, seq batching, BaseWindow plus WebContentsView composition, Rust-vs-TypeScript table
- `.planning/research/PITFALLS.md` — 29 pitfalls with phase mapping; Phase 1 owns the chat framing, process lifecycle, WebContentsView, proof and native-module ones
- `IDEA.md` — Isaac's original brief
- `CLAUDE.md` — unattended run rules, boundaries, and Isaac's decisions (Bitwarden via Chrome extensions)

### Source of truth (read-only, never modify)
- `/Users/ike/Eva/apps/evaos/README.md` — Chat section (line ~246 onward) and Side panel › Browser (line ~99 onward) define expected behavior
- `/Users/ike/Eva/apps/evaos/src/chat.rs` — omp RPC spawn (`--mode rpc-ui`, `--resume`), frame reducer and its unit tests; port the tests
- `/Users/ike/Eva/apps/evaos/src/chat_view.rs` — pin-to-bottom, Jump to latest and New reply behavior
- `/Users/ike/Eva/apps/evaos/src/panel/browser.rs` — browser panel behavior, address bar rules, tab handling
- `/Users/ike/Eva/apps/evaos/src/panel/browser/logins.rs` — Arc cookie import and the Eva-side exporter invocation to mirror
- `/Users/ike/Eva/.omp/tools/arc-cookies.ts` and `/Users/ike/Eva/.omp/tools/lib/evaos-arc-sites.txt` — Arc login exporter and site allowlist (run read-only)
- `omp://rpc.md` — the omp RPC protocol doc as referenced by chat.rs; it is not on disk as a plain file. The researcher must obtain it through omp itself (or derive the frame set from chat.rs) and record the frame list in RESEARCH.md

### External docs to verify during research
- Electron docs: BaseWindow, WebContentsView, `webContents.debugger`, `session.cookies`, `setWindowOpenHandler`, `before-input-event`
- electron-vite 6 changelog and Playwright `_electron` API
- `electron-chrome-extensions` and `electron-chrome-web-store` READMEs (samuelmaddock)
- virtua README (pinning and `shift` behavior)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None in this repo yet: it holds only `IDEA.md`, `run-gsd.sh` (the unattended driver that expects `gsd-sdk` on `node_modules/.bin`), the GSD install under `.claude/`, and a placeholder `package.json`. `.gitignore` already ignores `node_modules/`, `logs/` and `.DS_Store`.
- Rust unit tests in `src/chat.rs` are portable fixtures for `chat-core`.
- Eva-side tools (`arc-cookies.ts`, `habit-gate.ts`, `job-run.ts`) are invoked as black boxes under bun, exactly as the Rust app does.

### Established Patterns
- Commit per completed plan on `main`, no remote. Planning docs are committed.
- Everything the app writes goes to its own config dir; the Eva checkout is read-only in this phase.

### Integration Points
- `run-gsd.sh` drives `/gsd:autonomous` passes and stops when a pass makes no commits, so every plan must end in a commit and the app must build at every phase end.
- Later phases plug into: `Transport` (Phase 4 transports), `OverlayStack` (Phase 2 shell overlays), `EvaFs` allowlist (Phase 3 writes), `proofShot` (every phase).

</code_context>

<specifics>
## Specific Ideas

- Reference apps for feel: Synara (trysynara.com) and T3 Code (github.com/pingdotgg/t3code); both Electron. The browser panel should feel like a real browser tab strip, not an embedded webview.
- "Must clearly beat current EvaOS on browser quality and chat streaming smoothness": there is no repeatable Rust baseline, so Phase 1 states absolute budgets (D-28) and captures the numbers.
- Isaac's decision: Bitwarden through the real Chrome extension, not the `bw` CLI; prefer real extensions over reimplementation.

</specifics>

<deferred>
## Deferred Ideas

- New-chat transport (herdr plus Relay versus direct omp child): Phase 4 ADR (CHTP-14).
- OAuth popup windows sharing the guest partition (README line ~114): Phase 6 browser polish or a Phase 1 stretch if trivial with `setWindowOpenHandler` allow-list.
- Bitmap placeholder while the browser view is occluded: polish after Phase 2.
- Arc history import for address suggestions: v2 (BROW-10).
- Safari user-agent synthesis: not planned (anti-feature; Chromium UA is the point).

</deferred>

---

*Phase: 01-foundation-harness-and-the-two-spikes*
*Context gathered: 2026-10-14*

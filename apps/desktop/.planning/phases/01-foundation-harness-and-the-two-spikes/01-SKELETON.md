# Walking Skeleton: EvaOS Electron

**Phase:** 1
**Generated:** 2026-10-15
**Delivered by:** plan 01-01 (every later Phase 1 plan builds on it without changing these decisions)

## Capability Proven End-to-End

The developer runs `pnpm dev` (or the built app) and a BaseWindow opens with a sandboxed shell WebContentsView rendering the spike layout, whose rail shows `Fixture data` after the renderer round-trips `app.info` through the Zod-validated IPC contract to main, which resolved the fixture Eva root and wrote `app-state.json` into the temp config dir; Vitest and Playwright each run a real test and `pnpm gate` prints `GATE GREEN`.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Electron 44.7.2 + electron-vite 6.0.0 (Vite 8.3.4, Rolldown) + React 19.3.1 + TypeScript ~6.0.3 + Mantine 9.7.2 | Fixed by Isaac (CLAUDE.md); versions re-verified with `npm view` at install (D-02). TS 7 rejected: typescript-eslint peer range |
| Window composition | `BaseWindow` + one full-window shell `WebContentsView` (index 0) + one child `WebContentsView` per browser tab above it | D-06; verified with Playwright `firstWindow()`; WebContentsView is the only non-deprecated way to host a real Chromium tab beside the UI |
| Module format | CommonJS output (no `"type":"module"` in apps/desktop) | A sandboxed preload cannot be ESM (research P1) |
| Process security | Shell: `sandbox`, `contextIsolation`, no `nodeIntegration`, strict CSP; guests: `persist:browser`, sandboxed, no preload, popups and permissions denied | D-09; guests can never reach app IPC |
| IPC | Hand-rolled typed contract in `packages/contract` (one file per feature: `app.ts`, `chat.ts`, `browser.ts`), Zod at the boundary, `Result` values (never throw across IPC), `senderFrame` URL check, preload exposes only `window.eva = { invoke, on }` | FOUND-08; electron-trpc is unmaintained; per-feature files let parallel plans add channels without touching a shared file |
| Data layer (app state) | JSON files in the app's own config dir via `ConfigStore` (atomic temp-then-rename): `app-state.json`, later `browser-history.json`, `layout.json`, `chat.json`, `inbox.jsonl` | FOUND-05; separate from the Rust app's config; `$EVAOS_CONFIG_DIR` override; temp dir in dev/test |
| Data layer (Eva checkout) | Read-only; all future writes through `EvaFs` in `packages/eva-core/src/fs` with a closed allowlist (`todo-append`, `file-save`, `job-md`, `job-delete`, `meeting-status`), a runtime write trap and a static scan | FOUND-03, D-21; Phase 1 has zero EvaFs callers |
| Environment contract | `EVAOS_EVA_ROOT`, `EVAOS_OMP_BIN`, `EVAOS_CONFIG_DIR`, `EVAOS_SESSIONS_DIR`, `EVAOS_ARC_EXPORT_CMD`, `EVAOS_E2E`, `EVAOS_LIVE`; dev/test default to `fixtures/eva-root`, `fixtures/fake-omp/fake-omp.mjs`, a temp config dir; the real `~/Eva` root is refused unless `EVAOS_LIVE=1` (or the packaged app) | FOUND-04, D-22 |
| State management | zustand 5 vanilla stores outside React (chat panes, browser tabs, overlay stack), selectors for narrow re-renders | Main-process streams `setState` per animation frame without React in the loop (D-15) |
| Auth | None in-app (single-user local app). Site sign-in comes from Arc cookie import and the Bitwarden Chrome extension inside `persist:browser` only | Isaac's decision (CLAUDE.md), D-12, D-13 |
| Deployment target | Local only: `pnpm dev`, electron-vite build launched by Playwright, and an unsigned electron-builder `dir` `.app` (arm64, `identity: null`) for the packaged smoke | D-26; no signing, notarization, DMG or auto-update |
| Package manager | pnpm 12.11.2 through a repo-local corepack shim (`.tools/bin`, sourced by `scripts/env.sh`); `allowBuilds` in `pnpm-workspace.yaml` | No global config changes; pnpm 12 replaced `onlyBuiltDependencies` (D-03 deviation recorded) |
| Directory layout | `apps/desktop` (`src/main`, `src/preload`, `src/renderer`, `e2e`), Electron-free `packages/{contract,chat-core,eva-core,browser-core}` with subpath exports (`@evaos/<pkg>/<module>`, no barrel edits), `fixtures/`, `scripts/`, `proof/<phase>/` | D-01; pure packages carry most unit coverage and can be tested in Node |
| Feature seams | `registerChat(ctx)`, `registerBrowser(ctx)`, `installWriteGuard(env)`, `installTestHooks(ctx)`, `registerViewProvider`, `registerTestHook`, `ctx.onBeforeQuit` | Later slices plug in without editing `main/index.ts` |
| Testing | Vitest 5 projects (`main` node, `preload` node, `renderer` jsdom, `scripts`, one per package); Playwright `_electron` against the built output, workers 1, zero console errors asserted in fixture teardown; `proofShot` composites DOM + `capturePage` of native views | D-26, D-27, D-29; virtualization is e2e-only |
| Green gate | `pnpm gate` = frozen install, typecheck, eslint, prettier, em-dash AST lint, Vitest, build, sentinel (advisory), e2e, packaged smoke (from plan 01-10), metrics check under `EVAOS_PROOF=1` | D-05, FOUND-07 |

## Stack Touched in Phase 1

- [x] Project scaffold (framework, build, lint, test runner): plan 01-01
- [x] Routing: not a web app; the "route" is the IPC channel `app.info` plus the three-column spike layout (pages and tabs arrive in Phase 2)
- [x] Database: one real read (`app.info` reads `app-state.json` and the env) and one real write (`app-state.json` launch counter in the config dir); Eva data stays read-only
- [x] UI: the rail's env badge is filled from a live IPC call; Phase 1 slices add the session list, composer, browser chrome and overlays
- [x] Deployment: documented local full-stack run (`pnpm dev`, `pnpm build`, `pnpm e2e`, `pnpm gate`); packaged `.app` smoke in plan 01-10

## Out of Scope (Deferred to Later Slices)

- Real three-column shell, sidebar, main tabs, hotkey router, light theme (Phase 2)
- Any EvaFs write caller (first is todos append, Phase 3)
- New-chat transport ADR (herdr + Relay vs direct omp child) and chat list, categories, composer parity (Phase 4)
- Markdown, mermaid, `ui` widgets (Phase 5); Phase 1 renders plain text with code fences
- Terminal (node-pty), files, side chats, Eregon, global search (Phase 6)
- Relay client, inbox, notifications, theme editor (Phase 7)
- omp protocol v2 (`rpc_chunk`) negotiation; Phase 1 stays on v1
- OAuth popup windows in the guest partition; bitmap placeholder while a view is occluded; Arc history import (v2)
- Code signing, notarization, DMG, auto-update

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- Phase 1 (rest): transcript slice, gapless streaming slice, chat control and benchmark, browser single-tab, tabs/CDP/hotkeys, extensions and Arc import, proof
- Phase 2: the full EvaOS frame (sidebar, main card, right panel, footer), tabs, hotkey router, CSS-variable theming
- Phase 3: Dashboard, Workspaces, Jobs, Habits, Meetings with EvaFs writes
- Phase 4: Chat parity behind the existing `ChatTransport` interface
- Phase 5: Rich replies (markdown, mermaid, all `ui` widgets)
- Phase 6: Side panel tools, Eregon, global search
- Phase 7: Relay, Inbox, notifications, theme editor

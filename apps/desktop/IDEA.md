# EvaOS Electron

Port EvaOS (Isaac's desktop app for his AI assistant Eva) from Rust + gpui-kit to Electron + React + TypeScript, reaching feature parity with today's app.

## Why
- The gpui EvaOS browser panel is weak: a native WKWebView (wry) layered over gpui, with stacking, focus and position-sync seams and poor DevTools. Electron gives a real Chromium browser (WebContentsView, DevTools, CDP page control) in the same engine as the UI.
- One React stack, closer to Relay (Isaac's phone app), and faster agent iteration than gpui.
- Reference apps doing this well: Synara (trysynara.com) and T3 Code (pingdotgg/t3code), both Electron.

## Source of truth (read-only, never modify)
- Current app: `/Users/ike/Eva/apps/evaos` (Rust, ~68k lines). Read `README.md` there first; it lists every feature. Key files: `src/chat_view.rs`, `src/chat.rs`, `src/inbox.rs`, `src/inbox/digest.rs`, `src/inbox_view.rs`, `src/habits_view.rs`, `src/theme_editor.rs`, `src/panel/*`, `src/rich/widgets.rs`, `examples/showcase.md` (widget spec + expected rendering).
- Relay phone app: `/Users/ike/Eva/work/relay` (pnpm monorepo, `apps/mobile`). Reuse its widget schemas/logic if they port to web cleanly.
- Eva data EvaOS reads: `/Users/ike/Eva` (workspaces/, memory/, jobs/, habits.yml, work/items/). Read-only except the exact writes current EvaOS performs (e.g. New Todo).

## Scope
1. Spike first: Electron shell + chat with live omp session streaming + browser panel. Must clearly beat current EvaOS on browser quality and chat streaming smoothness (virtualized long scrollback, no dropped/reordered tokens).
2. Then parity for every feature in the EvaOS README: dashboard, sidebar/layout shell, chat, inbox (+ digests, notifications, approvals), habits, files panel, terminal, browser, theme editor, rich ```ui widgets (all showcase.md blocks), settings, hotkeys.
3. Backend logic: reuse via a Rust sidecar or rewrite in TypeScript, whichever is simpler per module; justify the choice.

## Constraints
- Stack: Electron (latest stable), React, TypeScript, Mantine, Vite, pnpm. Tests with Vitest + Playwright for Electron.
- Everything lives in this repo. Do not modify `/Users/ike/Eva/apps/evaos`, Relay, or any global config (~/.claude, ~/.omp, shell rc). Do not run the new app against Isaac's live sessions in a destructive way.
- No em dashes in UI text.
- Each phase ends with a running app and Playwright screenshot proof under `proof/`.
- Commit per completed plan on `main`. No remote, no pushing.

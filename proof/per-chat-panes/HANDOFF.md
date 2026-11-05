# Relay Desktop workspaces (per-assistant / per-chat pane layouts): handoff

Branch `eva/workspaces` on origin (cd9dec4f, made off `main` 2de1a2af with a private index, so the shared checkout stayed on `main`). Not deployed, not merged.

Careful: the same changes are still uncommitted in the shared `work/relay` checkout on `main` (other agents commit there; one already swept e2e/workspaces.spec.ts into 3c900acc). Merging `eva/workspaces` into main is the first step.

## Done
- Model (shell-core `workspace.ts`): one workspace on screen at a time. Key = browser scope: `page:agent:<id>` (an assistant's thread + every session it owns via the owner chain), `chat:<file>` / `draft:<n>` (plain chats), `page:<page>` (pages; all boards share `page:canvas`, review items `page:reviews`). Each has its own dockview layout; switching swaps, switching back restores (sizes, tabs, focus, zoom).
- No two workspaces side by side: drop guard + `openPlaceBeside` switches workspace for another workspace's chat. Pages beside a chat are page tool tabs `view:<key>`.
- Pins: pinned tool tabs (right-click, "Pin to every workspace") show in every workspace; pinned app tabs are shortcuts. New chat starts with just the pinned tabs.
- Agent APIs: `layout.read` + `pane.*` act on the caller's workspace (contract `scope`), on screen or not (hidden dockview engine `inWorkspace`); content actions land in the caller's workspace; quiet sidebar dot (`WorkspaceDot`) on the assistant/chat row until visited; `state.read` = viewed workspace.
- Persistence: layout.json `workspaces` {v:1, front, pinned, layouts, order} + `dock` (front, for rollback). Migration: the old window layout becomes the front workspace's (pages beside it become page tabs), others start empty.
- Single-page web tabs (`web:<id>`, no inner strip; Cmd+T; popups beside opener; owner mark; close-finished-session offer); main BrowserHost multi-view `browser.setSlots`.
- One + per pane (AddMenu) with Browser page / Files / Terminal / Canvas (board picker) / Studio / Test Bench + split/maximize/new chat; Tools grid retired.
- Click rules (plain = here, Cmd = background, Cmd+Shift = split, Option = `open -a Arc`), relay:// addresses for every tab kind, Cmd+Shift+C copy link.
- Navigation reuse: a plain chat/page workspace that is just its one tab takes that tab along (old same-tab behavior); its panes wait with a home marker. Empty new chats close when left; drafts with text are shortcuts everywhere. Chat pane survives a same-tick remount; chat scroll restores on remount.
- Docs: relay-control skill (Eva repo, auto-commit), apps/desktop/docs/agent-access.md.
- Proof: proof/per-chat-panes/*.png (astra-workspace, nova-workspace, background-dot, astra-restored, pinned-in-new-chat, migrated-nova).

## Tests
- Unit: shell-core 79/79, contract 93, chat-core, protocol green; apps/desktop vitest 2023/2028: the failures are load-timeouts (settings.test theme tests, update/packaged.test kick file) that pass when run alone.
- e2e passing (hidden instances): workspaces, tiling, tiling-agent, pages, tabs, canvas-live, shell-frame, shell-proof, studio, terminal (@smoke), agent-access, drag-region, new-chat, browser-* (basic, tabs, arc, auth, cdp, extensions), toast-over-browser, web-blank (@smoke, replaces tools-launcher), gate, proof, hotkeys, phase4-tour, settings-chat, new-todo, dashboard, sidebar, chat-stream (chunk 1 flaky under load), questions, chat-control/composer/writers/subagents-jobs (after the chat pane remount fix; last full re-run pending).

## Not done / next
- `pnpm e2e:smoke` passes (7/7) on the final tree. Still to run: the release gate's `pnpm e2e:run --only-changed=8f30e2e5` (fixtures.ts changed, so nearly the full suite) once more after the last fixes; then merge to main and `bun .omp/tools/relay-desktop-deploy.ts`.
- Unit tests that time out at 5 s when the whole vitest suite runs on a busy Mini (settings.test.tsx theme tests, Composer, a few widget tests; update/packaged.test kick file) pass alone. The deploy gate runs `pnpm test`: run it on a quiet machine or raise those files' timeouts.

## Known gaps / behavior to check with Isaac
- Pages as their own workspaces (Reviews, Test Bench, Settings...) is the simple default; Isaac hasn't decided.
- Hidden workspaces' web page titles update only when shown; an owned session's pages under its old `chat:<file>` browser scope (pre-workspaces) are not migrated into its assistant's layout.
- No chat message selection exists, so Cmd+Shift+C on a chat copies the chat link; `message=`/canvas `node=` parse but don't scroll yet; Studio page tab doesn't expose its job.
- Leaving a plain chat for a page via newTab closes the chat tab; a done chat then fast-settles in the list.
- Phone: desktop-only (panes/window concepts), nothing shipped to apps/mobile.

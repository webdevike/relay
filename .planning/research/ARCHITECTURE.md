# Architecture Research

**Domain:** Electron desktop AI-agent workbench (chat over a child-process agent, embedded browser, PTY terminal, file/data views) over a local data checkout
**Project:** EvaOS Electron
**Researched:** 2026-10-14
**Confidence:** MEDIUM-HIGH (Electron API facts verified against electronjs.org docs; omp frame behavior verified against `chat.rs`; reference apps Synara and T3 Code not inspected, so "typical" claims come from the Electron docs plus the Rust source, not from them)

## Standard Architecture

Electron workbench apps converge on one shape: a thin main process that owns everything with a handle (child processes, PTYs, file watchers, native views, disk writes), a narrow typed IPC contract, and a renderer that is a pure view over state streamed from main. Long-lived, crashy or CPU-heavy work moves to separate processes (utilityProcess or child processes) so the UI never shares a thread with it.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ BaseWindow (one app window)                                          │
│  ┌───────────────────────────────┐  ┌─────────────────────────────┐ │
│  │ Shell WebContentsView         │  │ Browser WebContentsViews     │ │
│  │ (preload + React + Mantine)   │  │ one per tab, own session,    │ │
│  │ full window, always at index 0│  │ positioned over the panel    │ │
│  │ routes: dashboard chat inbox  │  │ placeholder rect; sits ABOVE │ │
│  │ habits jobs meetings settings │  │ the shell view in z-order    │ │
│  │ side panel: terminal browser* │  └──────────────▲──────────────┘ │
│  │ files side-chats  (*=hole)    │                 │ setBounds /    │
│  └──────────────┬────────────────┘                 │ setVisible     │
├─────────────────┼──────────────────────────────────┼────────────────┤
│  typed IPC (contextBridge preload; invoke + event streams)          │
├─────────────────┼──────────────────────────────────┼────────────────┤
│ MAIN PROCESS (Node, TypeScript)                                      │
│  ┌──────────────┴─┐ ┌────────────┐ ┌────────────┐ ┌───────────────┐ │
│  │ SessionManager │ │ BrowserHost│ │ PtyManager │ │ EvaStore      │ │
│  │ omp children + │ │ views, CDP,│ │ node-pty,  │ │ readers,      │ │
│  │ chat-core      │ │ tab state  │ │ process grp│ │ watchers,     │ │
│  │ reducer        │ │            │ │            │ │ writers       │ │
│  └───────┬────────┘ └────────────┘ └─────┬──────┘ └──────┬────────┘ │
│          │            ┌──────────────┐   │               │          │
│          │            │ ConfigStore  │   │   ┌───────────┴───────┐  │
│          │            │ layout/chat/ │   │   │ InboxStore        │  │
│          │            │ theme/notif  │   │   │ inbox.jsonl+digest│  │
│          │            └──────────────┘   │   └───────────────────┘  │
├──────────┼───────────────────────────────┼──────────────────────────┤
│ CHILD PROCESSES                                                      │
│  omp --mode rpc-ui   $SHELL PTYs   utilityProcess: search index,     │
│  (stdin/stdout JSONL) (own pgrp)   digest build, file scans          │
│  bun .omp/tools/*.ts (habit-gate, job-run)   [optional Rust sidecar]  │
├──────────────────────────────────────────────────────────────────────┤
│ DISK (read-mostly)                                                   │
│  /Users/ike/Eva (workspaces memory jobs work habits.yml)             │
│  ~/.omp/agent/sessions/*.jsonl      $EVAOS_CONFIG_DIR (layout.json…) │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Main bootstrap | App lifecycle, BaseWindow, menu and global shortcuts, single-instance lock, quit guard (unsaved Files edits) | `app`, `BaseWindow`, `Menu`; one module per service wired in `main/index.ts` |
| SessionManager | Spawn, resume, write to, abort and reap `omp --mode rpc-ui` children; own the reducer state per live chat; emit ordered batches | `child_process.spawn`, line splitter, `chat-core` reducer, per-session sequence counter |
| Session catalog | List past chats (parse `~/.omp/agent/sessions` JSONL), group by workspace, pins, archive, rename/delete, watch for changes | Poll-based watcher (the Rust app found FSEvents misses writes to open files, `watch.rs`), cached incremental parse |
| BrowserHost | Create/close WebContentsViews per tab, apply bounds from renderer, visibility, navigation, title/favicon, DevTools, CDP | `WebContentsView`, `webContents.debugger`, one persistent `session` partition |
| PtyManager | PTY sessions with split panes, resize, HUP-then-KILL of owned process groups only | `node-pty` (rebuilt for Electron ABI), data forwarded over a `MessagePort` per pty |
| EvaStore | Typed readers over the Eva checkout (workspaces, journal, todos, jobs, meetings, work items) plus the few permitted writers (`append_todo`, job.md, meeting accept) | Pure TS functions over `fs`, `chokidar`-or-poll watchers, atomic temp-then-rename writes |
| InboxStore | Append-only `inbox.jsonl`, repo sources, digest generation, prefs, phone escalation | TS module; heavy digest work in a utilityProcess |
| SearchIndex | Build and query the global index off the UI thread | utilityProcess owning the index; main proxies queries over a MessagePort |
| ConfigStore | `layout.json`, `chat.json`, `theme.json`, `notifications.json` in `$EVAOS_CONFIG_DIR`, debounced atomic writes | One zod-validated JSON store class per file |
| Preload | The only bridge: exposes a typed `window.evaos` API, no raw `ipcRenderer` | `contextBridge.exposeInMainWorld`, contextIsolation on, sandbox on |
| Renderer shell | Layout, routing, hotkeys, stores, all pages | React + Mantine + react-router (memory router) + Zustand-style external stores |
| Chat view | Virtualized transcript, composer, dialogs, rich widgets | `@tanstack/react-virtual`, markdown pipeline, Relay widget schema |
| Panel host | Side panel tools; owns the browser placeholder rect | React; xterm.js for Terminal |

## Recommended Project Structure

pnpm workspace, one app and a few pure packages. Packages with no Electron or DOM imports are what make Vitest cheap and agent iteration fast.

```
apps/desktop/
  src/main/            # services above, one folder each; no React
    index.ts
    sessions/  browser/  pty/  eva/  inbox/  config/  ipc/
  src/preload/index.ts # builds window.evaos from the shared contract
  src/renderer/        # Vite root
    app/ (shell, layout, hotkeys)  pages/  panel/  chat/  widgets/  theme/
    state/             # external stores fed by window.evaos subscriptions
  e2e/                 # Playwright _electron specs
packages/
  contract/            # IPC channel names + zod schemas + inferred types (single source)
  chat-core/           # omp frame types, reducer, session-file parser, tagged()/untagged()
  eva-core/            # workspace/journal/todo/job/meeting parsers and writers (pure fs-in, data-out)
  widgets/             # re-export/adapter of Relay widget schemas + web renderers
  theme-core/          # theme model, kit presets, Mantine theme mapper
proof/                 # Playwright screenshots, committed per phase
```

Structure rationale:
- `contract/` is imported by main, preload and renderer. One zod schema per channel gives runtime validation on the main side (the renderer is untrusted by principle, and it renders model output) and free types on both sides.
- `chat-core/` and `eva-core/` take plain strings or injected `fs`, so the Rust unit tests port directly to Vitest.
- electron-vite is the usual glue (main, preload, renderer builds in one config); verified current at 6.0.0 on npm.

## Architectural Patterns

### Pattern 1: Main-authoritative session state, renderer as mirror (answers Q1)

**What:** The reducer from `chat.rs` (`Live::apply`) lives in `chat-core` and runs in main, next to the child process. The renderer never sees raw frames except through a typed projection. Main sends coalesced, sequence-numbered batches; the renderer applies them to an external store on animation frames.

**Why this beats the alternatives:** transcript survives renderer reload and HMR, a side chat and the main pane can mirror the same session, and the process that owns stdin is the process that knows the truth (the Rust app already needs "writer handoff" metadata because two views of one session are hard otherwise; `Live::handoff`).

**Verified facts from `chat.rs` that drive the design:**
- Transport is JSON lines, one frame per line; Rust parses each line and silently drops non-JSON lines. `message_update` carries the whole assistant `content`, and the reducer does `streaming.text = text`, so streaming is snapshot-idempotent: only the last `message_update` per `messageId` in a batch matters. This makes coalescing safe and makes "dropped token" impossible by construction as long as the final `message_end` is applied.
- `message_end` replaces the streaming copy (`retain(!streaming && id == id)`) and reconciles optimistic user prompts (`sent-` ids) against omp's echo.
- Frame kinds the reducer must handle (non-exhaustive): `response`, `model_changed`, `thinking_level_changed`, `agent_start`, `agent_end`, `session_settled`, `prompt_result`, `message_start/update/end`, `tool_execution_start/end`, `extension_ui_request` (select, confirm, input, editor, ask, cancel), plus synthetic `_stderr` and `_eof`.
- Startup handshake: `set_ask_dialog {enabled:true}` then `get_state`; commands get ids `evaos-N`, except `extension_ui_response` which must not.
- Closing stdin is the clean shutdown; reap off the hot path. Binary lookup must fall back to `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin` because a Finder-launched app has a bare PATH.

**Ordering and no-drop guarantees:**
1. Reader: accumulate stdout chunks with a `StringDecoder`, split on `\n`, hold the trailing partial line. Never `JSON.parse` a chunk. This is the classic source of "lost tokens".
2. Single writer per session: frames go through one async queue into the reducer in arrival order. No `await` between read and apply.
3. Main assigns `seq` (monotonic per session) when emitting batches. Renderer asserts `seq === last + 1`; on a gap or on mount it calls `chat.snapshot(sessionId)` and resumes from that seq. IPC itself is ordered, so a gap indicates a bug, and the check turns it into a detectable condition and a Vitest/Playwright assertion.
4. Emit tick: main flushes at most one batch per session every ~16 ms (timer, not rAF, there is no rAF in main). A batch is `{sessionId, seq, ops[]}` where ops are `upsert(message)`, `remove(id)`, `patch(sessionMeta)`. Within a batch, collapse repeated updates of the same message to the last one.
5. Renderer: the IPC listener only pushes into a queue; one `requestAnimationFrame` drains the queue and calls `store.apply(ops)` once per frame. Messages are immutable objects with stable identity, so `React.memo` rows and `useSyncExternalStore` selectors re-render only the streaming row.
6. Cost note: because updates are full-text snapshots, a very long reply is O(n) per flush. At 60 flushes/s that is fine to tens of KB; if profiling shows trouble, add a `textDelta` op computed in main by prefix comparison, with the snapshot as the fallback. Do not start with deltas.
7. Backpressure: if the renderer is hidden or busy, ops accumulate in main per session (bounded by collapse), so memory is bounded by transcript size, not frame count.

**Alternatives rejected:** reducer in renderer with raw-frame forwarding (duplicates transcript per view, loses state on reload, large image frames cross IPC twice); a Rust sidecar reducer (see Q3).

**Example contract fragment:**
```typescript
// packages/contract/src/chat.ts
export const ChatBatch = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: 'upsert', message: ChatMessage }),
    z.object({ op: 'remove', id: z.string() }),
    z.object({ op: 'meta', patch: SessionMetaPatch }),
  ])),
})
// preload: chat.onBatch(cb) => unsubscribe; chat.snapshot(id) => {seq, state}
```

### Pattern 2: Native view as a "hole" in the layout (answers Q2)

**What:** WebContentsViews are native compositor children of the window, not DOM nodes. The renderer renders an empty placeholder `<div data-browser-slot>` where the page should appear, measures it, and tells main to position the real view over it. Main is the only owner of view objects; the renderer holds tab ids.

**Verified Electron API facts (electronjs.org, current docs):** `View.setBounds(rect, {animate?})`, `View.setVisible(bool)`, `View.getVisible()` ("may still be obscured"), `addChildView(view, index?)` where re-adding "becomes the topmost view", and a `bounds-changed` event only for layout-driven changes. A WebContentsView can adopt an existing `webContents`, and one webContents can be in only one view. Views are not destroyed with the window: close each `webContents` yourself or leak.

**Layout choice:** use `BaseWindow` plus a full-window shell `WebContentsView` (index 0) and browser views added above it. Do not use `BrowserWindow` with child views for this; BaseWindow is the documented composition API. The shell view is transparent to nothing, so the browser views must be above it and must be hidden or shrunk whenever something in the shell needs to draw over that rectangle.

**Bounds sync protocol:**
1. Renderer: a `ResizeObserver` on the slot plus `window` `resize`, panel drag, sidebar fold and entrance animations call `measure()`. Coalesce to one send per animation frame. Send `getBoundingClientRect()` rounded to integers (fractional bounds cause 1px seams at DPR 2).
2. Preload: `browser.setSlot({tabId, rect, visible})` via `ipcRenderer.send` (fire-and-forget, ordered).
3. Main: `BrowserHost.apply()` calls `view.setBounds` and `setVisible`. Skip no-op updates.
4. Hide rules (the renderer computes one boolean `occluded` from a small store): any Mantine modal or drawer open, the global search (`⌘K`), Eregon floating chat overlapping the slot, context menus and popovers that intersect the rect, the Habit Gate full-window overlay, drag in progress, panel not on the Browser tool, route hidden. Maintain an `overlayCount` store that every overlay-capable component increments through one `useOccludeBrowser()` hook; the Mantine `Modal`, `Drawer`, `Menu` and `Popover` wrappers in the app call it automatically so features cannot forget.
5. Eregon and similar floating cards: prefer shrinking the browser rect to stay left of the floating window (the Rust app does exactly this, `browser.rs` header) over hiding it. Use hide only for full-rect overlays.
6. Hidden is not enough for modal safety: also stop forwarding keyboard focus to the page. When hiding, call `shellView.webContents.focus()`.
7. Flicker control: when hiding for a popover, optionally capture `view.webContents.capturePage()` into a `<img>` in the slot for the duration (the technique used for smooth overlays); treat as an enhancement, not spike scope.
8. Resize latency: setBounds lags the DOM by an IPC hop. During panel drag, hide the view or render the slot with a solid background and apply bounds on drag end, applying live only if profiling shows it smooth.

**Tabs:** one `WebContentsView` per subtab, all children of the window, only the active one visible. Keep a `Map<tabId, {view, state}>`. Background tabs stay alive (visible=false) so page state survives; cap with an LRU that destroys cold tabs. Persist tab URLs in `chat.json`/`browser.json`, not page contents.

**Events to main to renderer:** `page-title-updated`, `did-navigate`, `did-navigate-in-page`, `did-start/stop-loading`, `page-favicon-updated`, `can-go-back/forward` (via `navigationHistory`), `render-process-gone`. Stream a `BrowserTabState` object per tab; the address bar and tab strip are React over that state. `setWindowOpenHandler` decides popup policy (deny external, allow sign-in popups as real windows, as the Rust app does).

**CDP and DevTools:** `webContents.debugger.attach('1.3')`; `sendCommand` returns a promise; events arrive as `'message'`; the session ends with a `'detach'` event when DevTools is opened on the same webContents (verified in the Electron debugger docs). Consequences for design: wrap CDP behind a `PageControl` service that re-attaches lazily on the next command and treats `detach` as a normal state; open DevTools detached (`openDevTools({mode:'detach'})`) so it does not need a view slot. Whether two clients can coexist on newer Electron is NOT documented; verify in the spike (LOW confidence). If it conflicts, offer a "Page control" attach that is released when DevTools opens. Page control is for the app and for agents (`evaos-ctl open <url>` has a Rust analog over `control.sock`; port as a unix socket or localhost-token server in main).

**Security for the browser views:** separate `session.fromPartition('persist:browser')`, `sandbox: true`, `contextIsolation: true`, no preload, and no access to `window.evaos`. Never load web content into the shell view.

**Pitfall tie-in:** the Rust app's seams (stacking, focus, position sync) are the same class of problems; Electron removes the foreign-toolkit mismatch but not the "view is outside the DOM" mismatch. The `occluded` store is what addresses it.

### Pattern 3: Typed IPC contract with three shapes

**What:** every capability is exactly one of:
- `invoke` request/response (`eva.listWorkspaces()`, `jobs.save(job)`), validated by zod on main.
- `subscribe` event stream (`chat.onBatch`, `browser.onTabState`, `config.onChange`, `eva.onChanged`), returns an unsubscribe.
- `MessagePort` channel for high-volume bytes (PTY data, maybe chat batches later). Main creates a `MessageChannelMain`, transfers one end to the renderer; avoids contending on the shared IPC channel and gives per-pty ordering.

Preload exposes `window.evaos.<domain>.<method>`; there is no generic `send(channel, ...)`. Channel names live in `contract/` as constants. A single `registerHandlers(ipcMain, services)` file maps contract to services, which lets tests call services without Electron.

### Pattern 4: File-backed data with change fan-out

**What:** EvaStore reads on demand, caches with a version, and watches. The renderer does not poll disk; it subscribes to `eva.onChanged({domain})` and refetches that domain. Reload on window activation and `⌘R` are just forced invalidations. Poll-based watching for the sessions folder and any file open for append (FSEvents misses writes to open files, per `watch.rs`); event-based watching is fine for directories of small files.

**Write discipline:** every writer is a named function in `eva-core` with a golden-file Vitest test (`append_todo` numbering after the last open row, job.md round-trip preserving unknown keys, atomic rename). No generic "write file" IPC exists except the Files panel's explicit save, which main gates (path inside Eva root, mtime conflict check).

### Pattern 5: Panels as registered tools

A `PanelTool` registry (`id`, `icon`, `Component`, `shortcut`, `occludesBrowser`) mirrors the Rust `Tool` enum. Terminal, Browser, Files, Side chats and Simulator register themselves; the header tab collapse and launcher render from the registry. Keeps the side panel additive across phases.

## Data Flow

### Chat streaming
```
omp stdout bytes -> line splitter -> JSON.parse -> reducer(chat-core) -> dirty set
   -> 16ms flush -> {seq, ops} -> IPC (ordered) -> preload listener -> queue
   -> rAF drain -> external store.apply -> useSyncExternalStore -> virtualized rows

composer submit -> window.evaos.chat.prompt(id, text, images)
   -> main: tagged(text), optimistic `sent-N` user message op + stdin line {type:'prompt', streamingBehavior:'steer', id:'evaos-N'}
dialog answer  -> chat.answerDialog(id, answers|null) -> stdin extension_ui_response
```

### Browser panel
```
React layout -> slot <div> -> ResizeObserver + occluded store -> ipc.send(setSlot)
   -> main BrowserHost -> view.setBounds/setVisible
page events -> main -> subscribe stream -> address bar/tab strip state
address bar submit -> invoke browser.navigate(tabId, typed) -> normalize (URL | search | bare port) in main
```

### Eva data / inbox
```
disk (Eva checkout, sessions, config) -> watchers -> EvaStore invalidation -> eva.onChanged
   -> renderer refetch via invoke -> page stores
inbox sources -> InboxStore append inbox.jsonl -> inbox.onChanged -> bell/popover/page
user action (resolve, approve) -> invoke -> append record; Relay escalation call from main
```

### State management
Renderer stores are small external stores (Zustand or plain `useSyncExternalStore` stores), one per domain: `chatStore` (keyed by sessionId), `browserStore`, `layoutStore`, `evaStore`, `occludeStore`, `themeStore`. No server-state library is needed because the "server" is main and it pushes. Route-local UI state stays in components.

## Answering Q3: Rust sidecar vs TypeScript rewrite

**Default: TypeScript rewrite. Use a Rust sidecar only when a module passes the bar below.** Reasons grounded in the repo: the Rust modules are written against gpui types (`ChatMessage` carries `ImageItem` from the UI crate; `chat.rs` imports `crate::ui::image`, `crate::relay`), there is no existing library or CLI boundary to call (the crate has `lib.rs` but it exports the app), and a sidecar needs a protocol, a build, a packaging step, and cross-process error handling. The data formats are JSON, JSONL, YAML-ish markdown and small text files, which TypeScript handles natively. The Rust unit tests give you ready-made fixtures to port, which is the real reuse.

**Criteria to choose a sidecar for a module** (all three should hold):
1. Measured need: TypeScript version profiled and fails a budget (for example index build over the repo blocks a utilityProcess for seconds, or memory is excessive).
2. Clean seam: the module is already pure data in and data out, with no dependency on gpui types.
3. Ownership cost acceptable: Isaac wants a second toolchain in the build, and the binary can be built in this repo without modifying `/Users/ike/Eva/apps/evaos`.

Note the hard constraint: the Rust app is read-only, so any sidecar would be a new crate in this repo that copies the code. Copying 1-2k lines of Rust to avoid rewriting 1-2k lines of TS is rarely a win.

| Module group | Rust size | Recommendation | Why |
|--------------|-----------|----------------|-----|
| chat.rs reducer + omp spawn | 3.5k | **TypeScript** (`chat-core`) | Must run in the Electron process for IPC batching; JSON frames are native to JS; the reducer is a ~300-line state machine plus message conversion; port tests. Rust version tied to gpui image types. |
| Session file parsing, chat_groups, chat_ops | ~ | **TypeScript** | JSONL reading; renames use a short-lived omp, which TS can spawn equally. |
| eva.rs readers (workspaces, journal, todos), jobs.rs, meetings.rs | 586 + 890 + 833 | **TypeScript** | Small text parsing, `append_todo` and job.md round-trip are simple, golden tests port. |
| gate.rs / habits | | **TypeScript** | It only shells out to `bun .omp/tools/habit-gate.ts`; use `execFile` and parse JSON. |
| inbox store, prefs, escalate, relay.rs | 3.5k + 0.8k + 1.3k + 1.3k | **TypeScript** | Relay protocol is already TypeScript (`@relay/protocol` with zod and an HMAC helper); a Rust port is the odd one out. HID idle and screen lock probes shell out to `ioreg`, trivial from Node. |
| inbox/digest.rs | 1.9k | **TypeScript first; sidecar candidate** | The only inbox part plausibly worth a re-evaluation if it parses large volumes. Run in a utilityProcess; revisit only if criterion 1 fails. |
| search index (`index.rs`, `intent`, `live`, `http`) | 0.9k+ | **TypeScript in a utilityProcess** | Needs walking repo files (use `fast-glob` plus ignore rules) and subsequence scoring; both are easy in TS. Index must live off the UI thread: utilityProcess satisfies that. |
| search embeddings / semantic (`embed`, `semantic`, `jev`) | | **TypeScript** | They are HTTP calls to OpenAI/other plus cosine top-k over cached vectors. Use `fetch`. `curl` child limits become `AbortSignal.timeout`. |
| theme.rs, theme_fields.rs, theme_editor.rs | 1.0k + 0.7k + 2.1k | **TypeScript** | The kit theme collection is JSON under `assets/themes/kit/`; copy the JSON assets (not modify the Rust repo) and map to Mantine's theme. `theme_fields.rs` is a generated gpui key table that has no equivalent. |
| rich/widgets.rs, diagram.rs | 3.9k | **TypeScript renderer using Relay schemas** (see Q4) | Renders gpui elements; nothing to reuse. `diagram.rs` uses a headless browser screenshot; replace with `mermaid` in the DOM. |
| terminal (Alacritty PTY) | | **TypeScript: node-pty + xterm.js** | Native module with prebuilds; Rust PTY code is gpui-canvas coupled. |
| simulator.rs | 1k | **TypeScript shelling out to `xcrun simctl`** | Same commands; defer. |

Net: no Rust sidecar in the initial plan. The one place to leave an explicit extension point is a `Worker` interface behind SearchIndex and Digest so that a sidecar could be swapped in later without touching callers.

## Answering Q4: Reusing Relay widgets in a web renderer

**Verified facts (read from `/Users/ike/Eva/work/relay/packages/protocol`):** `package.json` name `@relay/protocol`, `private: true`, `main` and `exports` point at raw `./src/index.ts` (no build step), only dependency is `zod ^3.25`. Not React Native specific. `src/widget.ts` (651 lines) defines zod schemas for the whole widget vocabulary (chart, stat, tickets, compare, audio, video, gallery, model, recipe, text, rows, badge, divider, diff, emails, pr, button, link, image, table, progress, list, callout, code, quote, avatar, timeline, input; containers stack, card, grid, tabs, collapse), `MAX_DEPTH = 4`, `MAX_CHILDREN = 24`, a depth check before zod descends, and `parseWidget(text)` that returns `null` on any invalid input so the transcript falls back to rendering the block as code. `src/index.ts` also has the agent session, ask, approval and inbox item schemas (`InboxItem`, `AgentApproval`, `ESCALATOR_DEVICE_ID = 'evaos'`) that the inbox/Relay work will need, and `src/hmac.ts`.

**Recommendation:**
- Share the **schemas and parser, not the components.** The React Native components under `apps/mobile` use RN primitives and are not portable; the web renderer is a new set of Mantine components (`packages/widgets`), one per node type, keyed by `type`.
- Do not edit Relay. Consume `@relay/protocol` by one of: (a) a pnpm `link:`/`file:` dependency on `/Users/ike/Eva/work/relay/packages/protocol` (zero copy, always current, but couples the build to a path outside the repo and to the Relay checkout existing; zod must resolve to one copy), or (b) a vendored copy under `packages/widgets/vendor/relay-protocol` with a sync script and a drift test that diffs against the Relay source when present. **Recommend (b)**: the repo is declared self-contained ("everything lives in this repo"), and Relay is read-only and may move. Pin the vendored commit hash in a comment and in a test.
- The `ui` fence tests: use `examples/showcase.md` (13 fenced `ui` blocks) as the renderer's golden fixture; Relay's `fixtures/` and `test/protocol.test.ts` are a second source of valid and invalid payloads.
- Widget actions (button, input) flow back as a reply message through the same `chat.prompt` path with the tagged surface prefix; wire the callback in the chat view, not in the widget schemas.
- Confirm in the widgets phase that the README's widgets (badge, callout, audio, etc.) all exist in the Relay schema; a delta is likely small (LOW confidence, unchecked field by field) and any local extension should be additive in an `evaos-widgets.ts` file layered over the vendored schema, never a fork.
- Security: widgets render model output. `parseWidget` already bounds depth and fan-out; additionally sanitize `image`/`link` URLs (allow http(s) and the app's file protocol only) and never use `dangerouslySetInnerHTML`.

## Answering Q5: Testing architecture

| Layer | Tool | What it covers | Notes |
|-------|------|----------------|-------|
| Pure packages (`chat-core`, `eva-core`, `theme-core`, `widgets` schemas) | Vitest (node env) | Reducer, line splitter, session-file parser, `append_todo`, job round-trip, theme mapping, widget fixtures | Port Rust `#[cfg(test)]` cases first. Fastest feedback; most coverage should live here. |
| Main services | Vitest (node env) | SessionManager against a **fake omp** (a small Node script that replays recorded JSONL with controllable chunking), PtyManager, ConfigStore, IPC handler registration | Fake omp is the key test asset: inject frames split mid-line, interleaved `_stderr`, a 10k-update stream, and assert final transcript equals the oracle and `seq` is gapless. Never spawn the real omp against Isaac's sessions in tests. |
| Renderer units | Vitest + jsdom/happy-dom + React Testing Library | Stores, hooks (`useOccludeBrowser`), widget components, hotkey map, layout math | Virtualization needs layout; test the scroll pinning logic as a pure function and rely on e2e for real layout. |
| End to end | Playwright `_electron.launch` against the built app | Launch with `EVAOS_CONFIG_DIR` and an Eva root pointed at a **fixture checkout** (a small tree in `fixtures/eva/`), `OMP_BIN` pointed at the fake omp (add this override to `binary()` lookup for tests) | Assert behavior and take screenshots to `proof/<phase>/`. |

Specific e2e patterns:
- `electronApp.evaluate(({BaseWindow}) => ...)` to read view bounds and verify browser view rect equals the slot rect (the bounds-sync test), and that `getVisible()` is false while a modal is open.
- The shell is a WebContentsView, so Playwright's `firstWindow()` may not behave as with a BrowserWindow; verify in the shell-setup phase that `electronApp.windows()` exposes the shell page, and fall back to `webContents` lookup through `electronApp.evaluate` if not (MEDIUM risk, test it in Phase 1).
- **Screenshot caveat:** Playwright `page.screenshot()` captures only that page, not native sibling views. Proof for the browser panel needs either `webContents.capturePage()` on each view composed, or the OS-level capture of the window (`BaseWindow` has no `capturePage`; use `screencapture -l <windowId>` on macOS, or `desktopCapturer`). Decide the proof tooling in the spike and write it as a reusable `proofShot(name)` helper.
- Streaming smoothness metrics (the stated core value): in the renderer, record frame times with `PerformanceObserver` (`longtask`, `event`) and rAF delta during a replayed 50k-token stream plus a 5k-message scrollback; assert p95 frame time and zero seq gaps, and write numbers into `proof/` alongside screenshots. Compare against Rust numbers only if a repeatable measurement of the current app exists; otherwise state absolute budgets.
- A visual regression layer (`toHaveScreenshot`) is optional and brittle with fonts; prefer behavioral asserts plus human-reviewable proof images.
- CI-less environment: tests run locally and in the unattended driver, so keep e2e headless-capable (Electron needs a display on macOS; run in the logged-in session) and keep them under a few minutes via `--grep` projects per phase.

## Answering Q6: Build order (dependencies)

```
contract + chat-core (pure)  ─┐
                              ├─> SessionManager ─> chat store ─> Chat view (virtualized)
Shell (BaseWindow, preload,   ─┤                                      │
 renderer skeleton, theme)    ├─> BrowserHost ─> slot/occlusion ─> Browser panel
                              │                                      │
Test harness (fake omp,       ─┘                          proof capture helper
 fixture Eva, _electron)
                    ↓ spike gate: proof/ shows chat smoothness + browser quality
Layout shell (columns, resize, layout.json) ─> Sidebar/routes/tabs ─> hotkeys
EvaStore + ConfigStore ─> Dashboard, Todo, Workspace, Jobs, Meetings, Habits
Session catalog ─> Chat list, Eregon, Side chats
PtyManager ─> Terminal ─> Files panel ─> Simulator
widgets pkg ─> Rich replies (ui blocks, mermaid) ─> widget actions
SearchIndex (utilityProcess) ─> ⌘K
InboxStore ─> Inbox ─> digests ─> notifications ─> Relay approvals/escalation
Theme editor (needs theme-core + all pages consuming Mantine tokens)
Entrance animation (last; needs final layout)
```

Suggested phases (matches "spike first, then parity"):

1. **Foundation and harness.** pnpm workspace, electron-vite, BaseWindow + shell view, preload with `contract`, Vitest, Playwright `_electron` launching the shell, `proofShot` helper that can capture native views, fake omp and fixture Eva. Everything else depends on this; the screenshot-of-native-view question must be answered here.
2. **Chat streaming spike.** `chat-core` reducer (ported with tests), SessionManager, batching/seq protocol, minimal virtualized transcript with pin/jump pills, composer. Proof: replayed long stream, gapless seq, frame-time numbers. Real omp smoke test on a throwaway session only.
3. **Browser panel spike.** BrowserHost, slot sync, occlusion hook, tabs, address bar normalization, DevTools, CDP PageControl, popup policy. Proof: bounds assertions, modal-hides-view test, screenshots. (Phases 2 and 3 are independent once Phase 1 exists and can run in parallel plans.)
4. **Shell and layout.** Columns, resize and fold rules, `layout.json`, sidebar, routing, tabs, hotkey system with focus-region isolation (terminal), theme tokens. Prerequisite for every page.
5. **Eva data pages.** EvaStore/ConfigStore, dashboard, New Todo, workspace page, jobs, meetings, habits and gate overlay. Pure TS and low risk; parallelizable per page.
6. **Chat parity.** Session catalog and chat list, composer toolbar, dialogs/questions, subagents, background jobs, Claude harness option, Relay feed, Eregon, side chats.
7. **Rich replies.** Widgets package over vendored Relay schema, mermaid, showcase fixture.
8. **Side-panel tools.** PtyManager + xterm, Files, Simulator.
9. **Search and inbox.** SearchIndex utilityProcess and `⌘K`; InboxStore, digests, prefs, escalation and approvals.
10. **Theme editor, settings, polish.** Editor, undo/redo, export; entrance animation; hotkey audit against the README.

Ordering rationale: the contract and chat-core are the shared bottom layer; the two spikes carry the core-value risk and are independent, so they go before any breadth; the layout shell must precede pages because the browser slot and panel widths depend on it; widgets and search and inbox are leaves that depend on chat and data, so they go late; the theme editor last because it re-skins everything.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Forwarding raw frames to the renderer and reducing there
**Why bad:** state lost on reload, duplicated per view, images double-cross IPC, ordering bugs hidden in React effects.
**Instead:** Pattern 1.

### Anti-Pattern 2: One IPC message per token, setState per message
**Why bad:** thousands of renders per second, jank, and virtualized lists re-measure constantly.
**Instead:** 16 ms main-side coalescing, rAF drain, memoized rows, measure heights lazily with `useVirtualizer` and `measureElement`; anchor the scroll when pinned.

### Anti-Pattern 3: Putting the browser in an `<iframe>` or `<webview>` tag
**Why bad:** `<webview>` is discouraged by Electron, iframes hit X-Frame-Options and shared-process restrictions, and neither gives full DevTools and CDP.
**Instead:** WebContentsView owned by main.

### Anti-Pattern 4: `nodeIntegration` or exposing `ipcRenderer` to the shell
**Why bad:** the shell renders model output and remote images; XSS becomes shell access.
**Instead:** contextIsolation, sandbox, typed preload, zod validation, path checks in main for every file operation.

### Anti-Pattern 5: Generic file read/write IPC
**Why bad:** violates the data-safety constraint; any bug writes to the Eva checkout.
**Instead:** named writers only, with Eva-root path containment checks.

### Anti-Pattern 6: Killing processes by name or by session
**Why bad:** Isaac's live omp sessions share the machine.
**Instead:** track PIDs and process groups you spawned; HUP then KILL only those; closing stdin for omp; tests use fake omp.

### Anti-Pattern 7: Long synchronous work in main
**Why bad:** main blocks IPC, so streaming stutters (the exact thing this app must win).
**Instead:** `fs.promises`, utilityProcess for index and digest, no `execSync`, cache session-file parses incrementally.

## Scalability Considerations

(Single-user app; the axis is data size, not users.)

| Concern | Typical (today) | Large (10x transcript, 10k sessions) | Mitigation |
|---------|-----------------|--------------------------------------|------------|
| Transcript rendering | hundreds of messages | 5k+ messages, long markdown | Virtualize, memoize parsed markdown per message id, lazy-render widgets and diagrams |
| Session list | tens to hundreds of files | thousands | Incremental parse cache keyed by mtime+size, parse only head for classification (`classify` reads the first user prompt) |
| Search index | repo files | whole Eva repo with notes | utilityProcess, `ignore` rules, incremental updates, cancellable queries with debounce |
| Live sessions | 1-3 | 10+ concurrent (Eregon, side chats) | Per-session batching, background sessions flush at lower rate when not visible |
| Terminal output | typical shell | log floods | MessagePort per pty, xterm write-buffer with flow control (pause pty when xterm backlog high) |

## Open Risks to Validate Early (flag for phase research)

- Whether `debugger.attach` and DevTools can coexist on the same webContents in the current Electron (docs say session ends on DevTools open): spike test. LOW confidence until tested.
- Playwright `_electron` handling of a `BaseWindow` plus WebContentsView shell, and screenshotting native views: Phase 1 test.
- node-pty rebuild for the Electron ABI under pnpm (`electron-rebuild`/`@electron/rebuild`, `asarUnpack`); node-pty is at 1.1.0 on npm. Prebuilt binaries vs build tools need checking.
- Exact omp `rpc-ui` frame set: `omp://rpc.md` was not resolvable from this environment (no `rpc.md` on disk found), so the frame list above comes from the Rust reducer only. Plans should read `omp://rpc.md` through omp itself.
- Image attachments and large tool output in frames: confirm IPC size behavior; consider storing big blobs by reference.
- Claude Code harness bridge (`.claude/bridge/session.ts`) speaks the same dialect: SessionManager should take a `Launcher` (omp or bridge) so only launch args differ.

## Sources

- Electron View API (setBounds, setVisible, addChildView reorder to top, `bounds-changed`): https://www.electronjs.org/docs/latest/api/view (HIGH)
- Electron WebContentsView (constructor options, adopt webContents, main-process only): https://www.electronjs.org/docs/latest/api/web-contents-view (HIGH)
- Electron debugger API (attach, sendCommand, detach on DevTools open): https://www.electronjs.org/docs/latest/api/debugger (HIGH)
- Electron BaseWindow composition and "close each webContents yourself" caveat: https://www.electronjs.org/docs/latest/api/base-window (MEDIUM, via search summary)
- UtilityProcess / parentPort / MessagePort: https://www.electronjs.org/docs/latest/api/utility-process (MEDIUM, search summary)
- Versions (npm registry, 2026-10-14): electron 44.7.2, electron-vite 6.0.0, @mantine/core 9.7.2, @xterm/xterm 6.0.0, @tanstack/react-virtual 3.14.19, @playwright/test 1.64.1, zod 4.6.7 (note: Relay pins zod ^3.25; vendored schemas need zod 3 or a migration check), node-pty 1.1.0 (HIGH, from `npm view`)
- Electron support window (latest 3 stable lines): electronjs.org timelines (MEDIUM)
- Local source (HIGH): `/Users/ike/Eva/apps/evaos/src/chat.rs` (spawn, `Live::apply`, handshake, `binary`), `src/panel/browser.rs` header (wry overlay, hide/narrow behavior), `README.md` Layout table, `/Users/ike/Eva/work/relay/packages/protocol/src/{index,widget}.ts` and `package.json`
- Reference apps Synara and T3 Code were not inspected; structure claims about "typical" apps are inferred from Electron docs and the Rust app, not from them (LOW for that specific claim)

# Phase 4: Chat Parity - Research

**Researched:** 2026-10-15
**Domain:** Electron port of EvaOS chat list, composer, question cards, writer registry, transport ADR (omp rpc-ui over stdio)
**Confidence:** HIGH on Rust behavior (read directly from source), MEDIUM on dnd-kit behavior inside virtualized/tree markup, MEDIUM on Claude Code bridge scope

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
**Chat list**
- Behavior is a port of the read-only Rust app (`/Users/ike/Eva/apps/evaos/src`: `chat_groups.rs`, `chat_ops.rs`, `chat.rs`, `watch.rs`, README) into Electron-free logic in `packages/chat-core`, unit-tested with fixtures. Never write under `/Users/ike/Eva/apps/evaos`.
- Grouping, pinned section, running first, five newest plus Show N more, status rows, search that opens all groups including archived, and categories persisted in `chat.json` with its existing file shape. Writes go through the existing write layer, never directly.
- Drag and drop with `@dnd-kit/core` + `@dnd-kit/sortable`; right-click menu through the existing `EvaMenu` wrapper (Rename, Pin/Unpin, Archive/Unarchive, Delete, Move to).
- Session-file changes watched in main with chokidar on `~/.omp/agent/sessions` (narrow path), debounced so the list updates within 500 ms without window focus.
- Rename reaches the running omp via RPC when the session is owned by this app, otherwise a short resume as the README describes.

**Composer and settings**
- Two-line composer with toolbar: model picker, access mode, context ring, omp account selector (unsent chats only), image paste and drop. Extends the existing `Composer.tsx`.
- Settings > Chat switches `show_thinking` and `show_tools` persist through the existing config store and apply live to the chat view. Harness selector (omp or Claude Code) lives in the same section.
- Inline images in prompts and tool results render in the chat with a viewer modal through the existing overlay wrappers.

**Questions, subagents, writers**
- Question cards render every blocked `ask` with single-choice answers, keys `1`-`4` while the composer is not focused; extension UI requests (select, confirm, input, editor) answered through the RPC UI response frames.
- Subagent chips (running and finished) with Clear done; background jobs strip while the omp process runs.
- Shared writer registry in main tracks which pane owns which session; sending into a session owned elsewhere prompts for confirmation first.
- Every prompt carries the `<surface><machine> - EvaOS</surface>` tag via the existing tagged helper.

**Transport ADR**
- Decision: new chats start through a direct omp child (`omp --mode rpc-ui`) owned by `SessionManager`, behind the existing transport interface. Herdr plus Relay is rejected for this phase (Relay is read-only and out of repo). The Claude Code harness is a second transport implementation behind the same interface. Record the ADR in PROJECT.md Key Decisions and a short `docs/adr` note.
- Tests use `EVAOS_OMP_BIN` fake omp and fixture sessions; never attach to Isaac's live sessions.

**Proof and verification**
- Playwright for Electron specs with `EVAOS_E2E=1` (no focus stealing), screenshots under `proof/phase-4/`; Vitest for logic; app must build and launch.

### Claude's Discretion
Component structure, store shapes, icons, exact keyboard affordances, fixture contents, and plan slicing. No em dashes in UI strings.

### Deferred Ideas (OUT OF SCOPE)
Relay-observed sessions and Eregon sharing the view (Phase 6 and 7).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CHTP-01 | Chat list grouped by workspace, collapsible, running first, pinned, five newest + Show N more, status rows | Rust `chat::workspace_of`/`WORKSPACES`, `chat_view.rs` grouping (RECENT_CHATS=5, RECENTLY_ACTIVE=10 min), status wording table below |
| CHTP-02 | Search by title opens all groups incl. archived | Rust list behavior; search state in renderer, archived included only while query non-empty |
| CHTP-03 | Categories create/rename/delete, move, reorder headers | `chat_groups.rs` `Categories` (port verbatim incl. tests), dnd-kit |
| CHTP-04 | Right-click Rename/Pin/Archive/Delete; rename via RPC or short resume | `chat_ops.rs` (pins file, delete_session, rename_session), `apply_rename` order |
| CHTP-05 | List updates within 500 ms of file change | chokidar with `usePolling`/stat caveat (see Pitfall 1) |
| CHTP-06 | Composer toolbar | Launch args, `get_available_models`, `set_model`, `set_thinking_level`, `--approval-mode`, `--profile`, usage.contextWindow |
| CHTP-07 | show_thinking / show_tools persist | `chat.json` keys; current Electron stores them in `settings.json` (migration needed) |
| CHTP-08 | Question cards + extension UI | `Dialog`/`Ask` shapes and `extension_ui_response` frames; reducer currently auto-cancels all dialogs |
| CHTP-09 | Subagent chips, background jobs strip | `chat::subagents`, `chat::background_jobs` algorithms |
| CHTP-10 | Writer prompt + registry | Existing `SessionManager.owners`; replace hard `ALREADY_OWNED` with confirm-able error |
| CHTP-11 | Surface tag | `tagged()` already wired in `SessionManager.send`; add coverage for image/steer/resume paths |
| CHTP-12 | Claude Code harness | `bun .claude/bridge/session.ts --rpc`, flag mapping; no Claude transcript parser exists in chat-core yet |
| CHTP-13 | Inline images + viewer | `imagesize`-style header read, blob store `~/.omp/agent/blobs`, prompt `images` shape |
| CHTP-14 | ADR + new chat via direct child | Transport currently only does `--resume <file>`; new chat start needs a no-resume launch path |
</phase_requirements>

## Summary

The Rust app is the spec and it is small and readable. The pure logic (categories, workspace keyword matching, pins file, delete rules, dialog to answer frame mapping, background job and subagent derivation, surface tag) ports almost line for line into `packages/chat-core` with Vitest fixtures. The Electron side already has the hard streaming infrastructure (SessionManager, LiveReducer, SeqBatcher, OmpStdioTransport, tagged helper, single-owner map). Phase 4 is mostly: (1) a `chat-list` model and its IPC, (2) widening the reducer/contract so dialogs, subagents and jobs become state instead of being auto-cancelled, (3) a launch path that is not `--resume`, (4) composer/toolbar UI, (5) a fake-omp extension so every e2e path is deterministic.

Five gaps in the current code decide the plan: the transport only supports `--resume <file>`; the reducer auto-cancels every `extension_ui_request`; `SessionManager` throws `ALREADY_OWNED` instead of a confirmable owned-elsewhere result; `ChatPane` is hard wired to one `PANE_ID = 'pane-1'`; and show_thinking/show_tools live in `settings.json`, not `chat.json`. Also `fake-omp` supports only `--mode rpc-ui` and answers unknown commands with an error, so rename-by-resume, models, ask dialogs and background jobs need fake support first (Wave 0).

**Primary recommendation:** Slice as: (A) chat-core pure ports + fixtures, (B) main-side chat-list service (scan, watch, prefs, pins, ops) + IPC, (C) reducer/contract widening (dialogs, subagents, jobs, images) + fake-omp extension, (D) list UI with dnd-kit, (E) composer/toolbar, (F) question/chips/strip/writer prompt/images UI, (G) settings + harness + ADR, (H) e2e proof. Keep every write behind the existing `WriteQueue`/`ConfigStore`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session scan, grouping inputs (title, mtime, status) | Main (Node) | packages/chat-core (pure) | fs access; pure functions unit-tested without Electron |
| Grouping/sort/categories logic | packages/chat-core | Renderer (derives view) | Electron-free per CONTEXT |
| `chat.json` prefs read/write | Main via ConfigStore + WriteQueue | — | only reviewed writer; renderer never touches fs |
| Pins (`session-pins.json`), delete, archive | Main | — | omp's agent dir; same file shape as omp |
| Session watching | Main (chokidar) | Renderer subscribes to `chat.listChanged` | descriptors/CPU belong in main |
| omp process, writer registry, rename RPC | Main (`SessionManager`) | — | single writer rule (D-17) |
| Dialog/ask/jobs/subagent state | chat-core reducer (main) | Renderer store | one ordered op stream, seq-stamped |
| Cards, chips, strip, composer, modals | Renderer | — | presentation only, overlays via wrappers |
| Image bytes (paste/drop, blob lookup) | Main (temp file, blob read) | Renderer (thumbnail via custom URL/data) | renderer is sandboxed, no fs |
| Hotkeys `1`-`4` | Renderer hotkey router | — | existing router, focus-guarded |

## Standard Stack

### Core (already in repo; do not add alternatives)
| Library | Version | Purpose |
|---------|---------|---------|
| chokidar | 5.0.0 | Session dir watch in main [VERIFIED: apps/desktop/package.json] |
| zustand | 5.0.15 | chat/list stores [VERIFIED: package.json] |
| zod | 4.6.7 | IPC contract [VERIFIED: package.json] |
| @mantine/core, notifications | 9.7.2 | UI, Undo toast for Archive [VERIFIED: package.json] |
| virtua | 0.53.5 | virtualized log [VERIFIED: package.json] |

### New
| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| @dnd-kit/core | 6.3.1 (modified 2024-12-05) | DnD engine, KeyboardSensor, live-region announcements | User-locked in CONTEXT [VERIFIED: npm registry] |
| @dnd-kit/sortable | 10.0.0 (modified 2024-12-04), peer `@dnd-kit/core ^6.3.0` | Sortable header reorder | User-locked; peer-compatible with 6.3.1 [VERIFIED: npm registry] |
| @dnd-kit/utilities | 3.2.2 | `CSS.Transform` helper, transitive dep of sortable | Transitive |

**Installation:** `pnpm --filter @evaos/desktop add -D @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0` (renderer bundle, so devDependencies like the rest).
**Rejected:** `@dnd-kit/react` 0.x (pre-1.0, STACK.md says avoid). `dnd-kit` packages are stale since Dec 2024 but stable and React 19 compatible by peer range (`react >=16.8`) [VERIFIED: npm registry peerDependencies]; verify drag works under React 19.3 in the first list task.

## Package Legitimacy Audit

| Package | Registry | Age | Source | slopcheck | Disposition |
|---------|----------|-----|--------|-----------|-------------|
| @dnd-kit/core | npm | years (6.x line) | github.com/clauderic/dnd-kit | not run (tool not installed in this session) | Approved: user-named in CONTEXT/STACK; no postinstall script (empty `scripts.postinstall`) |
| @dnd-kit/sortable | npm | years | same | not run | Approved, same reason |

**Removed due to [SLOP]:** none. **Flagged [SUS]:** none. Since slopcheck did not run, planner may add a one-line `pnpm view` sanity check before install; risk is very low because both packages are explicitly named by the user's locked decision.

## Behavior Spec (read from the Rust source, authoritative)

### Workspace grouping (`chat.rs` `WORKSPACES`, `workspace_of`)
- Ordered table of `(group, keywords)`; the first group with any keyword appearing as a whole word or phrase wins. Lowercase title, replace every non-alphanumeric char with a space, collapse whitespace, pad with spaces, test `" {key} "`. No match gives `Other` (always last in `workspace_names()`).
- Keywords seen: eCard (`ecard, ecs, eng, ecardsystems, client api, reports app, linear`), EvaOS (`evaos, eva os, gpui`), Relay (`relay, herdr, catch the stars, airplay`), Texo, GoodOps (`goodops, goodword`), Flo (`flo, flodoc`), OpenFlight (`openflight, launch monitor, golf`), Bambee, Hexagon (`hexagon, ponder`), Eva (`eva, eren, elysia, omp, subagent, subagents, skill, journal, harness`). The head of the table (first entries before eCard) was not shown in my read; the planner's first task must copy the complete `WORKSPACES` constant from `chat.rs` lines ~200-240 verbatim into a chat-core module and port the Rust tests. [VERIFIED: chat.rs]

### Categories (`chat_groups.rs`, port exactly)
- `chat.json` keys: `chat_categories` (string[], creation order), `chat_group_order` (string[]), `chat_assignments` (object sessionId to category). `Categories` operations: `fromPrefs`, `toPrefs`, `exists` (workspace or Other or custom), `categoryOf(id,title)` (assignment only if category still exists, else `workspace_of(title)`), `names()` (order first filtered by exists, then custom, then workspaces), `rank`, `add` (trim; errors `Give the category a name.` / `A category with that name already exists.` case-insensitive; push to `custom` AND insert at index 0 of `order`), `rename` (custom only, error `Only your own categories can be renamed.`; rewrites custom/order/assigned), `remove`, `assign(id,name|null)`, `reorder(shown, moving, target)` (remove from, insert at target index, so dragging down lands after, up lands before; append remaining `names()`). The 4 Rust unit tests port directly. [VERIFIED: chat_groups.rs]
- Other keys in `chat.json` that this phase reads or writes: `collapsed_groups` (string[]), `archived_chats` (string[] of session ids), `harness` (`omp`|`claude`), `show_thinking`, `show_tools`, `favorite_models`, `account`, `chat_agent`. Writes are single-key read-modify-write (`save_pref`), preserving unknown keys, pretty JSON + trailing newline, tmp+rename. Use `ConfigStore.readForMerge('chat.json')` then `writeJson` inside the `WriteQueue`, which already preserves unknown keys. [VERIFIED: chat_view.rs 322-345]
- The Electron app uses its own config dir (`~/Library/Application Support/EvaOS Electron`, or `EVAOS_CONFIG_DIR`), so it does not share `chat.json` with the Rust app; "existing shape" means same file name and keys. [VERIFIED: env.ts]

### Session id and pins
- `session_id(path)`: file stem, then text after the last `_` (omp names `2026-10-02T23-30-41-963Z_<uuid>.jsonl`; Claude files are the uuid alone). Used as the key for pins, archive, assignments.
- Pins live in omp's own `<agentDir>/session-pins.json`, a JSON array of strings; missing/unreadable reads as empty; write sorted ids, pretty JSON, tmp file `session-pins.json.<pid>.tmp` then rename; keep other ids. Pinned chats list under Pinned on top. [VERIFIED: chat_ops.rs]
- Electron needs an `agentDir` in `Env` (only `sessionsDir` exists today). In e2e this must be a fixture dir (`fixtures/agent`), never `~/.omp/agent`. Add `EVAOS_AGENT_DIR` (default `PI_CODING_AGENT_DIR` or `~/.omp/agent` when live, `fixtures/agent` copy in tmp otherwise). [ASSUMED: env var name]

### Delete (`delete_session`)
Remove the `.jsonl`; remove dir `<file without .jsonl>` recursively (ignore not found); remove siblings named `<file name>.*.bak`. A session sharing a name prefix stays. Running chat refuses. Confirm dialog copy is in UI-SPEC. Deleting is a destructive write under `~/.omp/agent/sessions` that current EvaOS performs, so it is allowed, but e2e must operate on a copied fixture dir in tmp. [VERIFIED: chat_ops.rs]

### Rename order (`apply_rename`)
1. Session owned by this app: send `{type:'set_session_name', name}` on its transport; on success update the title locally.
2. (Rust only) running elsewhere via Relay: not applicable (Relay out of scope); treat as case 3.
3. `maybe_running` (written within 10 minutes, no Relay): refuse with notice (Rust: "This chat may be open in a terminal. Rename it there, or try again later.").
4. Else short resume: capture the file mtime, spawn `omp --mode rpc --resume <file> --no-extensions --no-skills --no-rules --no-lsp --no-title`, cwd = Eva root, write `{id:'evaos-rename',type:'set_session_name',name}`, wait up to 20 s for the response with that id, close stdin, wait exit, restore mtime (`fs.utimes`) so the chat keeps its list position. For Claude harness the command is `bun .claude/bridge/session.ts --rpc --no-relay --resume <file>`. Empty name is rejected. [VERIFIED: chat_ops.rs]
- Note `fake-omp` rejects `--mode rpc` (exits 2). Either teach fake-omp `--mode rpc` with `set_session_name` that rewrites the title record in a tmp copy, or make the short-resume spawn take the mode through a testable seam. Do the former (Wave 0).

### Status wording (README + `chat_view.rs` 4270-4285)
Rust wording is lowercase: `open` (omp runs in EvaOS), `working`, `needs approval`, `has a question`, `job`; `unread` is experimental only. Warning color for approval/question. UI-SPEC proposed `Working`, `Needs approval`, `Question`, `Job running` and said to confirm against README. **Resolution for the planner:** keep the Rust strings exactly, sentence-cased for display is a UI-SPEC call, so use `Open`, `Working`, `Needs approval`, `Has a question`, `Job`. Put the strings in one constants module and cover with a test so the choice is one line to flip. [VERIFIED: README + chat_view.rs; mismatch with UI-SPEC flagged in Open Questions]
Without Relay in this phase the statuses derive locally:
- `open`: this app owns a live process for the file.
- `working`: owned and `reducer.working`; also a running-elsewhere guess for files written in last 10 min (`RECENTLY_ACTIVE`) counts as "running" for sort only.
- `needs approval`: pending dialog is `confirm`; `has a question`: any other pending dialog (select/input/editor/ask).
- `job`: idle chat whose `background_jobs(file)` is non-empty.

### List shape (`chat_view.rs` ~3255-3300, README)
- Pinned section first. Groups ordered by `Categories.names()`/`rank`, unordered groups follow with groups containing running chats first, then by newest chat. Header: chevron, name, count, `N running`.
- Inside a group: running chats first (owned by this app, or file mtime within 10 minutes), then others newest first. Visible = `running + 5`; `Show N more`/`Show fewer` toggles; hidden while searching.
- Search filters by title and opens every group fully, archived included. Archived chats otherwise hide behind an `Archived (n)` toggle at the bottom (README). UI-SPEC instead shows an `Archived` chip only during search; add the bottom `Archived (n)` toggle too since README defines it (cheap, parity). [VERIFIED: README; UI-SPEC delta flagged]
- Empty group copy in Rust: "Drag chats here, or right-click one › Move to."; UI-SPEC uses `No chats in this group`; follow UI-SPEC.
- Titles: header `title` record, else session record title, else first user prompt one-lined to 80 chars (`Image` when only images). Existing `readHeader`/`listSessionFiles` has this; **it is capped at `limit = 50`**: raise or remove for the list (Rust lists all) and avoid re-parsing whole files per scan (cache by `mtimeMs+size`).
- `resolveLiveSessionsDir` already ports `omp_sessions_dir`.

### Dialogs and answers (`chat.rs` Dialog/Ask)
Request frames (`extension_ui_request`, field `method`): 
- `select`: `title`, `options: string[]`, optional `optionDetails[i].description`. Answer `{type:'extension_ui_response', id, value: <option string>}`.
- `confirm`: `title`, `message`. Answer `{..., confirmed: boolean}` (Rust maps picked "Yes"). UI-SPEC wants Confirm/Decline buttons; Decline should send `confirmed:false`? UI-SPEC says Decline sends the cancel frame; keep UI-SPEC (`cancelled:true`), both unblock omp.
- `input` / `editor`: `title`, optional `placeholder`. Answer `{..., value: <text>}`.
- `ask` (after `set_ask_dialog {enabled:true}`): `questions: [{id, question, header?, options:[{label,description?}], recommended?: index, multi?: bool}]`. Answer `{..., answers:[{id, selectedOptions:[labels]}|{id, selectedOptions:[], customInput:text}]}`. Unreadable ask: notice `omp asked a question EvaOS couldn't read, so it was cancelled.` and cancel.
- `cancel` request with `targetId` clears a pending dialog with that id. Other methods (notify, setStatus, etc.) are presentation only and ignored.
- Cancel frame: `{type:'extension_ui_response', id, cancelled:true}` (exists as `cmd.cancelUi`).
CONTEXT/UI-SPEC require single-choice cards with keys 1-4; the Rust app also supports multi-select and multi-question progress. For `ask` with several questions render one card per question inside one answer frame (answer frame is sent when every question is answered; a single-question ask sends immediately on pick). Multi-select: render checkbox rows plus a `Next`/submit button (small extra over UI-SPEC; otherwise a multi ask would be unanswerable). [VERIFIED: chat.rs; multi handling is a recommendation]
- Current reducer **auto-cancels** dialogs (T-01-25). Replace with: store pending dialog in reducer state, emit via a new `dialog` op, send nothing until the renderer answers through a new `chat.answerUi {paneId, id, response}` IPC (validated: id must equal the pending dialog id), cancel automatically on `_eof`, abort, or process close (mark card dead: `This question can no longer be answered.`). `set_ask_dialog` must be sent right after start (Rust does at spawn; the fake handles it).

### Background jobs / subagents (`chat.rs` 641-770)
- `background_jobs(file)`: scan lines containing `"toolCall"`, `"jobs"` or `"async"`. Remember `commands[toolCallId]=arguments.command` from assistant toolCall parts. A record (`custom_message` uses top-level `details`, else `message.details`) with `details.async.state == 'running'` and `jobId` starts a job (skip `type == 'task'`; kind defaults `job`); label = command one-lined to 160 or the jobId; start = record `timestamp`. `details.jobs[]`: an item with `jobId` ends it; an item with `id` and `status != 'running'` ends it. Result is oldest first. Only shown while the owned process runs; re-read when the file changes (debounced watch event).
- `subagents(file)`: folder = file without `.jsonl`; omp: `*.jsonl` directly in it; done iff sibling `<name>.md` exists; newest first by mtime; nested subagents excluded. Claude: `<folder>/subagents/*.jsonl`, done iff last uuid user/assistant record is an assistant without `tool_use` blocks. "Clear done" hides finished ones for this run of the app (renderer/main memory only, not persisted).
- Strip copy and chip states from UI-SPEC. Subagent live frames: fake supports `set_subagent_subscription`, but file-derived data is the Rust behavior; use files.

### Surface tag (CHTP-11)
`tagged()` (chat-core) already matches Rust `tag_with`: skip slash commands and blank; `<surface>{machine} - EvaOS</surface>\n{text}`; machine label from `~/.config/eva/machine` else short hostname (`hostname -s`) else `Mac`; `untagged()` strips any `<surface>` prefix before display (exists in session.ts). Work left: ensure every send path uses it (new-chat first prompt, steer, image prompts, claude transport) and add a SessionManager test per path. [VERIFIED: tagged.ts, chat.rs]

### Launch args (`Launch::args`)
`--profile personal|work` (omp harness, new chats; account Current has no flag), `--model <id>`, `--thinking <level>`, `--approval-mode yolo|write|always-ask`; fast mode has no flag (send `set_fast_mode` after start). Access labels: Full access (yolo, default), Ask before commands (write), Ask before edits (always-ask); initial value from `tools.approvalMode` in project or global omp config; omp takes it only at launch, so switching on an idle live chat restarts omp on the same session (close stdin, wait exit, respawn with `--resume`). Resume: `omp --mode rpc-ui --resume <file>` in the Eva root; new chat: same without `--resume` (session file is reported by `get_state.data.sessionFile`; after first prompt the new `.jsonl` appears in the sessions dir; bind pane to it). Account selector shows only for unsent GPT-provider chats. [VERIFIED: chat.rs 1780-1830, README]
- Models: Rust runs one throwaway `omp --no-session` rpc process once, sending `{id:'models',type:'get_available_models'}`; entries `{provider,id,name,contextWindow,images,levels}`; menu order newest first with dated aliases folded to the shortest id. Context ring percent = `contextTokens / contextWindow` (window from last assistant `usage.contextWindow`, else catalog); unknown window shows token count only; no reading shows "Unavailable", never zero. UI-SPEC copy `Context {n}% used`. The existing `SessionMeta.contextTokens` has no window: add `contextWindow` to meta and the reducer. Live switches: `set_model {provider,modelId}`, `set_thinking_level`, `set_fast_mode`; each success triggers `get_state`. [VERIFIED: chat.rs; command field names for set_model are ASSUMED, confirm against `omp://rpc.md` or the Rust sender near chat.rs line 2400]
- Images in prompts: command gets `images: [{type:'image', data:<base64>, mimeType}]`; accepted png/jpg/gif/webp up to 20 MB; disabled when the model has `images:false`. Pasted images are stored under `$TMPDIR/evaos-images` by Rust; in Electron keep bytes in main memory/tmp and send base64 over IPC (size cap 20 MB, Zod-validated), renderer shows blob/object URL thumbnails. Prompt rendering: image parts `data` inline base64 or `blob:sha256:<hash>` resolved from `~/.omp/agent/blobs/<hash>` (agentDir). Serve to the renderer through a registered `evaos-media://` protocol or base64 IPC read with path-containment checks. [VERIFIED: README; the blob file naming under `blobs/` is ASSUMED, inspect `ls ~/.omp/agent/blobs` read-only during implementation]
- `ChatMessageSchema.images` is only `{label}` today; widen to `{label, src?: token, width?, height?, caption?}` and read header dimensions for aspect (a tiny PNG/JPEG/GIF/WebP header reader, about 40 lines, replacing Rust `imagesize`) to reserve space and avoid jump in the virtual list.

## Architecture Patterns

### System Architecture Diagram
```
~/.omp/agent/sessions/<dir>/*.jsonl  --chokidar(debounce 100-200ms)--> ChatListService (main)
 session-pins.json (agentDir) --------------------------------------->   | scan: titles, mtime, ids, bg jobs
 chat.json (configDir) ---ConfigStore read------------------------->     | + Categories (chat-core) + live panes (SessionManager)
                                                                         v
                                              emit 'chat.list' {rows, groups inputs, pins, archived, categories}
                                                                         v
Renderer chat-list-store (zustand) --derive (chat-core groupChats)--> SessionList tree (dnd-kit, EvaMenu, search)
   user action (rename/pin/archive/delete/move/reorder/collapse)
        --> invoke chat.* --> main validates (Zod) --> WriteQueue --> chat.json | session-pins.json | fs delete | omp RPC rename
Composer send --> chat.send(paneId, text, images?, force?) --> SessionManager
   writer registry check --> 'owned-elsewhere' result --> EvaModal --> resend with force
   start transport (harness factory: OmpStdioTransport | ClaudeBridgeTransport) --> frames --> LiveReducer
   reducer state: messages, dialog, jobs? --> SeqBatcher ops --> chat.batch --> chat-store --> cards/chips/strip
   Dialog answer --> chat.answerUi --> transport.write(extension_ui_response)
```

### Recommended structure
```
packages/chat-core/src/
  workspaces.ts      WORKSPACES table + workspaceOf/workspaceNames
  categories.ts      Categories class (port of chat_groups.rs) + tests
  chat-groups.ts     groupChats(rows, prefs, now, query) -> pinned, groups, archived (pure)
  status.ts          status constants + rowStatus()
  jobs.ts            backgroundJobs(fileText), subagents(listing) pure parsers
  dialogs.ts         parseDialog(frame), dialogResponse(dialog, answers)
  launch.ts          Launch args, Approval, Account, Harness, image mime
  session-id.ts      sessionId(path)
apps/desktop/src/main/chat/
  chat-list.ts       scan + watch + prefs + ops service; chat-list-ipc.ts
  session-ops.ts     pins, deleteSession, renameViaResume (node fs/child_process)
  claude-transport.ts  second ChatTransport (bun bridge)
  writer-registry.ts   thin wrapper over SessionManager.owners (or extend it)
apps/desktop/src/renderer/chat/
  list/ (SessionList, GroupHeader, ChatRow, list-store, dnd)
  composer/ (Toolbar, ModelPicker, AccessPicker, ContextRing, ImageChips)
  cards/ (QuestionCard, ExtensionUiCard), strips/ (SubagentChips, JobsStrip), WriterPrompt, ImageViewer
```

### Pattern: chat.json single-key writes
Always `queue.enqueue(() => { const cur = config.readForMerge('chat.json'); config.writeJson('chat.json', {...cur, [key]: value}) })`. Collapsed state, categories (all three keys in one write), archive, harness, show_* all use it.

### Pattern: writer registry
`SessionManager.owners` (realpath to `Owner{pane,transport,closing}`) is already the registry. Extend: `owner(file) -> paneId|null`; `send(paneId,text,{force})` returns/throws `CodedError('owned-elsewhere')` when `owners` has the file under another pane, **or** when the file was written within 10 minutes with no owner here (README: ask before continuing a past chat another omp may be running; Relay down rule). Renderer shows the UI-SPEC modal; remembers the choice per session until owner changes (`rememberedForce: Map<file, ownerPaneId>`). Because there is one pane today, create the second-pane test via direct `SessionManager` unit tests and an e2e that opens the same file in a second pane id through a test hook; real multi-pane UI arrives in Phase 6 (side chats). A force-send into a file another pane owns must still not start a second process in this app: route it to the existing owner's transport (Rust "one writer").

### Pattern: new chat
Add `ChatTransport.start({sessionFile: string | null, cwd, launch})`. When null, omit `--resume`. After `get_state` response (`data.sessionFile`) or the first new file in sessions dir, `SessionManager` binds `pane.file/key` and registers the owner; chat list emits the row immediately (Rust shows the chat before the file exists). Keep `--mode rpc-ui` for live; short rename/model-list use `--mode rpc`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Drag and drop with keyboard + announcements | custom pointer logic | @dnd-kit core+sortable (locked) | KeyboardSensor, live region, collision detection |
| Context menus / modals / popovers | raw Mantine overlays | `EvaMenu/EvaModal/EvaPopover` wrappers | browser occlusion + dismiss stack; lint test enforces |
| Serialized config writes | ad hoc fs.writeFile | `WriteQueue` + `ConfigStore.readForMerge/writeJson` | atomicity, `.bad` backup of corrupt files |
| Eva-root writes | any fs write under Eva | `EvaFs` / write trap exists | trap throws; this phase writes only agentDir, configDir, tmp |
| JSON line framing | readline | existing `LineFramer` | U+2028/2029 safe |
| Debounced file watch | polling loop | chokidar 5 + 100-200 ms debounce | already used in `main/eva/watch.ts` |
| Surface tag / machine label | new helper | `tagged`, `machineLabel` | parity already tested |
| Markdown for chat rows | new renderer | existing `MessageRow` (Phase 5 polishes) | scope |
| Image header dimensions | image library | tiny header sniffer for png/jpeg/gif/webp | avoids a dependency |

**Key insight:** the risky parts are timing and ordering (watch latency, writer ownership, ordered frame state), not UI. Keep all derivation in pure chat-core functions and test those hard.

## Common Pitfalls

### Pitfall 1: File watch latency on a file omp holds open
**What goes wrong:** The Rust app polls (`PollWatcher` 500 ms) because FSEvents only reports writes through an open file when it closes. omp keeps its session file open while running. chokidar 5 uses `fs.watch` (FSEvents on macOS), so appends by a live omp may not fire promptly.
**How to avoid:** For this app's own panes the reducer already knows activity, so list updates for owned sessions come from the stream (mark the row dirty on batch). For external writers use chokidar with `usePolling: true, interval: 250` limited to the sessions dir (depth 1, plus subagent folder depth 2), `awaitWriteFinish` OFF (it delays by its stability threshold and breaks the 500 ms budget), debounce 100-150 ms. Test with a held-open file append exactly like Rust's `reports_writes_to_a_file_held_open`. Also rescan on window focus (cheap) as a belt. [VERIFIED: watch.rs comments; chokidar polling option behavior ASSUMED, prove in a Wave-0 test]
**Warning signs:** e2e passes only after the file closes.

### Pitfall 2: Reducer auto-cancel hides questions
Existing behavior cancels dialogs, so a naive card UI never fires. Replace deliberately, keep a test that a dialog is cancelled on `_eof`/close so omp never hangs.

### Pitfall 3: `ALREADY_OWNED` is an error, not a prompt
Current `SessionManager` rejects a second pane. Convert to a coded, retryable result; keep the guarantee of one process per file.

### Pitfall 4: `listSessionFiles(limit=50)` and per-scan parsing
List must show all chats; scanning thousands of files with `readFileSync` on each change would blow the 500 ms budget. Cache per file by `mtimeMs+size`; read only changed files (head 64 KB for header; first prompt fallback reads more only when no title).

### Pitfall 5: Sessions dir resolution and tmp dir in e2e
`EVAOS_SESSIONS_DIR` points at `fixtures/agent/sessions/-fixture` in tests. Delete/rename/pin e2e must copy the fixture dir to tmp and point `EVAOS_SESSIONS_DIR` and the new agent dir there, or the repo fixtures get destroyed.

### Pitfall 6: dnd-kit inside a scroll area with tree roles
Activation constraint distance 4 so click still opens the chat and the menu button works; `role="tree"` conflicts with dnd-kit's default `role="button"` attributes: override `attributes` (`role: 'treeitem'`, keep `aria-roledescription`). Dragging a chat onto a header and sorting headers need two DnD scopes: one `DndContext` with `data.type` discriminators (`chat` | `group`), custom `onDragEnd`. Use `closestCenter` for headers, `pointerWithin` for chat to group drops.

### Pitfall 7: Rename restores mtime
After the short resume omp rewrites the file; restore `utimes` or the chat jumps to the top. Also never short-resume a file this app owns or that is "maybe running".

### Pitfall 8: Focus stealing in e2e
Every launch `EVAOS_E2E=1`; hotkey tests dispatch DOM key events in the renderer (Playwright `page.keyboard` on the page, not OS events); never `win.focus()`.

### Pitfall 9: Key handling for `1`-`4`
Router must skip when the target is an input/textarea/contentEditable/xterm; add the action through the existing hotkey router with focus guard and unit test it.

### Pitfall 10: Virtual log reflow
Cards, chips and strips live outside the virtualized list or at fixed heights; the pinned card/jobs strip/chips render between log and composer (UI-SPEC). The in-log answered summary is a message row; changing its height must keep bottom pin (existing `pin.ts` tests extend).

### Pitfall 11: Claude Code harness scope
`chat-core/session.ts` parses only omp session JSONL; Claude transcripts chain by `uuid` and lack the `session` record (Rust `claude_session`). Listing `~/.claude/projects/<root>/*.jsonl` and rendering them needs a second parser. Minimum for CHTP-12: harness switch persists, new chats run via `bun .claude/bridge/session.ts --rpc` (+ `--model/--thinking/--approval-mode` with alias mapping), and a missing binary shows the UI-SPEC notice. Listing/rendering Claude transcripts is a stretch task; record deferral in VERIFICATION if not done. `bun` and `claude` exist on this machine; the bridge is read-only in `/Users/ike/Eva/.claude/bridge` and the e2e must use a fake bridge script (EVAOS_CLAUDE_BRIDGE_CMD override) rather than a real Claude run. [ASSUMED: override name]

## Code Examples

### Port of `workspace_of`
```ts
// Source: Rust chat.rs workspace_of
export function workspaceOf(title: string): string {
  const words = [...title.toLowerCase()].map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : ' ')).join('')
  const padded = ` ${words.split(/\s+/).filter(Boolean).join(' ')} `
  return WORKSPACES.find(([, keys]) => keys.some((k) => padded.includes(` ${k} `)))?.[0] ?? 'Other'
}
```

### Dialog response mapping
```ts
// Source: Rust Dialog::response
if (cancelled) return { type: 'extension_ui_response', id, cancelled: true }
switch (dialog.kind) {
  case 'select': return { type: 'extension_ui_response', id, value: picked }
  case 'confirm': return { type: 'extension_ui_response', id, confirmed: picked === 'Yes' }
  case 'text': return { type: 'extension_ui_response', id, value: typed }
  case 'ask': return { type: 'extension_ui_response', id, answers: answers.map((a) =>
    a.typed !== undefined ? { id: a.id, selectedOptions: [], customInput: a.typed }
                          : { id: a.id, selectedOptions: a.picked }) }
}
```

### Watch with a held-open file (Wave 0 test shape)
```ts
const w = chokidar.watch(sessionsDir, { ignoreInitial: true, depth: 2, usePolling: true, interval: 250,
  ignored: (p) => !p.endsWith('.jsonl') && path.extname(p) !== '' })
```

## Runtime State Inventory
Not a rename/migration phase. One migration note: Phase 2/3 stored `show_thinking`/`show_tools` in `settings.json` (`settings-ipc.ts`). CHTP-07 says persist as these keys; Rust keeps them in `chat.json`. Recommendation: `loadSettings` reads `chat.json` first, falls back to `settings.json`, `saveSettings` writes `chat.json` (keeps `settings.json` untouched). Existing `config-ipc.test.ts` and settings e2e must be updated. Defaults differ: Rust reads `show_thinking` default `false` when absent; Electron defaults both `true`. Keep Electron's current defaults (a Phase 2 decision) unless a test says otherwise; flag in Open Questions.

## Environment Availability

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| omp | live (not used in tests) | yes `/Users/ike/.local/bin/omp` | tests use fake-omp via `EVAOS_OMP_BIN` |
| bun | claude bridge | yes `/Users/ike/.bun/bin/bun` | |
| claude | claude bridge | yes `/Users/ike/.local/bin/claude` | never run live in tests |
| Node 24 / pnpm | build | yes (project) | |
| slopcheck | package audit | not installed | dnd-kit user-locked |
Missing blocking: none.

## Validation Architecture
`workflow.nyquist_validation` is `false` in `.planning/config.json`, so the formal section is skipped. Practical test plan for the planner: Vitest node project for `packages/chat-core` pure ports (copy Rust test cases for categories, workspace_of, pins, delete in tmp, dialogs, jobs, subagents, tagged); Vitest `apps/desktop` for `SessionManager` writer rules, list service with temp dirs, renderer components with Testing Library (menus, search, cards, hotkeys); Playwright (`apps/desktop/e2e`, workers 1) specs with screenshots into `proof/phase-4/`: chat-list, categories-dnd, ops (on tmp copy), composer, question, writers, settings-harness, images. Quick run: `pnpm --filter @evaos/chat-core test`, `pnpm --filter @evaos/desktop vitest run <file>`. Full: `pnpm -r test && pnpm --filter @evaos/desktop e2e`.

### Wave 0 gaps
- Extend `fixtures/fake-omp/fake-omp.mjs`: start without `--resume` (new session file in a given dir, reports `sessionFile` in `get_state`), `--mode rpc` for rename/models (`set_session_name` rewrites title; `get_available_models` returns a small catalog with contextWindow and image flags), `set_model/set_thinking_level/set_fast_mode`, `extension_ui_request` scenarios (select, confirm, input, editor, ask incl. multi) selectable by env or by prompt keyword, usage with contextWindow, `--approval-mode/--profile/--model` echoed to the log, and `extension_ui_response` recorded to `FAKE_OMP_LOG` so e2e asserts the answer frame.
- Fixture sessions: several workspace titles (ecard, relay, evaos, other), a pinned id, subagent folder with `.md` done marker, bg job records (running and ended), an image prompt with inline base64 and a blob ref, a file freshly touched by the test (running-recent), a held-open append test.
- A tmp-copy helper in `e2e/helpers` for destructive specs; `EVAOS_AGENT_DIR` env plumbing.
- `e2e/fixtures.ts` `buildLaunchEnv` extension for agent dir and fake claude bridge.

## Security Domain

| ASVS | Applies | Control |
|------|---------|---------|
| V5 Input validation | yes | Zod on every new IPC (paths must resolve inside sessions dir via `resolveInsideSessionsDir`; names trimmed/length-capped; image size/mime cap; dialog id must match pending) |
| V4 Access control | yes | `senderFrame` URL validation already in `handle`; delete only inside sessions dir; refuse delete/rename on owned or running files |
| V12 Files | yes | pins/archive keys are session ids from filenames; image reads limited to agent blobs dir by hash regex `^[a-f0-9]{64}$` |
Threats: path traversal via `file` args (use existing resolver), command injection in rename spawn (argv array, never shell), untrusted omp output in cards (render as text, no HTML), oversized base64 images over IPC (cap 20 MB), deleting live data (e2e on tmp copies; write trap allows only agentDir/config/tmp/repo).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | env var name `EVAOS_AGENT_DIR` for pins/blobs | Behavior Spec | low, internal naming |
| A2 | chokidar `usePolling` at 250 ms meets 500 ms for held-open files | Pitfall 1 | list misses the budget; fallback is own `fs.stat` poll like Rust |
| A3 | `set_model` command field names (`provider`, `modelId`) | Launch args | model switch fails; read Rust sender in chat.rs ~2400 first |
| A4 | blob store file naming under `~/.omp/agent/blobs` | Images | blob images do not render; inspect read-only |
| A5 | `EVAOS_CLAUDE_BRIDGE_CMD` override name | Pitfall 11 | none, internal |
| A6 | `@dnd-kit/*` works under React 19.3 (peer range allows it) | Stack | switch to pointer events or pin; prove in first list task |
| A7 | Display casing of status strings (Rust lowercase vs UI-SPEC) | Status wording | copy mismatch only |

## Open Questions

1. **Status wording: README vs UI-SPEC.** Rust: `open / working / needs approval / has a question / job`; UI-SPEC: `Working / Needs approval / Question / Job running`. Recommendation: use Rust words sentence-cased (`Open`, `Working`, `Needs approval`, `Has a question`, `Job`) from one constants module; UI-SPEC itself says to confirm against README.
2. **Claude Code transcripts list/render.** Required for full parity, large (port `claude_session`). Recommendation: implement harness switch + bridge transport + new chats as required; port transcript parser only if time allows, else record under Deferred gaps.
3. **Defaults for show_thinking/show_tools** (Rust false, Electron true). Keep Electron's.
4. **Single `PANE_ID`.** Writer registry multi-pane behavior is verified through unit tests and a test hook this phase; UI for multiple panes is Phase 6.
5. **Rename dialog vs inline.** Rust opens a dialog; UI-SPEC specifies inline rename. Follow UI-SPEC.
6. **Archived (n) bottom toggle** exists in README, not in UI-SPEC. Recommendation: include.

## Sources

### Primary (HIGH)
- `/Users/ike/Eva/apps/evaos/src/chat_groups.rs`, `chat_ops.rs`, `watch.rs`, `chat.rs` (workspace_of, Launch, Dialog, background_jobs, subagents, tagged, binary), `chat_view.rs` (prefs, rename, pins, list rendering, status), README.md chat sections (lines ~246-310, 372-395, 750-830) read this session.
- Repo: `packages/chat-core/src/*`, `packages/contract/src/chat.ts`, `apps/desktop/src/main/chat/*`, `settings-ipc.ts`, `config-store.ts`, `write-guard.ts`, `eva/watch.ts`, `renderer/chat/*`, `renderer/overlay/EvaMenu.tsx`, `fixtures/fake-omp/fake-omp.mjs`, `/Users/ike/Eva/.claude/bridge/README.md`.
- npm registry (`npm view`, 2026-10-15): @dnd-kit/core 6.3.1, @dnd-kit/sortable 10.0.0, @dnd-kit/utilities 3.2.2, peer ranges.

### Tertiary (LOW)
- chokidar polling behavior on held-open files, dnd-kit under React 19: training knowledge, prove in tests.

## Metadata
**Confidence:** Stack HIGH (one new dependency pair, user-locked); Architecture HIGH (extends verified existing code); Pitfalls MEDIUM-HIGH (watch latency and dnd-kit tree semantics need proof early).
**Research date:** 2026-10-15; valid 30 days.

## Project Constraints (from CLAUDE.md)
- Unattended: never wait for input; test `human_needed` items with Playwright for Electron, screenshots in `proof/phase-4/`, record `agent-verified` or `still-needs-isaac` in VERIFICATION.md; defer gaps under `## Deferred gaps`.
- App must build and launch; run tests before marking complete.
- Read-only: `/Users/ike/Eva/apps/evaos`, `/Users/ike/Eva/work/relay`, everything outside this repo except the exact Eva data writes current EvaOS performs (pins file, session delete, `chat.json` in config dir).
- No global config changes, no remote, no push; commit per plan on `main`.
- Every launch sets `EVAOS_E2E=1` (accessory app, `showInactive`); never `open`, `pnpm dev`, `pnpm dev:live`, `win.focus()`, OS-level mouse/keyboard events.
- No em dashes in UI strings. Mantine overlays only through wrappers. Zod IPC with `{ok,value|error}`; writes through write queue.
- Browser Bitwarden/Arc decisions are Phase 5/browser scope, not this phase.

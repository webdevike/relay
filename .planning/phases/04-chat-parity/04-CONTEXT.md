# Phase 4: Chat Parity - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning
**Mode:** Smart discuss, all recommended answers accepted (unattended run)

<domain>
## Phase Boundary

Users manage and use all their omp chats: list with groups and categories, composer, question cards, subagent chips, background jobs strip, shared-writer prompts, Claude Code harness choice, and a recorded transport decision. Covers CHTP-01..14. Rich reply rendering (markdown polish, mermaid, ui widgets) is Phase 5; side panel, Eregon and search are Phase 6.
</domain>

<decisions>
## Implementation Decisions

### Chat list
- Behavior is a port of the read-only Rust app (`/Users/ike/Eva/apps/evaos/src`: `chat_groups.rs`, `chat_ops.rs`, `chat.rs`, `watch.rs`, README) into Electron-free logic in `packages/chat-core`, unit-tested with fixtures. Never write under `/Users/ike/Eva/apps/evaos`.
- Grouping, pinned section, running first, five newest plus Show N more, status rows, search that opens all groups including archived, and categories persisted in `chat.json` with its existing file shape. Writes go through the existing write layer, never directly.
- Drag and drop with `@dnd-kit/core` + `@dnd-kit/sortable`; right-click menu through the existing `EvaMenu` wrapper (Rename, Pin/Unpin, Archive/Unarchive, Delete, Move to).
- Session-file changes watched in main with chokidar on `~/.omp/agent/sessions` (narrow path), debounced so the list updates within 500 ms without window focus.
- Rename reaches the running omp via RPC when the session is owned by this app, otherwise a short resume as the README describes.

### Composer and settings
- Two-line composer with toolbar: model picker, access mode, context ring, omp account selector (unsent chats only), image paste and drop. Extends the existing `Composer.tsx`.
- Settings > Chat switches `show_thinking` and `show_tools` persist through the existing config store and apply live to the chat view. Harness selector (omp or Claude Code) lives in the same section.
- Inline images in prompts and tool results render in the chat with a viewer modal through the existing overlay wrappers.

### Questions, subagents, writers
- Question cards render every blocked `ask` with single-choice answers, keys `1`-`4` while the composer is not focused; extension UI requests (select, confirm, input, editor) answered through the RPC UI response frames.
- Subagent chips (running and finished) with Clear done; background jobs strip while the omp process runs.
- Shared writer registry in main tracks which pane owns which session; sending into a session owned elsewhere prompts for confirmation first.
- Every prompt carries the `<surface><machine> - EvaOS</surface>` tag via the existing tagged helper.

### Transport ADR
- Decision: new chats start through a direct omp child (`omp --mode rpc-ui`) owned by `SessionManager`, behind the existing transport interface. Herdr plus Relay is rejected for this phase (Relay is read-only and out of repo). The Claude Code harness is a second transport implementation behind the same interface. Record the ADR in PROJECT.md Key Decisions and a short `docs/adr` note.
- Tests use `EVAOS_OMP_BIN` fake omp and fixture sessions; never attach to Isaac's live sessions.

### Proof and verification
- Playwright for Electron specs with `EVAOS_E2E=1` (no focus stealing), screenshots under `proof/phase-4/`; Vitest for logic; app must build and launch.

### Claude's Discretion
Component structure, store shapes, icons, exact keyboard affordances, fixture contents, and plan slicing. No em dashes in UI strings.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/chat-core` (session, reducer, batcher, frames, transport, tagged, sessions-dir), `packages/contract/src/chat.ts`.
- Renderer `chat/` (ChatPane, ChatLog, Composer, SessionList, chat-store, stream-drain), `settings/ChatSection.tsx`, `sidebar/` sub pages, overlay wrappers, `useOccludeBrowser`.

### Established Patterns
- Typed Zod IPC contract, `{ok,value|error}` results, zustand stores, Mantine overlays only through wrappers, EvaFs-style write queue.

### Integration Points
- Sidebar Chats sub page, tab `place` model, hotkey router, Settings page Chat section, main `SessionManager`.
</code_context>

<specifics>
## Specific Ideas

Match the README and Rust app behavior for status row wording and menu order.
</specifics>

<deferred>
## Deferred Ideas

Relay-observed sessions and Eregon sharing the view (Phase 6 and 7).
</deferred>

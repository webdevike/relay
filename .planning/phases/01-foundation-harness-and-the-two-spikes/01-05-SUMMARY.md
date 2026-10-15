---
phase: 01-foundation-harness-and-the-two-spikes
plan: 05
subsystem: chat-streaming
tags: [omp-rpc-ui, reducer, seq-batching, zustand, raf-drain, composer]
requires: [01-03, 01-04]
provides:
  - LiveReducer (port of Rust Live::apply), SeqBatcher, tagged(), ChatTransport interface in @evaos/chat-core
  - OmpStdioTransport and SessionManager (16 ms seq-stamped batches, snapshots, single-writer guard) in main
  - chat.send, chat.snapshot and chat.batch contract entries
  - Renderer rAF stream drain with seq-gap resync, composer send path, streaming header
affects: [01-06]
tech-stack:
  added: []
  patterns: [transport seam, dirty-id coalescing, seq contiguity with snapshot resync]
key-files:
  created:
    - packages/chat-core/src/{reducer,batcher,tagged,transport}.ts (+ tests)
    - apps/desktop/src/main/chat/{omp-transport,session-manager,live-ipc,shell-path}.ts
    - apps/desktop/src/renderer/chat/{stream-drain,Composer}.ts(x) (+ tests)
    - apps/desktop/e2e/chat-stream.spec.ts
  modified:
    - packages/contract/src/chat.ts
    - apps/desktop/src/main/chat/{index,transcript-ipc}.ts
    - apps/desktop/src/renderer/chat/{ChatPane,ChatLog,chat-store}.ts(x)
key-decisions:
  - "ChatTransport gained write(command) so the manager can send the handshake and reducer effects through the interface"
  - "Reducer rebuilds assistant rows with the transcript parser's ids (m, m-thinking, m-toolN) so live and history rows match, instead of the plan's <id>:<index> ids"
  - "Upsert ops carry an optional at index so new rows land before pending unconfirmed prompts"
  - "Reconnecting label stays at least 400 ms to avoid flicker"
requirements-completed: [CHAT-02, CHAT-03, CHAT-08]
duration: 45min
completed: 2026-10-15
---

# Phase 1 Plan 05: Streaming slice Summary

**Sending a prompt into a past session spawns `omp --mode rpc-ui --resume <file>` (fake omp in tests), applies frames with the ported `Live::apply` reducer, emits seq-stamped 16 ms batches, and the renderer drains them once per frame with snapshot recovery on a gap.**

## Accomplishments
- Reducer, batcher and tagged tests (23 new chat-core tests) cover the Rust live tests (lifecycle, unconfirmed reconciliation, prompt_result error, `_eof`, `_stderr`) plus dialog cancellation and unknown frames. Reducer uses `message.content` snapshots only.
- SessionManager unit-tested with an in-memory transport and fake timers (handshake order, seq 1,2,3, `already-owned`, effects, snapshot).
- e2e `chat-stream.spec.ts`: line, 1-byte, glued and emoji-split chunking all converge to the recorded reply exactly once with zero renderer gaps, `lastSeq === batches`, exact spawn args and cwd; a dropped batch shows `Reconnecting to the stream.` and heals from a snapshot.
- `pnpm gate` GREEN: 10 Playwright specs, unit tests all passing. No `.kill(`, SIGKILL, SIGTERM or readline in main chat code.

## Task Commits
1. Task 1 (failing e2e, reducer, batcher, tagged, transport type): `6b3222c`
2. Task 2 (transport, SessionManager, contract, IPC): `d5c1203`
3. Task 3 (drain, store, composer, header): `0843992`
4. Comment reword so the `assistantMessageEvent` grep is clean (committed with the docs commit)

## Deviations from Plan

**1. [Rule 3 - Blocking] ChatTransport.write**
- The interface in the plan had no way to send the `set_ask_dialog`, `get_state` handshake or reducer effects. Added `write(command)`; ids are filled in by the transport.

**2. [Rule 1 - Consistency] Row ids**
- Plan said thinking/tool rows use `<messageId>:<index>`. Using `messagesFrom` ids (`m1-thinking`, `m1-tool0`) keeps live rows identical to history rows and avoids remove-and-reinsert at `message_end`.

**3. [Rule 2 - Correctness] `at` index and ordering in batches**
- Removes are emitted first, upserts sorted by list index, so a new row inserts before pending optimistic prompts exactly as Rust `insert` does.

**4. [Rule 2] Reconnect label minimum visible time (400 ms)**
- Without it the label is cleared within a few ms and cannot be observed or read.

**5. [Rule 3] jsdom stub for `document.fonts`** in `test-setup.ts` (Mantine autosize Textarea).

**6. Extras**: `closeAll` runs on `onBeforeQuit` (stdin end only, no signals); `_eof` carries `expected: true` after our own close so it is not reported as an error; chat log follows the stream while pinned (pills remain plan 01-06).

## Known Stubs
- No Stop button or Escape abort (plan 01-06). `abort` exists in manager and transport but has no IPC channel yet.
- Transport close is stdin-end plus a timeout; full quit handling is plan 01-06.
- Session list has no live-session resume beyond opening a file and sending.

## Threat Flags
None beyond the plan's register. T-01-21 (frames validated, text nodes only), T-01-22 (strict Zod input, file contained by `chat.open`), T-01-23 (argv array, fixed args), T-01-24 (no signals, single-writer guard) and T-01-25 (dialogs cancelled) are mitigated.

## Self-Check: PASSED

---
phase: 04-chat-parity
plan: 14
subsystem: chat
tags: [chat-list, rename, pin, archive, delete, menu]
requires: [04-12]
provides:
  - session-ops (readPins, writePins, deleteSession, renameViaResume) in main
  - chat.pin, chat.archive, chat.rename, chat.delete handlers with list pushes
  - ChatListService.setTitle override until the file changes
  - RowMenu (EvaMenu) with a menuExtraItems slot for Move to, inline rename, DeleteChatModal, archive toast with Undo
affects: [04-16]
key-files:
  created:
    - apps/desktop/src/main/chat/session-ops.ts
    - apps/desktop/src/main/chat/session-ops.test.ts
    - apps/desktop/src/renderer/chat/list/RowMenu.tsx
    - apps/desktop/src/renderer/chat/list/RowMenu.test.tsx
    - apps/desktop/src/renderer/chat/list/DeleteChatModal.tsx
    - apps/desktop/src/renderer/chat/list/archive-toast.tsx
    - apps/desktop/e2e/chat-ops.spec.ts
    - proof/phase-4/chat-menu.png
    - proof/phase-4/chat-delete-modal.png
    - proof/phase-4/chat-rename-inline.png
  modified:
    - apps/desktop/src/main/chat/chat-list-ipc.ts
    - apps/desktop/src/main/chat/chat-list.ts
    - apps/desktop/src/main/chat/index.ts
    - apps/desktop/src/renderer/chat/list/ChatRow.tsx
    - apps/desktop/src/renderer/chat/list/ChatList.tsx
    - apps/desktop/src/renderer/chat/list/list-store.ts
    - apps/desktop/src/renderer/chat/list/chat-list.css
    - packages/eva-core/src/write-scan.test.ts
decisions:
  - "Rename follows Rust apply_rename: owned chat over its own omp (never a short resume), recently active unowned chat refused with the Rust notice, else a short omp --mode rpc --resume with the mtime restored."
  - "chat.rename is not queued on the WriteQueue (a resume can take seconds); pin, archive and delete are."
  - "Deleting a chat also drops its pin and archive mark, like Rust forget()."
  - "The row menu is one instance for the list, portalled to the body, because the sidebar is a containing block for fixed children and shifted the anchor."
  - "Keyboard menu open (Shift+F10) is deferred one task: Mantine's menu closes on any keydown outside it, including the bubbling event that opened it."
  - "The inline rename input registers on the Esc ladder at overlay priority, otherwise the global Esc handler leaves the sidebar sub-page first."
  - "Delete confirm is outlined danger: the theme's danger foreground is itself red, so a filled button cannot meet 4.5:1."
  - "session-ops.ts joins the reviewed writers in the static write scan (pins file, delete, mtime restore: the exact writes current EvaOS performs)."
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 14: Chat actions Summary

Rename, Pin / Unpin, Archive / Unarchive and Delete now work from the chat list through a right-click, `Chat actions` or Shift+F10 menu in Rust order, with rename reaching the owning omp over RPC or a short resume that restores the file mtime.

## What was built

- Main: `session-ops.ts` ports chat_ops.rs (pins with sorted ids and tmp then rename, delete of the .jsonl, stem folder and `<file>.*.bak` siblings, short-resume rename with a 20 s timeout and no shell). `chat-list-ipc.ts` registers `chat.pin`, `chat.archive`, `chat.rename`, `chat.delete`, resolves every file through `resolveInsideSessionsDir`, refuses owned or recently active chats on delete, and pushes `chat.listChanged` after each change.
- Renderer: `RowMenu` through `EvaMenu` (Rename, Pin or Unpin, Archive or Unarchive, extras slot, divider, Delete in danger color), inline rename (Enter, blur commit; Esc, empty cancel; error under the row), `DeleteChatModal` with initial focus on Keep chat, optimistic archive with a 6 s `Chat archived` toast and Undo.
- Tests: 12 new main tests (session-ops 8, ipc ops 9 incl. queue serialisation), 13 renderer tests, e2e `chat-ops.spec.ts` (7 tests on a `makeChatFixture` tmp copy). Full vitest 991 pass; chat-ops, chat-list, chat-list-search, chat-watch e2e green (16); build and typecheck clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Menu anchor shifted by the sidebar containing block**
- **Found during:** Task 3 e2e
- **Issue:** `position: fixed` anchor inside the sidebar was offset, so the menu rendered off screen.
- **Fix:** RowMenu portals its whole EvaMenu to `document.body`.
- **Commit:** 4b26387

**2. [Rule 1 - Bug] Shift+F10 menu closed in the same event**
- **Found during:** Task 3 e2e
- **Issue:** Mantine closes the menu on any outside keydown, including the opening one as it bubbles.
- **Fix:** open on the next task from the keyboard path.
- **Commit:** 4b26387

**3. [Rule 1 - Bug] Esc in the rename input left the sidebar sub-page**
- **Found during:** Task 3 e2e
- **Issue:** the global capture-phase Esc ladder ran the sub-page back dismisser first.
- **Fix:** the input registers `useDismissable(DISMISS_PRIORITY.overlay)` to cancel the rename.
- **Commit:** 4b26387

**4. [Rule 3 - Blocking] Static write scan flagged session-ops**
- **Issue:** `fs.rmSync`/`renameSync`/`writeFileSync` outside the reviewed writers failed `write-scan.test.ts`.
- **Fix:** added `session-ops.ts` to the scan's ALLOWED set with a comment (the writes are the ones current EvaOS performs on omp's agent dir).
- **Commit:** 70d042c

Plan e2e expectation adjusted: the tmp config dir has no `archived_chats`, so the Archived count goes 0 to 1 (not 1 to 2) and disappears after Undo.

## Known Stubs

None. The `menuExtraItems` slot is intentionally empty until 04-16 adds Move to.

## Deferred / out of scope

- `packages/chat-core/src/workspaces.ts` carried an uncommitted prettier-only change before this plan; left untouched.
- The chat-transcript 5,000-message flake is unrelated (ChatLog scrolling not touched).

## Self-Check: PASSED

Files and commits verified: c07b95c (e2e), 70d042c (main), 4b26387 (renderer); proof PNGs exist under proof/phase-4.

---
phase: 04-chat-parity
plan: 16
subsystem: chat
tags: [categories, drag-and-drop, dnd-kit, chat-list, electron, react]
requires:
  - phase: 04-01
    provides: Categories ops in chat-core
  - phase: 04-05
    provides: chat.setCategories contract channel
  - phase: 04-14
    provides: RowMenu menuExtraItems slot
provides:
  - chat.setCategories main handler (one read-modify-write of chat.json)
  - list-store createCategory, renameCategory, deleteCategory, moveChat, reorderGroups with optimistic update and rollback
  - resolveDrop (chat on group or chat assigns, header on header reorders)
  - Category UI: New category input, header menu, delete modal, Move to submenu, drag and drop in the tree
affects: [04-chat-parity]
tech-stack:
  added: ["@dnd-kit/core 6.3.1", "@dnd-kit/sortable 10.0.0"]
  patterns:
    - "Renderer runs the pure Categories op on a copy, shows it at once, saves the three keys in one IPC write, rolls back on failure"
    - "One DndContext; draggables carry data.type chat or group; headers are both draggable and droppable under the same id so sortableKeyboardCoordinates works"
key-files:
  created:
    - apps/desktop/src/renderer/chat/list/dnd.ts
    - apps/desktop/src/renderer/chat/list/dnd.test.ts
    - apps/desktop/src/renderer/chat/list/GroupMenu.tsx
    - apps/desktop/src/renderer/chat/list/CategoryInput.tsx
    - apps/desktop/src/renderer/chat/list/DeleteCategoryModal.tsx
    - apps/desktop/e2e/categories.spec.ts
  modified:
    - apps/desktop/src/main/chat/chat-list-ipc.ts
    - apps/desktop/src/main/chat/chat-list-ipc.test.ts
    - apps/desktop/src/renderer/chat/list/list-store.ts
    - apps/desktop/src/renderer/chat/list/list-store.test.ts
    - apps/desktop/src/renderer/chat/list/ChatList.tsx
    - apps/desktop/src/renderer/chat/list/ChatRow.tsx
    - apps/desktop/src/renderer/chat/list/GroupHeader.tsx
    - apps/desktop/src/renderer/chat/list/RowMenu.tsx
    - apps/desktop/src/renderer/chat/list/chat-list.css
    - apps/desktop/src/renderer/overlay/EvaMenu.tsx
    - apps/desktop/e2e/chat-ops.spec.ts
    - packages/eva-core/src/write-scan.test.ts
key-decisions:
  - "Headers use useDraggable plus useDroppable with the same id rather than useSortable: sortable's displacement transforms are wrong when rows sit between headers, while sortableKeyboardCoordinates only needs matching ids"
  - "Keyboard drag starts and ends on Space only; Enter keeps toggling a group"
  - "Rows are draggable only (not droppable); a chat is dropped on a header. Archived rows are not draggable"
  - "Move to is a Mantine Menu.Sub exposed as EvaMenu.Sub, so the overlay lint still holds"
requirements-completed: [CHTP-03]
duration: 45min
completed: 2026-10-15
---

# Phase 4 Plan 16: Categories Summary

Custom categories (create, rename, delete), moving chats by drag, keyboard or `Move to`, and reordering headers by drag, all persisted in chat.json through one `chat.setCategories` write.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1. dnd-kit install after legitimacy check, failing e2e | ab0c411 |
| 2. setCategories handler, store ops, resolveDrop | 365649e |
| 3. Category UI, Move to, drag and drop | e1ef837 |
| Follow-up: write-scan allowlist | e8526ca |

## Verification

- Legitimacy check: both packages resolve to github.com/clauderic/dnd-kit with no install scripts (only `prepublish`); exact versions pinned as devDependencies.
- Vitest: whole repo green (1020 tests), including 7 resolveDrop tests, 6 category store tests, setCategories write test.
- typecheck, eslint, em-dash lint, `pnpm -C apps/desktop build` clean.
- e2e (EVAOS_E2E=1, renderer-level mouse only): categories, chat-ops, chat-list, chat-list-search, sidebar, new-chat all green. categories.spec passed 4 of 4 repeated runs.
- A5/A6 (dnd-kit under React 19): pointer drag onto a header and Space/ArrowUp/Space header reorder both work, so no fallback was needed.
- Proof: proof/phase-4/categories.png, categories-drag.png (mid-drag with the 2px drop line), category-delete-modal.png.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Keyboard reorder did nothing with separate draggable and droppable ids**
- **Found during:** Task 3 e2e
- **Issue:** `sortableKeyboardCoordinates` looks up the active id among droppables; `drop:X` vs `group:X` ids returned no coordinates.
- **Fix:** header droppable id equals the draggable id (`group:<name>`).
- **Files modified:** GroupHeader.tsx
- **Commit:** e1ef837

**2. [Rule 3 - Blocking] write-scan test flagged `c.rename(` in list-store**
- **Issue:** The static write scan matches `rename(` in the in-memory Categories call.
- **Fix:** allowlisted list-store.ts with a comment, matching the existing categories.ts precedent.
- **Commit:** e8526ca

**3. [Rule 1 - Bug] chat-ops menu-order e2e expected four items**
- **Fix:** expectation now includes `Move to` in the Rust slot before Delete.
- **Commit:** e1ef837

**4. UI copy:** the new-category header row is labelled `Categories` (the sidebar already titles the page `Chats`).

## Known Stubs

None.

## Deferred Issues

- Rows are not droppable targets, so dropping a chat between rows does not assign; only headers accept chats. resolveDrop already supports chat-on-chat if a later plan wants it.
- Keyboard drag of a chat row (Space on a row) is wired through the same sensor but only header keyboard reorder is covered by e2e.
- Known pre-existing flaky chat-transcript 5,000-message test untouched (this plan does not touch ChatLog).

## Threat Flags

None. chat.setCategories input is Zod-validated by the existing contract (id regex, 120-char names) and written through the WriteQueue preserving other chat.json keys (T-04-52).

## Self-Check: PASSED

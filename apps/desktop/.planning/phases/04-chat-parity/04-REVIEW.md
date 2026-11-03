---
phase: 04-chat-parity
reviewed: 2026-10-15T00:00:00Z
depth: standard
files_reviewed: 81
files_reviewed_list:
  - apps/desktop/src/main/chat/chat-list-ipc.ts
  - apps/desktop/src/main/chat/chat-list.ts
  - apps/desktop/src/main/chat/chat-watch.ts
  - apps/desktop/src/main/chat/claude-transport.ts
  - apps/desktop/src/main/chat/extras.ts
  - apps/desktop/src/main/chat/index.ts
  - apps/desktop/src/main/chat/live-ipc.ts
  - apps/desktop/src/main/chat/media.ts
  - apps/desktop/src/main/chat/models.ts
  - apps/desktop/src/main/chat/omp-transport.ts
  - apps/desktop/src/main/chat/session-manager.ts
  - apps/desktop/src/main/chat/session-ops.ts
  - apps/desktop/src/main/chat/transcript-ipc.ts
  - apps/desktop/src/main/chat/transport-factory.ts
  - apps/desktop/src/main/env.ts
  - apps/desktop/src/main/index.ts
  - apps/desktop/src/main/settings-ipc.ts
  - apps/desktop/src/renderer/chat/ChatImage.tsx
  - apps/desktop/src/renderer/chat/ChatLog.tsx
  - apps/desktop/src/renderer/chat/ChatPane.tsx
  - apps/desktop/src/renderer/chat/Composer.tsx
  - apps/desktop/src/renderer/chat/ImageViewer.tsx
  - apps/desktop/src/renderer/chat/MessageRow.tsx
  - apps/desktop/src/renderer/chat/SessionList.tsx
  - apps/desktop/src/renderer/chat/WriterPrompt.tsx
  - apps/desktop/src/renderer/chat/cards/ExtensionUiCard.tsx
  - apps/desktop/src/renderer/chat/cards/PendingDialog.tsx
  - apps/desktop/src/renderer/chat/cards/QuestionCard.tsx
  - apps/desktop/src/renderer/chat/cards/cards.css
  - apps/desktop/src/renderer/chat/cards/useQuestionHotkeys.ts
  - apps/desktop/src/renderer/chat/chat-store.ts
  - apps/desktop/src/renderer/chat/chat.css
  - apps/desktop/src/renderer/chat/composer/AccessPicker.tsx
  - apps/desktop/src/renderer/chat/composer/AccountPicker.tsx
  - apps/desktop/src/renderer/chat/composer/ContextRing.tsx
  - apps/desktop/src/renderer/chat/composer/ImageChips.tsx
  - apps/desktop/src/renderer/chat/composer/ModelPicker.tsx
  - apps/desktop/src/renderer/chat/composer/Toolbar.tsx
  - apps/desktop/src/renderer/chat/composer/composer.css
  - apps/desktop/src/renderer/chat/composer/image-input.ts
  - apps/desktop/src/renderer/chat/composer/useLaunchState.ts
  - apps/desktop/src/renderer/chat/images.css
  - apps/desktop/src/renderer/chat/list/CategoryInput.tsx
  - apps/desktop/src/renderer/chat/list/ChatList.tsx
  - apps/desktop/src/renderer/chat/list/ChatRow.tsx
  - apps/desktop/src/renderer/chat/list/DeleteCategoryModal.tsx
  - apps/desktop/src/renderer/chat/list/DeleteChatModal.tsx
  - apps/desktop/src/renderer/chat/list/GroupHeader.tsx
  - apps/desktop/src/renderer/chat/list/GroupMenu.tsx
  - apps/desktop/src/renderer/chat/list/RowMenu.tsx
  - apps/desktop/src/renderer/chat/list/archive-toast.tsx
  - apps/desktop/src/renderer/chat/list/chat-list.css
  - apps/desktop/src/renderer/chat/list/dnd.ts
  - apps/desktop/src/renderer/chat/list/list-store.ts
  - apps/desktop/src/renderer/chat/open-chat.ts
  - apps/desktop/src/renderer/chat/strips/JobsStrip.tsx
  - apps/desktop/src/renderer/chat/strips/SubagentChips.tsx
  - apps/desktop/src/renderer/chat/strips/strips.css
  - apps/desktop/src/renderer/hotkeys/router.ts
  - apps/desktop/src/renderer/overlay/EvaMenu.tsx
  - apps/desktop/src/renderer/settings/ChatSection.tsx
  - apps/desktop/src/renderer/settings/settings-store.ts
  - apps/desktop/src/renderer/sidebar/SubPages.tsx
  - apps/desktop/src/renderer/tabs/tabs-store.ts
  - packages/chat-core/src/batcher.ts
  - packages/chat-core/src/categories.ts
  - packages/chat-core/src/chat-groups.ts
  - packages/chat-core/src/dialogs.ts
  - packages/chat-core/src/image-size.ts
  - packages/chat-core/src/jobs.ts
  - packages/chat-core/src/launch.ts
  - packages/chat-core/src/message.ts
  - packages/chat-core/src/reducer.ts
  - packages/chat-core/src/session-id.ts
  - packages/chat-core/src/session.ts
  - packages/chat-core/src/status.ts
  - packages/chat-core/src/transport.ts
  - packages/chat-core/src/workspaces.ts
  - packages/contract/src/chat.ts
  - packages/contract/src/index.ts
  - packages/contract/src/shell.ts
findings:
  critical: 0
  warning: 9
  info: 4
  total: 13
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-10-15
**Depth:** standard
**Files Reviewed:** 81
**Status:** issues_found

## Summary

The main-process chat code is carefully built. Single-writer ownership, close-before-restart sequencing, seq-stamped batching and blob path confinement all hold up when traced. `media.ts` is confined by realpath plus a prefix check. IPC inputs are Zod-validated and sender-checked. I found no exploitable injection or traversal. The weaknesses are defense-in-depth gaps in the session path guard, a few state and UI logic bugs in the reducer and renderer, and some contract-schema fragility. No BLOCKER-level defects.

Some files (CSS, small menu and modal components, `GroupHeader`, `RowMenu`, `CategoryInput`, `Toolbar`, `ContextRing`, strips, `SubPages`, `ChatSection`) were only skimmed or not opened. Findings there are not ruled out.

## Warnings

### WR-01: Session path guard accepts any file or folder inside the sessions dir

**File:** `apps/desktop/src/main/chat/transcript-ipc.ts:19-31` (used by `chat-list-ipc.ts:98,116`, `session-ops.ts:51-74`)
**Issue:** `resolveInsideSessionsDir` only checks the prefix. It does not require a `.jsonl` name, a regular file, or a direct child. Consequences:
- `chat.delete` on `<sessionsDir>/<id>/sub.jsonl` (a subagent transcript) passes. `deleteSession` then also runs `rmSync(<id>/sub, {recursive:true})` and removes the `.bak` siblings.
- `chat.delete` on a non-jsonl file passes and deletes it.
- On a directory path, `rmSync(file)` throws `EISDIR`, which is not ENOENT, so the call fails oddly.
- `chat.rename` on such paths spawns `omp --resume <any file>`.
- `chat.open` parses arbitrary files.

Only the app shell can call these, but this is a destructive path guarded by a prefix check alone.
**Fix:**
```ts
const st = fs.statSync(real)
if (!st.isFile() || !real.endsWith('.jsonl') || path.dirname(real) !== base) {
  throw new CodedError('outside-sessions-dir', 'Not a session file')
}
```
Also wrap `fs.realpathSync(sessionsDir)` so a missing dir yields a coded error instead of a raw ENOENT.

### WR-02: Reducer notice ids can collide, producing duplicate rows and keys

**File:** `packages/chat-core/src/reducer.ts:328-331`
**Issue:** The id is `notice-${this.msgs.length}`, and the list length is not monotone. Example: a `notice` frame arrives while a prompt is unconfirmed, so it is inserted before the prompt as `notice-N`. A `prompt_result` error then calls `dropUnconfirmed` (length back to N) and creates `notice-N` again. `insert` does not dedupe, so the reducer holds two rows with the same id. The renderer's `findLastIndex` upsert then overwrites the other row, and `ChatLog` renders duplicate React keys. `indexOf` (first match) and `applyOpsToPane` (last match) also disagree.
**Fix:** Use a monotonic counter (`private notices = 0; id = \`notice-${++this.notices}\``), or check `indexOf` before inserting.

### WR-03: Question and extension cards lock permanently after a failed or stale answer

**File:** `apps/desktop/src/renderer/chat/cards/QuestionCard.tsx:32-42`, `ExtensionUiCard.tsx:20-31`, `PendingDialog.tsx:18-23`
**Issue:** The `sent` ref is set on the first click and never reset. `PendingDialog.answer` handles `!r.ok` only by showing a banner. If `chat.answerUi` fails (write error) or returns `{ sent: false }` (stale id, process gone), the card is still live but every button is a no-op. `sent:false` shows nothing at all. `failed` also persists across dialog changes because it lives in `PendingDialog`, not keyed to the dialog id.
**Fix:** Make `answer` return a promise and let the cards reset `sent.current = false` on failure. Treat `r.ok && !r.value.sent` as a failure with a message. Clear `failed` in an effect keyed on `dialog.id`.

### WR-04: Launch state prefers stale session meta over the user's choice when no process runs

**File:** `apps/desktop/src/main/chat/session-manager.ts:473,481`
**Issue:** `model = meta.model ?? pane.launch.model` and `thinking = meta.thinking ?? pane.launch.thinking`. For a resumed chat with no process yet, `meta.model` comes from history, so a model or thinking level chosen in the picker is stored (and used at the next start) but `launchState` keeps returning the old one. The toolbar never shows the selection. A draft works only because its meta is null.
**Fix:** When `pane.transport === null`, prefer `pane.launch.*` over `meta.*`. With a live process, keep preferring `meta` (omp-confirmed).

### WR-05: Launch patch strings are passed to argv without validation

**File:** `packages/contract/src/chat.ts:68-75`, `packages/chat-core/src/launch.ts:27-34`
**Issue:** `thinking` is any string up to 32 characters, and `model.provider` and `modelId` are any strings. `flags()` pushes them as `--thinking <v>` and `--model <p>/<id>`. There is no shell, so there is no shell injection. A value starting with `-` can still be read by omp's argument parser as another flag. These are also persisted in `pane.launch`.
**Fix:** In `setLaunch`, validate `model` against `catalogFor(ctx).peek()` (or a `^[A-Za-z0-9._:/-]+$` regex that forbids a leading `-`). Validate `thinking` against the model's `levels`.

### WR-06: Contract schemas are stricter than the shared `chat.json` and omp pins, so list and category saves can fail

**File:** `packages/contract/src/chat.ts:43,175-183,187-191`; `apps/desktop/src/main/chat/chat-list.ts:160-179`
**Issue:** `chat_assignments` keys must match `SessionIdSchema` and values must be 120 characters or less. `chat-list.ts` copies every string pair from the Rust-shared `chat.json` without checking. One legacy or longer entry has two effects:
1. In dev (`handle.ts` parses the output when not packaged), `chat.list` throws `internal` and the whole sidebar errors.
2. The renderer round-trips the full prefs through `chat.setCategories`, so that single entry makes every category edit fail with `invalid-input`.

`chat.pin` and `chat.archive` outputs have the same exposure through `SessionIdSchema` on ids read from disk. Dev and packaged builds also behave differently, because output validation is skipped when packaged.
**Fix:** Filter entries in `prefs()` (and `readPins`) with the same predicates the schema uses. Alternatively relax the output schemas to `z.string()` and keep the strict check only on user-supplied input.

### WR-07: `openChatFile` early return can leave a stale chat on screen

**File:** `apps/desktop/src/renderer/chat/open-chat.ts:11-20`
**Issue:** The pane shows A. The user clicks B, and `chat.open(B)` is in flight. The user clicks A again, which returns early because `panes[PANE_ID].file === A`, so `latest` is not bumped. B's result then lands with `mine === latest` and replaces the pane. Main now holds B, but the tab place and sidebar selection say A.
**Fix:** Bump `latest` before the early return when the target is the already-shown file, so in-flight opens of other files are discarded. Re-open or resnapshot so main and renderer agree. Also surface a failed `chat.open` (currently `r.ok === false` does nothing).

### WR-08: Blob image cache stores failures forever and grows without bound

**File:** `apps/desktop/src/renderer/chat/ChatImage.tsx:12-40`
**Issue:**
- `loadBlob` caches `null` for any failed read, so an image whose blob is not on disk yet (omp writes it concurrently) never retries until reload.
- The cache holds every decoded data URL (up to about 27 MB each) for the life of the renderer.
- `useImageSrc` never resets `blob` state when `src` changes, so a recycled row briefly shows the previous image.

**Fix:** Delete the cache entry on failure. Cap the cache with LRU eviction. Call `setBlob(null)` at the start of the effect.

### WR-09: Composer attach computes capacity before an await and reads files it will discard

**File:** `apps/desktop/src/renderer/chat/Composer.tsx:64-84`
**Issue:** `room` is computed before `await readImageFiles`. Two overlapping attaches (paste and drop) both see the same room and can push the total past `MAX_PROMPT_IMAGES`. The send then fails contract validation (`max(8)`) with a generic error banner. `readImageFiles` also base64-encodes every file before the slice, so dropping 50 large images encodes all of them.
**Fix:** Compute `room` after the await from `imagesRef.current`, and truncate the file list to `room` before reading.

## Info

### IN-01: `setLaunch` mutates the pane's launch choices before the live commands succeed

**File:** `apps/desktop/src/main/chat/session-manager.ts:507-528`
**Issue:** `pane.launch` is updated first, then `live.write(...)` is awaited. If a write rejects, the choice stays recorded and is applied at the next restart, but the caller gets an error. The state looks half-applied.
**Fix:** Apply the writes first, or roll back the touched fields in a `catch`.

### IN-02: Test hooks are enabled by an environment variable in packaged builds

**File:** `apps/desktop/src/main/env.ts:178`, `live-ipc.ts:109-133`
**Issue:** `EVAOS_E2E=1` registers `openInPane` and `sendFromPane`, which read arbitrary files. That is acceptable for a single-user local app, but consider gating on `!app.isPackaged`.

### IN-03: Duplicate `CodedError` classes

**File:** `session-manager.ts:28`, `session-ops.ts:8`, `transcript-ipc.ts:9`
**Issue:** Three identical definitions.
**Fix:** Export one from a shared module.

### IN-04: Misplaced doc comment and duplicate import

**File:** `apps/desktop/src/renderer/chat/ChatLog.tsx:28-33`; `session-manager.ts:3-4,721`
**Issue:**
- The JSDoc describing the `ChatLog` pin behavior sits above `foldToolRuns`.
- `parseFrame` and `cmd` are imported from `@evaos/chat-core/frames` in two statements.
- `applyDialogChange` uses an inline `import('...')` type.

**Fix:** Move the comment, merge the imports, and use a top-level `import type`.

---

_Reviewed: 2026-10-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

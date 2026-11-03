---
phase: 04-chat-parity
plan: 08
subsystem: chat
tags: [images, blob-store, viewer, evamodal, virtua]
requires: [04-02, 04-03, 04-04, 04-05]
provides:
  - session parser image parts with data URL, sniffed mime and dimensions
  - chat.readImage handler confined to agentDir/blobs
  - ChatImage thumbnails and ImageViewer modal in chat rows
affects: [04-09]
tech-stack:
  patterns: [module-level promise cache per blob token, reserved thumbnail box from known dimensions]
key-files:
  created:
    - apps/desktop/src/main/chat/media.ts
    - apps/desktop/src/main/chat/media.test.ts
    - apps/desktop/src/renderer/chat/ChatImage.tsx
    - apps/desktop/src/renderer/chat/ImageViewer.tsx
    - apps/desktop/src/renderer/chat/ImageViewer.test.tsx
    - apps/desktop/src/renderer/chat/images.css
    - apps/desktop/e2e/images.spec.ts
  modified:
    - packages/chat-core/src/session.ts
    - packages/chat-core/src/session.test.ts
    - apps/desktop/src/main/chat/transcript-ipc.ts
    - apps/desktop/src/renderer/chat/MessageRow.tsx
    - apps/desktop/src/renderer/chat/MessageRow.test.tsx
decisions:
  - "Inline images get a src only when header sniffing says png, jpeg, gif or webp; the sniffed mime wins over the declared one (svg and unknown never reach an img)"
  - "Blob thumbnails use a fixed 160px square since dimensions are unknown until read; the box never resizes on load"
  - "Tool result images render under the tool header, outside the collapse, so they are visible without expanding"
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 08: Inline images and viewer Summary

Prompt and tool-result images render as thumbnails (max 240 by 240, space reserved) and open in an EvaModal viewer with arrow navigation, backed by a blob reader confined to omp's blob store.

## Tasks

| Task | Commit |
|------|--------|
| 1 Failing e2e for images and viewer | c39e32f |
| 2 Image parts with dimensions plus blob reader IPC | 6c79eb5 |
| 3 Thumbnails and viewer in rows | 5124f7d |

## Verification

- vitest full suite: 863 passed (session image cases, 6 media tests, MessageRow and ImageViewer cases, overlay lint).
- `pnpm -r typecheck` clean; eslint clean for `apps/desktop/src`; em dash lint clean; desktop build ok.
- e2e `images.spec.ts` and `chat-transcript.spec.ts` pass with `EVAOS_E2E=1`; proofs written to `proof/phase-4/images-inline.png` and `proof/phase-4/images-viewer.png` (fixture images are 8x8 so they look tiny).

## Deviations from Plan

None to the code. TDD note: Task 2 and 3 tests were written alongside the implementation and committed with it rather than as separate RED commits (Task 1 e2e was the committed RED gate).

## Deferred / out of scope

- `packages/chat-core/src/fake-omp.contract.test.ts` has 4 pre-existing `no-explicit-any` eslint errors (not touched by this plan).
- `packages/chat-core/src/workspaces.ts` has a pre-existing uncommitted prettier-only change in the working tree; left alone.
- The known `shell-proof.spec.ts` `sidebar-subpage-chats` failure was not addressed: this plan does not touch the sidebar or chat list.

## Threat model

T-04-25 (strict 64-hex token regex in contract and main, realpath inside blobs, symlink escape test), T-04-26 (stat before read, 20 MB cap), T-04-27 (only data:image png/jpeg/gif/webp rendered; svg test) all mitigated and covered by tests.

## Self-Check: PASSED

All created files exist; commits c39e32f, 6c79eb5, 5124f7d present.

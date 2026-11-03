---
phase: 04-chat-parity
plan: 09
subsystem: chat
tags: [composer, images, paste, drop, chat.send]
requires: [04-02, 04-03, 04-05]
provides:
  - two-line composer with attach button, paste and drop image chips
  - prompt images through chat.send, SessionManager and transport.send
  - echoed user row keeps attached images
affects: [04-17, 04-18]
tech-stack:
  patterns: [FileReader base64 read, object URLs revoked on remove, send and unmount]
key-files:
  created:
    - apps/desktop/e2e/composer-images.spec.ts
    - apps/desktop/src/renderer/chat/composer/image-input.ts
    - apps/desktop/src/renderer/chat/composer/image-input.test.ts
    - apps/desktop/src/renderer/chat/composer/ImageChips.tsx
    - apps/desktop/src/renderer/chat/composer/composer.css
    - proof/phase-4/composer-images.png
  modified:
    - apps/desktop/src/renderer/chat/Composer.tsx
    - apps/desktop/src/renderer/chat/Composer.test.tsx
    - apps/desktop/src/renderer/chat/chat.css
    - packages/chat-core/src/reducer.ts
    - packages/chat-core/src/reducer.test.ts
    - apps/desktop/src/main/chat/session-manager.ts
    - apps/desktop/src/main/chat/session-manager.test.ts
    - apps/desktop/src/main/chat/live-ipc.ts
decisions:
  - "chat.send omits the images key when none are attached, so existing send payloads and tests are unchanged"
  - "An image-only prompt is sent as blank, untagged text (tagged() leaves blank text alone)"
  - "When omp echoes the prompt without image data, the confirmed row keeps the images from the optimistic row"
  - "A failed send restores both text and chips; object URLs are revoked only after a successful send"
  - "Chips cap at 8 images (contract limit) with an inline notice"
metrics:
  tasks: 3
  completed: 2026-10-15
---

# Phase 4 Plan 09: Composer images Summary

Paste, drop or pick png/jpg/gif/webp images (up to 20 MB, max 8) in a two-line composer, see 48px removable chips, and send them with the prompt to omp; image-only prompts work and the echoed row keeps the images.

## Tasks

| Task | Commit |
| ---- | ------ |
| 1 failing e2e | 63fb1ef |
| 2 reducer, SessionManager, chat.send | 62faf23 |
| 3 composer UI, chips, drop zone | 056f2cc |

## Verification

- vitest full run: 121 files, 880 tests pass; typecheck, eslint, em-dash lint clean; app builds.
- e2e composer-images, chat-stream, chat-control: 12 pass (EVAOS_E2E=1, DOM events only).
- Proof: `proof/phase-4/composer-images.png` (chips and the `Only images can be attached.` notice visible).

## Deviations from Plan

None - plan executed as written. The Stop button aria-label changed from `Stop` to `Stop response` per UI-SPEC; no test depended on it.

## Notes

- The pre-existing `packages/chat-core/src/workspaces.ts` working-tree change (prettier reformat) is not part of this plan and was left uncommitted.
- The sidebar `sidebar-subpage-chats` e2e failure noted earlier was not touched (this plan does not alter the sidebar or chat list).
- Toolbar keeps a spacer between the attach button and Send for the pickers 04-18 adds.

## Known Stubs

None.

## Threat Flags

None. T-04-28 (renderer rejects over 20 MB before encoding, contract caps), T-04-29 (contract mime allow-list), T-04-30 (object URLs revoked) are mitigated; main-side imageSize mime re-check was not added (contract allow-list only).

## Self-Check: PASSED

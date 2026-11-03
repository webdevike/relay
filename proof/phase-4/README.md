# Phase 4 proof index

Captured with `EVAOS_PROOF=1 bash scripts/gate.sh` against fixtures and fakes only (fixture agent dir copy, fake omp, fake Claude bridge, fake habit gate). Every launch ran with `EVAOS_E2E=1` as a hidden accessory app. Spec files live in `apps/desktop/e2e/`.

## Screenshots

| PNG | Spec | Test | Paired assertion |
| --- | --- | --- | --- |
| categories | categories.spec.ts | category create/rename sections | Categories header with user categories and counts |
| categories-drag | categories.spec.ts | drag a chat into a category | Drop result moves the row and persists in chat.json |
| category-delete-modal | categories.spec.ts | delete a category | Confirm modal; chats return to their workspace group |
| chat-list | chat-list.spec.ts | chats are grouped with Pinned on top | Group order eCard, EvaOS, Relay, Eva, Other; 5 rows per group, 'Show 6 more' |
| chat-list-expanded | chat-list.spec.ts | chats are grouped with Pinned on top | Expanded Other shows 11 rows, 'Show fewer' |
| chat-search | chat-list-search.spec.ts | search filters the tree | Matching rows only |
| chat-collapsed | chat-list-search.spec.ts | groups collapse | Collapsed group hides its rows |
| chat-status | chat-watch.spec.ts | background jobs show Job; owned sessions show Working then Open | Row shows Working while the reply streams |
| chat-menu | chat-ops.spec.ts | row context menu | Menu items for a chat row |
| chat-rename-inline | chat-ops.spec.ts | inline rename | Title edit writes through and the row updates |
| chat-delete-modal | chat-ops.spec.ts | delete confirmation | Modal before the session file is removed |
| composer-toolbar | composer.spec.ts | toolbar | Model, access, account pickers and context ring present |
| composer-model-picker | composer.spec.ts | model picker | Catalog from get_available_models, selection sent as a live switch |
| composer-account | composer.spec.ts | account picker | Account choice applies to the next launch |
| composer-images | composer-images.spec.ts | paste, drop, remove and send images | Chips, drop overlay, non-image notice, 'Got 1 image(s)' |
| images-inline | images.spec.ts | prompt images render as thumbnails | Thumbnails at most 240 px with natural size |
| images-viewer | images.spec.ts | prompt images render as thumbnails | Viewer dialog, ArrowRight to image 2 of 2 |
| question-card | questions.spec.ts | [ask] answers with key 2 | 4 options with key chips; key 2 sends SQLite |
| question-confirm | questions.spec.ts | [confirm] focuses Decline | Decline focused; Decline sends cancelled |
| question-dead | questions.spec.ts | a question left when omp exits | Dead card, disabled options, notice |
| subagent-chips | subagents-jobs.spec.ts | subagent chips | Subagent chips on the owning chat |
| jobs-strip | subagents-jobs.spec.ts | jobs strip | Background job strip on a job chat |
| writer-prompt | writers.spec.ts | shared writer prompt | Prompt when another process writes the session |
| settings-chat | settings-chat.spec.ts | thinking switch applies live | Show thinking off, Show tool details on, harness control |
| settings-harness-missing | settings-chat.spec.ts | harness missing | 'Claude Code was not found. Install it, then try again.' |
| new-chat | new-chat.spec.ts | streams a reply, binds the new session file and tags the prompt | No --resume; surface tag once; tab points at the new file |
| new-chat-claude | new-chat.spec.ts | runs through the Claude bridge | Fake Claude bridge argv has --rpc and no --resume |
| tour-chat-question | phase4-tour.spec.ts | one session: question, image, live settings and a new chat | p4-ecard row shows 'Has a question' within 500 ms, card visible |
| tour-chat-image | phase4-tour.spec.ts | same session | Thumbnail 'Image 1 of 1' in the log, prompt-images logged by fake omp |
| tour-chat-new | phase4-tour.spec.ts | same session | New session row appears in the list within 2 s, reply streamed |
| tour-chat-compact | phase4-tour.spec.ts | same session | Chat plus browser panel at 800 by 720 |

## Gate result

`GATE GREEN`: typecheck, eslint, prettier, em-dash lint, Vitest (1053 tests), build, 184 e2e passed with 2 skipped (opt-in specs gated by environment variables), metrics check, and the packaged smoke. The packaged smoke lists the fixture chats in the Chats tree and proves a sent prompt spawns only the fake omp, resuming a file inside the fixture sessions dir.

## Latency

`chat-watch-latency.json`: a new session file shows in the chat list within the 500 ms budget (trials 119, 123, 129 ms in the final run). Question status in the tour spec appears within 500 ms.

## Transport decision

New-chat transport: see [docs/adr/0001-chat-transport.md](../../docs/adr/0001-chat-transport.md).

## still-needs-isaac

| Item | Why a human is required |
| --- | --- |
| Chat against a real omp session on live Eva data | Real omp, real model and live session files cannot be driven unattended; all proof uses the fake omp |
| A real Claude Code run through the bridge | Needs a real Claude Code sign-in and a live run; proof uses the fake bridge |
| Drag feel and smoothness of chat and category reordering | Feel and smoothness are human judgements; the specs only prove the resulting order |
| Rename against a real running omp in a terminal | Needs a real omp process owned by a terminal writing the same session file |

## Deferred

- Listing and rendering Claude Code transcripts in the chat list: orchestrator decision, stretch item. Harness choice, the bridge transport and new chats through it are delivered.
- `Show tool details` folding is a simple one-line fold per run of tool calls, not the Rust group summary with tool names.

## Deferred gaps

- `chat-transcript.spec.ts` 5,000-message test is flaky (about 50%): the log lands near the end but not on LAST-MESSAGE-MARKER. It predates Phase 4 and passed in the final gate run; it is recorded rather than fixed here and is owned by the chat virtualization work.

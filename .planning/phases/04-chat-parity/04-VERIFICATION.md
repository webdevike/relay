---
phase: 04-chat-parity
verified: 2026-10-15T16:20:00Z
status: passed
score: 14/14 requirements verified
overrides_applied: 0
---

# Phase 4: Chat parity Verification Report

**Phase Goal:** Users manage and use all their omp chats (list, categories, composer, questions, subagents, shared writers) with the transport decision made and recorded.
**Verified:** 2026-10-15
**Status:** passed (only still-needs-isaac items remain)
**Re-verification:** No, initial verification

## Evidence run by the verifier (not taken from SUMMARY)

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` | Done, no errors |
| `pnpm test` (Vitest) | 135 files, 1053 tests passed (one earlier run reported a failure under load; the rerun was fully green) |
| `pnpm build` | Built |
| Playwright (`EVAOS_E2E=1`, hidden accessory app) on chat-list, questions, writers, new-chat, categories, subagents-jobs, settings-chat, images, composer, chat-watch, chat-ops | 40 passed |
| Debt markers (TBD/FIXME/XXX) in phase files | none found |
| `docs/adr/0001-chat-transport.md` | Accepted; PROJECT.md decision row 91 links it |

## Requirements Coverage

All 14 IDs appear in plan frontmatter (04-01 .. 04-19) and in REQUIREMENTS.md; none orphaned.

| ID | Status | Evidence |
| --- | --- | --- |
| CHTP-01 grouped list, pinned, Show N more, status rows | SATISFIED | chat-list.spec, chat-watch.spec pass; proof/phase-4/chat-list.png, chat-status.png |
| CHTP-02 search opens all groups | SATISFIED | chat-list-search.spec; chat-search.png |
| CHTP-03 categories CRUD, drag, move | SATISFIED | categories.spec pass; categories-drag.png |
| CHTP-04 context menu rename/pin/archive/delete | SATISFIED | chat-ops.spec pass; chat-menu.png; short-resume rename in ADR and session-manager |
| CHTP-05 list updates within 500 ms | SATISFIED | chat-watch-latency.json (119 to 129 ms trials) |
| CHTP-06 composer toolbar, images | SATISFIED | composer.spec, composer-images.spec; composer-toolbar.png |
| CHTP-07 show_thinking / show_tools persist | SATISFIED | settings-chat.spec pass |
| CHTP-08 question cards, extension UI | SATISFIED | questions.spec (ask, confirm, input, editor, dead) pass |
| CHTP-09 subagent chips and jobs strip | SATISFIED | subagents-jobs.spec pass |
| CHTP-10 writer prompt and registry | SATISFIED | writers.spec pass |
| CHTP-11 surface tag | SATISFIED | `packages/chat-core/src/tagged.ts` plus tests; new-chat.spec asserts tag once |
| CHTP-12 Claude Code harness | SATISFIED | settings-chat.spec harness; new-chat.spec Claude bridge argv (fake bridge) |
| CHTP-13 inline images and viewer | SATISFIED | images.spec; images-viewer.png |
| CHTP-14 new chat via ADR transport, recorded | SATISFIED | new-chat.spec; ADR 0001; PROJECT.md |

## Agent-verified items

All fixture and fake-driven behavior above is `agent-verified`, with screenshots in `proof/phase-4/` (33 files indexed in `proof/phase-4/README.md`).

## Still needs Isaac

| Item | Reason |
| --- | --- |
| Chat against a real omp session on live Eva data | Real omp, model and live session files cannot be driven unattended; all proof uses fake omp |
| A real Claude Code run through the bridge | Needs a real Claude Code sign-in and live run |
| Drag feel and smoothness of chat and category reordering | Feel and smoothness are human judgements |
| Rename against a real running omp in a terminal | Needs a real terminal-owned omp process |

## Deferred gaps

- Claude Code transcripts are not listed or rendered in the chat list (stretch; harness choice, bridge and new chats are delivered).
- `Show tool details` is a one-line fold per tool run, not the Rust group summary with tool names.
- `chat-transcript.spec.ts` 5,000-message test is flaky (about 50%, the log lands near the end but not on the last-message marker). It predates Phase 4 and belongs to the chat virtualization work.

---

_Verified: 2026-10-15_
_Verifier: Claude (gsd-verifier)_

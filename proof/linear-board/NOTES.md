# Linear-style Board, ticket page and PR page (PR B): before/after proof

- Baseline: `61a5b2e6` (origin/main; app code untouched; only the spec, `e2e/helpers/fake-relay-host.ts`, `e2e/fixtures/tickets/` and `e2e/fixtures/reviews-diff/` were copied in for the run, then removed with `git checkout -- . && git clean -fd apps/desktop/e2e`)
- Head: after shots retaken on the round-5 fixes (branch `eva/board-desktop`, on `main` after #18/#19 merged)
- Spec: `apps/desktop/e2e/board-proof.spec.ts`, the same file in both phases (`PROOF_PHASE=before|after`, default after; `PROOF_DIR` overrides the root `proof/linear-board`). Assertions that only hold on the branch, and the after-only shots, run only in `after`; the Timeline shots skip on this branch (they belong to the Timeline PR).
- Mode: Relay Desktop in remote mode (paired `relay-remote.json`) against `FakeRelayHost`, plus a fixture Eva root (`makeEvaFixture`) with five ledger work items (`ENG-9001`..`ENG-9004`, `relay-demo`). The host answers `tickets.*` from `e2e/fixtures/tickets` (`tickets` and `tickets.writes` in after; a fallback test drops `tickets`), `reviews.req` from `e2e/fixtures/reviews-diff` with its PR served as the ticket's PR `example/sample#42` (`reviews.actions` in after), and each ticket's Reviews `linear` read (what the baseline's side panel shows) built from the same board tickets. Every write lands on the fake host's gate; the spec asserts the only writes are the inline comment's `prepare` + `commit` and no PR write. No GitHub, Linear, Claude or omp.
- Clock: `EVAOS_NOW=2026-11-27T18:00:00Z`, renderer clock fixed to the same instant (Playwright `clock.setFixedTime`); fixture dates relative to it
- Window: 1440 x 900, light scheme, hidden window
- Fixture seed: `e3d0769489efb9a0a4e5b141a73bee43c5c96feaf243aff142dc6c7e58a20295` = sha256 of these files concatenated in sorted path order, followed by the EVAOS_NOW string: `apps/desktop/e2e/fixtures/reviews-diff/answers.json`, `.../reviews-diff/media/1f66ef59700c79fa583239afc1e04d4affdeef1e.png`, `apps/desktop/e2e/fixtures/tickets/{ENG-9001,ENG-9101,board}.json`. The ledger items, the two extra board tickets (Done, In Review), the PR's ref/title/head/checks and the Linear reads are derived in the spec from these files and NOW.
- Fixtures are synthetic (sample tickets, people `Sample Teammate`/`Test Owner`, `example/sample`, `*.example.test` URLs, generated images). No private data.

Run (after): `cd apps/desktop && pnpm build && PROOF_PHASE=after pnpm e2e:run e2e/board-proof.spec.ts --project=parallel --retries 0 --max-failures 1`
Run (before): the same in a `61a5b2e6` worktree with the four paths above copied in and `PROOF_PHASE=before PROOF_DIR=<branch>/proof/linear-board`.

## Shots

| Shot | Before (61a5b2e6) | After (head) |
|---|---|---|
| `board.png` | Today's agent board from the ledger: Queued, Working, Needs Isaac, In review columns, cards with a stage pill; filters for agents, workspaces, grouping, stale. | Linear-style board: synced tickets merged with ledger items (5 items), `Waiting on you 1` filter, `Synced 2m ago` + Refresh, cards with priority, project, label, PR `#42` chips and the `Waiting on you · Sample · 3h` chip; Done hidden. |
| `ticket.png` | Clicking ENG-9001 opens the side panel over the board: agent strip, Reviews' Linear read, comments, composer and the PR's Conversation tab squeezed below. | The centered ticket page: crumbs `Board > Needs Isaac > ENG-9001`, summary card (waiting reply, summary, footer), description, Resources, Activity, composer; sidebar with Properties, Labels, Project, Pull requests, Related. |
| `pr.png` | Reviews Detail for `example/sample#42` with Conversation / Files / Checks / Guide and a reviewers/labels rail; no merge. | PR page inside the ticket: status strip, Guide / Diff / Comments (review threads inline), sidebar with status `Blocked: Waiting on review` (the same words as the ticket strip) and, since the PR can't merge now, the merge box's reason instead of a button (Relay only merges now, bound to the head; no auto-merge or merge queue), reviewers + Request review, checks by run, details. |
| `waiting-handled-focus.png` | (none) | Tab from the Waiting chip lands on Mark as handled; its focus ring shows (Settings > Theme > Focus ring switched to `auto` for this shot, since Relay starts with rings off). |
| `ticket-sidebar-collapsed.png` | (none) | Sidebar folded: the status strip (`In Progress`, `sample#42`, `Blocked: Waiting on review`, `3/3 checks passing`, `No conflicts`, `Sample is waiting on you`) and a wider centered column. |
| `pr-sidebar-collapsed.png` | (none) | PR sidebar folded: the ticket's strip carries the PR status; Comments take the full width. |
| `pr-diff-tree.png` | (none) | Diff tab: compacted file tree with +/- and Viewed boxes, split diff, noah's thread (with image) under line 3 of `items.ts`. |
| `pr-diff-longline.png` | (none) | After clicking `longline.ts` in the tree, the list jumps to it; the long lines wrap with no sideways scroll, tabs and tree stay in view. |
| `inline-thread.png` | (none) | ENG-9101: `flow, as drawn` highlighted in the description after a confirmed inline comment; the thread popover quotes it. |
| `fallback.png` | (none) | Host without `tickets`: the board from the ledger alone with the reason `The Mini's Relay Host can't sync Linear yet. Update it to see synced tickets.`, `Waiting on you 0`, no waiting chips, agent cards keep their stage pills (`Waiting on Agent`, `Review`, `Waiting on Noah`); the host saw no `tickets.*` frame. |

## Visual check (every PNG opened)

Fixed in this branch while taking the proof: the ticket PR page now holds its height (tabs and tree stay in view after a tree jump), a gap between the summary card and the description, and PR sidebar check names at the rail's label size.

Fixed in round 5: one time format on the ticket page (`12mo ago`), and one PR status selector, so the ticket strip, PR strip and PR sidebar all say `Blocked: Waiting on review` (old hosts that send no review decision keep `Required reviews or checks are missing`); the merge box gives the same reason.

Seen, not changed:
- The board scrolls sideways at 1440 px: the In review column is cut at the right edge in both phases.
- The fixture images on ENG-9101 are 1x1 PNGs, shown as dots.

# Timeline (PR D): proof

- Baseline: `61a5b2e6` has no Timeline (its Board header has no Board | Timeline switch; see `proof/linear-board/before/board.png`), so these shots are after-only.
- Head: retaken on the round-5 fixes, `27cefb64` (branch `eva/timeline`) plus the working-tree follow-up (date lines and ghosts beneath the bars; the proof host's re-plan proposal carries its baseline and account)
- Spec: `apps/desktop/e2e/board-proof.spec.ts` (after phase; its Timeline test runs only where the switch exists), plus `e2e/timeline.spec.ts` for zoom, open, re-plan and Apply.
- Mode: Relay Desktop in remote mode against `FakeRelayHost` with `tickets` and `tickets.writes`; the board comes from `e2e/fixtures/tickets`, the re-plan answer from `e2e/fixtures/tickets/replan-proposal.json`, sent as the host sends it (with its baseline and Linear account, `e2e/helpers/timeline-proposal.ts`). No Linear, Claude or omp; nothing is written in these shots.
- Clock: `EVAOS_NOW=2026-11-27T18:00:00Z`, renderer clock fixed to the same instant
- Window: 1440 x 900, light scheme, hidden window
- Fixture seed: `29264186b117d7be15658287ffeb56c88d33a24f172ea7eead7ead75f211f711` = sha256 of `apps/desktop/e2e/fixtures/reviews-diff/**` and `apps/desktop/e2e/fixtures/tickets/**` (7 files) concatenated in sorted path order, followed by the EVAOS_NOW string.
- Fixtures are synthetic. No private data.

Run: `cd apps/desktop && pnpm build && PROOF_DIR=/tmp/proof-d PROOF_PHASE=after pnpm e2e:run e2e/board-proof.spec.ts e2e/timeline.spec.ts --project=parallel --retries 0` then copy only `/tmp/proof-d/after/timeline*.png` here.

## Shots

| Shot | After (head) |
|---|---|
| `timeline.png` | Board / Timeline switch on Timeline, Week zoom (W / M / Q and - / = keys): Sample board > Beta (target 2026-12-18) > ENG-9001 and ENG-9002 bars ordered by priority, a red Today line and the dashed Beta target line running beneath the bars (every bar and its label stays on top), their labels in the time scale's own band below the dates (no tick or date covered), and the No date list with ENG-9004. |
| `timeline-proposal.png` | Ask Astra to re-plan on Beta: `Astra's plan: Land Beta by its target date` with each change and its reason (ENG-9001 due 2026-12-02 -> 2027-01-08; ENG-9002 priority Medium -> Urgent, order 20 -> 5), arrows on the rows, the ghost bar beneath ENG-9001's bar out to its new due date; Discard / Apply. Nothing is written until Apply, which confirms every row through the host's gate. |

## Visual check

- ENG-9001's ghost runs past the right edge of the visible chart (its new due date is off screen; the range now includes it, so it scrolls there).
- Bar text starts flush at the bar's left edge (SVAR's own bar label padding).
- Today and a milestone label on nearby days would overlap each other in the label band (not in these shots).
- No narrow (640 px) shot yet.

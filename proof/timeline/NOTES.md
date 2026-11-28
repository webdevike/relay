# Timeline (PR D): proof

- Baseline: `61a5b2e6` has no Timeline (its Board header has no Board | Timeline switch; see `proof/linear-board/before/board.png`), so these shots are after-only.
- Head: shots taken at `3c2de9c2` (branch `eva/timeline`)
- Spec: `apps/desktop/e2e/board-proof.spec.ts` (after phase; its Timeline test runs only where the switch exists), plus `e2e/timeline.spec.ts` for zoom, open, re-plan and Apply.
- Mode: Relay Desktop in remote mode against `FakeRelayHost` with `tickets` and `tickets.writes`; the board comes from `e2e/fixtures/tickets`, the re-plan answer from `e2e/fixtures/tickets/replan-proposal.json`. No Linear, Claude or omp; nothing is written in these shots.
- Clock: `EVAOS_NOW=2026-11-27T18:00:00Z`, renderer clock fixed to the same instant
- Window: 1440 x 900, light scheme, hidden window
- Fixture seed: `29264186b117d7be15658287ffeb56c88d33a24f172ea7eead7ead75f211f711` = sha256 of `apps/desktop/e2e/fixtures/reviews-diff/**` and `apps/desktop/e2e/fixtures/tickets/**` (7 files) concatenated in sorted path order, followed by the EVAOS_NOW string.
- Fixtures are synthetic. No private data.

Run: `cd apps/desktop && pnpm build && PROOF_DIR=/tmp/proof PROOF_PHASE=after pnpm e2e:run e2e/board-proof.spec.ts --project=parallel --retries 0` then copy `timeline*.png`.

## Shots

| Shot | After (head) |
|---|---|
| `timeline.png` | Board / Timeline switch on Timeline, Week zoom (W / M / Q and - / = keys): Sample board > Beta (target 2026-12-18) > ENG-9001 and ENG-9002 bars ordered by priority, a red Today line and the dashed Beta target line with their labels on the time scale, and the No date list with ENG-9004. |
| `timeline-proposal.png` | Ask Astra to re-plan on Beta: `Astra's plan: Land Beta by its target date` with each change and its reason (ENG-9001 due 2026-12-02 -> 2027-01-08; ENG-9002 priority Medium -> Urgent, order 20 -> 5), arrows on the rows, the ghost bar; Discard / Apply. Nothing is written until Apply, which confirms every row through the host's gate. |

## Visual check

- The Today line runs through bar labels that start before it (as in Linear).
- The Beta label on the scale covers part of the `13 Dec` date under it.

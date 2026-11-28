# Dragging a Board card to another column (desktop)

One card dragged to another Board column (`apps/desktop/src/renderer/agents-board/card-move.machine.ts`, run by `useCardMove()` in `card-move-actor.ts`). The column becomes one of the team's Linear states, written by the host's write gate as Isaac; the board only offers moves that will stick, Done and Canceled are confirmed, and a write whose answer was lost is checked, never sent again on its own. One move at a time.

- **ready**: nothing in flight; a drop starts a move, and dismisses the last one's message.
  - **idle**: no move.
  - **staysPut**: the drop was refused before anything was written: an agent drives the card (its column follows the run), it has no Linear issue, writes are off, no state matches the column, or the board would put it straight back ("This card stays in In review: PR #9 is open").
  - **settled**: Linear has the new state; the card shows in its new column and Undo is offered for `UNDO_WINDOW` (8 s). No Undo of an Undo, or of a move out of Done or Canceled.
  - **undoGate**: Undo only while the card is still in the state it was moved to; else it says Linear changed and writes nothing.
  - **conflict**: the host refused because the ticket changed in Linear since the board read it; the card goes back to its column.
  - **failed**: the move didn't happen (the gate refused, Linear failed, or it didn't land); the card goes back. Retry sends the same write with the same opId (Done and Canceled ask the gate for a new approval first).
- **checking**: finding the team's state for the column and whether the move would stick.
- **pickState**: several states match the column; the status picker asks which.
- **confirming**: Done or Canceled waits on Isaac's confirm.
- **preparing**: the host's gate approves the confirmed move.
- **writing** / **undoing**: the move (or its swapped Undo, with a new opId) is being written; the card shows in its new column meanwhile.
- **unknown**: the answer was lost; the board says "Checking whether it moved" and reads the ticket's state: moved means settled, unmoved means failed (Retry is safe: the host dedupes the opId), anything else is a conflict.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  [*] --> ready
  state ready {
    [*] --> ready_idle
    state "idle" as ready_idle
    state "staysPut" as ready_staysPut
    state "settled" as ready_settled
    state "undoGate" as ready_undoGate
    state "conflict" as ready_conflict
    state "failed" as ready_failed
  }
  ready --> ready_idle : move.drop [sameColumn]
  ready --> ready_staysPut : move.drop [blocked]
  ready --> checking : move.drop
  ready --> ready_idle : move.cancel
  ready_settled --> ready_undoGate : move.undo [canUndo]
  ready_settled --> ready_idle : after UNDO_WINDOW
  ready_undoGate --> undoing : always [stillMoved]
  ready_undoGate --> ready_conflict : always
  ready_failed --> preparing : move.retry [needsApproval]
  ready_failed --> writing : move.retry [hasWrite]
  ready_failed --> checking : move.retry
  checking --> ready_staysPut : done resolve [stays]
  checking --> pickState : done resolve [ambiguous]
  checking --> confirming : done resolve [terminalState]
  checking --> writing : done resolve
  checking --> ready_failed : error resolve
  pickState --> confirming : move.pick [pickedTerminal]
  pickState --> writing : move.pick [picked]
  pickState --> ready : move.cancel
  confirming --> preparing : move.confirm
  confirming --> ready : move.cancel
  preparing --> writing : done prepare [approved]
  preparing --> ready_conflict : done prepare [conflicted]
  preparing --> ready_failed : done prepare
  preparing --> ready_failed : error prepare
  writing --> ready_settled : done commit [written]
  writing --> unknown : done commit [lost]
  writing --> ready_conflict : done commit [conflicted]
  writing --> ready_failed : done commit
  writing --> unknown : error commit
  undoing --> ready_settled : done commit [written]
  undoing --> unknown : done commit [lost]
  undoing --> ready_conflict : done commit [conflicted]
  undoing --> ready_failed : done commit
  undoing --> unknown : error commit
  unknown --> ready_settled : done reconcile [landed]
  unknown --> ready_failed : done reconcile [unmoved]
  unknown --> ready_conflict : done reconcile
  unknown --> ready_failed : error reconcile
```
<!-- diagram:end -->

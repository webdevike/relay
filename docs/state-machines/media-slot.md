# Chat media load order (desktop)

One image or video in a chat waiting for its turn to load (`apps/desktop/src/renderer/chat/widgets/media-slot.machine.ts`, run per element by `useMediaSlot` in `media-slot.ts`). Nothing loads until the element comes within 600 px of the visible chat; then it asks the queue (`media-queue.ts`: four at a time) and the newest message's media go first. The `ticket` actor is that ask: leaving `claimed` releases it, so the next element starts. 3D models do not queue: they open only on a click (`chat-model-viewer.md`).

- **away**: off screen; its sized frame holds the space.
- **claimed.queued**: near the viewport, waiting for a slot; scrolling it away again drops it from the line.
- **claimed.loading**: its media loads and it holds a slot until it loaded or failed (`slot.settled`), or `LOAD_TIMEOUT` (15 s) passes.
- **shown**: loaded; it stays.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  [*] --> away
  state claimed {
    [*] --> claimed_queued
    state "queued" as claimed_queued
    state "loading" as claimed_loading
  }
  away --> claimed : slot.near
  claimed_queued --> claimed_loading : slot.granted
  claimed_queued --> away : slot.away
  claimed_loading --> shown : slot.settled
  claimed_loading --> shown : after LOAD_TIMEOUT
```
<!-- diagram:end -->

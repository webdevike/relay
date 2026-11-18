# Inverted chat follow

Whether a chat transcript (inverted list) keeps the newest row in view (`apps/mobile/src/ui/chatFollow.machine.ts`, run by `useInvertedChatScroll`). `following` pins the list to the bottom as rows arrive; `restoring` picks that or `reading` from where the thread was left. Only a gesture leaves it: `reading.moving` is a finger or the flick after it, and where it ends decides between following again (near the bottom) and `reading.still`.

`returning` is the animated trip home after the scroll-to-bottom button; it ends on the scroll's end event, or after `RETURN_TIMEOUT` when no event comes (the list was already at the bottom). `centring` scrolls a chosen row to the middle and stays a reader until the next gesture.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  state "any state" as anyState
  [*] --> restoring
  state reading {
    [*] --> reading_still
    state "moving" as reading_moving
    state "still" as reading_still
  }
  anyState --> returning : follow.toBottom [animated]
  anyState --> following : follow.toBottom
  anyState --> centring : follow.toRow [validRow]
  restoring --> following : always [startsNear]
  restoring --> reading : always
  following --> reading_moving : follow.dragStart
  following --> reading_moving : follow.momentumStart
  reading_moving --> following : follow.dragEnd [nearBottom]
  reading_moving --> reading_still : follow.dragEnd
  reading_moving --> following : follow.momentumEnd [nearBottom]
  reading_moving --> reading_still : follow.momentumEnd
  reading_still --> reading_moving : follow.dragStart
  reading_still --> reading_moving : follow.momentumStart
  returning --> following : follow.momentumEnd
  returning --> reading_moving : follow.dragStart
  returning --> following : after RETURN_TIMEOUT
  centring --> reading_moving : follow.dragStart
  centring --> reading_moving : follow.momentumStart
```
<!-- diagram:end -->

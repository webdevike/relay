// Port of TrackpadInputSink.swift. Turns a batch of phone trackpad events into uinput reports.
// Consecutive moves inside a batch coalesce into one REL_X/REL_Y report so a burst never piles
// up work; clicks, drags and scrolls flush pending motion first to preserve ordering.
//
// Runs inline on the event loop: the uinput fd is non-blocking and one report is one `write`,
// so `handle` stays cheap without the Mac's separate queue.

import type { InputEvent } from "@relay/protocol";
import type { InputSink } from "../seams";
import { PointerModel } from "./pointer-model";
import type { EventPoster } from "./poster";

export class TrackpadInputSink implements InputSink {
  private readonly model = new PointerModel();
  private lastMoveT: number | null = null;

  constructor(private readonly poster: EventPoster) {}

  handle(events: readonly InputEvent[]): void {
    let pendingDX = 0;
    let pendingDY = 0;

    const flushMove = (): void => {
      if (pendingDX === 0 && pendingDY === 0) return;
      this.poster.moveBy(pendingDX, pendingDY);
      pendingDX = 0;
      pendingDY = 0;
    };

    for (const event of events) {
      switch (event.k) {
        case "move": {
          const dt = this.lastMoveT === null ? 8 : event.t - this.lastMoveT;
          this.lastMoveT = event.t;
          const { dx, dy } = this.model.accelerate(event.dx, event.dy, dt);
          pendingDX += dx;
          pendingDY += dy;
          break;
        }
        case "click":
          flushMove();
          if (this.model.dragging) break;
          this.poster.button(event.button, true);
          this.poster.button(event.button, false);
          break;
        case "drag":
          flushMove();
          if (event.phase === "start") {
            if (this.model.beginDrag()) this.poster.button("left", true);
          } else if (this.model.endDrag()) {
            this.poster.button("left", false);
          }
          break;
        case "scroll": {
          flushMove();
          const { dx, dy } = this.model.scrollDelta(event.dx, event.dy);
          if (dx !== 0 || dy !== 0) this.poster.scroll(dx, dy);
          break;
        }
      }
    }
    flushMove();
  }
}

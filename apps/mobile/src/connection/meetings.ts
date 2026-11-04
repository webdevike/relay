/**
 * Routes Meetings' server frames into the meetings store: `meetings.state` replaces the list,
 * `meeting.recording` one recording, `meeting.live` a page's lines, `meeting.astra` its Astra
 * session; `meetings.res` settles the `meetings.req` waiting on its rid after storing a snapshot
 * or an Astra answer it carried.
 */
import type { MeetingsOp, MeetingsResult, ServerMessage } from "@relay/protocol";
import type { MeetingsStore } from "@/state/meetings";

/** How long a Meetings request waits; an Astra ask waits for her session to start. */
export const MEETINGS_TIMEOUT_MS = 30_000;
export const MEETINGS_ASK_TIMEOUT_MS = 120_000;

export class PendingMeetings {
  private readonly waiting = new Map<
    string,
    { op: MeetingsOp; resolve: (result: MeetingsResult) => void; timer: number }
  >();

  add(rid: string, op: MeetingsOp): Promise<MeetingsResult> {
    // Executor form: the phone's test runtime predates Promise.withResolvers.
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.settle({ rid, ok: false, error: "Your Mac did not answer." });
        },
        op.kind === "ask" ? MEETINGS_ASK_TIMEOUT_MS : MEETINGS_TIMEOUT_MS,
      );
      this.waiting.set(rid, { op, resolve, timer });
    });
  }

  op(rid: string): MeetingsOp | undefined {
    return this.waiting.get(rid)?.op;
  }

  settle(result: MeetingsResult): void {
    const entry = this.waiting.get(result.rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(result.rid);
    entry.resolve(result);
  }

  cancelAll(): void {
    for (const rid of [...this.waiting.keys()])
      this.settle({ rid, ok: false, error: "Disconnected." });
  }
}

type Sink = Pick<
  MeetingsStore,
  "setState" | "upsertRecording" | "setPage" | "applyLive" | "setAstra"
>;

export function createMeetingsFrameRouter(
  store: Sink,
  pending: PendingMeetings,
): (message: ServerMessage) => void {
  return (message) => {
    if (message.t === "meetings.state") {
      store.setState({
        recordings: message.recordings,
        meetings: message.meetings,
        digest: message.digest,
        now: message.now,
      });
    }
    if (message.t === "meeting.recording") store.upsertRecording(message.recording);
    if (message.t === "meeting.live") store.applyLive(message.id, message.upsert);
    if (message.t === "meeting.astra") store.setAstra(message.id, message.item);
    if (message.t === "meetings.res") {
      const op = pending.op(message.rid);
      if (message.ok && message.snapshot !== undefined) store.setPage(message.snapshot);
      if (message.ok && message.astra !== undefined && op?.kind === "ask")
        store.setAstra(op.id, message.astra);
      pending.settle(message);
    }
  };
}

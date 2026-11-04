// Pushes "Join <agent> on <board>" to the phones when a live canvas room opens: the Join card in the
// chat, for a phone that is not looking at that chat. A phone that muted the assistant the room's
// chat belongs to (`push.prefs`) gets nothing. Rooms already live when the host starts, and rooms
// that ended, are no invitation.

import type { CanvasRoomInfo } from "@relay/protocol";
import type { PushMessage, PushSender } from "./notifier";
import type { PushTokenSource } from "./token-store";

export interface CanvasInvitationsDeps {
  readonly tokens: PushTokenSource & { unregister(deviceId: string): void };
  readonly sender: PushSender;
  readonly log: (line: string) => void;
}

export class CanvasInvitations {
  private seen = new Set<string>();

  constructor(private readonly deps: CanvasInvitationsDeps) {}

  /** Baseline without pushing. */
  seed(rooms: readonly CanvasRoomInfo[]): void {
    this.seen = new Set(rooms.map((room) => room.id));
  }

  /** The room list after any change; pushes each live room not seen before. */
  observe(rooms: readonly CanvasRoomInfo[]): void {
    for (const room of rooms) {
      if (this.seen.has(room.id)) continue;
      this.seen.add(room.id);
      if (room.live) this.invite(room);
    }
  }

  private invite(room: CanvasRoomInfo): void {
    const recipients = [...this.deps.tokens.tokens(room.chat.assistant)].map(([deviceId, token]) => ({ deviceId, token }));
    if (recipients.length === 0) return;
    const message: Omit<PushMessage, "to"> = {
      title: `Join ${room.agent.name}`,
      body: room.chat.title === undefined || room.chat.title === "" ? `on ${room.board || room.slug}` : `on ${room.board || room.slug}: ${room.chat.title}`,
      data: { canvas: room.slug },
      threadId: `canvas:${room.slug}`,
    };
    void this.deps.sender.send(recipients.map((recipient) => ({ ...message, to: recipient.token }))).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.ok) return;
          const recipient = recipients[index];
          if (recipient === undefined) return;
          this.deps.log(`canvas push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) this.deps.tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        this.deps.log(`canvas push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
}

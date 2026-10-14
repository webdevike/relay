// Host side of the notification inbox's phone escalation. EvaOS decides what reaches the phone (see
// apps/evaos/src/inbox/escalate.rs) and sends it as `inbox.item`; this service keeps what is open,
// relays it to the other paired devices, pushes a Time Sensitive notification for a new item and
// closes the loop both ways:
//   - EvaOS says an item closed on the Mac: `inbox.resolve` goes to the phones and the delivered
//     notification is withdrawn with a silent push.
//   - A phone answers (`agent.approve`, `agent.deny`, `agent.ask.answer`): the session claims the
//     answer before it runs, and when omp's resolved event follows, `settled` names the phone as
//     the one who answered so EvaOS can mark its row "answered on iPhone".

import {
  ESCALATOR_DEVICE_ID,
  INBOX_CATEGORY,
  type InboxItem,
  type InboxResolve,
  type ServerMessage,
} from "@relay/protocol";
import type { InboxRelaying } from "../seams";
import type { PushMessage, PushSender } from "../push/notifier";
import type { PushTokenSource } from "../push/token-store";

export interface InboxServiceDeps {
  readonly tokens: PushTokenSource & { unregister(deviceId: string): void };
  readonly sender: PushSender;
  /** Sends `message` to every authenticated device except the one named (`null`: all of them). */
  readonly broadcast: (message: ServerMessage, exceptDeviceId: string | null) => void;
  /** Whether `deviceId` has this session open on screen right now; it has the live card, no push. */
  readonly isViewing: (deviceId: string, sessionId: string) => boolean;
  readonly log: (line: string) => void;
}

/** What a notification carries so the phone can answer it with the app killed and no state. */
export interface InboxPushData {
  readonly id: string;
  readonly kind: InboxItem["kind"];
  readonly sessionId?: string;
  readonly approvalId?: string;
  readonly requiresBiometric?: boolean;
  /** The destructive pattern ("force push"), for the Face ID prompt. */
  readonly destructive?: string;
  readonly askId?: string;
  readonly questionId?: string;
  readonly options?: readonly string[];
}

export function pushDataOf(item: InboxItem): InboxPushData {
  const base = { id: item.id, kind: item.kind, ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }) };
  switch (item.kind) {
    case "approval":
      return {
        ...base,
        approvalId: item.approval.id,
        requiresBiometric: item.approval.requiresBiometric,
        ...(item.approval.destructive === undefined ? {} : { destructive: item.approval.destructive }),
      };
    case "ask":
      return { ...base, askId: item.ask.id, questionId: item.ask.questionId, options: item.ask.options };
    case "alert":
      return base;
  }
}

function categoryOf(item: InboxItem): string | undefined {
  switch (item.kind) {
    case "approval":
      return item.approval.requiresBiometric ? INBOX_CATEGORY.approvalBiometric : INBOX_CATEGORY.approval;
    case "ask":
      return INBOX_CATEGORY.ask;
    case "alert":
      return undefined;
  }
}

/** The notification for a new item. Time Sensitive breaks through Focus, as an agent blocked on Isaac should. */
export function pushMessageOf(token: string, item: InboxItem): PushMessage {
  const category = categoryOf(item);
  const title = item.more === undefined || item.more === 0 ? item.title : `${item.title} (+${item.more} more)`;
  return {
    to: token,
    title,
    body: item.body,
    data: { ...pushDataOf(item), ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }) },
    // A digest is a nudge, never a break through Focus, and makes no sound.
    interruptionLevel: item.passive === true ? "passive" : "time-sensitive",
    ...(item.passive === true ? { sound: null } : {}),
    ...(category === undefined ? {} : { categoryId: category }),
  };
}

/** A silent push that makes the phone remove the delivered notification for `id`. */
export function withdrawMessageOf(token: string, id: string): PushMessage {
  return { to: token, data: { withdraw: id }, contentAvailable: true, sound: null };
}

export class InboxService implements InboxRelaying {
  private readonly items = new Map<string, InboxItem>();
  /** Ids a notification was pushed for, so closing one withdraws it. */
  private readonly pushed = new Set<string>();
  private readonly claims = new Map<string, { deviceId: string; answer: string }>();

  constructor(private readonly deps: InboxServiceDeps) {}

  pending(): readonly InboxItem[] {
    return [...this.items.values()];
  }

  item(deviceId: string, item: InboxItem): void {
    if (deviceId !== ESCALATOR_DEVICE_ID) {
      this.deps.log(`ignored inbox.item from ${deviceId}: only ${ESCALATOR_DEVICE_ID} escalates`);
      return;
    }
    this.deps.broadcast({ t: "inbox.item", item }, ESCALATOR_DEVICE_ID);
    if (item.passive === true) {
      // Nothing to answer, so nothing to replay or withdraw.
      this.push(item, false);
      return;
    }
    const known = this.items.has(item.id);
    this.items.set(item.id, item);
    if (known || item.silent === true) return;
    this.push(item, true);
  }

  resolve(deviceId: string, resolve: Pick<InboxResolve, "id" | "answer">): void {
    if (deviceId !== ESCALATOR_DEVICE_ID) {
      this.deps.log(`ignored inbox.resolve from ${deviceId}: a phone's answer is derived from its command`);
      return;
    }
    this.items.delete(resolve.id);
    this.claims.delete(resolve.id);
    const frame: ServerMessage = { t: "inbox.resolve", id: resolve.id, by: "mac", ...(resolve.answer === undefined ? {} : { answer: resolve.answer }) };
    this.deps.broadcast(frame, ESCALATOR_DEVICE_ID);
    this.withdraw(resolve.id);
  }

  claim(id: string, deviceId: string, answer: string): void {
    this.claims.set(id, { deviceId, answer });
  }

  release(id: string): void {
    this.claims.delete(id);
  }

  settled(kind: "approval" | "ask", requestId: string): void {
    const id = `${kind}:${requestId}`;
    const claim = this.claims.get(id);
    this.claims.delete(id);
    const stored = this.items.delete(id);
    const byPhone = claim !== undefined && claim.deviceId !== ESCALATOR_DEVICE_ID;
    if (!byPhone && !stored) return;
    const frame: ServerMessage = {
      t: "inbox.resolve",
      id,
      by: byPhone ? "phone" : "mac",
      ...(claim === undefined ? {} : { answer: claim.answer }),
    };
    // EvaOS hears of a phone's answer so its row reads "answered on iPhone"; it needs no echo of
    // what happened on the Mac.
    this.deps.broadcast(frame, byPhone ? null : ESCALATOR_DEVICE_ID);
    this.withdraw(id);
  }

  private push(item: InboxItem, withdrawable: boolean): void {
    const recipients: { deviceId: string; token: string }[] = [];
    for (const [deviceId, token] of this.deps.tokens.tokens()) {
      if (item.sessionId !== undefined && this.deps.isViewing(deviceId, item.sessionId)) continue;
      recipients.push({ deviceId, token });
    }
    if (recipients.length === 0) return;
    if (withdrawable) this.pushed.add(item.id);
    this.send(recipients, (token) => pushMessageOf(token, item));
  }

  private withdraw(id: string): void {
    if (!this.pushed.delete(id)) return;
    const recipients = [...this.deps.tokens.tokens()].map(([deviceId, token]) => ({ deviceId, token }));
    if (recipients.length === 0) return;
    this.send(recipients, (token) => withdrawMessageOf(token, id));
  }

  private send(recipients: readonly { deviceId: string; token: string }[], build: (token: string) => PushMessage): void {
    void this.deps.sender.send(recipients.map((recipient) => build(recipient.token))).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.ok) return;
          const recipient = recipients[index];
          if (recipient === undefined) return;
          this.deps.log(`inbox push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) this.deps.tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        this.deps.log(`inbox push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
}

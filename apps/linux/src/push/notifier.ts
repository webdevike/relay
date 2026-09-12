// Pushes a notification to every registered phone when a session starts waiting on the user
// (`waiting` or `needs_permission`), then again every REMINDER_MS while it keeps waiting. A phone
// that is looking at that session right now (connected and subscribed to it) is skipped; it has the
// live card in front of it. Delivery goes through Expo's push service, which holds the APNs key.

import type { AgentSession, AgentStatus } from "@relay/protocol";
import type { SessionClock } from "../session";
import type { PushTokenSource } from "./token-store";

export const REMINDER_MS = 10 * 60_000;

export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: { readonly sessionId: string };
}

export type PushOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly unregistered: boolean };

/** One HTTP round trip to the push service; outcomes line up with `messages`. */
export interface PushSender {
  send(messages: readonly PushMessage[]): Promise<readonly PushOutcome[]>;
}

export interface NotifierDeps {
  readonly tokens: PushTokenSource & { unregister(deviceId: string): void };
  readonly sender: PushSender;
  /** Whether `deviceId` has this session open on screen right now. */
  readonly isViewing: (deviceId: string, sessionId: string) => boolean;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

interface Tracked {
  session: AgentSession;
  cancelReminder: (() => void) | null;
}

function waitsOnUser(status: AgentStatus): boolean {
  return status === "waiting" || status === "needs_permission";
}

export class AttentionNotifier {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly deps: NotifierDeps) {}

  /** Baseline without notifying: sessions already waiting when the host starts are not news. */
  seed(sessions: readonly AgentSession[]): void {
    for (const session of sessions) this.tracked.set(session.id, { session, cancelReminder: null });
  }

  /** The current session list after any change; diffs against the last call. */
  observe(sessions: readonly AgentSession[]): void {
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const entry = this.tracked.get(session.id);
      const was = entry === undefined ? false : waitsOnUser(entry.session.status);
      const now = waitsOnUser(session.status);
      if (entry === undefined) {
        this.tracked.set(session.id, { session, cancelReminder: null });
      } else {
        entry.session = session;
      }
      if (now && !was) {
        this.notify(session.id, false);
      } else if (!now && was) {
        this.stopReminder(session.id);
      }
    }
    for (const id of this.tracked.keys()) {
      if (seen.has(id)) continue;
      this.stopReminder(id);
      this.tracked.delete(id);
    }
  }

  private notify(sessionId: string, reminder: boolean): void {
    const entry = this.tracked.get(sessionId);
    if (entry === undefined || !waitsOnUser(entry.session.status)) return;
    const session = entry.session;
    entry.cancelReminder?.();
    entry.cancelReminder = this.deps.clock.after(REMINDER_MS, () => {
      this.notify(sessionId, true);
    });

    const recipients: { deviceId: string; token: string }[] = [];
    for (const [deviceId, token] of this.deps.tokens.tokens()) {
      if (this.deps.isViewing(deviceId, session.id)) continue;
      recipients.push({ deviceId, token });
    }
    if (recipients.length === 0) return;

    const title = reminder ? `${session.title} is still waiting` : session.title;
    const body = session.status === "needs_permission" ? `Needs permission${session.statusDetail === undefined ? "" : `: ${session.statusDetail}`}` : session.lastActivity;
    const messages = recipients.map((recipient) => ({ to: recipient.token, title, body, data: { sessionId: session.id } }));
    void this.deps.sender.send(messages).then(
      (outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.ok) return;
          const recipient = recipients[index];
          if (recipient === undefined) return;
          this.deps.log(`push to ${recipient.deviceId} failed: ${outcome.error}`);
          if (outcome.unregistered) this.deps.tokens.unregister(recipient.deviceId);
        });
      },
      (error: unknown) => {
        this.deps.log(`push failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }

  private stopReminder(sessionId: string): void {
    const entry = this.tracked.get(sessionId);
    if (entry === undefined) return;
    entry.cancelReminder?.();
    entry.cancelReminder = null;
  }
}

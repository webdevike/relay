// Background lines held back while an `ask` card is open. Used by the relay-bridge omp extension,
// which imports it by relative path under omp's bun, so this file may only use node built-ins.
//
// A turn sent while omp's `ask` tool blocks would queue behind it, and omp drops an ask that has
// messages queued behind it. Isaac's own typed turn therefore cancels the ask (his send is his
// answer). A line the host or a job sends for him is not: it waits here until no ask is open.

/** The prefix every assistant job line carries (`statusPrefix` in assistant/service.ts): `[From <title>'s background jobs] `. */
const BACKGROUND_LINE = /^\[From [^\]\n]*'s background jobs\] /;

/** True for a job, agent-session or heartbeat line an assistant's host sends; false for anything Isaac typed or said. */
export function isBackgroundLine(text: string): boolean {
  return BACKGROUND_LINE.test(text);
}

/** Deliveries that wait for the open asks to close; released in arrival order. */
export class AskHold {
  private held: (() => void)[] = [];

  get size(): number {
    return this.held.length;
  }

  hold(deliver: () => void): void {
    this.held.push(deliver);
  }

  /** Delivers everything held, unless `asking()` (another ask opened meanwhile): then it all keeps waiting. */
  release(asking: () => boolean): void {
    if (asking()) return;
    const ready = this.held;
    this.held = [];
    for (const deliver of ready) deliver();
  }

  /** Drops everything held (the session it was for ended or switched). */
  clear(): void {
    this.held = [];
  }
}

/** What the gate needs of the session: whether an ask is open, and how to cancel every open ask. */
export interface AskGateSession {
  open(): boolean;
  cancel(): void;
}

/**
 * Decides what a turn sent to the session does to an open ask. Isaac's own turn cancels it (and gets
 * `settleMs` for the cancelled ask's terminal dialog to dismiss); a background line is held and
 * delivered by `closed()` once no ask is open, whether it was answered, timed out or cancelled.
 */
export class AskGate {
  private readonly hold = new AskHold();

  constructor(
    private readonly session: AskGateSession,
    private readonly settleMs: number,
  ) {}

  /** Lines waiting for the ask to close. */
  get waiting(): number {
    return this.hold.size;
  }

  /**
   * True when the caller should deliver `text` now. False when it was held: `deliver` runs later, from
   * `closed()`. Only a turn (`sendsTurn`) is affected; text left in the editor never touches an ask.
   */
  async admit(text: string, sendsTurn: boolean, deliver: () => void): Promise<boolean> {
    if (!sendsTurn || !this.session.open()) return true;
    if (isBackgroundLine(text)) {
      this.hold.hold(deliver);
      return false;
    }
    this.session.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs).unref());
    return true;
  }

  /** An ask closed or was cancelled: deliver held lines after `settleMs`, if no other ask has opened by then. */
  closed(): void {
    if (this.hold.size === 0) return;
    setTimeout(() => {
      this.hold.release(() => this.session.open());
    }, this.settleMs).unref();
  }

  /** The session ended or switched: held lines belonged to it. */
  clear(): void {
    this.hold.clear();
  }
}

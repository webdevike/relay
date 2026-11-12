// Dismissed status cards (the one-row cards above a chat's composer): the host keeps one set for
// every device, each an id the clients name a card by, so Relay desktop and the phone agree on what
// Isaac closed. Kept in `$XDG_CONFIG_HOME/relay/dismissed-cards.json` (dir 0700, file 0600, written
// atomically); every change goes out to every device as the whole `cards.dismissed` set. A
// dismissal never reaches an agent: no note, no turn, no push.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DismissedCardId, DismissedCards, MAX_DISMISSED_CARDS, type ServerMessage } from "@relay/protocol";

const CardState = z.object({
  /** Every dismissed card id, oldest first. */
  ids: DismissedCards.default([]),
});
type CardState = z.infer<typeof CardState>;

/** `$XDG_CONFIG_HOME/relay/dismissed-cards.json`. */
export function defaultDismissedCardsPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "dismissed-cards.json");
}

export interface DismissedCardServiceDeps {
  readonly path: string;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  readonly log: (line: string) => void;
}

/** What a phone session and the server need of the dismissed cards. */
export interface DismissedCardRelaying {
  /** Every dismissed card id, oldest first. */
  snapshot(): readonly string[];
  /** Dismisses (`on`) or restores card `id`; false when it already was so, or `id` is no card id. */
  set(id: string, on: boolean): boolean;
}

export class DismissedCardService implements DismissedCardRelaying {
  private state: CardState;

  constructor(private readonly deps: DismissedCardServiceDeps) {
    this.state = this.load();
  }

  snapshot(): readonly string[] {
    return this.state.ids;
  }

  set(id: string, on: boolean): boolean {
    if (!DismissedCardId.safeParse(id).success) return false;
    if (this.state.ids.includes(id) === on) return false;
    this.state = { ids: on ? [...this.state.ids, id].slice(-MAX_DISMISSED_CARDS) : this.state.ids.filter((other) => other !== id) };
    this.save();
    this.deps.broadcast({ t: "cards.dismissed", ids: [...this.state.ids] });
    this.deps.log(`cards: ${on ? "dismissed" : "restored"} ${id}`);
    return true;
  }

  private load(): CardState {
    const empty: CardState = { ids: [] };
    if (!existsSync(this.deps.path)) return empty;
    try {
      const parsed = CardState.safeParse(JSON.parse(readFileSync(this.deps.path, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`cards: ${this.deps.path} is not a dismissed-cards file; starting empty`);
    } catch (error) {
      this.deps.log(`cards: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return empty;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.deps.path);
    } catch (error) {
      this.deps.log(`cards: cannot save ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

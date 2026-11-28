// Inline comment anchors on the host (PLAN T3.1). Linear keeps only an inline comment's quoted
// words, so when the same words appear twice in a description the occurrence Isaac commented on
// is lost. `anchors.json` under the tickets dir keeps, per comment Isaac made in Relay, the text
// just before and after the quote `{v: 1, anchors: {[commentId]: {prefix, suffix, at}}}`;
// Relay-only, never written to Linear. Oldest entries go past `MAX_ANCHORS`.

import { join } from "node:path";
import { TicketAnchorContext, type TicketComment } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";

export const MAX_ANCHORS = 5000;

const Entry = TicketAnchorContext.extend({ at: z.number() });
const AnchorsFile = z.object({ v: z.literal(1), anchors: z.record(z.string(), Entry) });

/** `anchors.json`: the saved context of each inline comment made in Relay, by comment id. */
export class AnchorStore {
  private readonly path: string;
  private readonly anchors: Record<string, z.infer<typeof Entry>>;

  constructor(
    dir: string,
    private readonly now: () => number,
    private readonly max = MAX_ANCHORS,
  ) {
    this.path = join(dir, "anchors.json");
    const parsed = AnchorsFile.safeParse(readJson(this.path, null));
    this.anchors = parsed.success ? { ...parsed.data.anchors } : {};
  }

  get(commentId: string): TicketAnchorContext | null {
    const a = this.anchors[commentId];
    return a === undefined ? null : { prefix: a.prefix, suffix: a.suffix };
  }

  /** Keeps `anchor` for the comment and saves; the oldest go past the cap. */
  set(commentId: string, anchor: TicketAnchorContext): void {
    this.anchors[commentId] = { prefix: anchor.prefix, suffix: anchor.suffix, at: this.now() };
    const ids = Object.keys(this.anchors);
    if (ids.length > this.max) {
      ids.sort((a, b) => this.anchors[a]!.at - this.anchors[b]!.at);
      for (const id of ids.slice(0, ids.length - this.max)) delete this.anchors[id];
    }
    writeJson(this.path, { v: 1, anchors: this.anchors });
  }

  /** The comments with their saved anchor, where one is kept. */
  attach(comments: readonly TicketComment[]): TicketComment[] {
    return comments.map((c) => {
      const anchor = c.quotedText === null ? null : this.get(c.id);
      return anchor === null ? c : { ...c, anchor };
    });
  }
}

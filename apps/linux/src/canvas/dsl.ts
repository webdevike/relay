// Streaming parser for the agent's action lines. Actions are emitted as soon as their header
// line is complete; text blocks (@set_text / @add_node) stream their content while tokens
// arrive, so the agent starts typing before the model finishes.
//
//   @say <one line to the human>          streams into the cursor bubble
//   @point <id>                           glide the cursor to a node while talking about it
//   @select <id>
//   @set_text <id> <title|body>           then text lines, then @end
//   @append_text <id> <title|body>        then text lines, then @end (typed after a newline)
//   @add_node <newId> <note|topic|suggestion> <x> <y> <w>   then title line, body lines, @end
//   @move_node <id> <x> <y>
//   @add_edge <sourceId> <targetId> [label words]
//   @delete <id>
//   @add_image <newId> <x> <y> <w> <src>                   then title line, caption lines, @end
//                                         (src: an absolute local path or an https image URL; may hold spaces)
//   @add_frame <newId> <x> <y> <w> <h>                     then title line, @end
//   @add_ui <newId> <x> <y> <w> [h]                        then title line, OpenUI Lang source lines, @end
//                                         (a live widget: checked like a dashboard's before it lands;
//                                         @set_text <id> body replaces its source, checked the same way)
//   @add_proto <newId> <x> <y> <w> [h] <relay|ecard|mantine> [mobile]   then title line, JSX lines, @end
//                                         (an interactive prototype in that design system: the JSX is
//                                         ```mantine-widget's contract and must compile before it lands;
//                                         @set_text <id> body replaces it, checked the same way)
//   @parent <id> <frameId|none>           put a node in a frame (it then moves with it), or take it out
//                                         (@add_frame adopts the nodes whose center is inside it; @add_* and
//                                         @move_node parent a node that lands fully inside a frame, and clear
//                                         the parent when it lands outside it)
//   @cursor <x> <y>                       glide the cursor to a spot on the board
//   @handoff <main|Name> <request>        the canvas self only: hand work that needs real tools to
//                                         the chat that started the room (main) or a joined worker

import type { TextField } from "@relay/canvas-live/shared";

/** Text that arrives incrementally; the typer drains it. */
export class TextStream {
  text = "";
  closed = false;
  private wake: (() => void) | null = null;
  push(s: string): void {
    if (!s) return;
    this.text += s;
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  /** Resolves when more text arrives or the stream closes. */
  changed(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.wake = () => {
      this.wake = null;
      resolve(undefined);
    };
    return promise;
  }
}

export type Action =
  | { kind: "point"; id: string }
  | { kind: "cursor"; x: number; y: number }
  | { kind: "select"; id: string }
  | { kind: "append_text"; id: string; field: TextField; text: TextStream }
  | { kind: "set_text"; id: string; field: TextField; text: TextStream }
  | { kind: "add_node"; id: string; type: "note" | "topic" | "suggestion"; x: number; y: number; w: number; text: TextStream }
  | { kind: "add_image"; id: string; x: number; y: number; w: number; src: string; text: TextStream }
  | { kind: "add_frame"; id: string; x: number; y: number; w: number; h: number; text: TextStream }
  | { kind: "add_ui"; id: string; x: number; y: number; w: number; h: number | null; text: TextStream }
  | { kind: "add_proto"; id: string; x: number; y: number; w: number; h: number | null; system: string; viewport: "desktop" | "mobile"; text: TextStream }
  | { kind: "move_node"; id: string; x: number; y: number }
  | { kind: "parent"; id: string; frame: string | null }
  | { kind: "add_edge"; source: string; target: string; label: string }
  | { kind: "delete"; id: string }
  | { kind: "handoff"; target: string; request: string };

const NODE_TYPES: Record<string, "note" | "topic" | "suggestion"> = { note: "note", topic: "topic", suggestion: "suggestion" };

export class ActionParser {
  private pending = "";
  private mode: "top" | "say" | "block" = "top";
  private block: TextStream | null = null;
  private curPushed = 0;
  private needNL = false;
  private saidAny = false;

  constructor(
    private onAction: (a: Action) => void,
    private onSay: (chunk: string) => void,
  ) {}

  feed(delta: string): void {
    this.pending += delta;
    this.drain(false);
  }

  finish(): void {
    this.drain(true);
    if (this.mode === "block" && this.block) {
      this.block.close();
      this.block = null;
    }
    this.mode = "top";
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.mode === "say") {
        const nl = this.pending.indexOf("\n");
        if (nl < 0) {
          this.onSay(this.pending);
          this.pending = "";
          return;
        }
        this.onSay(this.pending.slice(0, nl));
        this.pending = this.pending.slice(nl + 1);
        this.mode = "top";
        continue;
      }
      if (this.mode === "block") {
        if (!this.drainBlock(final)) return;
        continue;
      }
      // top level
      if (this.pending.startsWith("@say ")) {
        if (this.saidAny) this.onSay("\n");
        this.saidAny = true;
        this.pending = this.pending.slice(5);
        this.mode = "say";
        continue;
      }
      const nl = this.pending.indexOf("\n");
      if (nl < 0) {
        if (final && this.pending.trim()) {
          const line = this.pending;
          this.pending = "";
          this.command(line);
        }
        return;
      }
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.command(line);
    }
  }

  /** Returns true when it switched back to top level and more input may remain. */
  private drainBlock(final: boolean): boolean {
    const stream = this.block;
    if (!stream) {
      this.mode = "top";
      return true;
    }
    const emit = (s: string) => {
      if (!s) return;
      if (this.curPushed === 0 && this.needNL) {
        stream.push("\n");
        this.needNL = false;
      }
      stream.push(s);
      this.curPushed += s.length;
    };
    for (;;) {
      const nl = this.pending.indexOf("\n");
      if (nl >= 0) {
        const line = this.pending.slice(0, nl);
        this.pending = this.pending.slice(nl + 1);
        if (this.curPushed === 0 && line.trim() === "@end") {
          stream.close();
          this.block = null;
          this.mode = "top";
          return true;
        }
        if (this.curPushed === 0 && line === "") {
          if (this.needNL) stream.push("\n");
          this.needNL = true;
        } else {
          emit(line);
          this.needNL = true;
        }
        this.curPushed = 0;
        continue;
      }
      // Partial line: hold anything that might become "@end".
      const p = this.pending;
      if (this.curPushed === 0 && p.startsWith("@") && !final) return false;
      if (final && this.curPushed === 0 && p.trim() === "@end") {
        this.pending = "";
        return false;
      }
      emit(p);
      this.pending = "";
      return false;
    }
  }

  private command(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (!line.startsWith("@")) {
      // Plain prose outside a block: treat as speech.
      if (this.saidAny) this.onSay("\n");
      this.saidAny = true;
      this.onSay(line);
      return;
    }
    const [cmd, ...a] = line.slice(1).split(/\s+/);
    const num = (s: string | undefined) => Number.parseFloat(s ?? "0") || 0;
    switch (cmd ?? "") {
      case "point":
        if (a[0]) this.onAction({ kind: "point", id: a[0] });
        return;
      case "append_text": {
        if (!a[0]) return;
        const text = new TextStream();
        this.onAction({ kind: "append_text", id: a[0], field: a[1] === "title" ? "title" : "body", text });
        this.openBlock(text);
        return;
      }
      case "select":
        if (a[0]) this.onAction({ kind: "select", id: a[0] });
        return;
      case "set_text": {
        if (!a[0]) return;
        const text = new TextStream();
        this.onAction({ kind: "set_text", id: a[0], field: a[1] === "title" ? "title" : "body", text });
        this.openBlock(text);
        return;
      }
      case "add_node": {
        const text = new TextStream();
        this.onAction({
          kind: "add_node",
          id: a[0] ?? `n-${Date.now().toString(36)}`,
          type: NODE_TYPES[a[1] ?? ""] ?? "note",
          x: num(a[2]),
          y: num(a[3]),
          w: num(a[4]) || 420,
          text,
        });
        this.openBlock(text);
        return;
      }
      case "move_node":
        if (a[0]) this.onAction({ kind: "move_node", id: a[0], x: num(a[1]), y: num(a[2]) });
        return;
      case "parent":
        if (a[0] && a[1]) this.onAction({ kind: "parent", id: a[0], frame: a[1] === "none" ? null : a[1] });
        return;
      case "add_edge":
        if (a[0] && a[1]) this.onAction({ kind: "add_edge", source: a[0], target: a[1], label: a.slice(2).join(" ") });
        return;
      case "delete":
        if (a[0]) this.onAction({ kind: "delete", id: a[0] });
        return;
      case "add_image": {
        // A height before the src (`<x> <y> <w> <h> <src>`) is dropped: an image keeps its aspect ratio.
        const rest = a.slice(4);
        if (rest.length > 1 && /^\d+(\.\d+)?$/.test(rest[0] ?? "")) rest.shift();
        const src = rest.join(" ");
        if (!a[0] || src === "") return;
        const text = new TextStream();
        this.onAction({ kind: "add_image", id: a[0], x: num(a[1]), y: num(a[2]), w: num(a[3]) || 420, src, text });
        this.openBlock(text);
        return;
      }
      case "add_frame": {
        if (!a[0]) return;
        const text = new TextStream();
        this.onAction({ kind: "add_frame", id: a[0], x: num(a[1]), y: num(a[2]), w: num(a[3]) || 600, h: num(a[4]) || 600, text });
        this.openBlock(text);
        return;
      }
      case "add_ui": {
        if (!a[0]) return;
        const text = new TextStream();
        this.onAction({ kind: "add_ui", id: a[0], x: num(a[1]), y: num(a[2]), w: num(a[3]) || 420, h: num(a[4]) || null, text });
        this.openBlock(text);
        return;
      }
      case "add_proto": {
        if (!a[0]) return;
        // `[h]` is optional: a number in the fifth slot is the height, else the design system starts there.
        const rest = a.slice(4);
        const h = /^\d+(\.\d+)?$/.test(rest[0] ?? "") ? num(rest.shift()) || null : null;
        const text = new TextStream();
        this.onAction({
          kind: "add_proto",
          id: a[0],
          x: num(a[1]),
          y: num(a[2]),
          w: num(a[3]) || 960,
          h,
          system: (rest[0] ?? "").toLowerCase(),
          viewport: rest[1]?.toLowerCase() === "mobile" ? "mobile" : "desktop",
          text,
        });
        this.openBlock(text);
        return;
      }
      case "cursor":
        this.onAction({ kind: "cursor", x: num(a[0]), y: num(a[1]) });
        return;
      case "handoff":
        if (a[0] && a.length > 1) this.onAction({ kind: "handoff", target: a[0], request: a.slice(1).join(" ") });
        return;
      case "say":
        this.onSay(a.join(" "));
        return;
    }
  }

  private openBlock(text: TextStream): void {
    this.block = text;
    this.mode = "block";
    this.curPushed = 0;
    this.needNL = false;
  }
}

// Comment pins on the board and the thread popover a pin opens (Figma-style). A pin sits on the
// card it was left on (it follows the card when moved) or on a board spot, drawn at screen size
// whatever the zoom, with the face of whoever started the thread. Its popover holds the thread:
// everyone's messages with faces, names and times, the reply an agent is writing as it streams,
// a reply box, and resolve or reopen. Resolved pins leave the board until opened again.
import { IconArrowUp, IconCircleCheck, IconCornerDownRight, IconRotate2, IconX } from "@tabler/icons-react";
import { type ReactFlowInstance, useStore } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Presence } from "../../canvas-live/src/shared";
import {
  type ThreadAnchor,
  type ThreadMap,
  type ThreadSnap,
  excerpt,
  pinAt,
  postInThread,
  setResolved,
  snapThreads,
} from "../../canvas-live/src/threads";
import { Face } from "./avatar";
import { ago, threadDraft } from "./comments";
import { useYSnapshot } from "./hooks";
import { doc, page, self } from "./room";

/** Pin size in screen px; its tip is its bottom-left corner. */
export const PIN = 30;
const POPOVER_W = 320;

/** A page's threads, live. */
export function useThreads(threads: Y.Map<ThreadMap>): ThreadSnap[] {
  return useYSnapshot(() => snapThreads(threads));
}

/** What a thread is on, for its header and its row: the card's title (from its page's `nodes`), "the board", or a removed card. */
export function threadPlace(anchor: ThreadAnchor, nodes: Y.Map<Y.Map<unknown>>): string {
  if (anchor.node === undefined) return "On the board";
  const title = nodes.get(anchor.node)?.get("title");
  if (title === undefined) return "Card removed";
  const text = String(title).trim();
  return text === "" ? anchor.node : excerpt(text, 40);
}

/** Pans (never zooms out past readable) so thread `t`'s pin sits a little left of center, with room for its popover. */
export function centerOnThread(rf: Pick<ReactFlowInstance, "getInternalNode" | "setCenter" | "getZoom">, t: ThreadSnap): void {
  const node = t.anchor.node === undefined ? undefined : rf.getInternalNode(t.anchor.node);
  const box = node
    ? { x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }
    : null;
  const at = pinAt(t.anchor, box);
  if (at === null) return;
  const zoom = Math.max(rf.getZoom(), 0.6);
  void rf.setCenter(at.x + POPOVER_W / 2 / zoom, at.y + 80 / zoom, { zoom, duration: 400 });
}

/** Every pin's tip in screen px (relative to the board), live as cards move and the camera pans. */
export function usePinSpots(threads: readonly ThreadSnap[]): Map<string, { x: number; y: number }> {
  const flat = useStore((s) => {
    const [tx, ty, zoom] = s.transform;
    const rows: string[] = [];
    for (const t of threads) {
      const node = t.anchor.node === undefined ? undefined : s.nodeLookup.get(t.anchor.node);
      const box = node
        ? {
            x: node.internals.positionAbsolute.x,
            y: node.internals.positionAbsolute.y,
            w: node.measured.width ?? node.width ?? 0,
            h: node.measured.height ?? node.height ?? 0,
          }
        : null;
      const p = pinAt(t.anchor, box);
      if (p !== null) rows.push(`${t.id}\t${String(Math.round(p.x * zoom + tx))}\t${String(Math.round(p.y * zoom + ty))}`);
    }
    return rows.join("\n");
  });
  return useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    if (flat === "") return out;
    for (const row of flat.split("\n")) {
      const [id = "", x = "0", y = "0"] = row.split("\t");
      out.set(id, { x: Number(x), y: Number(y) });
    }
    return out;
  }, [flat]);
}

export function Pins({
  threads,
  spots,
  openId,
  presences,
  onOpen,
}: {
  threads: readonly ThreadSnap[];
  spots: Map<string, { x: number; y: number }>;
  openId: string | null;
  presences: Map<number, Presence>;
  onOpen: (id: string | null) => void;
}) {
  return (
    <div className="cv-pins">
      {threads.map((t) => {
        const at = spots.get(t.id);
        const first = t.messages[0];
        if (at === undefined || first === undefined || (t.resolved && t.id !== openId)) return null;
        const busy = threadDraft(presences.values(), t) !== null;
        return (
          <button
            key={t.id}
            type="button"
            className={`cv-pin${t.id === openId ? " is-open" : ""}${t.resolved ? " is-resolved" : ""}`}
            style={{ transform: `translate(${String(at.x)}px, ${String(at.y - PIN)}px)` }}
            data-testid="canvas-pin"
            data-thread={t.id}
            aria-label={`Comment by ${first.name}: ${excerpt(first.text, 60)}`}
            title={excerpt(first.text, 80)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(t.id === openId ? null : t.id);
            }}
          >
            <Face who={first} size={22} />
            {busy ? <span className="cv-pin-busy" aria-hidden="true" /> : null}
            {t.messages.length > 1 ? <span className="cv-pin-count">{t.messages.length}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ThreadPopover({
  thread,
  at,
  bounds,
  sheet,
  presences,
  onClose,
}: {
  thread: ThreadSnap;
  /** The pin's tip in board px; null when its card is gone (the popover then sits top-left). */
  at: { x: number; y: number } | null;
  bounds: { width: number; height: number };
  /** Phones: a sheet at the bottom instead of a popover at the pin. */
  sheet: boolean;
  presences: Map<number, Presence>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);
  const draft = threadDraft(presences.values(), thread);
  const now = Date.now();
  // The popover only opens on the viewer's page.
  const { nodes, threads } = page();
  const place = threadPlace(thread.anchor, nodes);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [thread.messages.length, draft?.text]);
  useLayoutEffect(() => {
    const h = boxRef.current?.offsetHeight;
    if (h !== undefined && h !== height) setHeight(h);
  });

  const send = () => {
    const body = text.trim();
    if (body === "") return;
    doc.transact(() => {
      postInThread(threads, thread.id, {
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "human",
        name: self.name,
        color: self.color,
        text: body,
        ts: Date.now(),
      });
    });
    setText("");
  };

  // Beside the pin, inside the board.
  let style: React.CSSProperties | undefined;
  if (!sheet) {
    const x = at === null ? 16 : Math.min(at.x + 12, bounds.width - POPOVER_W - 12);
    const below = at === null ? 64 : at.y - PIN - 4;
    const y = Math.max(56, Math.min(below, bounds.height - height - 12));
    style = { transform: `translate(${String(Math.max(12, x))}px, ${String(y)}px)` };
  }

  return (
    <div
      ref={boxRef}
      className={`cv-thread${sheet ? " is-sheet" : ""}`}
      style={style}
      role="dialog"
      aria-label={`Comment thread ${place}`}
      data-testid="canvas-thread"
      data-thread={thread.id}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="cv-thread-head">
        <span className="cv-thread-place">
          <IconCornerDownRight size={14} stroke={1.75} aria-hidden="true" />
          {place}
        </span>
        {thread.resolved ? <span className="cv-thread-state">Resolved</span> : null}
        <button
          type="button"
          className="cv-thread-btn"
          aria-label={thread.resolved ? "Reopen" : "Resolve"}
          title={thread.resolved ? "Reopen" : "Resolve"}
          data-testid="canvas-thread-resolve"
          onClick={() => {
            setResolved(threads, thread.id, !thread.resolved);
            if (!thread.resolved) onClose();
          }}
        >
          {thread.resolved ? <IconRotate2 size={16} stroke={1.75} /> : <IconCircleCheck size={16} stroke={1.75} />}
        </button>
        <button type="button" className="cv-thread-btn" aria-label="Close" title="Close" onClick={onClose}>
          <IconX size={16} stroke={1.75} />
        </button>
      </header>
      <div className="cv-thread-msgs" ref={listRef}>
        {thread.messages.map((m) => (
          <div key={m.id} className="cv-thread-msg" data-kind={m.kind}>
            <Face who={m} size={24} />
            <div className="cv-thread-body">
              <div className="cv-thread-meta">
                <b>{m.name}</b>
                <time dateTime={new Date(m.ts).toISOString()} title={new Date(m.ts).toLocaleString()}>
                  {ago(m.ts, now)}
                </time>
              </div>
              <div className="cv-thread-text">{m.text}</div>
            </div>
          </div>
        ))}
        {draft !== null ? (
          <div className="cv-thread-msg is-draft" data-kind="agent">
            <Face who={draft.user} size={24} />
            <div className="cv-thread-body">
              <div className="cv-thread-meta">
                <b>{draft.user.name}</b>
                {draft.text === "" ? <span>{draft.label}</span> : null}
              </div>
              {draft.text === "" ? (
                <span className="cv-typing-dots" aria-label="writing" />
              ) : (
                <div className="cv-thread-text">{draft.text}</div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      {/* No <form>: Relay Desktop embeds the room in a sandboxed iframe without allow-forms, where a submit never fires. */}
      <div className="cv-thread-reply">
        <input
          aria-label="Reply"
          placeholder={thread.resolved ? "Reply to reopen" : "Reply"}
          enterKeyHint="send"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") onClose();
          }}
        />
        <button type="button" className="cv-thread-send" aria-label="Send" disabled={text.trim() === ""} onClick={send}>
          <IconArrowUp size={16} stroke={2} />
        </button>
      </div>
    </div>
  );
}

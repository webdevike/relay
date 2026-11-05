// Comment pins on the board and the thread popover a pin opens (Figma-style). A pin sits on the
// card it was left on (it follows the card when moved) or on a board spot, drawn at screen size
// whatever the zoom, with the face of whoever started the thread. Its popover holds the thread:
// everyone's messages with faces, names and times, the reply an agent is writing as it streams,
// a reply box, and resolve or reopen. Resolved pins leave the board until opened again.
import { IconArrowUp, IconCircleCheck, IconCornerDownRight, IconRotate2, IconX } from "@tabler/icons-react";
import { type ReactFlowInstance, useReactFlow, useStore } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { DRAG_THRESHOLD, OffsetMemory, anchorAtPoint, clampOffset } from "../../canvas-live/src/pindrag";
import type { Presence } from "../../canvas-live/src/shared";
import {
  type ThreadAnchor,
  type ThreadMap,
  type ThreadSnap,
  type Box,
  excerpt,
  pinAt,
  postInThread,
  setResolved,
  moveThread,
  snapThreads,
} from "../../canvas-live/src/threads";
import { Face } from "./avatar";
import { ago, threadDraft } from "./comments";
import { useMentionables, useYSnapshot } from "./hooks";
import { MentionInput } from "./mention-input";
import { doc, page, self } from "./room";

/** Pin size in screen px; its tip is its bottom-left corner. */
export const PIN = 30;
const POPOVER_W = 320;
/** Where each thread's popover was dragged to, for this page load. */
const popoverOffsets = new OffsetMemory();

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
  movable = true,
}: {
  threads: readonly ThreadSnap[];
  spots: Map<string, { x: number; y: number }>;
  openId: string | null;
  presences: Map<number, Presence>;
  onOpen: (id: string | null) => void;
  /** Pins can be dragged to another card or spot. */
  movable?: boolean;
}) {
  const rf = useReactFlow();
  const press = useRef<{ id: string; x0: number; y0: number; grabDx: number; grabDy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const boxes = (): Map<string, Box> => {
    const out = new Map<string, Box>();
    for (const n of rf.getNodes()) {
      const internal = rf.getInternalNode(n.id);
      if (internal === undefined) continue;
      out.set(n.id, { x: internal.internals.positionAbsolute.x, y: internal.internals.positionAbsolute.y, w: internal.measured.width ?? 0, h: internal.measured.height ?? 0 });
    }
    return out;
  };
  return (
    <div className="cv-pins">
      {threads.map((t) => {
        const at = spots.get(t.id);
        const first = t.messages[0];
        if (at === undefined || first === undefined || (t.resolved && t.id !== openId)) return null;
        const busy = threadDraft(presences.values(), t) !== null;
        const d = drag?.id === t.id ? drag : null;
        return (
          <button
            key={t.id}
            type="button"
            className={`cv-pin${t.id === openId ? " is-open" : ""}${t.resolved ? " is-resolved" : ""}${d ? " is-dragging" : ""}`}
            style={{ transform: `translate(${String(at.x + (d?.dx ?? 0))}px, ${String(at.y - PIN + (d?.dy ?? 0))}px)` }}
            data-testid="canvas-pin"
            data-thread={t.id}
            aria-label={`Comment by ${first.name}: ${excerpt(first.text, 60)}`}
            title={excerpt(first.text, 80)}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (!movable || e.button !== 0) return;
              const r = e.currentTarget.getBoundingClientRect();
              press.current = { id: t.id, x0: e.clientX, y0: e.clientY, grabDx: e.clientX - r.left, grabDy: e.clientY - r.bottom, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const p = press.current;
              if (p === null || p.id !== t.id) return;
              const dx = e.clientX - p.x0;
              const dy = e.clientY - p.y0;
              if (!p.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
              p.moved = true;
              setDrag({ id: t.id, dx, dy });
            }}
            onPointerUp={(e) => {
              const p = press.current;
              press.current = null;
              setDrag(null);
              if (p === null || p.id !== t.id || !p.moved) return;
              suppressClick.current = true;
              // The tip lands where it was dropped: on the card under it, else on the board.
              const drop = rf.screenToFlowPosition({ x: e.clientX - p.grabDx, y: e.clientY - p.grabDy });
              moveThread(page().threads, t.id, anchorAtPoint(drop, boxes()));
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
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
  const [offset, setOffset] = useState(() => popoverOffsets.get(thread.id));
  let base = { x: 0, y: 0, w: POPOVER_W, h: height };
  // Drag the popover by its header: it keeps where it was put for this session, on screen.
  const startDrag = (e: React.PointerEvent) => {
    if (sheet || e.button !== 0 || (e.target as Element).closest("button")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const from = clampOffset(base, offset, { w: bounds.width, h: bounds.height });
    const move = (m: PointerEvent) => {
      const next = clampOffset(base, { dx: from.dx + m.clientX - x0, dy: from.dy + m.clientY - y0 }, { w: bounds.width, h: bounds.height });
      popoverOffsets.set(thread.id, next);
      setOffset(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Esc closes the popover wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const draft = threadDraft(presences.values(), thread);
  const now = Date.now();
  const mentionables = useMentionables();
  const assignee = thread.assignee === undefined ? undefined : mentionables.find((c) => c.id === thread.assignee);
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
    const x = Math.max(12, at === null ? 16 : Math.min(at.x + 12, bounds.width - POPOVER_W - 12));
    const below = at === null ? 64 : at.y - PIN - 4;
    const y = Math.max(56, Math.min(below, bounds.height - height - 12));
    base = { x, y, w: POPOVER_W, h: height };
    const o = clampOffset(base, offset, { w: bounds.width, h: bounds.height });
    style = { transform: `translate(${String(x + o.dx)}px, ${String(y + o.dy)}px)` };
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
      <header className="cv-thread-head" data-testid="canvas-thread-head" onPointerDown={startDrag}>
        <span className="cv-thread-place">
          <IconCornerDownRight size={14} stroke={1.75} aria-hidden="true" />
          {place}
        </span>
        {assignee !== undefined ? (
          <span className="cv-thread-for" data-testid="canvas-thread-assignee" data-agent={assignee.id} title={`${assignee.name} answers this thread`}>
            <Face who={{ name: assignee.name, color: assignee.color ?? "#8b5cf6", kind: "agent", avatar: assignee.avatar }} size={16} />
            {assignee.name}
          </span>
        ) : null}
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
        <MentionInput
          aria-label="Reply"
          placeholder={thread.resolved ? "Reply to reopen, @ for an agent" : "Reply, @ for an agent"}
          enterKeyHint="send"
          value={text}
          candidates={mentionables}
          onChange={setText}
          onEnter={send}
          onEscape={onClose}
        />
        <button type="button" className="cv-thread-send" aria-label="Send" disabled={text.trim() === ""} onClick={send}>
          <IconArrowUp size={16} stroke={2} />
        </button>
      </div>
    </div>
  );
}

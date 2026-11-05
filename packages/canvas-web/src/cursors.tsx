// Everyone else's cursor on this viewer's page: name tag, live cursor-chat draft or bubble, the
// agent's avatar and status, its caret-following glide and the line it drags when connecting two
// nodes. The camera never chases the agent unless the viewer turned Follow on (then follow mode
// takes the viewer to the agent's page when it changes pages, and pans the board so the agent
// stays in view while it works). When the agent works off-screen, a small avatar chip at the
// viewport edge points to where, and a click jumps there. An agent's cursor shows only while it is
// doing something (a turn or batch running, a new line said, a move) and fades out AGENT_LINGER_MS
// after; people's cursors always show.
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import { pagesOf } from "../../canvas-live/src/pages";
import { Face } from "./avatar";
import { onPage, presencePage } from "./boardpages";
import { useCurrentPage, useThrottledPresence } from "./hooks";
import { awareness, doc, env, presenceStates, setPage } from "./room";

/** Follow the agent like following a presenter; off until the toolbar toggle (or `follow=1`) turns it on. */
export const follow = { on: env.follow };
/** How long follow keeps panning after the agent's cursor stops moving. */
const FOLLOW_SETTLE_MS = 2500;
/** How long an agent's cursor stays after its last action or line before it fades out. */
const AGENT_LINGER_MS = 3000;
/** The page each agent was last seen on (kept across the board's remount on a page switch). */
const agentPages = new Map<number, string>();

/** Takes a following viewer to `page` when the board still has it. */
export function followToPage(page: string): void {
  if (pagesOf(doc).some((p) => p.id === page)) setPage(page);
}

export function CursorArrow({ color }: { color: string }) {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
      <path
        d="M1 1 L1 17 L5.5 13 L8.5 20.5 L11.5 19.2 L8.6 12 L15 12 Z"
        fill={color}
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATUS_LABEL: Record<string, string> = {
  thinking: "thinking",
  typing: "writing",
  drawing: "connecting",
};

export function Cursors({
  wrapRef,
  bottomInset,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  bottomInset: number;
}) {
  const states = useThrottledPresence();
  const page = useCurrentPage();
  const store = useStoreApi();
  const rf = useReactFlow();
  const els = useRef(new Map<number, HTMLDivElement>());
  const lineRef = useRef<SVGPathElement>(null);
  const smooth = useRef(new Map<number, { x: number; y: number }>());
  const chips = useRef(new Map<number, { root: HTMLButtonElement; arrow: HTMLSpanElement }>());
  // When each agent's cursor target last changed: follow keeps panning until a point lands, even
  // after the agent has gone idle (an opener that ends with "@point" otherwise stops mid-pan).
  const moved = useRef(new Map<number, { x: number; y: number; at: number }>());
  // When each agent last did something (worked, said a new line, moved), and the line it said.
  const active = useRef(new Map<number, { at: number; said: string }>());
  const inset = useRef(bottomInset);
  inset.current = bottomInset;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const wrap = wrapRef.current?.getBoundingClientRect();
      const [tx, ty, zoom] = store.getState().transform;
      let line = "";
      let lineColor = "";
      if (wrap) {
        for (const [cid, p] of presenceStates()) {
          if (cid === awareness.clientID) continue;
          if (p.user?.kind === "agent") {
            const at = presencePage(p);
            const was = agentPages.get(cid);
            agentPages.set(cid, at);
            // Following: the agent went to another page, so does the viewer (the board then remounts).
            if (follow.on && was !== undefined && was !== at && at !== page) followToPage(at);
          }
          const el = els.current.get(cid);
          if (!el) continue;
          if (!p.cursor || !onPage(p, page)) {
            el.style.opacity = "0";
            smooth.current.delete(cid);
            continue;
          }
          let target = p.cursor;
          // While the agent types, its cursor sits on its caret inside the node.
          if (p.typing) {
            const caret = document.querySelector(`[data-caret="${cid}"]`);
            if (caret) {
              const r = caret.getBoundingClientRect();
              target = {
                x: (r.left - wrap.left + 2 - tx) / zoom,
                y: (r.bottom - wrap.top - 4 - ty) / zoom,
              };
            }
          }
          const cur = smooth.current.get(cid) ?? { ...target };
          const k = 1 - Math.exp(-dt / (p.user?.kind === "agent" ? 55 : 30));
          cur.x += (target.x - cur.x) * k;
          cur.y += (target.y - cur.y) * k;
          smooth.current.set(cid, cur);
          const rx = cur.x * zoom + tx;
          const ry = cur.y * zoom + ty;
          const off = rx < 0 || ry < 0 || rx > wrap.width || ry > wrap.height;
          const sx = Math.max(4, Math.min(wrap.width - 70, rx));
          const sy = Math.max(4, Math.min(wrap.height - 40, ry));
          el.style.transform = `translate(${sx}px, ${sy}px)`;
          const isAgent = p.user?.kind === "agent";
          if (isAgent) {
            const said = p.bubble?.text ?? "";
            const was = active.current.get(cid);
            const busy =
              (p.status !== undefined && p.status !== "idle") || p.bubble?.streaming === true;
            const lastMove = moved.current.get(cid);
            const stepped =
              lastMove !== undefined && (lastMove.x !== target.x || lastMove.y !== target.y);
            // First sight (a page just loaded): an idle agent starts hidden, its old bubble no news.
            if (was === undefined)
              active.current.set(cid, { at: busy ? now : -AGENT_LINGER_MS, said });
            else if (busy || stepped || (said !== "" && said !== was.said))
              active.current.set(cid, { at: now, said: said || was.said });
          }
          const shown =
            !isAgent || now - (active.current.get(cid)?.at ?? -AGENT_LINGER_MS) < AGENT_LINGER_MS;
          el.style.opacity = shown ? "1" : "0";
          el.classList.toggle("is-offscreen", off && shown);
          const chip = chips.current.get(cid);
          if (chip) {
            const showChip = isAgent && shown && off;
            chip.root.style.opacity = showChip ? "1" : "0";
            chip.root.style.pointerEvents = showChip ? "auto" : "none";
            if (showChip) {
              // Where the ray from the viewport's center to the agent leaves the viewport, inset a little.
              const hx = wrap.width / 2;
              const hy = wrap.height / 2;
              const vx = rx - hx;
              const vy = ry - hy;
              const t = Math.min(
                (hx - 30) / Math.max(1, Math.abs(vx)),
                (hy - 30) / Math.max(1, Math.abs(vy)),
              );
              chip.root.style.transform = `translate(${hx + vx * t - 16}px, ${hy + vy * t - 16}px)`;
              chip.arrow.style.transform = `rotate(${Math.atan2(vy, vx)}rad)`;
            }
          }
          const lastMove = moved.current.get(cid);
          if (lastMove === undefined || lastMove.x !== target.x || lastMove.y !== target.y)
            moved.current.set(cid, { x: target.x, y: target.y, at: now });
          const settling = now - (moved.current.get(cid)?.at ?? 0) < FOLLOW_SETTLE_MS;
          if (
            follow.on &&
            p.user?.kind === "agent" &&
            ((p.status && p.status !== "idle") || settling)
          ) {
            const m = Math.min(140, wrap.width * 0.2);
            // Room on the right and below for the agent's bubble (and the phone's composer).
            const right = Math.min(300, wrap.width * 0.45);
            const below = 120 + inset.current;
            const dx =
              rx < m ? m - rx : rx > wrap.width - m - right ? wrap.width - m - right - rx : 0;
            const dy =
              ry < m ? m - ry : ry > wrap.height - m - below ? wrap.height - m - below - ry : 0;
            if (dx || dy) {
              const kk = 1 - Math.exp(-dt / 260);
              void rf.setViewport({ x: tx + dx * kk, y: ty + dy * kk, zoom });
            }
          }
          if (p.connecting) {
            const n = store.getState().nodeLookup.get(p.connecting.source);
            if (n) {
              const w = n.measured.width ?? 300;
              const h = n.measured.height ?? 150;
              const nx = n.internals.positionAbsolute.x;
              const ny = n.internals.positionAbsolute.y;
              const fromRight = cur.x > nx + w / 2;
              const x0 = (fromRight ? nx + w : nx) * zoom + tx;
              const y0 = (ny + h / 2) * zoom + ty;
              const mx = (x0 + rx) / 2;
              line = `M${x0},${y0} C${mx},${y0} ${mx},${ry} ${rx},${ry}`;
              lineColor = p.user.color;
            }
          }
        }
      }
      if (lineRef.current) {
        lineRef.current.setAttribute("d", line);
        lineRef.current.setAttribute("stroke", lineColor);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store, wrapRef, rf, page]);

  return (
    <div className="cv-cursors">
      <svg className="cv-cursor-lines" aria-hidden="true">
        <path ref={lineRef} strokeWidth={2.5} strokeDasharray="6 5" fill="none" />
      </svg>
      {[...states].map(([cid, p]) => {
        if (cid === awareness.clientID || !p.user || !onPage(p, page)) return null;
        const agent = p.user.kind === "agent";
        // What it is doing off the board ("building the mockup…") reads better than a bare "thinking".
        const status = agent ? (p.doing ?? (p.status ? STATUS_LABEL[p.status] : undefined)) : undefined;
        // A reply written in a comment thread shows in the thread, not at the cursor.
        const bubbleText = p.draft != null ? p.draft : p.bubble?.thread ? undefined : p.bubble?.text;
        return (
          <div
            key={cid}
            className={`cv-cursor${agent ? " is-agent" : ""} status-${p.status ?? "idle"}`}
            data-testid={`cursor-${p.user.name}`}
            ref={(el) => {
              if (el) els.current.set(cid, el);
              else els.current.delete(cid);
            }}
          >
            <CursorArrow color={p.user.color} />
            <div className="cv-cursor-label" style={{ background: p.user.color }}>
              {agent ? <Face who={p.user} size={20} className="cv-avatar" /> : null}
              {agent ? <span className="cv-dot" /> : null}
              {p.user.name}
              {status ? <span className="cv-status-text">{status}</span> : null}
            </div>
            {bubbleText != null && (bubbleText !== "" || p.draft != null) ? (
              <div
                className={`cv-cursor-bubble${p.draft != null ? " is-draft" : ""}${p.bubble?.streaming ? " is-streaming" : ""}`}
                style={{ borderColor: p.user.color, "--who": p.user.color } as CSSProperties}
              >
                {bubbleText || <span className="cv-typing-dots" />}
              </div>
            ) : null}
          </div>
        );
      })}
      {[...states].map(([cid, p]) => {
        if (cid === awareness.clientID || p.user?.kind !== "agent" || !onPage(p, page)) return null;
        return (
          <button
            key={`chip-${cid}`}
            type="button"
            className="cv-edge-chip"
            data-testid={`edge-chip-${p.user.name}`}
            title={`${p.user.name} is working here. Jump to ${p.user.name}`}
            style={{ "--who": p.user.color } as CSSProperties}
            ref={(el) => {
              const arrow = el?.querySelector<HTMLSpanElement>(".cv-edge-arrow");
              if (el && arrow) chips.current.set(cid, { root: el, arrow });
              else chips.current.delete(cid);
            }}
            onClick={() => {
              const at = smooth.current.get(cid) ?? presenceStates().get(cid)?.cursor;
              if (at) void rf.setCenter(at.x, at.y, { zoom: rf.getZoom(), duration: 450 });
            }}
          >
            <span className="cv-edge-arrow" aria-hidden="true" />
            <Face who={p.user} size={32} className="cv-edge-avatar" />
          </button>
        );
      })}
    </div>
  );
}

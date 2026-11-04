import {
  IconBoxMultiple,
  IconCornerDownRight,
  IconEye,
  IconLock,
  IconLockOpen,
  IconLayoutDistributeHorizontal,
  IconMessageCircle,
  IconMoon,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import {
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionMode,
  type Node,
  type NodeChange,
  SelectionMode,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { CanvasLayout } from "../../canvas-live/src/layout";
import type { ChatMsg, ClientMetrics } from "../../canvas-live/src/shared";
import { CanvasCard } from "./cards";
import { CursorArrow, Cursors, follow } from "./cursors";
import { CanvasEdge } from "./edge";
import { postEmbed } from "./embed";
import { useAgent, useConnection, useSession } from "./hooks";
import { SideLog } from "./log";
import {
  type CardNode,
  type FlowBox,
  LOCAL_ORIGIN,
  type LinkEdge,
  absolutePositions,
  deleteNodes,
  framesWithOutsideChildren,
  groupNodes,
  reparentDropped,
  snapEdges,
  snapNodes,
  toFlowEdges,
  toFlowNodes,
  toggleId,
  ungroupFrames,
} from "./model";
import { pageTheme, useScheme } from "./page-theme";
import { ActivityPill } from "./pill";
import { canEdit, flowInteraction } from "./lock";
import { ArrivalTracker } from "./arrival";
import { arrivals } from "./page-arrival";
import { pageLock, useLocked } from "./page-lock";
import {
  awareness,
  doc,
  env,
  presenceStates,
  provider,
  qa,
  self,
  setPresence,
  subscribePresence,
  undo,
  yChat,
  yEdges,
  yMeta,
  yMetrics,
  yNodes,
  ySettings,
} from "./room";
import { useTidy, useTidySetting } from "./useTidy";

const NODE_TYPES = { card: CanvasCard };
const EDGE_TYPES = { link: CanvasEdge };
const SEARCH = new URLSearchParams(location.search);
/** Own cursor drawn in the page, for headless recordings that have no OS pointer. */
const SHOW_OWN_CURSOR = SEARCH.has("showcursor");

/** Touch-first UI: phone embed, or a coarse pointer on the plain web page. */
const TOUCH =
  env.embed === "phone" || (env.embed === "web" && matchMedia("(pointer: coarse)").matches);

function boardLayout(): CanvasLayout | undefined {
  const l = yMeta.get("layout");
  return l === "grid" || l === "tree" || l === "flow" ? l : undefined;
}

/** Keyboard height over the page (phones), from the visual viewport. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/** Client-measured latency of the agent's reply to `msgId`, from Enter. */
function trackLatency(msgId: string) {
  const t0 = performance.now();
  const m: ClientMetrics = { cursor: null, firstToken: null, done: null };
  let started = false;
  const off = subscribePresence(() => {
    for (const [, p] of presenceStates()) {
      if (p.user?.kind !== "agent" || p.replyTo !== msgId) continue;
      const now = performance.now() - t0;
      if (p.status && p.status !== "idle") started = true;
      if (m.cursor === null && started) m.cursor = now;
      if (m.firstToken === null && p.bubble?.text) m.firstToken = now;
      if (m.done === null && started && p.status === "idle") {
        m.done = now;
        yMetrics.set(`c:${msgId}`, m);
        off();
      }
    }
  });
  // A reply that never comes must not keep a listener forever.
  setTimeout(off, 120_000);
}

function Board({ logOpen, onOpenLog }: { logOpen: boolean; onOpenLog: () => void }) {
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [edges, setEdges] = useState<LinkEdge[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow<CardNode, LinkEdge>();
  const store = useStoreApi<CardNode, LinkEdge>();
  const initialized = useNodesInitialized();
  const didFit = useRef(false);
  /** The board stays faded out until the first fit has landed, so opening never shows a pan or zoom. */
  const [opening, setOpening] = useState(true);
  const [following, setFollowing] = useState(follow.on);
  const pointer = useRef({ sx: 0, sy: 0, fx: 0, fy: 0 });
  const ownCursorRef = useRef<HTMLDivElement>(null);
  const [chat, setChat] = useState<{ sx: number; sy: number; text: string } | null>(null);
  const [ownBubble, setOwnBubble] = useState<{ sx: number; sy: number; text: string } | null>(null);
  const connection = useConnection();
  const session = useSession();
  const agent = useAgent();
  const keyboard = useKeyboardInset();
  const ended = session?.open === false;
  /** Absolute positions as last drawn, to write drags back as file coordinates. */
  const absRef = useRef(new Map<string, { x: number; y: number }>());
  const tidy = useTidy();
  const locked = useLocked();
  const editable = canEdit({ locked, ended: session?.open === false });
  const interaction = flowInteraction(locked, TOUCH);
  const tidyOn = useTidySetting();
  // Scripted QA (zoom and screenshot checks) drives the viewport through this.
  useEffect(() => {
    qa.rf = rf;
  }, [rf]);

  /** A pan or zoom that ends between device pixels redraws text and borders soft: settle on a whole device pixel. */
  const snapViewport = useCallback(
    (_: unknown, v: { x: number; y: number; zoom: number }) => {
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(v.x * dpr) / dpr;
      const y = Math.round(v.y * dpr) / dpr;
      if (x !== v.x || y !== v.y) void rf.setViewport({ x, y, zoom: v.zoom });
    },
    [rf],
  );
  const arrivalTracker = useRef(new ArrivalTracker()).current;
  /** Doc to React Flow; drawn sizes from the previous pass feed placement and frame growth. */
  const readDoc = useCallback(() => {
    const specs = snapNodes(yNodes);
    for (const id of arrivalTracker.observe(specs.map((s) => s.id))) {
      const type = yNodes.get(id)?.get("type");
      // A frame holds other cards: it never hides them behind a skeleton.
      if (type === "frame") continue;
      arrivals.start(id, type !== "image" && type !== "ui" && type !== "proto");
    }
    const edgeSnaps = snapEdges(yEdges);
    const layout = boardLayout();
    setNodes((prev) => {
      const measured = new Map<string, { w: number; h: number }>();
      for (const n of prev)
        if (n.measured?.width && n.measured.height)
          measured.set(n.id, { w: n.measured.width, h: n.measured.height });
      const input = { nodes: specs, edges: edgeSnaps, layout, measured };
      absRef.current = absolutePositions(input);
      return toFlowNodes(input, prev);
    });
    setEdges(toFlowEdges(edgeSnaps, new Set(specs.map((s) => s.id))));
  }, [arrivalTracker]);

  // Cards that show up after the board has synced (an agent or someone else adding them) arrive
  // as skeletons; the ones it opened with, and anything a resync brings, just appear.
  useEffect(() => {
    const arm = () => arrivalTracker.baseline(yNodes.keys());
    const onSync = (synced: boolean) => (synced ? arm() : arrivalTracker.disarm());
    if (provider.synced) arm();
    provider.on("sync", onSync);
    return () => provider.off("sync", onSync);
  }, [arrivalTracker]);

  useEffect(() => {
    readDoc();
    yNodes.observeDeep(readDoc);
    yEdges.observeDeep(readDoc);
    yMeta.observe(readDoc);
    return () => {
      yNodes.unobserveDeep(readDoc);
      yEdges.unobserveDeep(readDoc);
      yMeta.unobserve(readDoc);
    };
  }, [readDoc]);

  // Open at a readable zoom: fit the board once, with no animation (or start at its top-left when
  // fitting makes text tiny), then stay put: cards the agent adds later never move the camera.
  useEffect(() => {
    if (!initialized || didFit.current || !nodes.length) return;
    didFit.current = true;
    // Now that cards have real heights, frames and unplaced nodes settle around them.
    readDoc();
    void rf.fitView({ padding: 0.08, duration: 0 }).then(() => {
      if (rf.getZoom() < 0.6) {
        const b = rf.getNodesBounds(nodes.map((n) => n.id));
        const z = TOUCH ? 0.7 : 0.75;
        void rf.setViewport({ x: -b.x * z + 24, y: -b.y * z + 64, zoom: z });
      }
      setOpening(false);
    });
  }, [initialized, nodes, rf, readDoc]);
  // An empty board (or one that never measures) has nothing to fit: show it anyway.
  useEffect(() => {
    const t = window.setTimeout(() => setOpening(false), 2000);
    return () => window.clearTimeout(t);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      tidy.sizesChanged(changes);
      doc.transact(() => {
        for (const c of changes) {
          if (c.type !== "position" || !c.dragging || !c.position) continue;
          // React Flow reports a child's position relative to its frame; the file keeps absolute ones.
          const parentId = store.getState().nodeLookup.get(c.id)?.parentId;
          const origin = parentId ? absRef.current.get(parentId) : undefined;
          const next = origin
            ? { x: c.position.x + origin.x, y: c.position.y + origin.y }
            : c.position;
          const m = yNodes.get(c.id);
          const was = absRef.current.get(c.id);
          if (!m) continue;
          const x = Math.round(next.x);
          const y = Math.round(next.y);
          m.set("x", x);
          m.set("y", y);
          // The file keeps absolute positions: a frame's children move with it.
          if (was && m.get("type") === "frame" && (x !== was.x || y !== was.y)) {
            const dx = x - was.x;
            const dy = y - was.y;
            const inFrame = (id: string): boolean => {
              for (
                let p = yNodes.get(id)?.get("parent"), guard = 0;
                typeof p === "string" && guard < 64;
                p = yNodes.get(p)?.get("parent"), guard++
              )
                if (p === c.id) return true;
              return false;
            };
            for (const [id, child] of yNodes) {
              const at = absRef.current.get(id);
              if (!at || !inFrame(id)) continue;
              child.set("x", at.x + dx);
              child.set("y", at.y + dy);
            }
          }
        }
      }, LOCAL_ORIGIN);
    },
    [store, tidy],
  );

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const e = new Y.Map<unknown>();
    e.set("source", c.source);
    e.set("target", c.target);
    if (c.sourceHandle) e.set("sourceHandle", c.sourceHandle);
    if (c.targetHandle) e.set("targetHandle", c.targetHandle);
    yEdges.set(`e-${c.source}-${c.target}-${Date.now().toString(36)}`, e);
  }, []);

  const selectedRef = useRef<string[]>([]);
  /** Selection as it was when the current press began (React Flow replaces it on press). */
  const selBefore = useRef<string[]>([]);
  /** Touch multi-select: after a long press, taps toggle cards until nothing is selected. */
  const multiTouch = useRef(false);
  const forced = useRef<string[] | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const [ask, setAsk] = useState<{ ids: string[]; frames: string[] } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    const ids = sel.map((n) => n.id);
    selectedRef.current = ids;
    if (ids.length === 0) multiTouch.current = false;
    setSelectedIds(ids);
    setPresence("selected", ids);
  }, []);

  const setSelection = useCallback((ids: readonly string[]) => {
    const want = new Set(ids);
    setNodes((nds) =>
      nds.map((n) => (!!n.selected === want.has(n.id) ? n : { ...n, selected: want.has(n.id) })),
    );
  }, []);

  /** Deletes now; a frame that still holds other cards first asks (keeping them is the default). */
  const requestDelete = useCallback(() => {
    const ids = selectedRef.current.filter((id) => yNodes.has(id));
    if (ids.length === 0 || !editable) return;
    const frames = framesWithOutsideChildren(yNodes, ids);
    if (frames.length > 0) {
      setAsk({ ids, frames });
      return;
    }
    doc.transact(() => {
      deleteNodes(yNodes, yEdges, ids);
    }, LOCAL_ORIGIN);
    undo.stopCapturing();
  }, [editable]);

  const confirmDelete = (keepChildren: boolean) => {
    if (!ask) return;
    doc.transact(() => {
      deleteNodes(yNodes, yEdges, ask.ids, keepChildren);
    }, LOCAL_ORIGIN);
    undo.stopCapturing();
    setAsk(null);
  };

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPressStart = (e: React.PointerEvent) => {
    selBefore.current = selectedRef.current;
    if (e.pointerType !== "touch") return;
    const id = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset["id"];
    if (!id) return;
    cancelPress();
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        multiTouch.current = true;
        forced.current = toggleId(selBefore.current, id);
        setSelection(forced.current);
        navigator.vibrate?.(10);
      }, 450),
    };
  };
  const onPressMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress();
  };
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!TOUCH) return;
      if (forced.current) {
        setSelection(forced.current);
        forced.current = null;
      } else if (multiTouch.current) {
        setSelection(toggleId(selBefore.current, node.id));
      }
    },
    [setSelection],
  );

  /** Every node as drawn: absolute top-left and measured size. */
  const flowBoxes = useCallback((): FlowBox[] => {
    const out: FlowBox[] = [];
    for (const [id, n] of store.getState().nodeLookup) {
      out.push({
        id,
        type: n.data.spec.type,
        x: n.internals.positionAbsolute.x,
        y: n.internals.positionAbsolute.y,
        w: n.measured.width ?? n.width ?? 0,
        h: n.measured.height ?? n.height ?? 0,
      });
    }
    return out;
  }, [store]);

  /** A card dropped into a frame joins it; dropped out of one, it leaves. One undo step per drag. */
  const onDragStart = useCallback<OnNodeDrag<CardNode>>(
    (e, node, dragged) => {
      undo.stopCapturing();
      tidy.onNodeDragStart(e, node, dragged);
    },
    [tidy],
  );
  const onDragStop = useCallback<OnNodeDrag<CardNode>>(
    (e, node, dragged) => {
      const ids = dragged.map((n) => n.id);
      doc.transact(() => {
        reparentDropped(yNodes, flowBoxes(), ids);
      }, LOCAL_ORIGIN);
      undo.stopCapturing();
      tidy.onNodeDragStop(e, node, dragged);
    },
    [flowBoxes, tidy],
  );

  const group = useCallback(() => {
    if (selectedIds.length < 2 || !editable) return;
    const id = `grp-${Date.now().toString(36)}`;
    doc.transact(() => {
      groupNodes(yNodes, flowBoxes(), selectedIds, id);
    }, LOCAL_ORIGIN);
    undo.stopCapturing();
  }, [selectedIds, flowBoxes, editable]);

  /** The frames to dissolve: the selected ones, else the frames that hold the selected cards. */
  const ungroupTargets = (): string[] => {
    const frames = selectedIds.filter((id) => yNodes.get(id)?.get("type") === "frame");
    if (frames.length > 0) return frames;
    const up = new Set<string>();
    for (const id of selectedIds) {
      const p = yNodes.get(id)?.get("parent");
      if (typeof p === "string" && yNodes.get(p)?.get("type") === "frame") up.add(p);
    }
    return [...up];
  };
  const canUngroup = ungroupTargets().length > 0;
  const ungroup = useCallback(() => {
    const targets = ungroupTargets();
    if (targets.length === 0 || !editable) return;
    doc.transact(() => {
      ungroupFrames(yNodes, targets);
    }, LOCAL_ORIGIN);
    undo.stopCapturing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, editable]);

  /** Own pointer: screen spot for popups, flow spot for everyone else (one awareness update per frame). */
  const rafPending = useRef(0);
  const trackPointer = useCallback(
    (clientX: number, clientY: number, now: boolean) => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const f = rf.screenToFlowPosition({ x: clientX, y: clientY });
      pointer.current = { sx: clientX - r.left, sy: clientY - r.top, fx: f.x, fy: f.y };
      if (ownCursorRef.current)
        ownCursorRef.current.style.transform = `translate(${pointer.current.sx}px, ${pointer.current.sy}px)`;
      if (now) {
        setPresence("cursor", { x: f.x, y: f.y });
        return;
      }
      if (rafPending.current) return;
      rafPending.current = requestAnimationFrame(() => {
        rafPending.current = 0;
        setPresence("cursor", { x: pointer.current.fx, y: pointer.current.fy });
      });
    },
    [rf],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    // Touch has no hover: its cursor is the last tap.
    if (e.pointerType === "touch") return;
    trackPointer(e.clientX, e.clientY, false);
    if (chat && !TOUCH)
      setChat((c) => (c ? { ...c, sx: pointer.current.sx, sy: pointer.current.sy } : c));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") trackPointer(e.clientX, e.clientY, true);
  };

  const openChat = useCallback(() => {
    if (ended) return;
    // No pointer yet (keyboard, or a phone before its first tap): the selected node, else the middle.
    if (!pointer.current.sx && !pointer.current.sy) {
      const r = wrapRef.current?.getBoundingClientRect();
      const first = selectedIds[0];
      const sel = first ? rf.getInternalNode(first) : null;
      const [tx, ty, zoom] = store.getState().transform;
      const sx = sel
        ? sel.internals.positionAbsolute.x * zoom + tx + 40
        : (r?.width ?? 400) / 2 - 120;
      const sy = sel ? sel.internals.positionAbsolute.y * zoom + ty + 40 : (r?.height ?? 600) / 2;
      trackPointer(sx + (r?.left ?? 0), sy + (r?.top ?? 0), true);
    } else setPresence("cursor", { x: pointer.current.fx, y: pointer.current.fy });
    setChat({ sx: pointer.current.sx, sy: pointer.current.sy, text: "" });
    setPresence("draft", "");
  }, [ended, rf, selectedIds, store, trackPointer]);

  useEffect(() => {
    if (TOUCH) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        setMenu(null);
        setAsk(null);
        return;
      }
      if (ask) return;
      if (key === "l" && !mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        pageLock.toggle();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        openChat();
      } else if (mod && key === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
      } else if (mod && key === "a") {
        e.preventDefault();
        if (!locked) setSelection([...yNodes.keys()]);
      } else if (mod && key === "z" && editable) {
        e.preventDefault();
        if (e.shiftKey) undo.redo();
        else undo.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (t?.tagName === "BUTTON" && !t.closest(".react-flow__node")) return;
        e.preventDefault();
        requestDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openChat, group, ungroup, setSelection, requestDelete, ask, editable, locked]);

  // Locking drops whatever this viewer had selected or open: nothing is left half-edited.
  useEffect(() => {
    if (!locked) return;
    setSelection([]);
    setMenu(null);
    setAsk(null);
  }, [locked, setSelection]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".cv-menu")) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  useEffect(() => {
    if (ended && chat) {
      setChat(null);
      setPresence("draft", null);
    }
  }, [ended, chat]);

  const closeChat = () => {
    setChat(null);
    setPresence("draft", null);
  };

  const send = () => {
    const text = chat?.text.trim();
    if (!chat || !text) {
      closeChat();
      return;
    }
    const msg: ChatMsg = {
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "human",
      name: self.name,
      color: self.color,
      text,
      nodeIds: selectedIds,
      at: { x: pointer.current.fx, y: pointer.current.fy },
      ts: Date.now(),
    };
    trackLatency(msg.id);
    yChat.push([msg]);
    setPresence("draft", null);
    setPresence("bubble", { text });
    setOwnBubble({ sx: chat.sx, sy: chat.sy, text });
    setChat(null);
    setTimeout(() => {
      setPresence("bubble", null);
      setOwnBubble(null);
    }, 5000);
  };

  const attached = selectedIds.map((id) => String(yNodes.get(id)?.get("title") ?? "") || id);

  /** Popups stay at the pointer but fully inside the board. */
  const popupAt = (sx: number, sy: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const x = Math.max(8, Math.min(sx + 14, (r?.width ?? 1e4) - 292));
    const y = Math.max(8, Math.min(sy + 16, (r?.height ?? 1e4) - 96));
    return `translate(${x}px, ${y}px)`;
  };

  const composer = chat ? (
    <div
      className={`cv-cursor-chat${TOUCH ? " is-sheet" : ""}`}
      style={
        TOUCH
          ? { bottom: keyboard + 12, borderColor: self.color }
          : { transform: popupAt(chat.sx, chat.sy), borderColor: self.color }
      }
    >
      {attached.length > 0 ? (
        <div className="cv-chat-ctx">
          <IconCornerDownRight size={14} /> {attached.join(", ")}
        </div>
      ) : null}
      <input
        // Focus without letting the browser scroll the board to reveal the input.
        ref={(el) => {
          if (el && document.activeElement !== el) el.focus({ preventScroll: true });
        }}
        aria-label={`Message ${agent.name}`}
        placeholder={`Say something to ${agent.name}`}
        enterKeyHint="send"
        value={chat.text}
        onChange={(e) => {
          setChat({ ...chat, text: e.target.value });
          setPresence("draft", e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
          if (e.key === "Escape") closeChat();
        }}
        onBlur={() => {
          if (!chat.text) closeChat();
        }}
      />
    </div>
  ) : null;

  const scheme = useScheme();

  return (
    <div
      className={`cv-board${TOUCH ? " is-touch" : ""}${opening ? " is-opening" : ""}${locked ? " is-locked" : ""}`}
      ref={wrapRef}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerDownCapture={onPressStart}
      onPointerMoveCapture={onPressMove}
      onPointerUpCapture={cancelPress}
      onPointerCancelCapture={cancelPress}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") setPresence("cursor", null);
      }}
      onFocus={(e) => {
        // Keyboard focus on a control inside a card (a suggestion's buttons, a link) that sits
        // off-screen: pan so the focused control is visible, like nodes do on focus.
        const target = e.target;
        const wrap = wrapRef.current?.getBoundingClientRect();
        if (
          !wrap ||
          !(target instanceof HTMLElement) ||
          target.classList.contains("react-flow__node")
        )
          return;
        if (target.closest(".react-flow__node") === null) return;
        const r = target.getBoundingClientRect();
        const pad = 24;
        const dx =
          r.left < wrap.left + pad
            ? wrap.left + pad - r.left
            : r.right > wrap.right - pad
              ? wrap.right - pad - r.right
              : 0;
        const dy =
          r.top < wrap.top + pad
            ? wrap.top + pad - r.top
            : r.bottom > wrap.bottom - pad
              ? wrap.bottom - pad - r.bottom
              : 0;
        if (dx === 0 && dy === 0) return;
        const v = rf.getViewport();
        void rf.setViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom }, { duration: 150 });
      }}
    >
      <ReactFlow<CardNode, LinkEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onDragStart}
        onMoveEnd={snapViewport}
        onNodeDragStop={onDragStop}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={interaction.nodesConnectable}
        nodesDraggable={interaction.nodesDraggable}
        elementsSelectable={interaction.elementsSelectable}
        minZoom={0.1}
        maxZoom={4}
        zoomOnPinch
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionOnDrag={interaction.selectionOnDrag}
        selectionMode={SelectionMode.Partial}
        panOnDrag={interaction.panOnDrag}
        panOnScroll={!TOUCH}
        panActivationKeyCode="Space"
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
        onNodeClick={onNodeClick}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          if (!editable) return;
          const r = wrapRef.current?.getBoundingClientRect();
          if (!selectedRef.current.includes(node.id)) setSelection([node.id]);
          setMenu({ x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) });
        }}
        // Edge labels can't be scrolled into view on focus; nodes can.
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      </ReactFlow>
      <Cursors wrapRef={wrapRef} bottomInset={TOUCH ? 72 + keyboard : 0} />
      {SHOW_OWN_CURSOR ? (
        <div className="cv-cursor cv-own-cursor" ref={ownCursorRef}>
          <CursorArrow color={self.color} />
          <div className="cv-cursor-label" style={{ background: self.color }}>
            {self.name}
          </div>
        </div>
      ) : null}
      {composer}
      {ownBubble ? (
        <div
          className="cv-own-bubble"
          style={{ transform: popupAt(ownBubble.sx, ownBubble.sy), background: self.color }}
        >
          {ownBubble.text}
        </div>
      ) : null}
      {connection !== "live" ? (
        <div className="cv-connecting">
          {connection === "connecting" ? "Connecting" : "Reconnecting"}
        </div>
      ) : null}
      <ActivityPill onOpen={onOpenLog} />
      <div className={`cv-topbar${logOpen ? " log-open" : ""}`}>
        {ended ? null : (
          <button
            type="button"
            className={`cv-toggle${following ? " on" : ""}`}
            aria-pressed={following}
            title={`Keep ${agent.name}'s cursor in view while ${agent.name} works`}
            onClick={() => {
              follow.on = !follow.on;
              setFollowing(follow.on);
            }}
          >
            <IconEye size={16} /> Follow {agent.name}
          </button>
        )}
        <button
          type="button"
          className={`cv-toggle${tidyOn ? " on" : ""}`}
          aria-pressed={tidyOn}
          title="Push overlapping cards apart and route links around cards, for everyone on this board"
          disabled={locked}
          onClick={() => ySettings.set("tidy", !tidyOn)}
        >
          <IconLayoutDistributeHorizontal size={16} /> Tidy
        </button>
        {selectedIds.length > 1 && editable ? (
          <button
            type="button"
            className="cv-toggle"
            title="Put the selected cards in a frame (Cmd+G)"
            onClick={group}
          >
            <IconBoxMultiple size={16} /> Group
          </button>
        ) : null}
        {canUngroup && editable ? (
          <button
            type="button"
            className="cv-toggle"
            title="Dissolve the frame, keeping its cards (Cmd+Shift+G)"
            onClick={ungroup}
          >
            <IconBoxMultiple size={16} /> Ungroup
          </button>
        ) : null}
        {!TOUCH && selectedIds.length > 0 && editable ? (
          <button
            type="button"
            className="cv-toggle"
            title="Delete the selected cards (Delete)"
            onClick={requestDelete}
          >
            <IconTrash size={16} /> Delete
          </button>
        ) : null}
        <button
          type="button"
          className={`cv-toggle${locked ? " on" : " cv-icon-toggle"}`}
          aria-pressed={locked}
          aria-label={locked ? "Unlock board" : "Lock board"}
          title={locked ? "Unlock board (L)" : "Lock board (L)"}
          onClick={pageLock.toggle}
        >
          {locked ? <IconLock size={16} stroke={1.75} /> : <IconLockOpen size={16} stroke={1.75} />}
          {locked ? "Locked" : null}
        </button>
        <button
          type="button"
          className="cv-toggle cv-icon-toggle"
          aria-label={scheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={scheme === "dark" ? "Light mode" : "Dark mode"}
          onClick={pageTheme.toggle}
        >
          {scheme === "dark" ? (
            <IconSun size={16} stroke={1.5} />
          ) : (
            <IconMoon size={16} stroke={1.5} />
          )}
        </button>
      </div>
      {ask ? (
        <div className="cv-confirm" role="dialog" aria-label="Delete frame">
          <b>{ask.frames.length > 1 ? "Delete these frames?" : "Delete this frame?"}</b>
          <span>It still holds cards. Keep them on the board, or delete them with it?</span>
          <div className="cv-confirm-actions">
            <button
              type="button"
              className="cv-toggle on"
              // biome-ignore lint/a11y/noAutofocus: keeping the cards is the default, Enter picks it
              autoFocus
              onClick={() => confirmDelete(true)}
            >
              Keep the cards
            </button>
            <button type="button" className="cv-toggle" onClick={() => confirmDelete(false)}>
              Delete the cards too
            </button>
            <button type="button" className="cv-toggle" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {menu ? (
        <div
          className="cv-menu"
          role="menu"
          style={{ transform: popupAt(menu.x - 14, menu.y - 16) }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              requestDelete();
            }}
          >
            <IconTrash size={14} /> Delete
          </button>
          {selectedIds.length > 1 ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                group();
              }}
            >
              <IconBoxMultiple size={14} /> Group
            </button>
          ) : null}
          {canUngroup ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                ungroup();
              }}
            >
              <IconBoxMultiple size={14} /> Ungroup
            </button>
          ) : null}
        </div>
      ) : null}
      {ended ? (
        <div className="cv-ended" role="status">
          <b>Session with {agent.name} ended</b>
          {session?.summary ? <p>{session.summary}</p> : null}
          <span>The summary is in the chat. The board stays as it is.</span>
        </div>
      ) : chat && TOUCH ? null : TOUCH && selectedIds.length > 0 ? (
        <div
          className="cv-selbar"
          role="toolbar"
          aria-label="Selection"
          style={{ bottom: keyboard + 16 }}
        >
          <span className="cv-selbar-count">{selectedIds.length} selected</span>
          <button type="button" className="cv-selbar-btn" onClick={openChat}>
            <IconMessageCircle size={18} /> Comment
          </button>
          {selectedIds.length > 1 ? (
            <button type="button" className="cv-selbar-btn" onClick={group}>
              <IconBoxMultiple size={18} /> Group
            </button>
          ) : null}
          <button
            type="button"
            className="cv-selbar-btn danger"
            aria-label="Delete selected"
            onClick={requestDelete}
          >
            <IconTrash size={18} /> Delete
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="cv-fab"
          onClick={openChat}
          style={TOUCH ? { bottom: keyboard + 16 } : undefined}
        >
          <IconMessageCircle size={18} /> Comment {TOUCH ? null : <kbd>/</kbd>}
        </button>
      )}
    </div>
  );
}

/** Posts `canvas.ready` after the first sync and `canvas.ended` once the session closes. */
function useEmbedEvents() {
  const session = useSession();
  const sentEnded = useRef(false);
  useEffect(() => {
    const ready = () => postEmbed(window, { type: "canvas.ready", slug: env.slug });
    if (provider.synced) ready();
    else provider.once("sync", ready);
  }, []);
  useEffect(() => {
    if (session?.open !== false || sentEnded.current) return;
    sentEnded.current = true;
    postEmbed(window, { type: "canvas.ended", slug: env.slug, summary: session.summary ?? null });
  }, [session]);
}

function Room() {
  const [logOpen, setLogOpen] = useState(
    () => !TOUCH && env.embed !== "phone" && window.innerWidth > 760,
  );
  useEmbedEvents();
  return (
    <>
      <Board logOpen={logOpen} onOpenLog={() => setLogOpen(true)} />
      <SideLog open={logOpen} setOpen={setLogOpen} touch={TOUCH} />
    </>
  );
}

export function App({ state }: { state: "ok" | "expired" }) {
  if (state === "expired") {
    return (
      <div className="cv-expired" role="alert">
        <b>This canvas link expired</b>
        <p>Go back to the chat and open the canvas again.</p>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Room />
    </ReactFlowProvider>
  );
}

// Keep the awareness entry honest when the tab goes away (y-websocket also does this on unload).
window.addEventListener("pagehide", () => awareness.setLocalState(null));

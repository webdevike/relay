import { IconCornerDownRight, IconEye, IconMessageCircle } from "@tabler/icons-react";
import {
	Background,
	BackgroundVariant,
	type Connection,
	ConnectionMode,
	type Node,
	type NodeChange,
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
import { type CardNode, type LinkEdge, absolutePositions, snapEdges, snapNodes, toFlowEdges, toFlowNodes } from "./model";
import { awareness, doc, env, presenceStates, provider, self, setPresence, subscribePresence, yChat, yEdges, yMeta, yMetrics, yNodes } from "./room";

const NODE_TYPES = { card: CanvasCard };
const EDGE_TYPES = { link: CanvasEdge };
const SEARCH = new URLSearchParams(location.search);
/** Own cursor drawn in the page, for headless recordings that have no OS pointer. */
const SHOW_OWN_CURSOR = SEARCH.has("showcursor");

/** Touch-first UI: phone embed, or a coarse pointer on the plain web page. */
const TOUCH = env.embed === "phone" || (env.embed === "web" && matchMedia("(pointer: coarse)").matches);

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
		const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
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

function Board({ logOpen }: { logOpen: boolean }) {
	const [nodes, setNodes] = useState<CardNode[]>([]);
	const [edges, setEdges] = useState<LinkEdge[]>([]);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const wrapRef = useRef<HTMLDivElement>(null);
	const rf = useReactFlow<CardNode, LinkEdge>();
	const store = useStoreApi<CardNode, LinkEdge>();
	const initialized = useNodesInitialized();
	const didFit = useRef(false);
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

	/** Doc to React Flow; drawn sizes from the previous pass feed placement and frame growth. */
	const readDoc = useCallback(() => {
		const specs = snapNodes(yNodes);
		const edgeSnaps = snapEdges(yEdges);
		const layout = boardLayout();
		setNodes((prev) => {
			const measured = new Map<string, { w: number; h: number }>();
			for (const n of prev) if (n.measured?.width && n.measured.height) measured.set(n.id, { w: n.measured.width, h: n.measured.height });
			const input = { nodes: specs, edges: edgeSnaps, layout, measured };
			absRef.current = absolutePositions(input);
			return toFlowNodes(input, prev);
		});
		setEdges(toFlowEdges(edgeSnaps, new Set(specs.map((s) => s.id))));
	}, []);

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

	// Open at a readable zoom: fit the board, or start at its top-left when fitting makes text tiny.
	useEffect(() => {
		if (!initialized || didFit.current || !nodes.length) return;
		didFit.current = true;
		// Now that cards have real heights, frames and unplaced nodes settle around them.
		readDoc();
		void rf.fitView({ padding: 0.08, duration: 0 }).then(() => {
			if (rf.getZoom() >= 0.6) return;
			const b = rf.getNodesBounds(nodes.map((n) => n.id));
			const z = TOUCH ? 0.7 : 0.75;
			void rf.setViewport({ x: -b.x * z + 24, y: -b.y * z + 64, zoom: z });
		});
	}, [initialized, nodes, rf, readDoc]);

	const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => {
		setNodes((nds) => applyNodeChanges(changes, nds));
		doc.transact(() => {
			for (const c of changes) {
				if (c.type === "position" && c.dragging && c.position) {
					// React Flow reports a child's position relative to its frame; the file keeps absolute ones.
					const parentId = store.getState().nodeLookup.get(c.id)?.parentId;
					const origin = parentId ? absRef.current.get(parentId) : undefined;
					const next = origin ? { x: c.position.x + origin.x, y: c.position.y + origin.y } : c.position;
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
							for (let p = yNodes.get(id)?.get("parent"), guard = 0; typeof p === "string" && guard < 64; p = yNodes.get(p)?.get("parent"), guard++) if (p === c.id) return true;
							return false;
						};
						for (const [id, child] of yNodes) {
							const at = absRef.current.get(id);
							if (!at || !inFrame(id)) continue;
							child.set("x", at.x + dx);
							child.set("y", at.y + dy);
						}
					}
				} else if (c.type === "remove") {
					yNodes.delete(c.id);
					for (const [eid, e] of yEdges) if (e.get("source") === c.id || e.get("target") === c.id) yEdges.delete(eid);
				}
			}
		});
	}, [store]);

	const onConnect = useCallback((c: Connection) => {
		if (!c.source || !c.target || c.source === c.target) return;
		const e = new Y.Map<unknown>();
		e.set("source", c.source);
		e.set("target", c.target);
		if (c.sourceHandle) e.set("sourceHandle", c.sourceHandle);
		if (c.targetHandle) e.set("targetHandle", c.targetHandle);
		yEdges.set(`e-${c.source}-${c.target}-${Date.now().toString(36)}`, e);
	}, []);

	const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
		const ids = sel.map((n) => n.id);
		setSelectedIds(ids);
		setPresence("selected", ids);
	}, []);

	/** Own pointer: screen spot for popups, flow spot for everyone else (one awareness update per frame). */
	const rafPending = useRef(0);
	const trackPointer = useCallback(
		(clientX: number, clientY: number, now: boolean) => {
			const r = wrapRef.current?.getBoundingClientRect();
			if (!r) return;
			const f = rf.screenToFlowPosition({ x: clientX, y: clientY });
			pointer.current = { sx: clientX - r.left, sy: clientY - r.top, fx: f.x, fy: f.y };
			if (ownCursorRef.current) ownCursorRef.current.style.transform = `translate(${pointer.current.sx}px, ${pointer.current.sy}px)`;
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
		if (chat && !TOUCH) setChat((c) => (c ? { ...c, sx: pointer.current.sx, sy: pointer.current.sy } : c));
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
			const sx = sel ? sel.internals.positionAbsolute.x * zoom + tx + 40 : (r?.width ?? 400) / 2 - 120;
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
			if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				openChat();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openChat]);

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
			style={TOUCH ? { bottom: keyboard + 12, borderColor: self.color } : { transform: popupAt(chat.sx, chat.sy), borderColor: self.color }}
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

	return (
		<div
			className={`cv-board${TOUCH ? " is-touch" : ""}`}
			ref={wrapRef}
			onPointerMove={onPointerMove}
			onPointerDown={onPointerDown}
			onPointerLeave={(e) => {
				if (e.pointerType !== "touch") setPresence("cursor", null);
			}}
			onFocus={(e) => {
				// Keyboard focus on a control inside a card (a suggestion's buttons, a link) that sits
				// off-screen: pan so the focused control is visible, like nodes do on focus.
				const target = e.target;
				const wrap = wrapRef.current?.getBoundingClientRect();
				if (!wrap || !(target instanceof HTMLElement) || target.classList.contains("react-flow__node")) return;
				if (target.closest(".react-flow__node") === null) return;
				const r = target.getBoundingClientRect();
				const pad = 24;
				const dx = r.left < wrap.left + pad ? wrap.left + pad - r.left : r.right > wrap.right - pad ? wrap.right - pad - r.right : 0;
				const dy = r.top < wrap.top + pad ? wrap.top + pad - r.top : r.bottom > wrap.bottom - pad ? wrap.bottom - pad - r.bottom : 0;
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
				connectionMode={ConnectionMode.Loose}
				nodesConnectable={!TOUCH}
				minZoom={0.1}
				maxZoom={4}
				zoomOnPinch
				zoomOnDoubleClick={false}
				proOptions={{ hideAttribution: true }}
				deleteKeyCode={["Backspace", "Delete"]}
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
				<div className="cv-own-bubble" style={{ transform: popupAt(ownBubble.sx, ownBubble.sy), background: self.color }}>
					{ownBubble.text}
				</div>
			) : null}
			{connection !== "live" ? <div className="cv-connecting">{connection === "connecting" ? "Connecting" : "Reconnecting"}</div> : null}
			<div className={`cv-topbar${logOpen ? " log-open" : ""}`}>
				{ended ? null : (
					<button
						type="button"
						className={`cv-follow${following ? " on" : ""}`}
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
			</div>
			{ended ? (
				<div className="cv-ended" role="status">
					<b>Session with {agent.name} ended</b>
					{session?.summary ? <p>{session.summary}</p> : null}
					<span>The summary is in the chat. The board stays as it is.</span>
				</div>
			) : chat && TOUCH ? null : (
				<button type="button" className="cv-fab" onClick={openChat} style={TOUCH ? { bottom: keyboard + 16 } : undefined}>
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
	const [logOpen, setLogOpen] = useState(() => !TOUCH && env.embed !== "phone" && window.innerWidth > 760);
	useEmbedEvents();
	return (
		<>
			<Board logOpen={logOpen} />
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

// How each node kind draws, matching Relay Desktop's canvas cards (evaos-electron
// renderer/canvas/cards/CanvasCard.tsx): same sizes, radii, type and tones. Live additions: other
// people's selection rings, the agent's caret inside the text, double-click to edit title/body.
import {
	IconExternalLink,
	IconFrame,
	IconGitPullRequest,
	IconLayoutKanban,
	IconLink,
	IconNote,
	IconPhoto,
	IconSparkles,
} from "@tabler/icons-react";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, type MouseEvent, type ReactNode, memo, useMemo, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import type { Presence, TextField } from "../../canvas-live/src/shared";
import { imageUrl } from "./env";
import { type CardNode, type NodeSnap, applyDiff, host, swatchColor, tone } from "./model";
import { awareness, doc, env, presenceStates, subscribePresence, yEdges, yNodes } from "./room";

// ---------- who else is on this node (re-render a card only when its own slice changes) ----------

interface NodePresence {
	cid: number;
	name: string;
	color: string;
	sel: boolean;
	typing: Presence["typing"];
}

function nodePresenceKey(id: string): string {
	const out: NodePresence[] = [];
	for (const [cid, p] of presenceStates()) {
		if (cid === awareness.clientID || !p.user) continue;
		const sel = !!p.selected?.includes(id);
		const typing = p.typing?.nodeId === id ? p.typing : null;
		if (sel || typing) out.push({ cid, name: p.user.name, color: p.user.color, sel, typing });
	}
	return JSON.stringify(out);
}

function useNodePresence(id: string): NodePresence[] {
	const key = useSyncExternalStore(subscribePresence, () => nodePresenceKey(id));
	return useMemo(() => JSON.parse(key) as NodePresence[], [key]);
}

function PresenceRing({ others }: { others: NodePresence[] }) {
	const first = others[0];
	if (!first) return null;
	return (
		<>
			<div className="cv-ring" style={{ borderColor: first.color }} />
			<div className="cv-ring-tags">
				{others.map((o) => (
					<span key={o.cid} style={{ background: o.color }}>
						{o.name}
					</span>
				))}
			</div>
		</>
	);
}

// ---------- live text ----------

function withCaret(text: string, caret: NodePresence | undefined, field: TextField): ReactNode {
	const t = caret?.typing;
	if (!caret || !t || t.field !== field) return text;
	if (t.selectAll) return <mark style={{ background: `${caret.color}40` }}>{text}</mark>;
	const i = Math.min(t.index, text.length);
	return (
		<>
			{text.slice(0, i)}
			<span className="cv-caret" data-caret={caret.cid} style={{ background: caret.color }} />
			{text.slice(i)}
		</>
	);
}

/**
 * A title or body: the doc's Y.Text, double-click to edit (edits merge with the agent's typing).
 * `fallback` shows while the text is empty and nobody is typing in it.
 */
function Field({ nodeId, field, value, className, caret, icon, fallback }: { nodeId: string; field: TextField; value: string; className: string; caret: NodePresence | undefined; icon?: ReactNode; fallback?: string }) {
	const [editing, setEditing] = useState(false);
	if (editing) {
		return (
			<textarea
				// biome-ignore lint/a11y/noAutofocus: entering edit mode on double-click
				autoFocus
				className={`cv-edit nodrag nowheel nopan ${className}`}
				value={value}
				rows={Math.max(1, value.split("\n").length)}
				onFocus={(e) => e.currentTarget.setSelectionRange(value.length, value.length)}
				onChange={(e) => {
					const yt = yNodes.get(nodeId)?.get(field);
					if (yt instanceof Y.Text) applyDiff(yt, e.target.value);
				}}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Escape") setEditing(false);
				}}
			/>
		);
	}
	const shown = value === "" && fallback && caret?.typing?.field !== field ? fallback : withCaret(value, caret, field);
	return (
		<div className={className} onDoubleClick={() => setEditing(true)}>
			{icon}
			{icon ? <span>{shown}</span> : shown}
		</div>
	);
}

// ---------- parts ----------

const stop = (e: MouseEvent | React.PointerEvent): void => e.stopPropagation();

function LinkRow({ url }: { url: string }) {
	return (
		<a className="cv-link nodrag nopan" href={url} target="_blank" rel="noreferrer" title={url} onPointerDown={stop} onClick={stop}>
			<IconExternalLink size={12} stroke={1.75} aria-hidden />
			<span>{host(url)}</span>
		</a>
	);
}

/** An image card's picture, at its natural aspect once loaded. */
function Picture({ spec, inner }: { spec: NodeSnap; inner: number }) {
	const [state, setState] = useState<{ src: string; ratio: number | null; failed: boolean }>({ src: "", ratio: null, failed: false });
	const src = spec.src;
	const current = state.src === src ? state : { src: src ?? "", ratio: null, failed: false };
	const fallback = inner * 0.75;
	if (!src || current.failed) {
		return (
			<div className="cv-picture cv-picture-note" style={{ height: fallback }}>
				<IconPhoto size={14} stroke={1.5} aria-hidden />
				<span>{src ? "Image unavailable" : "No image"}</span>
			</div>
		);
	}
	return (
		<img
			className="cv-picture"
			src={imageUrl(env, src)}
			alt={spec.title}
			draggable={false}
			style={{ height: current.ratio ? inner * current.ratio : fallback }}
			onLoad={(e) => {
				const img = e.currentTarget;
				setState({ src, ratio: img.naturalWidth ? img.naturalHeight / img.naturalWidth : null, failed: false });
			}}
			onError={() => setState({ src, ratio: null, failed: true })}
		/>
	);
}

function Swatches({ spec }: { spec: NodeSnap }) {
	return (
		<div className="cv-swatches">
			{(spec.colors ?? []).map((s, i) => (
				<div key={`${s.hex}-${i}`} className="cv-swatch">
					<span className="cv-swatch-chip" style={{ background: swatchColor(s.hex) ?? "var(--c-muted)" }} />
					{s.name !== undefined ? <span className="cv-swatch-name">{s.name}</span> : null}
					<span className="cv-swatch-hex">{s.hex.toUpperCase()}</span>
				</div>
			))}
		</div>
	);
}

function Specimen({ spec, caret }: { spec: NodeSnap; caret: NodePresence | undefined }) {
	const font: CSSProperties = spec.font ? { fontFamily: `"${spec.font}", var(--font-ui)` } : {};
	return (
		<>
			<Field nodeId={spec.id} field="title" value={spec.title} fallback="Type" className="cv-small" caret={caret} />
			<div className="cv-type-head" style={font}>
				<span className="cv-type-aa">Aa</span>
				<span className="cv-type-family">{spec.font ?? "Theme font"}</span>
			</div>
			{(["Regular", "Medium", "Semibold"] as const).map((w, i) => (
				<div key={w} className="cv-type-weight" style={{ ...font, fontWeight: 400 + i * 100 }}>
					{w}
				</div>
			))}
			{spec.sample !== undefined ? (
				<div className="cv-type-sample" style={font}>
					{spec.sample}
				</div>
			) : null}
		</>
	);
}

/** Which status dots of each wireframe row are lit (cards.rs wireframe). */
const WIRE_ROWS = [
	[true, true, false],
	[true, true, false],
	[true, false, true],
	[false, true, true],
	[true, true, false],
	[true, false, true],
	[false, true, true],
] as const;

/** A browser window wireframe for an empty frame with a `url`. */
function Wireframe({ url }: { url: string }) {
	return (
		<div className="cv-wire">
			<div className="cv-wire-bar">
				<span className="cv-wire-dot" data-tone="danger" />
				<span className="cv-wire-dot" data-tone="warn" />
				<span className="cv-wire-dot" data-tone="success" />
				<span className="cv-wire-url">{url}</span>
			</div>
			<div className="cv-wire-body">
				<div className="cv-wire-side">
					<span className="cv-wire-line" style={{ width: 56 }} />
					<span className="cv-wire-line" data-on="true" style={{ width: 44 }} />
					{[0, 1, 2, 3].map((i) => (
						<span key={i} className="cv-wire-line" style={{ width: 44 }} />
					))}
				</div>
				<div className="cv-wire-main">
					<span className="cv-wire-line cv-wire-heading" style={{ width: 110 }} />
					{WIRE_ROWS.map((row, i) => (
						<div key={i} className="cv-wire-row">
							<span className="cv-wire-line" style={{ width: 60 }} />
							<span className="cv-wire-grow">
								<span className="cv-wire-line" style={{ width: 80 }} />
							</span>
							{row.map((on, j) => (
								<span key={j} className="cv-wire-dot" data-on={on ? "true" : undefined} />
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/** Add branch: the suggestion becomes a note in place (edges kept). Dismiss: it goes, with its edges. */
function SuggestionButtons({ id }: { id: string }) {
	return (
		<div className="cv-suggest-actions">
			<button
				type="button"
				className="cv-pill-btn nodrag nopan"
				data-variant="accent"
				onPointerDown={stop}
				onClick={(e) => {
					e.stopPropagation();
					const m = yNodes.get(id);
					if (!m) return;
					doc.transact(() => {
						m.set("type", "note");
						const title = m.get("title");
						if (title instanceof Y.Text) applyDiff(title, title.toString().replace(/^Eva suggests: /, ""));
					});
				}}
			>
				Add branch
			</button>
			<button
				type="button"
				className="cv-pill-btn nodrag nopan"
				onPointerDown={stop}
				onClick={(e) => {
					e.stopPropagation();
					doc.transact(() => {
						yNodes.delete(id);
						for (const [eid, edge] of yEdges) if (edge.get("source") === id || edge.get("target") === id) yEdges.delete(eid);
					});
				}}
			>
				Dismiss
			</button>
		</div>
	);
}

function showBody(spec: NodeSnap, caret: NodePresence | undefined): boolean {
	return spec.body !== "" || spec.fields.includes("body") || caret?.typing?.field === "body";
}

function Body({ spec, hasChildren, caret }: { spec: NodeSnap; hasChildren: boolean; caret: NodePresence | undefined }) {
	const { id, title } = spec;
	const titleShown = title !== "" || caret?.typing?.field === "title";
	const link = spec.url !== undefined ? <LinkRow url={spec.url} /> : null;
	switch (spec.type) {
		case "topic":
			return (
				<>
					<div className="cv-topic-label">Topic</div>
					<Field nodeId={id} field="title" value={title} className="cv-topic-title" caret={caret} />
					{showBody(spec, caret) ? <Field nodeId={id} field="body" value={spec.body} className="cv-topic-body" caret={caret} /> : null}
				</>
			);
		case "note":
			return (
				<>
					{titleShown ? <Field nodeId={id} field="title" value={title} className="cv-note-title" caret={caret} icon={<IconNote size={14} stroke={1.75} aria-hidden />} /> : null}
					{showBody(spec, caret) || title === "" ? <Field nodeId={id} field="body" value={spec.body} className="cv-note-body" caret={caret} /> : null}
				</>
			);
		case "ticket":
			return (
				<>
					<div className="cv-ticket-head">
						<IconLayoutKanban size={12} stroke={1.75} aria-hidden />
						<span className="cv-ticket-key">{spec.key ?? ""}</span>
						{spec.status !== undefined ? (
							<span className="cv-status" data-tone={tone(spec.tone, "accent")}>
								{spec.status}
							</span>
						) : null}
					</div>
					<Field nodeId={id} field="title" value={title} className="cv-heading" caret={caret} />
					{showBody(spec, caret) ? <Field nodeId={id} field="body" value={spec.body} className="cv-small" caret={caret} /> : null}
					{spec.pr !== undefined ? (
						<div className="cv-meta">
							<IconGitPullRequest size={12} stroke={1.75} aria-hidden />
							<span>{spec.pr}</span>
						</div>
					) : null}
					{link}
				</>
			);
		case "image":
			return (
				<>
					<Picture spec={spec} inner={(spec.w ?? 240) - 20} />
					{titleShown ? <Field nodeId={id} field="title" value={title} className="cv-heading cv-pad" caret={caret} /> : null}
					{spec.caption !== undefined ? <div className="cv-small cv-pad">{spec.caption}</div> : null}
					{showBody(spec, caret) ? <Field nodeId={id} field="body" value={spec.body} className="cv-small cv-pad" caret={caret} /> : null}
					{link ? <div className="cv-pad">{link}</div> : null}
				</>
			);
		case "link":
			return (
				<>
					<div className="cv-link-head">
						<IconLink size={14} stroke={1.75} aria-hidden />
						<Field nodeId={id} field="title" value={title} fallback={spec.url ?? ""} className="cv-heading" caret={caret} />
					</div>
					{spec.caption !== undefined ? <div className="cv-small">{spec.caption}</div> : null}
					{showBody(spec, caret) ? <Field nodeId={id} field="body" value={spec.body} className="cv-small" caret={caret} /> : null}
					{link}
				</>
			);
		case "frame":
			return (
				<>
					<Field nodeId={id} field="title" value={title} className="cv-frame-title" caret={caret} icon={<IconFrame size={12} stroke={1.75} aria-hidden />} />
					{!hasChildren && spec.url !== undefined ? <Wireframe url={spec.url} /> : null}
				</>
			);
		case "suggestion":
			return (
				<>
					<Field nodeId={id} field="title" value={title} className="cv-suggest-title" caret={caret} icon={<IconSparkles size={14} stroke={1.75} aria-hidden />} />
					{showBody(spec, caret) ? <Field nodeId={id} field="body" value={spec.body} className="cv-small" caret={caret} /> : null}
					<SuggestionButtons id={id} />
				</>
			);
		case "palette":
			return (
				<>
					<Field nodeId={id} field="title" value={title} fallback="Palette" className="cv-small" caret={caret} />
					<Swatches spec={spec} />
				</>
			);
		case "typography":
			return <Specimen spec={spec} caret={caret} />;
	}
}

const SIDES = [
	["left", Position.Left],
	["top", Position.Top],
	["right", Position.Right],
	["bottom", Position.Bottom],
] as const;

/** One node, drawn by its kind. */
export const CanvasCard = memo(function CanvasCard({ id, data, selected }: NodeProps<CardNode>) {
	const { spec, hasChildren } = data;
	const others = useNodePresence(id);
	const caret = others.find((o) => o.typing);
	const kind = spec.type;
	const t = kind === "note" ? tone(spec.tone, "warn") : kind === "ticket" ? tone(spec.tone, "accent") : undefined;
	return (
		<div
			className="cv-card"
			data-kind={kind}
			data-tone={t}
			data-selected={selected ? "true" : undefined}
			data-testid={`canvas-card-${id}`}
			style={spec.h !== undefined || kind === "frame" ? { height: "100%" } : undefined}
		>
			<PresenceRing others={others} />
			<Body spec={spec} hasChildren={hasChildren} caret={caret} />
			{SIDES.map(([side, position]) => (
				<Handle key={side} id={side} type="source" position={position} className="cv-handle" />
			))}
		</div>
	);
});

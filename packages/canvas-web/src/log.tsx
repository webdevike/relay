// The side log: the board and who is here, the cursor-chat history with per-turn latency, the
// model toggle and Wrap up. Collapses to a "Chat" pill (always on phones until opened).
import { IconCornerDownRight, IconX } from "@tabler/icons-react";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { type ClientMetrics, MODELS, type ModelKey, type ServerMetrics } from "../../canvas-live/src/shared";
import { avatarUrl, roomUrl } from "./env";
import { useAgent, useSession, useThrottledPresence, useYSnapshot } from "./hooks";
import { env, roomMe, self, yChat, yMeta, yMetrics, yNodes, ySettings } from "./room";

function fmt(ms: number | null | undefined): string {
	if (ms == null) return "-";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function SideLog({ open, setOpen, touch }: { open: boolean; setOpen: (open: boolean) => void; touch: boolean }) {
	const messages = useYSnapshot(() => yChat.toArray());
	const model = useYSnapshot(() => (ySettings.get("model") as ModelKey | undefined) ?? "sonnet");
	const metrics = useYSnapshot(() => Object.fromEntries(yMetrics.entries()) as Record<string, ServerMetrics | ClientMetrics | undefined>);
	const title = useYSnapshot(() => String(yMeta.get("title") ?? roomMe?.board ?? "Board"));
	const session = useSession();
	const agent = useAgent();
	const people = useThrottledPresence();
	const listRef = useRef<HTMLDivElement>(null);
	const rf = useReactFlow();
	const [wrapping, setWrapping] = useState(false);
	const [wrapError, setWrapError] = useState(false);

	useEffect(() => {
		if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [messages.length, open]);

	const ended = session?.open === false;
	const wrapUp = () => {
		setWrapping(true);
		setWrapError(false);
		fetch(roomUrl(env, "end"), { method: "POST" })
			.then((res) => {
				if (!res.ok) setWrapError(true);
			})
			.catch(() => setWrapError(true))
			.finally(() => setWrapping(false));
	};

	if (!open) {
		return (
			<button type="button" className="cv-log-toggle" onClick={() => setOpen(true)}>
				Chat {messages.length > 0 ? <span>{messages.length}</span> : null}
			</button>
		);
	}
	return (
		<aside className="cv-log" aria-label="Canvas chat">
			<header>
				<div className="cv-log-head">
					<b>{title}</b>
					<div className="cv-session-line">
						{ended ? `Session with ${agent.name} ended` : `Live with ${agent.name}`}
						{session?.chatTitle ? `, from ${session.chatTitle}` : ""}
					</div>
					<div className="cv-people">
						{[...people.entries()].flatMap(([cid, p]) =>
							!p.user
								? []
								: [
										p.user.avatar ? (
											<img key={cid} src={avatarUrl(env, p.user.avatar)} alt={p.user.name} title={p.user.name} style={{ borderColor: p.user.color }} />
										) : (
											<span key={cid} style={{ background: p.user.color }} title={p.user.name}>
												{p.user.name.slice(0, 1)}
											</span>
										),
									],
						)}
					</div>
				</div>
				<button type="button" className="cv-icon-btn" onClick={() => setOpen(false)} aria-label="Collapse chat" title="Collapse chat">
					<IconX size={16} />
				</button>
			</header>
			<div className="cv-model" role="group" aria-label="Model">
				{(Object.keys(MODELS) as ModelKey[]).map((k) => (
					<button type="button" key={k} className={k === model ? "on" : ""} aria-pressed={k === model} onClick={() => ySettings.set("model", k)}>
						{MODELS[k].label}
					</button>
				))}
			</div>
			<div className="cv-msgs" ref={listRef}>
				{messages.length === 0 ? (
					<p className="cv-hint">
						{touch ? (
							<>Tap a node, then Comment. {agent.name} answers at the cursor and edits the board.</>
						) : (
							<>
								Click a node, press <kbd>/</kbd> and type a note. {agent.name} answers at the cursor and edits the board.
							</>
						)}
					</p>
				) : null}
				{messages.map((m) => {
					const s = m.replyTo ? (metrics[`s:${m.replyTo}`] as ServerMetrics | undefined) : undefined;
					const c = m.replyTo ? (metrics[`c:${m.replyTo}`] as ClientMetrics | undefined) : undefined;
					return (
						<div key={m.id} className={`cv-msg cv-msg-${m.kind}`}>
							<span className="cv-who" style={{ color: m.color }}>
								{m.name}
							</span>
							{m.nodeIds.length > 0 ? (
								<button type="button" className="cv-chip" onClick={() => void rf.fitView({ nodes: m.nodeIds.map((id) => ({ id })), duration: 300, maxZoom: 1 })}>
									<IconCornerDownRight size={13} /> {m.nodeIds.map((id) => String(yNodes.get(id)?.get("title") ?? id)).join(", ")}
								</button>
							) : null}
							<div className="cv-text">{m.text}</div>
							{s ? (
								<div className="cv-lat">
									{MODELS[s.model]?.label ?? s.model}, cursor {fmt(c?.cursor ?? s.cursor)}, first token {fmt(c?.firstToken ?? s.firstToken)}, first edit {fmt(s.firstEdit)}, done {fmt(c?.done ?? s.done)}
								</div>
							) : null}
						</div>
					);
				})}
				{ended && session?.summary ? (
					<div className="cv-msg cv-msg-summary">
						<span className="cv-who">Summary</span>
						<div className="cv-text">{session.summary}</div>
					</div>
				) : null}
			</div>
			<footer>
				{ended ? null : (
					<button type="button" className="cv-btn primary" disabled={wrapping || !session?.open} onClick={wrapUp} title={`End the session and post a summary to the chat with ${agent.name}`}>
						{wrapping ? "Wrapping up" : "Wrap up"}
					</button>
				)}
				{wrapError ? <span className="cv-error">Could not wrap up. Try again.</span> : null}
				<span className="cv-you">
					You are <b style={{ color: self.color }}>{self.name}</b>
				</span>
			</footer>
		</aside>
	);
}

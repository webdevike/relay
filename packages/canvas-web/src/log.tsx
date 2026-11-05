// The side panel: the board and who is here, then every comment thread (open first, newest
// activity first; resolved ones collapsed below), each with its first words, the card it is on
// and its last reply; a click pans to the pin and opens it. The room chat (session notices, lines
// spoken outside a thread, per-turn latency) is the second tab. The model toggle and Wrap up stay.
// Collapses to a "Comments" pill (always on phones until opened).
import { IconChevronRight, IconCornerDownRight, IconMessageCircle, IconX } from "@tabler/icons-react";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import {
  type ClientMetrics,
  MODELS,
  type ModelKey,
  type ServerMetrics,
} from "../../canvas-live/src/shared";
import { type ThreadSnap, excerpt, lastActivity, orderThreads } from "../../canvas-live/src/threads";
import { Face } from "./avatar";
import { ago, threadDraft } from "./comments";
import { roomUrl } from "./env";
import { useAgent, useSession, useThrottledPresence, useYSnapshot } from "./hooks";
import { centerOnThread, threadPlace, useThreads } from "./pins";
import { env, roomMe, self, yChat, yMeta, yMetrics, yNodes, ySettings } from "./room";

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

type Tab = "comments" | "chat";

function ThreadRow({
  thread,
  open,
  working,
  now,
  onOpen,
}: {
  thread: ThreadSnap;
  open: boolean;
  working: boolean;
  now: number;
  onOpen: () => void;
}) {
  const first = thread.messages[0];
  const last = thread.messages.length > 1 ? thread.messages.at(-1) : undefined;
  if (first === undefined) return null;
  return (
    <button
      type="button"
      className={`cv-trow${open ? " is-open" : ""}${thread.resolved ? " is-resolved" : ""}`}
      data-testid="canvas-thread-row"
      data-thread={thread.id}
      aria-current={open ? "true" : undefined}
      onClick={onOpen}
    >
      <Face who={first} size={24} />
      <span className="cv-trow-main">
        <span className="cv-trow-meta">
          <b>{first.name}</b>
          <span className="cv-trow-place">
            <IconCornerDownRight size={12} stroke={1.75} aria-hidden="true" />
            {threadPlace(thread.anchor)}
          </span>
          <time>{ago(lastActivity(thread), now)}</time>
        </span>
        <span className="cv-trow-text">{excerpt(first.text, 110)}</span>
        {working ? (
          <span className="cv-trow-last is-working">Answering…</span>
        ) : last !== undefined ? (
          <span className="cv-trow-last">
            <Face who={last} size={16} />
            <span>
              <b>{last.name}</b> {excerpt(last.text, 80)}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function SideLog({
  open,
  setOpen,
  touch,
  openThread,
  setOpenThread,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  touch: boolean;
  openThread: string | null;
  setOpenThread: (id: string | null) => void;
}) {
  const messages = useYSnapshot(() => yChat.toArray());
  const threads = useThreads();
  const model = useYSnapshot(() => (ySettings.get("model") as ModelKey | undefined) ?? "opus");
  const metrics = useYSnapshot(
    () =>
      Object.fromEntries(yMetrics.entries()) as Record<
        string,
        ServerMetrics | ClientMetrics | undefined
      >,
  );
  const title = useYSnapshot(() => String(yMeta.get("title") ?? roomMe?.board ?? "Board"));
  const session = useSession();
  const agent = useAgent();
  const people = useThrottledPresence();
  const listRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const [tab, setTab] = useState<Tab>("comments");
  const [showResolved, setShowResolved] = useState(false);
  const [wrapping, setWrapping] = useState(false);
  const [wrapError, setWrapError] = useState(false);
  const { open: openThreads, resolved } = orderThreads(threads);
  const now = Date.now();

  useEffect(() => {
    if (open && tab === "chat") listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, open, tab]);
  // A resolved thread opened from the board shows in its section.
  useEffect(() => {
    if (openThread !== null && resolved.some((t) => t.id === openThread)) setShowResolved(true);
  }, [openThread, resolved]);

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
  const focus = (t: ThreadSnap) => {
    centerOnThread(rf, t);
    setOpenThread(t.id);
    if (touch) setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="cv-log-toggle" onClick={() => setOpen(true)}>
        <IconMessageCircle size={16} stroke={1.75} /> Comments
        {openThreads.length > 0 ? <span>{openThreads.length}</span> : null}
      </button>
    );
  }
  const row = (t: ThreadSnap) => (
    <ThreadRow
      key={t.id}
      thread={t}
      open={t.id === openThread}
      working={threadDraft(people.values(), t) !== null}
      now={now}
      onOpen={() => focus(t)}
    />
  );
  return (
    <aside className="cv-log" aria-label="Comments and room chat">
      <header>
        <div className="cv-log-head">
          <b>{title}</b>
          <div className="cv-session-line">
            {ended ? `Session with ${agent.name} ended` : `Live with ${agent.name}`}
            {session?.chatTitle ? `, from ${session.chatTitle}` : ""}
          </div>
          <div className="cv-people" aria-label="Who is here">
            {[...people.entries()].flatMap(([cid, p]) => {
              if (!p.user) return [];
              const isAgent = p.user.kind === "agent";
              // An agent works while a turn or batch runs, or while a handed-off request is open.
              const working =
                isAgent && ((p.status !== undefined && p.status !== "idle") || (p.task ?? "") !== "");
              const state = !isAgent ? null : working ? (p.task ? `working: ${p.task}` : "working") : "idle";
              return [
                <span
                  key={cid}
                  className={`cv-person${isAgent && !working ? " is-idle" : ""}`}
                  title={state === null ? p.user.name : `${p.user.name}, ${state}`}
                >
                  <Face who={p.user} size={20} ring={isAgent} />
                  {p.user.name}
                  {isAgent ? <em>{working ? "working" : "idle"}</em> : null}
                </span>,
              ];
            })}
          </div>
        </div>
        <button
          type="button"
          className="cv-icon-btn"
          onClick={() => setOpen(false)}
          aria-label="Collapse panel"
          title="Collapse panel"
        >
          <IconX size={16} />
        </button>
      </header>
      <div className="cv-model" role="group" aria-label="Model">
        {(Object.keys(MODELS) as ModelKey[]).map((k) => (
          <button
            type="button"
            key={k}
            className={k === model ? "on" : ""}
            aria-pressed={k === model}
            onClick={() => ySettings.set("model", k)}
          >
            {MODELS[k].label}
          </button>
        ))}
      </div>
      <div className="cv-tabs" role="tablist" aria-label="Panel">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "comments"}
          className={tab === "comments" ? "on" : ""}
          onClick={() => setTab("comments")}
        >
          Comments{openThreads.length > 0 ? <span>{openThreads.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          className={tab === "chat" ? "on" : ""}
          onClick={() => setTab("chat")}
        >
          Room chat
        </button>
      </div>
      {tab === "comments" ? (
        <div className="cv-msgs cv-threads" data-testid="canvas-threads">
          {threads.length === 0 ? (
            <p className="cv-hint">
              {touch ? (
                <>Tap a card, then Comment. {agent.name} answers in the comment and edits the board.</>
              ) : (
                <>
                  Click a card, press <kbd>/</kbd> and leave a comment. {agent.name} answers in the
                  thread and edits the board.
                </>
              )}
            </p>
          ) : null}
          {openThreads.map(row)}
          {resolved.length > 0 ? (
            <>
              <button
                type="button"
                className="cv-tsection"
                aria-expanded={showResolved}
                onClick={() => setShowResolved((s) => !s)}
              >
                <IconChevronRight
                  size={14}
                  stroke={1.75}
                  className={showResolved ? "is-open" : undefined}
                  aria-hidden="true"
                />
                Resolved <span>{resolved.length}</span>
              </button>
              {showResolved ? resolved.map(row) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="cv-msgs" ref={listRef}>
          {messages.length === 0 ? <p className="cv-hint">Nothing said in the room yet.</p> : null}
          {messages.map((m) => {
            const s = m.replyTo ? (metrics[`s:${m.replyTo}`] as ServerMetrics | undefined) : undefined;
            const c = m.replyTo ? (metrics[`c:${m.replyTo}`] as ClientMetrics | undefined) : undefined;
            return (
              <div key={m.id} className={`cv-msg cv-msg-${m.kind}`}>
                <span className="cv-who" style={{ color: m.color }}>
                  {m.name}
                </span>
                {m.nodeIds.length > 0 ? (
                  <button
                    type="button"
                    className="cv-chip"
                    onClick={() =>
                      void rf.fitView({
                        nodes: m.nodeIds.map((id) => ({ id })),
                        duration: 300,
                        maxZoom: 1,
                      })
                    }
                  >
                    <IconCornerDownRight size={13} />{" "}
                    {m.nodeIds.map((id) => String(yNodes.get(id)?.get("title") ?? id)).join(", ")}
                  </button>
                ) : null}
                <div className="cv-text">{m.text}</div>
                {s ? (
                  <div className="cv-lat">
                    {MODELS[s.model]?.label ?? s.model}, cursor {fmt(c?.cursor ?? s.cursor)}, first
                    token {fmt(c?.firstToken ?? s.firstToken)}, first edit {fmt(s.firstEdit)}, done{" "}
                    {fmt(c?.done ?? s.done)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {ended && session?.summary ? (
        <div className="cv-msg cv-msg-summary">
          <span className="cv-who">Summary</span>
          <div className="cv-text">{session.summary}</div>
        </div>
      ) : null}
      <footer>
        {ended ? null : (
          <button
            type="button"
            className="cv-btn primary"
            disabled={wrapping || !session?.open}
            onClick={wrapUp}
            title={`End the session and post a summary to the chat with ${agent.name}`}
          >
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

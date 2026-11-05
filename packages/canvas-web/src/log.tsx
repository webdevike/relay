// The side panel: the board and who is here, then every comment thread on every page (open first,
// newest activity first; resolved ones collapsed below), each with its first words, the card it is
// on, its page (when the board has more than one) and its last reply; a click goes to its page,
// pans to the pin and opens it. The room chat (session notices, lines spoken outside a thread,
// per-turn latency) is the second tab. The model toggle and Wrap up stay.
// Collapses to a "Comments" pill (always on phones until opened).
import { IconChevronRight, IconCornerDownRight, IconMessageCircle, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { type PageInfo, pageMaps } from "../../canvas-live/src/pages";
import {
  type ClientMetrics,
  MODELS,
  type ModelKey,
  type ServerMetrics,
} from "../../canvas-live/src/shared";
import { type ThreadSnap, excerpt, lastActivity, snapThreads } from "../../canvas-live/src/threads";
import { Face } from "./avatar";
import { type ThreadRowItem, statesOnPage, threadRows } from "./boardpages";
import { ago, threadDraft } from "./comments";
import { roomUrl } from "./env";
import { useAgent, useCurrentPage, usePages, useSession, useThrottledPresence, useYSnapshot } from "./hooks";
import { threadPlace } from "./pins";
import { doc, env, pageView, roomMe, self, yChat, yMeta, yMetrics, ySettings } from "./room";

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

type Tab = "comments" | "chat";
function ThreadRow({
  thread,
  page,
  open,
  working,
  now,
  onOpen,
}: {
  thread: ThreadSnap;
  /** The page it is on, labeled when the board has more than one. */
  page: { info: PageInfo; labeled: boolean };
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
      data-page={page.info.id}
      aria-current={open ? "true" : undefined}
      onClick={onOpen}
    >
      <Face who={first} size={24} />
      <span className="cv-trow-main">
        <span className="cv-trow-meta">
          <b>{first.name}</b>
          <span className="cv-trow-place">
            <IconCornerDownRight size={12} stroke={1.75} aria-hidden="true" />
            {threadPlace(thread.anchor, pageMaps(doc, page.info.id).nodes)}
          </span>
          <time>{ago(lastActivity(thread), now)}</time>
        </span>
        {page.labeled ? <span className="cv-trow-page">{page.info.title}</span> : null}
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
  onFocusThread,
  onShowNodes,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  touch: boolean;
  /** The thread open on the board, and its page. */
  openThread: { page: string; id: string } | null;
  /** Goes to `page`, pans to thread `t`'s pin and opens it. */
  onFocusThread: (page: string, t: ThreadSnap) => void;
  /** Fits the viewer's page to these cards. */
  onShowNodes: (ids: readonly string[]) => void;
}) {
  const messages = useYSnapshot(() => yChat.toArray());
  const pages = usePages();
  const viewerPage = useCurrentPage();
  const rows = useYSnapshot(() =>
    threadRows(pages.map((p) => ({ page: p, threads: snapThreads(pageMaps(doc, p.id).threads) }))),
  );
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
  const viewerNodes = pageView(viewerPage).nodes;
  const [tab, setTab] = useState<Tab>("comments");
  const [showResolved, setShowResolved] = useState(false);
  const [wrapping, setWrapping] = useState(false);
  const [wrapError, setWrapError] = useState(false);
  const { open: openThreads, resolved } = rows;
  const labeled = pages.length > 1;
  const isOpen = (r: ThreadRowItem) => openThread !== null && r.page.id === openThread.page && r.thread.id === openThread.id;
  const now = Date.now();

  useEffect(() => {
    if (open && tab === "chat") listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, open, tab]);
  // A resolved thread opened from the board shows in its section.
  useEffect(() => {
    if (resolved.some(isOpen)) setShowResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const focus = (r: ThreadRowItem) => {
    onFocusThread(r.page.id, r.thread);
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
  const row = (r: ThreadRowItem) => (
    <ThreadRow
      key={r.key}
      thread={r.thread}
      page={{ info: r.page, labeled }}
      open={isOpen(r)}
      // Who answers a thread is on its page.
      working={threadDraft(statesOnPage(people, r.page.id).values(), r.thread) !== null}
      now={now}
      onOpen={() => focus(r)}
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
          {openThreads.length + resolved.length === 0 ? (
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
                    onClick={() => onShowNodes(m.nodeIds)}
                  >
                    <IconCornerDownRight size={13} />{" "}
                    {m.nodeIds.map((id) => String(viewerNodes.get(id)?.get("title") ?? id)).join(", ")}
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

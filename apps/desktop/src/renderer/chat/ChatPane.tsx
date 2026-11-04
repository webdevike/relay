import './chat.css'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import { ContextButton } from '../context/ContextButton'
import { ArtifactsButton } from '../artifacts/ArtifactsButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatLog } from './ChatLog'
import { useProfile } from '../pages/profile'
import { Composer, type ComposerHandle } from './Composer'
import { WidgetActions, type WidgetActionsValue } from './widgets/actions'
import { PendingDialog } from './cards/PendingDialog'
import { JobsStrip } from './strips/JobsStrip'
import { StatusStrip } from './strips/StatusStrip'
import { SubagentChips } from './strips/SubagentChips'
import { openActivity } from '../activity/open-activity'
import { useActivityItems } from '../activity/activity-store'
import { ownedActive } from '@evaos/chat-core/activity'
import { listStore, useListStore } from './list/list-store'
import { sessionId } from '@evaos/chat-core/session-id'
import { chatStore, hiddenKey, useChatStore } from './chat-store'
import { createStreamDrain } from './stream-drain'
import { invoke, on } from '../ipc'
import { browserScope, placeOf, type Place } from '@evaos/shell-core'
import { replaceTabPlace } from '../tabs/tabs-store'
import { renameBrowserScope } from '../browser/browser-scope'
import { dropChatPane, newChatPaneId, openChatFile, openDraftPane } from './open-chat'
import { setTabChatPane } from './front-chat'
import { draftKeyFor, loadDrafts } from './drafts'
import { FOLDED_LABEL, toggleSidebar, useLayout } from '../shell/layout-store'
import {
  frontToolTabs,
  openSubagentTab,
  toggleToolPanes,
  toolsShown,
  useTiling,
} from '../tiling/tiling-store'
import { setChatTitle } from '../eva/names-store'
import { AgentCrumb, OwnedCrumb } from '../assistants/AgentCrumb'
import { AgentNotch } from '../assistants/AgentNotch'
import { useLocalRows } from './local-rows'
import { agentFile, agentIdOf, agentOf, useAssistants } from '../assistants/assistants-store'
import { fillComposer } from './composer-fill'
import {
  ReactionScope,
  useReactionThread,
  type ReactionScopeValue,
} from './reactions/reactions-store'

declare global {
  interface Window {
    __evaosChatStats?: Record<
      string,
      { batches: number; gaps: number; snapshots: number; lastSeq: number }
    >
  }
}

/**
 * What every chat on screen shares, mounted once: the one stream drain (batches from main are
 * applied once per animation frame, to whichever pane they name), the extras listener for every
 * pane, and the saved composer drafts.
 */
export function ChatRuntime() {
  useEffect(() => {
    void loadDrafts()
    const offExtras = on('chat.extras', (e) => chatStore.getState().setExtras(e))
    let e2e = false
    void invoke('app.info', {}).then((r) => {
      if (r.ok) e2e = r.value.e2e
    })
    const drain = createStreamDrain({
      store: chatStore,
      subscribe: (cb) => on('chat.batch', cb),
      requestSnapshot: async (paneId) => {
        const r = await invoke('chat.snapshot', { paneId })
        return r.ok ? r.value : null
      },
      onStats: (paneId, s) => {
        if (!e2e) return
        window.__evaosChatStats = { ...window.__evaosChatStats, [paneId]: s }
      },
    })
    return () => {
      offExtras()
      drain.dispose()
    }
  }, [])
  return null
}

/**
 * App tab `tab`'s chat (a chat, or an assistant's thread) while it is on screen, under its own
 * chat pane id: a fresh one each mount, forgotten when the tab goes behind another or closes.
 * Main runs one omp per session file, so a second pane on a chat this app runs reads it live and
 * sends through its owner once Isaac says so; one Relay runs (an assistant's) streams and replies
 * in every pane alike. `lead` puts the sidebar and panel toggles in its header.
 */
export function TabChat({ tab, place, lead }: { tab: number; place: Place; lead: boolean }) {
  const [paneId, setPaneId] = useState<string | null>(null)
  useEffect(() => {
    const id = newChatPaneId()
    setPaneId(id)
    setTabChatPane(tab, id)
    return () => {
      setTabChatPane(tab, null)
      dropChatPane(id)
    }
  }, [tab])
  return paneId === null ? null : <ChatView paneId={paneId} place={place} tab={tab} lead={lead} />
}

function ChatView({
  paneId,
  place,
  tab,
  lead,
}: {
  paneId: string
  place: Place
  tab: number
  lead: boolean
}) {
  const pane = useChatStore((s) => s.panes[paneId])
  const starter = useProfile() === 'starter'
  const composer = useRef<ComposerHandle>(null)
  // A widget reply can go wherever the composer can send: a pane with a session. A stopped one
  // resumes on send (session-manager starts omp) and one running outside this app gets it through
  // Relay, exactly like a typed prompt.
  const canReply = pane !== undefined
  const widgetActions = useMemo<WidgetActionsValue>(
    () => ({ reply: (text) => composer.current?.sendReply(text), canReply }),
    [canReply],
  )
  // Rows this app added to an assistant's thread (the avatar editor), after the session's messages.
  const localRows = useLocalRows(paneId)
  const shownMessages = useMemo(
    () => (localRows.length === 0 || !pane ? pane?.messages : [...pane.messages, ...localRows]),
    [pane, localRows],
  )
  const [evaRoot, setEvaRoot] = useState<string | null>(null)
  const sidebarState = useLayout((s) => s.state)
  const panelOpen = useTiling(toolsShown)
  // The subagent a pane shows in front, when it is one of this chat's.
  const viewedSubagent = useTiling((s) => {
    const front = frontToolTabs(s).find((t) => t.kind === 'subagent' && t.session === pane?.file)
    return front?.kind === 'subagent' ? front.name : null
  })
  const sidebarLabel =
    sidebarState === 'open'
      ? 'Hide sidebar'
      : sidebarState === 'hidden'
        ? 'Show sidebar'
        : FOLDED_LABEL
  // An agent's page shows its thread here once omp wrote the file (native Page::Agent).
  const thread = useAssistants((s) => agentFile(s, place))
  const agent = agentIdOf(place)
  // An assistant thread shows the agent "typing" while Relay hears it working.
  const typing = useAssistants((s) => {
    const a = agent === null ? null : agentOf(s, agent)
    return a?.status === 'working' ? a.title : null
  })
  // Tapbacks: the thread this chat's bubbles react in, as Relay keeps it for every device; Reply
  // quotes a bubble into this pane's composer.
  const reactionThread = useReactionThread(pane?.file ?? '', agent)
  const reactionScope = useMemo<ReactionScopeValue>(
    () => ({ thread: reactionThread, reply: (text) => fillComposer(paneId, text) }),
    [reactionThread, paneId],
  )
  const placeChat = place.page === 'chat' ? place.chat : thread
  // A chat an assistant started names that assistant in its header and leads back to its thread.
  const shownId = place.page === 'chat' && pane?.file ? sessionId(pane.file) : null
  const ownerAgent = useListStore((s) =>
    shownId === null ? null : (s.list?.rows.find((r) => r.id === shownId)?.owner?.agent ?? null),
  )
  useEffect(() => {
    if (shownId !== null && !listStore.getState().list) void listStore.getState().load()
  }, [shownId])
  const draftKey = draftKeyFor(pane, placeChat, browserScope(placeOf('chat'), tab))

  const hiddenDone = useChatStore((s) => s.hiddenDone)
  const hiddenNames = useMemo(() => {
    const names = new Set<string>()
    for (const a of pane?.extras.subagents ?? [])
      if (pane && hiddenDone.has(hiddenKey(pane.file, a.name))) names.add(a.name)
    return names
  }, [pane, hiddenDone])

  // A tab whose place is a session path shows that session; a draft tab shows a new chat.
  useEffect(() => {
    if (placeChat === 'draft') void openDraftPane(paneId)
    else if (placeChat) void openChatFile(placeChat, paneId)
  }, [placeChat, paneId])

  // A new chat that omp gave a session file: the tab follows it in place, so Back never returns
  // to a dead draft and the pane does not reopen. The draft's browser tabs carry over.
  const boundTo = pane?.boundTo ?? null
  useEffect(() => {
    if (!boundTo || placeChat !== 'draft') return
    const chat = placeOf('chat', { chat: boundTo })
    renameBrowserScope(browserScope(placeOf('chat'), tab), browserScope(chat, tab))
    replaceTabPlace(chat, tab)
  }, [boundTo, placeChat, tab])

  // Everything else this chat's assistant has in progress (sessions, harnesses, canvas agents),
  // from the host's activity list: a badge each beside the subagents'.
  const activityItems = useActivityItems()
  const ownThread =
    agent !== null ? `assistant:${agent}` : pane?.file ? `session:${sessionId(pane.file)}` : null
  const spunOff = useMemo(
    () => ownedActive(activityItems, ownThread).filter((i) => i.kind !== 'helper'),
    [activityItems, ownThread],
  )

  // A tab on this chat names it as the header does, and follows a rename or omp's auto title.
  const shownFile = pane?.file ?? ''
  const shownTitle = pane?.title ?? ''
  useEffect(() => {
    if (shownFile !== '' && shownTitle !== '') setChatTitle(shownFile, shownTitle)
  }, [shownFile, shownTitle])

  const draft = placeChat === 'draft' || (pane !== undefined && pane.file === '')
  useEffect(() => {
    if (!draft || evaRoot !== null) return
    void invoke('app.info', {}).then((r) => {
      if (r.ok) setEvaRoot(r.value.evaRoot)
    })
  }, [draft, evaRoot])

  // An error is a banner, not a lock: the next send retries (and restarts omp if it exited).
  return (
    <section className="eva-chat" data-testid="chat-pane" data-chat-pane={paneId}>
      <div className="eva-chat-header" data-testid="chat-header">
        {lead ? (
          <Tooltip label={sidebarLabel} position="bottom">
            <ActionIcon
              variant="subtle"
              size="var(--eva-kit-control-sm)"
              data-testid="sidebar-toggle"
              aria-label={sidebarLabel}
              aria-pressed={sidebarState === 'open'}
              onClick={() => toggleSidebar()}
            >
              <IconLayoutSidebar size="calc(var(--eva-font-size) * .875)" stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        ) : null}
        {pane ? (
          <>
            {/* An assistant's notch already says it's working, so its thread shows no dot. */}
            {pane.running && agent === null ? (
              <span className="eva-streaming-dot" role="img" aria-label="Eva is replying" />
            ) : null}
            {/* An agent's thread names its way back: "< Assistants / Astra"; a chat it started,
                "< Astra / ENG-6545 auto-work". */}
            <h2 className="eva-heading eva-chat-title" title={pane.file || undefined}>
              {agent !== null ? (
                <AgentCrumb id={agent} />
              ) : ownerAgent !== null ? (
                <OwnedCrumb agent={ownerAgent} title={pane.title} />
              ) : (
                pane.title
              )}
            </h2>
            {agent !== null ? <AgentNotch id={agent} edit={{ paneId }} /> : null}
            {pane.file && !pane.extras.running && !pane.owner && !pane.away ? (
              <span className="eva-chat-saved">Saved session</span>
            ) : null}
            {pane.away?.job ? (
              <span className="eva-chat-saved" data-testid="chat-job">
                Running as a job
              </span>
            ) : null}
            {pane.owner && pane.owner !== paneId && !pane.extras.running ? (
              <span className="eva-label eva-dim eva-chat-owner" data-testid="chat-owner">
                Owned by another pane
              </span>
            ) : null}
            {pane.reconnecting ? (
              <span className="eva-label eva-dim eva-chat-reconnecting">
                Reconnecting to the stream.
              </span>
            ) : null}
          </>
        ) : (
          <h2 className="eva-heading eva-chat-title">
            {agent !== null ? <AgentCrumb id={agent} /> : 'New chat'}
          </h2>
        )}
        {agent !== null ? <ArtifactsButton agent={agent} /> : <ContextButton />}
        {lead ? (
          <Tooltip label={panelOpen ? 'Hide tool panes' : 'Show tool panes'} position="bottom">
            <ActionIcon
              variant="subtle"
              className="eva-header-btn eva-chat-panel-toggle"
              data-testid="panel-toggle"
              aria-label={panelOpen ? 'Hide tool panes' : 'Show tool panes'}
              aria-pressed={panelOpen}
              onClick={() => toggleToolPanes()}
            >
              <IconLayoutSidebarRight size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </div>
      {/* The notch hangs below the header: the banner, log or empty state start below it. */}
      {pane && agent !== null ? <div className="eva-chat-notch-room" aria-hidden /> : null}
      {pane?.error ? (
        <div className="eva-error-banner" role="alert" data-testid="chat-error">
          {pane.error}
        </div>
      ) : null}
      {pane && shownMessages && !(pane.file === '' && shownMessages.length === 0) ? (
        <WidgetActions.Provider value={widgetActions}>
          <ReactionScope.Provider value={reactionScope}>
            <ChatLog
              paneId={paneId}
              messages={shownMessages}
              // A draft keeps its log key when omp names the file, so binding never jumps the scroll.
              file={pane.boundTo ? '' : pane.file}
              scrollFile={pane.file}
              shown
              typing={typing}
              busy={pane.running}
            />
          </ReactionScope.Provider>
        </WidgetActions.Provider>
      ) : draft ? (
        <div className="eva-chat-empty">
          <div className="eva-chat-intro">
            <h2>{starter ? 'What should we work on?' : 'What should Eva work on?'}</h2>
            {evaRoot ? (
              <div className="eva-dim">Each chat is an omp session in {evaRoot}.</div>
            ) : null}
          </div>
        </div>
      ) : (
        // A thread while it opens: nothing to say yet.
        <div className="eva-chat-empty" />
      )}
      {pane ? (
        <SubagentChips
          subagents={pane.extras.subagents}
          hidden={hiddenNames}
          active={viewedSubagent}
          activity={spunOff}
          onOpenActivity={(item) => {
            openActivity(item)
          }}
          onOpen={(s) =>
            openSubagentTab({
              session: pane.file,
              // A subagent's transcript lives in the session's folder, named like the session.
              file: `${pane.file.replace(/\.jsonl$/, '')}/${s.file}`,
              name: s.name,
            })
          }
          onClearDone={() => chatStore.getState().clearDone(paneId)}
        />
      ) : null}
      <PendingDialog paneId={paneId} />
      {pane ? <JobsStrip running={pane.extras.running} jobs={pane.extras.jobs} /> : null}
      <StatusStrip paneId={paneId} />
      <Composer ref={composer} paneId={paneId} disabled={!pane} draftKey={draftKey} />
    </section>
  )
}

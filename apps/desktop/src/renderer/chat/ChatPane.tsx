import './chat.css'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import { ContextButton } from '../context/ContextButton'
import { ArtifactsButton } from '../artifacts/ArtifactsButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatLog } from './ChatLog'
import { askAgentOf, useWatchedAsks } from './asks/asks-store'
import { AsksButton } from './asks/AsksButton'
import { turnRailFits } from './minimap/TurnMinimap'
import { useProfile } from '../pages/profile'
import { Composer, type ComposerHandle } from './Composer'
import { WidgetActions, type WidgetActionsValue } from './widgets/actions'
import { PendingDialog } from './cards/PendingDialog'
import { JobsStrip } from './strips/JobsStrip'
import { StatusStrip } from './strips/StatusStrip'
import { SubagentChips } from './strips/SubagentChips'
import { AgentWorkCards } from './strips/AgentWorkCards'
import { MeetingCards } from './strips/MeetingCards'
import { useFrontChatPane } from './front-chat'
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
import { agentTitle, setChatTitle } from '../eva/names-store'
import { AgentCrumb, OwnedCrumb } from '../assistants/AgentCrumb'
import { DrillCrumb } from './DrillCrumb'
import { drillStore, useDrillTrail } from './drill-store'
import { SubagentTranscript } from './SubagentTranscript'
import { AgentNotch } from '../assistants/AgentNotch'
import { useLocalRows } from './local-rows'
import { placeRows, useComputerRows } from './computer-rows'
import { agentFile, agentIdOf, agentOf, useAssistants } from '../assistants/assistants-store'
import { fillComposer } from './composer-fill'
import {
  ReactionScope,
  useReactionThread,
  type ReactionScopeValue,
} from './reactions/reactions-store'
import { PinsScope, usePinsFor } from '../pins/pins-scope'
import { PinsButton, PinsRail, useRailFits } from '../pins/PinsRail'
import { PinHoverLayer } from '../pins/PinHoverLayer'

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

/** Each app tab's chat pane while mounted; a drop waits a tick so a remount keeps the pane. */
const tabPanes = new Map<number, { id: string; drop?: number }>()

/**
 * App tab `tab`'s chat (a chat, or an assistant's thread) while it is on screen, under its own
 * chat pane id, forgotten when the tab goes behind another or closes. A remount in the same tick
 * (its workspace's panes rebuilt around it) keeps the pane and all it holds. Main runs one omp per
 * session file, so a second pane on a chat this app runs reads it live and sends through its
 * owner once Isaac says so; one Relay runs (an assistant's) streams and replies in every pane
 * alike. `lead` puts the sidebar and panel toggles in its header.
 */
export function TabChat({ tab, place, lead }: { tab: number; place: Place; lead: boolean }) {
  const [paneId, setPaneId] = useState<string | null>(null)
  useEffect(() => {
    let held = tabPanes.get(tab)
    if (held?.drop !== undefined) {
      window.clearTimeout(held.drop)
      held.drop = undefined
    }
    if (!held) {
      held = { id: newChatPaneId() }
      tabPanes.set(tab, held)
    }
    const mine = held
    setPaneId(mine.id)
    setTabChatPane(tab, mine.id)
    return () => {
      mine.drop = window.setTimeout(() => {
        if (tabPanes.get(tab) === mine) tabPanes.delete(tab)
        setTabChatPane(tab, null)
        dropChatPane(mine.id)
      }, 0)
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
  // Rows this app added to an assistant's thread (the avatar editor), after the session's
  // messages, and `@computer` runs, each in the timeline where Isaac sent it.
  const localRows = useLocalRows(paneId)
  const computerRows = useComputerRows(paneId, pane?.file || null)
  const shownMessages = useMemo(
    () =>
      (localRows.length === 0 && computerRows.length === 0) || !pane
        ? pane?.messages
        : [...placeRows(pane.messages, computerRows), ...localRows],
    [pane, localRows, computerRows],
  )
  const [evaRoot, setEvaRoot] = useState<string | null>(null)
  const sidebarState = useLayout((s) => s.state)
  const panelOpen = useTiling(toolsShown)
  // The subagent a pane shows in front, when it is one of this chat's.
  const viewedSubagent = useTiling((s) => {
    const front = frontToolTabs(s).find((t) => t.kind === 'subagent' && t.session === pane?.file)
    return front?.kind === 'subagent' ? front.name : null
  })
  // Agents' pages in the workspace on screen get their work cards in the chat in front.
  const inFront = useFrontChatPane() === paneId
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
  // The assistant thread's open asks (the host's questions Isaac has not answered), for the log
  // and the line above the composer.
  const askAgent = askAgentOf(reactionThread)
  useWatchedAsks(askAgent)
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

  // A chip's plain click swaps this pane to a session transcript; the trail is the way back, and
  // it ends when the pane moves to another chat.
  const trail = useDrillTrail(paneId)
  const current = trail[trail.length - 1]
  const paneFile = pane?.file ?? ''
  useEffect(() => {
    drillStore.popTo(paneId, 0)
  }, [paneId, paneFile, placeChat])
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
  // The owning assistant's portrait color tints the chips' progress fill; a plain chat uses the accent.
  const agentColor = useAssistants((s) =>
    agent === null ? undefined : agentOf(s, agent)?.avatar.colors?.accent,
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

  // Pins: the thread's pinned things beside the log (a rail when the gutter fits it, else a header
  // button with a popover).
  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const railOk = useRailFits(sectionRef)
  // The turn rail at the log's left edge: where it would sit on the text, its open asks move to a header count.
  const turnRailOk = useRailFits(sectionRef, turnRailFits)
  const pins = usePinsFor(paneId, pane?.file ?? '', agent, true)

  // An error is a banner, not a lock: the next send retries (and restarts omp if it exited).
  return (
    <section className="eva-chat" data-testid="chat-pane" data-chat-pane={paneId} ref={sectionRef}>
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
            <h2 className="eva-heading eva-chat-title">
              {current !== undefined ? (
                <DrillCrumb
                  paneId={paneId}
                  root={agent !== null ? (agentTitle(agent) ?? agent) : pane.title}
                  trail={trail}
                />
              ) : agent !== null ? (
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
        {askAgent !== null && pane && !turnRailOk ? (
          <AsksButton agent={askAgent} paneId={paneId} />
        ) : null}
        {!railOk ? <PinsButton scope={pins} /> : null}
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
      {current !== undefined ? (
        <div className="eva-chat-body" data-testid="drill-body">
          <SubagentTranscript key={current.file} file={current.file} version={null} poll />
        </div>
      ) : pane && shownMessages && !(pane.file === '' && shownMessages.length === 0) ? (
        // The log and the pin rail side by side: the rail is fixed in the right gutter, outside the scroll.
        <div className="eva-chat-body" ref={bodyRef}>
          <PinsScope.Provider value={pins}>
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
            {railOk ? <PinsRail scope={pins} /> : null}
            <PinHoverLayer bodyRef={bodyRef} />
          </PinsScope.Provider>
        </div>
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
          helperActivity={activityItems}
          sessionFile={pane.file}
          agentColor={agentColor}
          hidden={hiddenNames}
          active={viewedSubagent}
          activity={spunOff}
          onOpenActivity={(item, split) => {
            // A click swaps this pane to the transcript; Cmd+click splits it beside the pane.
            void openActivity(item, 'here', split ? undefined : (e) => drillStore.push(paneId, e))
          }}
          onOpen={(s, split) => {
            // A subagent's transcript lives in the session's folder, named like the session.
            const file = `${pane.file.replace(/\.jsonl$/, '')}/${s.file}`
            if (split) openSubagentTab({ session: pane.file, file, name: s.name })
            else drillStore.push(paneId, { file, title: s.name })
          }}
          onClearDone={() => chatStore.getState().clearDone(paneId)}
        />
      ) : null}
      {inFront ? <AgentWorkCards /> : null}
      {agent !== null ? <MeetingCards agent={agent} /> : null}
      <PendingDialog paneId={paneId} />
      {pane ? <JobsStrip running={pane.extras.running} jobs={pane.extras.jobs} /> : null}
      <StatusStrip paneId={paneId} />
      {current === undefined ? (
        <Composer
          ref={composer}
          paneId={paneId}
          disabled={!pane}
          draftKey={draftKey}
          agent={agent}
        />
      ) : null}
    </section>
  )
}

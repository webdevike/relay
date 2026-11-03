import './chat.css'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import { ContextButton } from '../context/ContextButton'
import { ArtifactsButton } from '../artifacts/ArtifactsButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatLog } from './ChatLog'
import { Composer, type ComposerHandle } from './Composer'
import { WidgetActions, type WidgetActionsValue } from './widgets/actions'
import { PendingDialog } from './cards/PendingDialog'
import { JobsStrip } from './strips/JobsStrip'
import { StatusStrip } from './strips/StatusStrip'
import { SubagentChips } from './strips/SubagentChips'
import { listStore, useListStore } from './list/list-store'
import { sessionId } from '@evaos/chat-core/session-id'
import { chatStore, hiddenKey, useChatStore } from './chat-store'
import { createStreamDrain } from './stream-drain'
import { invoke, on } from '../ipc'
import { browserScope, frontTabs, placeOf, toolsShown, type Place } from '@evaos/shell-core'
import { FOLDED_LABEL } from '../tabs/TabBar'
import {
  activePlace,
  activeTabId,
  replaceActivePlace,
  tabsStore,
  useTabs,
} from '../tabs/tabs-store'
import { renameBrowserScope } from '../browser/browser-scope'
import { dropChatPane, newToolPaneId, openChatFile, openDraftPane, PANE_ID } from './open-chat'
import { draftKeyFor, loadDrafts } from './drafts'
import { toggleSidebar, useLayout } from '../shell/layout-store'
import { openSubagentTab, toggleToolPanes, useTiling } from '../tiling/tiling-store'
import { setChatTitle } from '../eva/names-store'
import { AgentCrumb, OwnedCrumb } from '../assistants/AgentCrumb'
import { AgentNotch } from '../assistants/AgentNotch'
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

/** Main's chat pane: what the app tab in front shows when it is a chat or an assistant's thread. */
export function ChatPane() {
  const place = useTabs(activePlace)
  return <ChatView paneId={PANE_ID} place={place} main />
}

/**
 * An assistant's thread as a tool pane's tab: the same chat as main's pane, under its own pane id
 * (a fresh one each mount, forgotten when the tab goes). Main runs one omp per session file, so a
 * second pane on a chat this app runs reads it live and sends through its owner once Isaac says
 * so; one Relay runs (an assistant's) streams and replies in every pane alike.
 */
export function ToolChat({ place }: { place: Place }) {
  const [paneId, setPaneId] = useState<string | null>(null)
  useEffect(() => {
    const id = newToolPaneId()
    setPaneId(id)
    return () => dropChatPane(id)
  }, [])
  return paneId === null ? null : <ChatView paneId={paneId} place={place} main={false} />
}

function ChatView({ paneId, place, main }: { paneId: string; place: Place; main: boolean }) {
  const pane = useChatStore((s) => s.panes[paneId])
  const composer = useRef<ComposerHandle>(null)
  // A widget reply can go wherever the composer can send: a pane with a session. A stopped one
  // resumes on send (session-manager starts omp) and one running outside this app gets it through
  // Relay, exactly like a typed prompt.
  const canReply = pane !== undefined
  const widgetActions = useMemo<WidgetActionsValue>(
    () => ({ reply: (text) => composer.current?.sendReply(text), canReply }),
    [canReply],
  )
  const [evaRoot, setEvaRoot] = useState<string | null>(null)
  const sidebarState = useLayout((s) => s.state)
  const panelOpen = useTiling((s) => toolsShown(s.tiling))
  // The subagent a pane shows in front, when it is one of this chat's.
  const viewedSubagent = useTiling((s) => {
    const tab = frontTabs(s.tiling).find((t) => t.kind === 'subagent' && t.session === pane?.file)
    return tab?.kind === 'subagent' ? tab.name : null
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
  const appTab = useTabs(activeTabId)
  const draftKey = draftKeyFor(pane, placeChat, main ? browserScope(placeOf('chat'), appTab) : '')
  useEffect(() => {
    if (main) void loadDrafts()
  }, [main])

  const hiddenDone = useChatStore((s) => s.hiddenDone)
  const hiddenNames = useMemo(() => {
    const names = new Set<string>()
    for (const a of pane?.extras.subagents ?? [])
      if (pane && hiddenDone.has(hiddenKey(pane.file, a.name))) names.add(a.name)
    return names
  }, [pane, hiddenDone])

  // Subagents and jobs come from main (file-derived), pushed per pane; main's pane listens for all.
  useEffect(() => {
    if (!main) return
    return on('chat.extras', (e) => chatStore.getState().setExtras(e))
  }, [main])

  const activeIx = useTabs((s) => s.tabs.active)
  const reopen = main ? activeIx : -1

  // A tab whose place is a session path shows that session; a draft tab shows a new chat (main's
  // pane only: a tool pane's tab is always a thread).
  useEffect(() => {
    if (placeChat === 'draft') {
      if (main) void openDraftPane()
    } else if (placeChat) void openChatFile(placeChat, paneId)
  }, [placeChat, reopen, main, paneId])

  // A new chat that omp gave a session file: the tab follows it in place, so Back never returns
  // to a dead draft and the pane does not reopen. The draft's browser tabs carry over.
  const boundTo = pane?.boundTo ?? null
  useEffect(() => {
    if (!main || !boundTo || placeChat !== 'draft') return
    const appTab = activeTabId(tabsStore.getState())
    const chat = placeOf('chat', { chat: boundTo })
    renameBrowserScope(browserScope(placeOf('chat'), appTab), browserScope(chat, appTab))
    replaceActivePlace(chat)
  }, [main, boundTo, placeChat])

  // A tab on this chat names it as the header does, and follows a rename or omp's auto title.
  const shownFile = pane?.file ?? ''
  const shownTitle = pane?.title ?? ''
  useEffect(() => {
    if (shownFile !== '' && shownTitle !== '') setChatTitle(shownFile, shownTitle)
  }, [shownFile, shownTitle])

  // One drain for the whole app (main's pane): batches from main are applied once per animation
  // frame, to whichever pane they name.
  useEffect(() => {
    if (!main) return
    let e2e = false
    void invoke('app.info', {}).then((r) => {
      if (r.ok) {
        e2e = r.value.e2e
        setEvaRoot(r.value.evaRoot)
      }
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
    return () => drain.dispose()
  }, [main])

  // An error is a banner, not a lock: the next send retries (and restarts omp if it exited).
  const Root = main ? 'main' : 'section'
  return (
    <Root
      className={main ? 'eva-chat' : 'eva-chat eva-chat-tool'}
      data-testid="chat-pane"
      data-chat-pane={paneId}
    >
      <div className="eva-chat-header" data-testid="chat-header">
        {main ? (
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
            {agent !== null ? <AgentNotch id={agent} /> : null}
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
            {!main && agent !== null ? <AgentCrumb id={agent} /> : 'New chat'}
          </h2>
        )}
        {/* This header is the page's whenever the pane shows (a chat, an agent's thread; MainCard
            drops MainHeader then); otherwise the pane is hidden and MainHeader has the button.
            A tool pane's chat is always a thread. */}
        {place.page === 'chat' || thread !== null ? (
          agent !== null ? (
            <ArtifactsButton agent={agent} />
          ) : (
            <ContextButton />
          )
        ) : null}
        {main ? (
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
      {pane && !(pane.file === '' && pane.messages.length === 0) ? (
        <WidgetActions.Provider value={widgetActions}>
          <ReactionScope.Provider value={reactionScope}>
            <ChatLog
              paneId={paneId}
              messages={pane.messages}
              // A draft keeps its log key when omp names the file, so binding never jumps the scroll.
              file={pane.boundTo ? '' : pane.file}
              scrollFile={pane.file}
              shown={!main || place.page === 'chat' || thread !== null}
              typing={typing}
              busy={pane.running}
            />
          </ReactionScope.Provider>
        </WidgetActions.Provider>
      ) : main ? (
        <div className="eva-chat-empty">
          <div className="eva-chat-intro">
            <h2>What should Eva work on?</h2>
            {evaRoot ? (
              <div className="eva-dim">Each chat is an omp session in {evaRoot}.</div>
            ) : null}
          </div>
        </div>
      ) : (
        // A tool pane's thread while it opens: nothing to say yet.
        <div className="eva-chat-empty" />
      )}
      {pane ? (
        <SubagentChips
          subagents={pane.extras.subagents}
          hidden={hiddenNames}
          active={viewedSubagent}
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
    </Root>
  )
}

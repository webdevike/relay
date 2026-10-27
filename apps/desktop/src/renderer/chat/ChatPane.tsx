import './chat.css'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import { ContextButton } from '../context/ContextButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatLog } from './ChatLog'
import { Composer, type ComposerHandle } from './Composer'
import { WidgetActions, type WidgetActionsValue } from './widgets/actions'
import { PendingDialog } from './cards/PendingDialog'
import { JobsStrip } from './strips/JobsStrip'
import { StatusStrip } from './strips/StatusStrip'
import { SubagentChips } from './strips/SubagentChips'
import { chatStore, hiddenKey, useChatStore } from './chat-store'
import { createStreamDrain } from './stream-drain'
import { invoke, on } from '../ipc'
import { browserScope, placeOf } from '@evaos/shell-core'
import {
  activePlace,
  activeTabId,
  replaceActivePlace,
  tabsStore,
  useTabs,
} from '../tabs/tabs-store'
import { renameBrowserScope } from '../browser/browser-scope'
import { openChatFile, openDraftPane, PANE_ID } from './open-chat'
import { draftKeyFor, loadDrafts } from './drafts'
import { openSubagentPanel, togglePanel, toggleSidebar, useLayout } from '../shell/layout-store'
import { setChatTitle } from '../eva/names-store'
import { AgentCrumb } from '../assistants/AgentCrumb'
import { agentFile, agentIdOf, agentOf, useAssistants } from '../assistants/assistants-store'

declare global {
  interface Window {
    __evaosChatStats?: Record<
      string,
      { batches: number; gaps: number; snapshots: number; lastSeq: number }
    >
  }
}

export function ChatPane() {
  const pane = useChatStore((s) => s.panes[PANE_ID])
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
  const panelOpen = useLayout((s) => s.panelOpen)
  // The subagent the side panel shows, when it is one of this chat's.
  const viewedSubagent = useLayout((s) =>
    s.panelOpen && s.panelView.kind === 'subagent' && s.panelView.session === pane?.file
      ? s.panelView.name
      : null,
  )
  const sidebarLabel =
    sidebarState === 'open'
      ? 'Hide sidebar'
      : sidebarState === 'hidden'
        ? 'Show sidebar'
        : 'Sidebar hidden to fit the window. Widen the window or close the panel to bring it back.'
  // An agent's page shows its thread here once omp wrote the file (native Page::Agent).
  const place = useTabs(activePlace)
  const thread = useAssistants((s) => agentFile(s, place))
  const agent = agentIdOf(place)
  // An assistant thread shows the agent "typing" while Relay hears it working.
  const typing = useAssistants((s) => {
    const a = agent === null ? null : agentOf(s, agent)
    return a?.status === 'working' ? a.title : null
  })
  const placeChat = place.page === 'chat' ? place.chat : thread
  const appTab = useTabs(activeTabId)
  const draftKey = draftKeyFor(pane, placeChat, browserScope(placeOf('chat'), appTab))
  useEffect(() => void loadDrafts(), [])

  const hiddenDone = useChatStore((s) => s.hiddenDone)
  const hiddenNames = useMemo(() => {
    const names = new Set<string>()
    for (const a of pane?.extras.subagents ?? [])
      if (pane && hiddenDone.has(hiddenKey(pane.file, a.name))) names.add(a.name)
    return names
  }, [pane, hiddenDone])

  // Subagents and jobs come from main (file-derived), pushed per pane.
  useEffect(() => on('chat.extras', (e) => chatStore.getState().setExtras(e)), [])

  const activeIx = useTabs((s) => s.tabs.active)

  // A tab whose place is a session path shows that session; a draft tab shows a new chat.
  useEffect(() => {
    if (placeChat === 'draft') void openDraftPane()
    else if (placeChat) void openChatFile(placeChat)
  }, [placeChat, activeIx])

  // A new chat that omp gave a session file: the tab follows it in place, so Back never returns
  // to a dead draft and the pane does not reopen. The draft's browser tabs carry over.
  const boundTo = pane?.boundTo ?? null
  useEffect(() => {
    if (!boundTo || placeChat !== 'draft') return
    const appTab = activeTabId(tabsStore.getState())
    const chat = placeOf('chat', { chat: boundTo })
    renameBrowserScope(browserScope(placeOf('chat'), appTab), browserScope(chat, appTab))
    replaceActivePlace(chat)
  }, [boundTo, placeChat])

  // A tab on this chat names it as the header does, and follows a rename or omp's auto title.
  const shownFile = pane?.file ?? ''
  const shownTitle = pane?.title ?? ''
  useEffect(() => {
    if (shownFile !== '' && shownTitle !== '') setChatTitle(shownFile, shownTitle)
  }, [shownFile, shownTitle])

  // One drain for the whole app: batches from main are applied once per animation frame.
  useEffect(() => {
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
  }, [])

  // An error is a banner, not a lock: the next send retries (and restarts omp if it exited).
  return (
    <main className="eva-chat" data-testid="chat-pane">
      <div className="eva-chat-header" data-testid="chat-header">
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
        {pane ? (
          <>
            {pane.running ? (
              <span className="eva-streaming-dot" role="img" aria-label="Eva is replying" />
            ) : null}
            {/* An agent's thread names its way back: "< Assistants / Astra". */}
            <h2 className="eva-heading eva-chat-title" title={pane.file || undefined}>
              {agent !== null ? <AgentCrumb id={agent} /> : pane.title}
            </h2>
            {pane.file && !pane.extras.running && !pane.owner && !pane.away ? (
              <span className="eva-chat-saved">Saved session</span>
            ) : null}
            {pane.away?.job ? (
              <span className="eva-chat-saved" data-testid="chat-job">
                Running as a job
              </span>
            ) : null}
            {pane.owner && pane.owner !== PANE_ID && !pane.extras.running ? (
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
          <h2 className="eva-heading eva-chat-title">New chat</h2>
        )}
        {/* An assistant's page has the main header, which carries the button already. */}
        {agent === null ? <ContextButton /> : null}
        <Tooltip label={panelOpen ? 'Close panel' : 'Open panel'} position="bottom">
          <ActionIcon
            variant="subtle"
            className="eva-header-btn eva-chat-panel-toggle"
            data-testid="panel-toggle"
            aria-label={panelOpen ? 'Close panel' : 'Open panel'}
            aria-pressed={panelOpen}
            onClick={() => togglePanel()}
          >
            <IconLayoutSidebarRight size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </div>
      {pane?.error ? (
        <div className="eva-error-banner" role="alert" data-testid="chat-error">
          {pane.error}
        </div>
      ) : null}
      {pane && !(pane.file === '' && pane.messages.length === 0) ? (
        <WidgetActions.Provider value={widgetActions}>
          <ChatLog
            paneId={PANE_ID}
            messages={pane.messages}
            // A draft keeps its log key when omp names the file, so binding never jumps the scroll.
            file={pane.boundTo ? '' : pane.file}
            typing={typing}
          />
        </WidgetActions.Provider>
      ) : (
        <div className="eva-chat-empty">
          <div className="eva-chat-intro">
            <h2>What should Eva work on?</h2>
            {evaRoot ? (
              <div className="eva-dim">Each chat is an omp session in {evaRoot}.</div>
            ) : null}
          </div>
        </div>
      )}
      {pane ? (
        <SubagentChips
          subagents={pane.extras.subagents}
          hidden={hiddenNames}
          active={viewedSubagent}
          onOpen={(s) =>
            openSubagentPanel({
              session: pane.file,
              // A subagent's transcript lives in the session's folder, named like the session.
              file: `${pane.file.replace(/\.jsonl$/, '')}/${s.file}`,
              name: s.name,
            })
          }
          onClearDone={() => chatStore.getState().clearDone(PANE_ID)}
        />
      ) : null}
      <PendingDialog paneId={PANE_ID} />
      {pane ? <JobsStrip running={pane.extras.running} jobs={pane.extras.jobs} /> : null}
      <StatusStrip paneId={PANE_ID} />
      <Composer ref={composer} paneId={PANE_ID} disabled={!pane} draftKey={draftKey} />
    </main>
  )
}

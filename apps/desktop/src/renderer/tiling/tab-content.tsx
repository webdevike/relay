import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  pageTabPlace,
  toolTabId,
  type PageTab,
  type SubagentTab,
  type ToolTab,
} from '@evaos/shell-core'
import { WebPanel } from '../browser/WebPanel'
import { useChatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { InToolPaneContext, ReplacePlaceContext } from '../pages/place-host'
import { PageView } from '../pages/PageRouter'
import { MainHeader } from '../shell/MainHeader'
import { ExperimentArmPanel } from '../test-bench/ExperimentArmPanel'
import { MeetingTab } from '../meetings/MeetingTab'
import { mountedToolTabs, replacePageTab, tabVisible, useTiling } from './tiling-store'

// The files editor (and Monaco behind it) loads the first time Files opens.
const FilesPanel = lazy(() =>
  import('../files/FilesPanel').then((m) => ({ default: m.FilesPanel })),
)

// xterm loads the first time a Terminal opens.
const TerminalPanel = lazy(() =>
  import('../terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
)

/**
 * Every tool tab's content renders once, through a portal, into its own detached node; its
 * dockview panel shows it by moving that node into the panel's body, and parks it out of sight
 * otherwise. Moving a tab to another pane, splitting or maximizing never remounts it (a page
 * keeps its view, Files its editors). Files stays mounted after its tab closes, like the old side
 * panel kept it, so closing a tab or pane never loses an edit; a Terminal does not, closing it
 * ends its shells, and a page tab closes its page.
 */
const nodes = new Map<string, HTMLDivElement>()
/** Scroll offsets inside a parked node, put back when it shows again. */
const parkedScroll = new WeakMap<HTMLElement, Array<[Element, number, number]>>()
let park: HTMLDivElement | null = null

function nodeFor(id: string): HTMLDivElement {
  let node = nodes.get(id)
  if (!node) {
    node = document.createElement('div')
    node.className = 'eva-tab-content'
    node.dataset['tabId'] = id
    nodes.set(id, node)
  }
  return node
}

function scrollOffsets(node: HTMLElement): Array<[Element, number, number]> {
  const out: Array<[Element, number, number]> = []
  for (const el of node.querySelectorAll('*')) {
    if (el.scrollTop || el.scrollLeft) out.push([el, el.scrollTop, el.scrollLeft])
  }
  return out
}

/** Re-parents `node`, keeping the scroll offsets inside it (a DOM move resets them). */
function moveNode(node: HTMLElement, parent: HTMLElement): void {
  if (node.parentElement === parent) return
  const toPark = parent === park
  const offsets = node.parentElement === park ? (parkedScroll.get(node) ?? []) : scrollOffsets(node)
  parent.appendChild(node)
  if (toPark) {
    parkedScroll.set(node, offsets)
    return
  }
  for (const [el, top, left] of offsets) {
    el.scrollTop = top
    el.scrollLeft = left
  }
}

/** Shows tool tab `id`'s content in `body` while its panel is mounted. */
export function useAttachContent(body: RefObject<HTMLElement | null>, id: string): void {
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const node = nodeFor(id)
    moveNode(node, el)
    return () => {
      if (node.parentElement !== el) return
      if (park) moveNode(node, park)
      else node.remove()
    }
  }, [body, id])
}

/** The subagent as the chat showing its session lists it (the one in front first). */
function useViewedSubagent(tab: SubagentTab) {
  return useChatStore((s) => {
    const front = s.panes[frontChatPaneOf()]
    const pane =
      front?.file === tab.session
        ? front
        : Object.values(s.panes).find((p) => p.file === tab.session)
    return pane?.extras.subagents.find((a) => a.name === tab.name)
  })
}

function SubagentContent({ tab }: { tab: SubagentTab }) {
  const subagent = useViewedSubagent(tab)
  // A helper of an open chat is told by that chat's extras; any other transcript (a session an
  // assistant started, a helper of a chat that is not open) is looked at for growth.
  return (
    <SubagentTranscript
      file={tab.file}
      version={subagent?.mtimeMs ?? null}
      poll={subagent === undefined}
    />
  )
}

/** A page beside the chat (Studio, a board, a Reviews item), with its header; it follows itself. */
function PageContent({ tab }: { tab: PageTab }) {
  const id = toolTabId(tab)
  const place = pageTabPlace(tab)
  return (
    <div className="eva-app-panel" data-testid={`page-tab-${tab.key}`}>
      <MainHeader place={place} lead={false} />
      <ReplacePlaceContext.Provider value={(p) => replacePageTab(id, p)}>
        <InToolPaneContext.Provider value>
          <PageView place={place} />
        </InToolPaneContext.Provider>
      </ReplacePlaceContext.Provider>
    </div>
  )
}

function TabContent({ tab, visible }: { tab: ToolTab; visible: boolean }) {
  switch (tab.kind) {
    case 'web':
      return <WebPanel tabId={tab.id} visible={visible} />
    case 'files':
      return (
        <Suspense fallback={null}>
          <FilesPanel hidden={!visible} />
        </Suspense>
      )
    case 'terminal':
      return (
        <Suspense fallback={null}>
          <TerminalPanel hidden={!visible} />
        </Suspense>
      )
    case 'subagent':
      return <SubagentContent tab={tab} />
    case 'experiment-arm':
      return <ExperimentArmPanel key={toolTabId(tab)} view={tab} />
    case 'meeting':
      return <MeetingTab key={toolTabId(tab)} id={tab.id} />
    case 'page':
      return <PageContent tab={tab} />
    case 'browser':
      // The retired Browser panel, until the load turns it into page tabs (web-tabs.ts).
      return null
  }
}

/** Tools that stay mounted once opened. */
const KEPT: readonly ToolTab['kind'][] = ['files']

/**
 * Renders every tool tab's content into its node, and the park the hidden ones wait in: the
 * workspace on screen's, the pinned ones, and those of every workspace shown this session, so a
 * switch back finds them as they were.
 */
export function TabContentHost() {
  // Re-render on any pane change (tabs open, close and come forward) and any hidden workspace's.
  useTiling((s) => s.panes)
  useTiling((s) => s.zoom)
  useTiling((s) => s.rev)
  useTiling((s) => s.scope)
  const kept = useRef(new Map<string, ToolTab>())
  const tabs = mountedToolTabs()
  for (const [id, tab] of tabs) if (KEPT.includes(tab.kind)) kept.current.set(id, tab)
  for (const [id, tab] of kept.current) if (!tabs.has(id)) tabs.set(id, tab)
  const ids = [...tabs.keys()].join('\n')
  // A closed tab that is not kept goes, with its node, once its portal unmounted.
  useEffect(() => {
    const live = new Set(ids.split('\n'))
    for (const [id, node] of nodes) {
      if (live.has(id)) continue
      node.remove()
      nodes.delete(id)
    }
  }, [ids])
  return (
    <>
      <div
        className="eva-tab-park"
        aria-hidden
        ref={(el) => {
          park = el
        }}
      />
      {[...tabs].map(([id, tab]) =>
        createPortal(<TabContent tab={tab} visible={tabVisible(id)} />, nodeFor(id), id),
      )}
    </>
  )
}

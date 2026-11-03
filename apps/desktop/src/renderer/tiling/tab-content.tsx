import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  allPanes,
  isTabVisible,
  tabId,
  type PaneTab,
  type Place,
  type SubagentTab,
} from '@evaos/shell-core'
import { ReplacePlaceContext } from '../pages/place-host'
import { BrowserPanel } from '../browser/BrowserPanel'
import { useChatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { PageView } from '../pages/PageRouter'
import { ExperimentArmPanel } from '../test-bench/ExperimentArmPanel'
import { replaceTab, useTiling } from './tiling-store'

// The files editor (and Monaco behind it) loads the first time Files opens.
const FilesPanel = lazy(() =>
  import('../files/FilesPanel').then((m) => ({ default: m.FilesPanel })),
)

/**
 * Every tab's content renders once, through a portal, into its own detached node; a pane shows
 * its tab in front by moving that node into its body, and parks the rest out of sight. Moving a
 * tab to another pane, splitting or zooming never remounts it (the browser keeps its view, Files
 * its editors). The browser and Files stay mounted after their tab closes, like the
 * old side panel kept them, so closing a tab or pane never loses an edit.
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

/** Shows tab `id`'s content in `body` while it is the pane's tab in front. */
export function useAttachContent(body: RefObject<HTMLElement | null>, id: string | null): void {
  useLayoutEffect(() => {
    const el = body.current
    if (!el || id === null) return
    const node = nodeFor(id)
    moveNode(node, el)
    return () => {
      if (node.parentElement !== el) return
      if (park) moveNode(node, park)
      else node.remove()
    }
  }, [body, id])
}

/** The subagent as the chat pane showing its session lists it (main's first, else a tool pane's). */
function useViewedSubagent(tab: SubagentTab) {
  return useChatStore((s) => {
    const main = s.panes[PANE_ID]
    const pane =
      main?.file === tab.session ? main : Object.values(s.panes).find((p) => p.file === tab.session)
    return pane?.extras.subagents.find((a) => a.name === tab.name)
  })
}

function SubagentContent({ tab }: { tab: SubagentTab }) {
  const subagent = useViewedSubagent(tab)
  return <SubagentTranscript file={tab.file} version={subagent?.mtimeMs ?? null} />
}

/** A page in a tool pane: what it settles on replaces its own tab, not the chat pane's. */
function PageTab({ tab }: { tab: Extract<PaneTab, { kind: 'page' }> }) {
  const id = tabId(tab)
  const replace = useCallback((place: Place) => replaceTab(id, { kind: 'page', place }), [id])
  return (
    <ReplacePlaceContext.Provider value={replace}>
      <PageView place={tab.place} />
    </ReplacePlaceContext.Provider>
  )
}

function TabContent({ tab, visible }: { tab: PaneTab; visible: boolean }) {
  switch (tab.kind) {
    case 'browser':
      return <BrowserPanel hidden={!visible} />
    case 'files':
      return (
        <Suspense fallback={null}>
          <FilesPanel hidden={!visible} />
        </Suspense>
      )
    case 'subagent':
      return <SubagentContent tab={tab} />
    case 'experiment-arm':
      return <ExperimentArmPanel key={tabId(tab)} view={tab} />
    case 'page':
      return <PageTab tab={tab} />
  }
}

/** Tools that stay mounted once opened; the browser from the start (its host scope follows it). */
const KEPT: readonly PaneTab['kind'][] = ['browser', 'files']

/** Renders every tab's content into its node, and the park the hidden ones wait in. */
export function TabContentHost() {
  const tiling = useTiling((s) => s.tiling)
  const kept = useRef(new Map<string, PaneTab>([['browser', { kind: 'browser' }]]))
  const tabs = new Map<string, PaneTab>()
  for (const pane of allPanes(tiling.root)) for (const tab of pane.tabs) tabs.set(tabId(tab), tab)
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
        createPortal(<TabContent tab={tab} visible={isTabVisible(tiling, id)} />, nodeFor(id), id),
      )}
    </>
  )
}

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { appTabOf, toolTabId, type SubagentTab, type ToolTab } from '@evaos/shell-core'
import { BrowserPanel } from '../browser/BrowserPanel'
import { useChatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { ExperimentArmPanel } from '../test-bench/ExperimentArmPanel'
import { tabVisible, toolTabOfId, useTiling } from './tiling-store'

// The files editor (and Monaco behind it) loads the first time Files opens.
const FilesPanel = lazy(() =>
  import('../files/FilesPanel').then((m) => ({ default: m.FilesPanel })),
)

/**
 * Every tool tab's content renders once, through a portal, into its own detached node; its
 * dockview panel shows it by moving that node into the panel's body, and parks it out of sight
 * otherwise. Moving a tab to another pane, splitting or maximizing never remounts it (the
 * browser keeps its view, Files its editors). The browser and Files stay mounted after their tab
 * closes, like the old side panel kept them, so closing a tab or pane never loses an edit.
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
  return <SubagentTranscript file={tab.file} version={subagent?.mtimeMs ?? null} />
}

function TabContent({ tab, visible }: { tab: ToolTab; visible: boolean }) {
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
      return <ExperimentArmPanel key={toolTabId(tab)} view={tab} />
  }
}

/** Tools that stay mounted once opened; the browser from the start (its host scope follows it). */
const KEPT: readonly ToolTab['kind'][] = ['browser', 'files']

/** Renders every tool tab's content into its node, and the park the hidden ones wait in. */
export function TabContentHost() {
  // Re-render on any pane change: tabs open, close and come forward.
  const panes = useTiling((s) => s.panes)
  useTiling((s) => s.zoom)
  const kept = useRef(new Map<string, ToolTab>([['browser', { kind: 'browser' }]]))
  const tabs = new Map<string, ToolTab>()
  for (const pane of panes) {
    for (const id of pane.views) {
      if (appTabOf(id) !== null) continue
      const tab = toolTabOfId(id)
      if (tab) tabs.set(id, tab)
    }
  }
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

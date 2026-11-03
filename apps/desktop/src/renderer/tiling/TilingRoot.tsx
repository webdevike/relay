import './tiling.css'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  CHAT_PANE,
  GAP,
  toolsShown,
  allPanes,
  findNode,
  isChatPane,
  layoutRects,
  type Rect,
  type TilingRects,
} from '@evaos/shell-core'
import { setFocusedPane } from '../hotkeys/pane-focus'
import { useBrowserHotkeys } from '../browser/useBrowserHotkeys'
import { useFilesHotkeys } from '../files/files-hotkeys'
import { MainCard } from '../shell/MainCard'
import { Divider } from './Divider'
import { TabContentHost } from './tab-content'
import { useDrag } from './tab-drag'
import { ToolPane } from './ToolPane'
import { LAYOUT_EVENT } from './layout-event'
import { focusPaneById, setRects, tilingStore, useTiling } from './tiling-store'

const ChatPaneContent = memo(function ChatPaneContent() {
  return <MainCard />
})

interface FrameProps {
  id: string
  rect: Rect | undefined
  /** A tool pane on the top edge starts below the tab strip, level with the chat's card. */
  padTop: boolean
  focused: boolean
  /** Folded away by the panel toggle: zero wide at the right edge, hidden once it got there. */
  collapsed: boolean
  /** The width the pane's content keeps while the frame folds (like the sidebar's inner width). */
  innerW: number
  children: ReactNode
}

function PaneFrame({ id, rect, padTop, focused, collapsed, innerW, children }: FrameProps) {
  const chat = isChatPane(id)
  return (
    <div
      className="eva-pane"
      data-pane-id={id}
      data-pane-kind={chat ? 'chat' : 'tool'}
      data-focused={focused || undefined}
      data-pad-top={padTop || undefined}
      data-collapsed={collapsed || undefined}
      data-testid={chat ? 'pane-chat' : undefined}
      tabIndex={-1}
      style={
        rect
          ? ({
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              '--eva-pane-inner-w': `${innerW}px`,
            } as CSSProperties)
          : { display: 'none' }
      }
      aria-hidden={collapsed || undefined}
      inert={collapsed || undefined}
      onPointerDownCapture={() => {
        if (tilingStore.getState().tiling.focus !== id) focusPaneById(id)
      }}
      onFocusCapture={() => {
        setFocusedPane(id)
        if (tilingStore.getState().tiling.focus !== id) focusPaneById(id)
      }}
      onBlurCapture={() => setFocusedPane(null)}
    >
      {children}
    </div>
  )
}

/** Where a drop would land: the half of the pane a split would take, or the whole pane. */
function DropOverlay({
  rects,
  root,
}: {
  rects: Record<string, Rect>
  root: RefObject<HTMLDivElement | null>
}) {
  const drag = useDrag((s) => s.drag)
  const target = useDrag((s) => s.target)
  const origin = drag ? root.current?.getBoundingClientRect() : undefined
  if (!drag || !origin) return null
  const r = target ? rects[target.pane] : undefined
  let zone: Rect | null = null
  if (r && target) {
    const halfW = Math.round(r.w / 2)
    const halfH = Math.round(r.h / 2)
    zone =
      target.zone === 'left'
        ? { ...r, w: halfW }
        : target.zone === 'right'
          ? { ...r, x: r.x + r.w - halfW, w: halfW }
          : target.zone === 'up'
            ? { ...r, h: halfH }
            : target.zone === 'down'
              ? { ...r, y: r.y + r.h - halfH, h: halfH }
              : r
  }
  return (
    <>
      {zone ? (
        <div
          className="eva-drop-zone"
          data-testid="drop-zone"
          data-zone={target?.zone}
          style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h }}
        />
      ) : null}
      <div
        className="eva-drag-ghost"
        style={{ left: drag.x - origin.left + 12, top: drag.y - origin.top + 12 }}
      >
        {drag.title}
      </div>
    </>
  )
}

/**
 * The panes beside the sidebar: a split tree laid out as absolutely placed frames, so a pane
 * never remounts when the tree around it changes. The dividers sit in the gaps between siblings;
 * a zoomed pane fills the area alone.
 */
export function TilingRoot() {
  const loaded = useTiling((s) => s.loaded)
  const tiling = useTiling((s) => s.tiling)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const widths = useRef(new Map<string, number>())
  const last = useRef({ shown: false, w: 0, h: 0 })
  /** Pane ids already on screen once; null until the first loaded render. */
  const mounted = useRef<Set<string> | null>(null)
  const [, setUnfold] = useState(0)
  useFilesHotkeys()
  useBrowserHotkeys()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const b = el.getBoundingClientRect()
      setSize((s) =>
        s.w === Math.round(b.width) && s.h === Math.round(b.height)
          ? s
          : { w: Math.round(b.width), h: Math.round(b.height) },
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loaded])

  const shown = tiling.zoom === null ? tiling.root : findNode(tiling.root, tiling.zoom)
  const layout = useMemo<TilingRects>(
    () =>
      shown
        ? layoutRects(shown, { x: 0, y: 0, w: size.w, h: size.h }, GAP)
        : { panes: {}, splits: {}, dividers: [] },
    [shown, size.w, size.h],
  )

  useEffect(() => setRects(layout.panes), [layout])
  // Only a panel open or close animates (the sidebar's rule): not window fitting, divider drags
  // or layout changes that happen to land in the same render.
  useLayoutEffect(() => {
    const el = ref.current
    const prev = last.current
    const now = { shown: toolsShown(tiling), w: size.w, h: size.h }
    last.current = now
    if (!el || !loaded) return
    const seeded = mounted.current !== null
    const toggled = seeded && prev.shown !== now.shown && prev.w === now.w && prev.h === now.h
    el.dataset['panelTransition'] = String(toggled)
    const ids = new Set(allPanes(tiling.root).map((p) => p.id))
    const fresh = [...ids].some((id) => !mounted.current?.has(id))
    mounted.current = ids
    if (seeded && toggled && fresh) {
      // The folded frame must be styled once before it unfolds, or there is nothing to transition.
      void el.offsetWidth
      setUnfold((n) => n + 1)
    }
  }, [layout, tiling, size.w, size.h, loaded])
  // A tab moved to another pane can land somewhere else at the same size: slots re-measure.
  useEffect(() => {
    window.dispatchEvent(new Event(LAYOUT_EVENT))
  }, [layout, tiling])

  if (!loaded) return <div className="eva-tiling" ref={ref} data-testid="tiling" />
  const panes = allPanes(tiling.root)
  const many = Object.keys(layout.panes).length > 1
  // The panel toggle zooms the chat pane: the tool panes fold to the right edge instead of
  // vanishing, so the frames slide like the sidebar column does.
  const folding = tiling.zoom === CHAT_PANE
  // A tool pane opening for the first time (no pane to unfold) mounts folded for one frame.
  const entering = (id: string): boolean =>
    mounted.current !== null && !last.current.shown && !mounted.current.has(id) && !isChatPane(id)
  return (
    <div
      className="eva-tiling"
      ref={ref}
      data-testid="tiling"
      data-zoomed={tiling.zoom !== null || undefined}
    >
      {panes.map((p) => {
        const own = layout.panes[p.id]
        const collapsed = (own === undefined && folding && size.w > 0) || (own && entering(p.id))
        const rect: Rect | undefined = collapsed ? { x: size.w, y: 0, w: 0, h: size.h } : own
        if (own) widths.current.set(p.id, own.w)
        return (
          <PaneFrame
            key={p.id}
            id={p.id}
            rect={rect}
            padTop={rect !== undefined && rect.y === 0 && !isChatPane(p.id)}
            focused={many && tiling.focus === p.id}
            collapsed={collapsed === true}
            innerW={widths.current.get(p.id) ?? 0}
          >
            {isChatPane(p.id) ? <ChatPaneContent /> : <ToolPane id={p.id} />}
          </PaneFrame>
        )
      })}
      {layout.dividers.map((d) => {
        const s = layout.splits[d.split]
        return (
          <Divider
            key={`${d.split}:${d.index}`}
            d={d}
            length={d.dir === 'row' ? (s?.w ?? 0) : (s?.h ?? 0)}
          />
        )
      })}
      <DropOverlay rects={layout.panes} root={ref} />
      <TabContentHost />
    </div>
  )
}

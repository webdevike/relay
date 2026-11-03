import { describe, expect, it } from 'vitest'
import { placeOf } from './place'
import {
  CHAT_PANE,
  TilingError,
  activatePaneTab,
  allPanes,
  closePane,
  closePaneTab,
  defaultTiling,
  findTab,
  isTabVisible,
  layoutRects,
  minSize,
  movePaneTab,
  neighbor,
  openPaneTab,
  replacePaneTab,
  resizePane,
  setZoom,
  splitPane,
  tabId,
  tilingFromJson,
  tilingToJson,
  toolsShown,
  type Tiling,
} from './tiling'

const shape = (t: Tiling): unknown => {
  const walk = (n: Tiling['root']): unknown =>
    n.type === 'pane'
      ? `${n.id}[${n.tabs.map(tabId).join(',')}]`
      : { [n.dir]: n.children.map(walk) }
  return walk(t.root)
}

const bench = { kind: 'page', place: placeOf('test-bench') } as const

describe('tiling', () => {
  it('defaults to today: chat, then one tool pane with the three tools', () => {
    const t = defaultTiling(0.3, 'files')
    expect(shape(t)).toEqual({ row: ['chat[]', 'p2[browser,files,artifacts]'] })
    expect(t.root.type === 'split' && t.root.sizes).toEqual([0.7, 0.3])
    expect(isTabVisible(t, 'files')).toBe(true)
    expect(isTabVisible(t, 'browser')).toBe(false)
    expect(toolsShown(t)).toBe(true)
  })

  it('splits a pane, moving a tab that is open elsewhere', () => {
    const { tiling, pane } = splitPane(defaultTiling(), 'p2', 'down', { kind: 'browser' })
    expect(shape(tiling)).toEqual({
      row: ['chat[]', { column: ['p2[files,artifacts]', `${pane}[browser]`] }],
    })
    expect(tiling.focus).toBe(pane)
    // Splitting the same way again adds a sibling instead of nesting.
    const again = splitPane(tiling, pane, 'down', bench).tiling
    expect(shape(again)).toEqual({
      row: [
        'chat[]',
        { column: ['p2[files,artifacts]', `${pane}[browser]`, 'p5[page:test-bench]'] },
      ],
    })
  })

  it('builds chat | files over browser | canvas', () => {
    let t = defaultTiling()
    t = splitPane(t, 'p2', 'down', { kind: 'browser' }).tiling
    const canvas = { kind: 'page', place: placeOf('canvas', { canvas: 'b' }) } as const
    t = splitPane(t, t.root.type === 'split' ? t.root.children[1]!.id : '', 'right', canvas).tiling
    expect(shape(t)).toEqual({
      row: ['chat[]', { column: ['p2[files,artifacts]', 'p3[browser]'] }, 'p5[canvas:b]'],
    })
  })

  it('splitting a whole row toward its own direction keeps the row', () => {
    const { tiling, pane } = splitPane(defaultTiling(), 's1', 'right', bench, 0.25)
    expect(tiling.root.id).toBe('s1')
    expect(shape(tiling)).toEqual({
      row: ['chat[]', 'p2[browser,files,artifacts]', `${pane}[page:test-bench]`],
    })
    expect(tiling.root.type === 'split' && tiling.root.sizes[2]).toBeCloseTo(0.25)
  })

  it('replaces a page tab in place, or folds it into the same page open elsewhere', () => {
    const canvas = (slug: string | null) =>
      ({ kind: 'page', place: placeOf('canvas', { canvas: slug }) }) as const
    let t = openPaneTab(defaultTiling(), canvas(null))
    t = replacePaneTab(t, 'page:canvas', canvas('b'))
    expect(shape(t)).toEqual({ row: ['chat[]', 'p2[browser,canvas:b,files,artifacts]'] })
    t = openPaneTab(t, canvas(null))
    t = replacePaneTab(t, 'page:canvas', canvas('b'))
    expect(shape(t)).toEqual({ row: ['chat[]', 'p2[browser,canvas:b,files,artifacts]'] })
    expect(isTabVisible(t, 'canvas:b')).toBe(true)
  })

  it('an only tab split beside its own pane changes nothing', () => {
    const t = splitPane(defaultTiling(), 'p2', 'down', { kind: 'browser' }).tiling
    expect(splitPane(t, 'p3', 'right', { kind: 'browser' }).tiling).toBe(t)
  })

  it('moving the last tab out closes its pane and collapses the split', () => {
    let t = splitPane(defaultTiling(), 'p2', 'right', { kind: 'artifacts' }).tiling
    t = movePaneTab(t, { kind: 'artifacts' }, 'p2', 0)
    expect(shape(t)).toEqual({ row: ['chat[]', 'p2[artifacts,browser,files]'] })
    expect(t.focus).toBe('p2')
  })

  it('refuses tabs in the chat pane and chats in tool panes', () => {
    expect(() => movePaneTab(defaultTiling(), { kind: 'files' }, CHAT_PANE)).toThrow(TilingError)
    const chat = { kind: 'page', place: placeOf('chat') } as const
    expect(() => openPaneTab(defaultTiling(), chat)).toThrow('Chats stay')
    expect(() => closePane(defaultTiling(), CHAT_PANE)).toThrow('cannot close')
  })

  it("takes an assistant's thread tab into a pane or a split like any other page", () => {
    const nova = { kind: 'page', place: placeOf('agent:nova') } as const
    let t = openPaneTab(defaultTiling(), nova)
    expect(findTab(t, tabId(nova))?.pane.id).toBe('p2')
    t = splitPane(defaultTiling(), 'p2', 'down', nova).tiling
    expect(findTab(t, tabId(nova))).not.toBeNull()
    // It survives a layout.json round trip.
    expect(findTab(tilingFromJson(tilingToJson(t)), tabId(nova))).not.toBeNull()
  })

  it('opens a new tab in the focused or last tool pane, else a new pane', () => {
    let t = openPaneTab(defaultTiling(), bench)
    expect(findTab(t, 'page:test-bench')?.pane.id).toBe('p2')
    t = closePane(t, 'p2')
    expect(shape(t)).toBe('chat[]')
    t = openPaneTab(t, { kind: 'files' })
    expect(shape(t)).toEqual({ row: ['chat[]', 'p3[files]'] })
    // Opening what is already open focuses it; naming a pane moves it.
    const { tiling } = splitPane(t, 'p3', 'down', bench)
    expect(openPaneTab(tiling, { kind: 'files' }).focus).toBe('p3')
    expect(shape(openPaneTab(tiling, { kind: 'files' }, 'p5'))).toEqual({
      row: ['chat[]', 'p5[page:test-bench,files]'],
    })
  })

  it('closing a tab picks the next one and an empty pane goes away', () => {
    let t = activatePaneTab(defaultTiling(), 'files')
    t = closePaneTab(t, 'files')
    expect(allPanes(t.root)[1]?.active).toBe('artifacts')
    t = closePaneTab(closePaneTab(t, 'artifacts'), 'browser')
    expect(shape(t)).toBe('chat[]')
    expect(t.focus).toBe(CHAT_PANE)
  })

  it('zoom shows one pane; opening a tab elsewhere ends it', () => {
    let t = setZoom(defaultTiling(), CHAT_PANE)
    expect(toolsShown(t)).toBe(false)
    t = openPaneTab(t, { kind: 'files' })
    expect(t.zoom).toBeNull()
    expect(isTabVisible(t, 'files')).toBe(true)
  })

  it('resizes within the parent, keeping sibling proportions', () => {
    let t = splitPane(defaultTiling(0.5), 'chat', 'right', bench, 0.5).tiling
    t = resizePane(t, 'chat', 0.5)
    const root = t.root.type === 'split' ? t.root : null
    expect(root?.sizes[0]).toBeCloseTo(0.5)
    // The bench pane took half the chat's half; both siblings scale to fill the other half.
    expect(root?.sizes[1]).toBeCloseTo(1 / 6)
    expect(root?.sizes[2]).toBeCloseTo(1 / 3)
  })

  it('lays out rects and dividers with gaps, and finds neighbors', () => {
    let t = splitPane(defaultTiling(0.5), 'p2', 'down', { kind: 'browser' }).tiling
    const { panes, dividers } = layoutRects(t.root, { x: 0, y: 0, w: 1008, h: 600 }, 8)
    expect(panes['chat']).toEqual({ x: 0, y: 0, w: 500, h: 600 })
    expect(panes['p2']).toEqual({ x: 508, y: 0, w: 500, h: 296 })
    expect(panes['p3']).toEqual({ x: 508, y: 304, w: 500, h: 296 })
    expect(dividers.map((d) => d.dir)).toEqual(['row', 'column'])
    expect(neighbor(panes, 'chat', 'right')).toBe('p2')
    expect(neighbor(panes, 'p3', 'up')).toBe('p2')
    expect(neighbor(panes, 'p3', 'left')).toBe('chat')
    expect(neighbor(panes, 'chat', 'left')).toBeNull()
    t = setZoom(t, null)
    expect(minSize(t.root, 'w', 8)).toBe(480 + 8 + 240)
  })

  it('round-trips through JSON and repairs what it cannot trust', () => {
    const t = splitPane(defaultTiling(), 'p2', 'down', bench).tiling
    const json = tilingToJson(t)
    const back = tilingFromJson(JSON.parse(JSON.stringify(json)))
    expect(back && tilingToJson(back)).toEqual(json)
    expect(tilingFromJson(null)).toBeNull()
    expect(tilingFromJson({ root: { type: 'nope' } })).toBeNull()
    // No chat pane: it comes back on the left. Unknown and duplicate tabs drop out.
    const repaired = tilingFromJson({
      root: {
        type: 'pane',
        id: 'p7',
        tabs: [{ kind: 'files' }, { kind: 'terminal' }, { kind: 'files' }],
        active: 'gone',
      },
      focus: 'p9',
    })
    expect(repaired && shape(repaired)).toEqual({ row: ['chat[]', 'p7[files]'] })
    expect(repaired?.focus).toBe(CHAT_PANE)
    expect(repaired?.seq).toBeGreaterThan(7)
  })
})

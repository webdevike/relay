import { describe, expect, it } from 'vitest'
import type { DockJson } from './dock'
import { diffEntries, fromEntries, placeDock, portableDock, toEntries } from './mirror'

/** Files beside the chat, Terminal under Files: a row of [p1, column[p2, p3]]. */
const dock = (w: number, h: number, left: number): DockJson => ({
  grid: {
    root: {
      type: 'branch',
      size: h,
      data: [
        { type: 'leaf', size: left, data: { id: 'p1', views: ['tab:1'], activeView: 'tab:1' } },
        {
          type: 'branch',
          size: w - left,
          data: [
            { type: 'leaf', size: h * 0.6, data: { id: 'p2', views: ['files'] } },
            { type: 'leaf', size: h * 0.4, data: { id: 'p3', views: ['web:t4'] } },
          ],
        },
      ],
    },
    width: w,
    height: h,
    orientation: 'HORIZONTAL',
  },
  panels: {
    'tab:1': { id: 'tab:1', contentComponent: 'app', title: 'Chat on the Mini' },
    files: {
      id: 'files',
      contentComponent: 'tool',
      title: 'Files',
      params: { tab: { kind: 'files' } },
    },
    'web:t4': {
      id: 'web:t4',
      contentComponent: 'tool',
      title: 'Example',
      params: { tab: { kind: 'web', id: 't4' } },
    },
  },
  activeGroup: 'p1',
})

describe('portableDock / placeDock', () => {
  it('the same split in two window sizes is one portable layout, without titles', () => {
    const mini = portableDock(dock(2400, 1300, 1560))
    const book = portableDock(dock(1500, 860, 975))
    expect(mini).toEqual(book)
    expect(Object.values(mini.panels).some((p) => 'title' in p)).toBe(false)
  })

  it('lays a portable layout out in a window and comes back to the same shares', () => {
    const portable = portableDock(dock(2400, 1300, 1560))
    const placed = placeDock(portable, { width: 1512, height: 900 })
    const root = placed.grid.root
    expect(root.type === 'branch' && root.data.map((c) => c.size)).toEqual([983, 529])
    const right = root.type === 'branch' ? root.data[1]! : null
    expect(right?.type === 'branch' && right.data.map((c) => c.size)).toEqual([540, 360])
    expect(portableDock(placed)).toEqual(portable)
  })
})

describe('toEntries / fromEntries / diffEntries', () => {
  it('round-trips tabs, workspaces and pages', () => {
    const state = {
      tabs: { active: 0, list: [{ id: 1 }] },
      workspaces: {
        front: 'chat:a',
        pinned: [{ kind: 'files' as const }],
        layouts: { 'chat:a': dock(1000, 700, 600) },
        order: ['chat:a'],
      },
      pages: { t4: { url: 'https://example.com/', title: 'Example', scope: 'chat:a' } },
    }
    const entries = toEntries(state)
    expect(Object.keys(entries).sort()).toEqual([
      'layout:chat:a',
      'order',
      'page:t4',
      'pinned',
      'tabs',
    ])
    const back = fromEntries(entries)
    expect(back.tabs).toEqual(state.tabs)
    expect(back.pages).toEqual(state.pages)
    expect(back.workspaces?.order).toEqual(['chat:a'])
    expect(back.workspaces?.front).toBeNull()
    expect(back.workspaces?.layouts['chat:a']).toEqual(portableDock(dock(1000, 700, 600)))
  })

  it('diffs by value, whatever the key order', () => {
    const prev = { a: { x: 1, y: 2 }, b: 1, c: 2 }
    const next = { a: { y: 2, x: 1 }, b: 3, d: 4 }
    expect(diffEntries(prev, next)).toEqual({ set: { b: 3, d: 4 }, del: ['c'] })
  })
})

import { describe, expect, it } from 'vitest'
import {
  STUDIO_UNSORTED,
  studioItems,
  studioLineage,
  type StudioJob,
  type StudioParent,
} from '@evaos/contract'
import { clickSelection, railCounts, studioGrid } from './grid'
import { FILTERS } from './local'

let n = 0
function job(
  over: Partial<StudioJob> & { prompt?: string; favorite?: boolean; parent?: StudioParent } = {},
): StudioJob {
  n += 1
  const { prompt = `prompt ${n}`, favorite, ...rest } = over
  return {
    id: `j${n}`,
    spec: { mode: 'image', backend: 'codex-image', prompt, aspect: '1:1', resolution: '1024x1024' },
    state: 'done',
    origin: 'desktop',
    createdAt: n * 1000,
    progress: 1,
    outputs: [
      {
        id: `a${n}`,
        kind: 'image',
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        size: 1,
        path: `/studio/a${n}/t`,
        thumb: `/studio/a${n}/t/thumb`,
        origin: 'output',
        createdAt: n * 1000,
        ...(favorite ? { favorite: true } : {}),
      },
    ],
    ...rest,
  }
}

function library(jobs: StudioJob[]) {
  const items = studioItems(jobs)
  return { items, lineage: studioLineage(items) }
}

describe('studioGrid', () => {
  it('lists originals newest first with the count of versions below each', () => {
    const root = job({ prompt: 'a red cup' })
    const child = job({ parent: { asset: root.outputs[0]!.id, how: 'edit' } })
    const grand = job({ parent: { asset: child.outputs[0]!.id, how: 'upscale' }, favorite: true })
    const other = job({ project: 'p1' })
    const jobs = [other, grand, child, root]
    const { items, lineage } = library(jobs)
    const grid = studioGrid('all', items, lineage, jobs, FILTERS)
    expect(grid.order).toEqual([other.outputs[0]!.id, root.outputs[0]!.id])
    expect(grid.counts.get(root.outputs[0]!.id)).toBe(2)
    expect(studioGrid('p1', items, lineage, jobs, FILTERS).order).toEqual([other.outputs[0]!.id])
    expect(studioGrid(STUDIO_UNSORTED, items, lineage, jobs, FILTERS).order).toEqual([
      root.outputs[0]!.id,
    ])
    // Favorites lists every favorite, versions too.
    expect(studioGrid('fav', items, lineage, jobs, FILTERS).order).toEqual([grand.outputs[0]!.id])
  })

  it('filters by prompt, model, favorite and date, and hides pending tiles while filtering', () => {
    const a = job({ prompt: 'Lighthouse at dusk', favorite: true })
    const b = job({
      prompt: 'Paper boat',
      spec: {
        mode: 'image',
        backend: 'moss',
        model: 'moss-image',
        prompt: 'Paper boat',
        aspect: '1:1',
        resolution: '1024x1024',
      },
    })
    const running = { ...job(), state: 'running' as const, outputs: [] }
    const jobs = [running, b, a]
    const { items, lineage } = library(jobs)
    const now = 10_000
    expect(studioGrid('all', items, lineage, jobs, FILTERS, now).pending.map((j) => j.id)).toEqual([
      running.id,
    ])
    const q = studioGrid('all', items, lineage, jobs, { ...FILTERS, query: 'light' }, now)
    expect(q.order).toEqual([a.outputs[0]!.id])
    expect(q.pending).toEqual([])
    expect(
      studioGrid('all', items, lineage, jobs, { ...FILTERS, models: ['moss:moss-image'] }, now)
        .order,
    ).toEqual([b.outputs[0]!.id])
    expect(
      studioGrid('all', items, lineage, jobs, { ...FILTERS, favOnly: true }, now).order,
    ).toEqual([a.outputs[0]!.id])
    expect(
      studioGrid('all', items, lineage, jobs, { ...FILTERS, date: 'week' }, 30 * 86_400_000).order,
    ).toEqual([])
  })

  it('counts originals by project for the rail, with the newest as cover', () => {
    const a = job({ project: 'p1' })
    const b = job({ project: 'p1', favorite: true })
    const c = job({ parent: { asset: a.outputs[0]!.id, how: 'vary' }, project: 'p1' })
    const { items, lineage } = library([c, b, a])
    const counts = railCounts(items, lineage)
    expect(counts.all).toBe(2)
    expect(counts.fav).toBe(1)
    expect(counts.by.get('p1')).toBe(2)
    expect(counts.by.get(STUDIO_UNSORTED)).toBe(0)
    expect(counts.cover.get('p1')).toBe(b.outputs[0]!.thumb)
  })
})

describe('clickSelection', () => {
  const order = ['a', 'b', 'c', 'd']
  const none = { selected: [] as string[], anchor: null, selectMode: false }
  const plain = { shiftKey: false, metaKey: false, ctrlKey: false }

  it('opens on a plain click with nothing selected', () => {
    expect(clickSelection(plain, 'b', order, none)).toBe('open')
  })

  it('toggles with Cmd, or on a plain click while selecting', () => {
    expect(clickSelection({ ...plain, metaKey: true }, 'b', order, none)).toEqual({
      selected: ['b'],
      anchor: 'b',
    })
    expect(clickSelection(plain, 'b', order, { ...none, selected: ['b', 'c'] })).toEqual({
      selected: ['c'],
      anchor: 'b',
    })
    expect(clickSelection(plain, 'a', order, { ...none, selectMode: true })).toEqual({
      selected: ['a'],
      anchor: 'a',
    })
  })

  it('selects a range from the anchor with Shift', () => {
    expect(
      clickSelection({ ...plain, shiftKey: true }, 'd', order, {
        ...none,
        selected: ['b'],
        anchor: 'b',
      }),
    ).toEqual({ selected: ['b', 'c', 'd'], anchor: 'b' })
  })
})

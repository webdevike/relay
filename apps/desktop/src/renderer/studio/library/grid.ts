// The landing's grid as pure functions of the host's jobs: originals of the open view newest
// first (Favorites lists every favorite), pending originals, and the rail's counts and covers.
import {
  STUDIO_UNSORTED,
  studioDescendantCount,
  studioIsOriginal,
  studioJobActive,
  studioProjectOf,
  type StudioItem,
  type StudioJob,
  type StudioLineage,
} from '@evaos/contract'
import { engineKey } from './create-models'
import { VIEW_ALL, VIEW_FAV, type DateFilter } from './local'

export interface GridFilters {
  query: string
  models: readonly string[]
  favOnly: boolean
  date: DateFilter
}

export interface Grid {
  items: StudioItem[]
  /** Queued or running originals of the view, oldest first (they sit before the images). */
  pending: StudioJob[]
  /** Asset ids in grid order, for Shift ranges and Select all. */
  order: string[]
  /** Versions below each original (the iteration badge). */
  counts: ReadonlyMap<string, number>
}

export const filtering = (f: GridFilters): boolean =>
  f.query.trim() !== '' || f.models.length > 0 || f.favOnly || f.date !== 'all'

function since(date: DateFilter, now: number): number {
  if (date === 'today') return new Date(now).setHours(0, 0, 0, 0)
  if (date === 'week') return now - 7 * 86_400_000
  return 0
}

const inProject = (view: string, job: StudioJob): boolean =>
  view === VIEW_ALL || studioProjectOf(job) === view

export function studioGrid(
  view: string,
  items: readonly StudioItem[],
  lineage: StudioLineage,
  jobs: readonly StudioJob[],
  f: GridFilters,
  now = Date.now(),
): Grid {
  const q = f.query.trim().toLowerCase()
  const from = since(f.date, now)
  const passes = (i: StudioItem): boolean =>
    (q === '' || i.job.spec.prompt.toLowerCase().includes(q)) &&
    (f.models.length === 0 || f.models.includes(engineKey(i.job.spec))) &&
    (!f.favOnly || i.asset.favorite === true) &&
    i.asset.createdAt >= from
  const shown = items.filter((i) =>
    view === VIEW_FAV
      ? i.asset.favorite === true && passes(i)
      : inProject(view, i.job) && studioIsOriginal(i, lineage) && passes(i),
  )
  const pending =
    view === VIEW_FAV || filtering(f)
      ? []
      : jobs
          .filter((j) => studioJobActive(j) && j.parent === undefined && inProject(view, j))
          .sort(
            (a, b) => a.createdAt - b.createdAt || (a.batch?.index ?? 0) - (b.batch?.index ?? 0),
          )
  const counts = new Map<string, number>()
  for (const i of shown) counts.set(i.asset.id, studioDescendantCount(i.asset.id, lineage))
  return { items: shown, pending, order: shown.map((i) => i.asset.id), counts }
}

export interface RailCounts {
  all: number
  fav: number
  /** Originals by project (STUDIO_UNSORTED for none). */
  by: ReadonlyMap<string, number>
  /** The newest original's thumb by project. */
  cover: ReadonlyMap<string, string>
}

export function railCounts(items: readonly StudioItem[], lineage: StudioLineage): RailCounts {
  const by = new Map<string, number>()
  const cover = new Map<string, string>()
  let all = 0
  let fav = 0
  for (const i of items) {
    if (i.asset.favorite) fav += 1
    if (!studioIsOriginal(i, lineage)) continue
    all += 1
    const p = studioProjectOf(i.job)
    by.set(p, (by.get(p) ?? 0) + 1)
    if (!cover.has(p)) cover.set(p, i.asset.thumb)
  }
  if (!by.has(STUDIO_UNSORTED)) by.set(STUDIO_UNSORTED, 0)
  return { all, fav, by, cover }
}

/** Click semantics: Shift extends from the anchor, Cmd toggles, a plain click toggles while selecting. */
export function clickSelection(
  e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  id: string,
  order: readonly string[],
  s: { selected: readonly string[]; anchor: string | null; selectMode: boolean },
): { selected: string[]; anchor: string | null } | 'open' {
  if (e.shiftKey) {
    const to = order.indexOf(id)
    const from = s.anchor !== null && order.includes(s.anchor) ? order.indexOf(s.anchor) : to
    const [a, b] = from < to ? [from, to] : [to, from]
    return {
      selected: [...new Set([...s.selected, ...order.slice(a, b + 1)])],
      anchor: s.anchor ?? id,
    }
  }
  if (e.metaKey || e.ctrlKey || s.selected.length > 0 || s.selectMode) {
    return {
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
      anchor: id,
    }
  }
  return 'open'
}

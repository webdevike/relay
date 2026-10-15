// Port of apps/evaos/src/panel/browser/history.rs (address bar suggestions), minus Arc sqlite.

export interface Visit {
  url: string
  title: string
  visits: number
  /** `github.com/foo` from `https://www.github.com/foo/`, lowercased. */
  key: string
  titleKey: string
}

function bareOf(url: string): string {
  const i = url.indexOf('://')
  let rest = i >= 0 ? url.slice(i + 3) : url
  while (rest.startsWith('www.')) rest = rest.slice(4)
  return rest.replace(/\/+$/, '')
}

export function visitKey(url: string): string {
  return bareOf(url).toLowerCase()
}

export function makeVisit(url: string, title: string, visits: number): Visit {
  return { url, title, visits, key: visitKey(url), titleKey: title.toLowerCase() }
}

/** Folds into the same page when known (visits add up, non-empty title replaces); else appends. */
export function addVisit(list: Visit[], visit: Visit): void {
  const known = list.find((v) => v.key === visit.key)
  if (!known) {
    list.push(visit)
    return
  }
  known.visits += visit.visits
  if (visit.title) {
    known.title = visit.title
    known.titleKey = visit.titleKey
  }
}

/** Up to `limit` pages for `typed`; every word must appear in the key or title. */
export function suggest(list: readonly Visit[], typed: string, limit = 6): Visit[] {
  const t = typed.trim().toLowerCase()
  const i = t.indexOf('://')
  let key = i >= 0 ? t.slice(i + 3) : t
  while (key.startsWith('www.')) key = key.slice(4)
  const words = key.split(/\s+/).filter(Boolean)
  const first = words[0]
  if (first === undefined) return []
  const found: Array<[number, Visit]> = []
  for (const v of list) {
    if (!words.every((w) => v.key.includes(w) || v.titleKey.includes(w))) continue
    const rank = v.key.startsWith(key)
      ? 0
      : v.key.split(/[./-]/).some((p) => p.startsWith(first))
        ? 1
        : 2
    found.push([rank, v])
  }
  found.sort(([ra, a], [rb, b]) => ra - rb || b.visits - a.visits || a.key.length - b.key.length)
  return found.slice(0, limit).map(([, v]) => v)
}

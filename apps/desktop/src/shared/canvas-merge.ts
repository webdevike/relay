import type { CanvasBoard } from '@evaos/contract'

/**
 * Three-way merge of one board page, so Isaac and the agent can change the same board at once:
 * `ours` is what Isaac's board shows (his unsaved edits on top of `base`, the file as his board
 * last read or wrote it), `theirs` the file now (the agent's writes since `base`). Per card and
 * per link: one Isaac changed (added, edited, moved, deleted) is his, else the file's. Top-level
 * fields (title, layout, viewport) the same way. Both changing one card is a conflict the agent's
 * per-card lock prevents (main/canvas/agent-canvas.ts); if it happens anyway, Isaac's wins.
 */
export function mergeBoards(
  base: CanvasBoard,
  ours: CanvasBoard,
  theirs: CanvasBoard,
): CanvasBoard {
  const merged: CanvasBoard = { ...theirs }
  const fields = new Set([...Object.keys(ours), ...Object.keys(base), ...Object.keys(theirs)])
  for (const key of fields) {
    if (key === 'nodes' || key === 'edges') continue
    const k = key as keyof CanvasBoard
    if (same(ours[k], base[k])) continue
    if (ours[k] === undefined) delete merged[k]
    else (merged as Record<string, unknown>)[k] = ours[k]
  }
  merged.nodes = mergeItems(base.nodes, ours.nodes, theirs.nodes)
  merged.edges = mergeItems(base.edges, ours.edges, theirs.edges)
  return merged
}

/** The ids of the cards (and links) that differ between `a` and `b`, either way. */
export function changedIds(
  a: readonly { id: string }[],
  b: readonly { id: string }[],
): Set<string> {
  const before = byId(a)
  const after = byId(b)
  const out = new Set<string>()
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!same(before.get(id), after.get(id))) out.add(id)
  }
  return out
}

function mergeItems<T extends { id: string }>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
): T[] {
  const b = byId(base)
  const o = byId(ours)
  const t = byId(theirs)
  const mine = (id: string): boolean => !same(o.get(id), b.get(id))
  const out: T[] = []
  // The file's order, each item Isaac's when he changed it (gone when he deleted it).
  for (const item of theirs) {
    if (!mine(item.id)) out.push(item)
    else if (o.has(item.id)) out.push(o.get(item.id)!)
  }
  // What Isaac changed that the file no longer (or never) had: his new cards, and his edits of
  // cards the agent removed.
  for (const item of ours) if (!t.has(item.id) && mine(item.id)) out.push(item)
  return out
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]))
}

/** Deep equality by value, key order ignored (a board read from the file and one drawn differ in it). */
function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

function stable(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x: unknown) =>
      x !== null && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
        : x,
    ) ?? 'undefined'
  )
}

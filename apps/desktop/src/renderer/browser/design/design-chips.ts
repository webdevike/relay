import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { NoteOwner } from '@evaos/contract'
import { invoke } from '../../ipc'
import type { DesignActor } from './design-runtime'

/**
 * Design Mode's selection as the owning chat's composer chips: the selected elements and regions
 * (a thumbnail, the one he drew on when he did) and his style edits ("3 style edits"). He types the
 * request in the chat; the composer sends the chips' note text and screenshots with that message
 * (`design.compose`) and tells the page tab it was handed off. Removing a chip drops that
 * selection. design-runtime.ts publishes each tab's chips as its machine changes.
 */

export interface DesignChip {
  id: string
  kind: 'element' | 'region' | 'edits'
  label: string
  /** PNG base64 of the crop, or of the drawing over it. */
  png: string | null
  drawn: boolean
}

interface Entry {
  /** The chat that owns the page: `file:<session file>` or `assistant:<id>`; null until known. */
  owner: string | null
  chips: DesignChip[]
}

const store = createStore<{ byTab: Record<string, Entry> }>(() => ({ byTab: {} }))

export const ownerKey = (o: NoteOwner | null): string | null =>
  o === null ? null : 'file' in o ? `file:${o.file}` : `assistant:${o.assistant}`

/** What the composer of the chat `owner` shows: the page tab and its chips, null for none. */
export function useDesignChips(
  owner: string | null,
): { tabId: string; chips: DesignChip[] } | null {
  // Each selector answers a string or a stored array, never a new object (zustand re-renders on one).
  const tabId = useStore(store, (s) => {
    if (owner === null) return null
    for (const [id, e] of Object.entries(s.byTab)) {
      if (e.owner === owner && e.chips.length > 0) return id
    }
    return null
  })
  const chips = useStore(store, (s) => (tabId === null ? null : (s.byTab[tabId]?.chips ?? null)))
  return tabId !== null && chips !== null ? { tabId, chips } : null
}

function chipsOf(actor: DesignActor): DesignChip[] {
  const s = actor.getSnapshot()
  if (!s.matches('on') || s.matches({ on: { selected: 'sent' } })) return []
  const c = s.context
  const chips: DesignChip[] = c.items
    .filter((i) => !i.missing)
    .map((i) => {
      const drawn = c.drawings[i.selector]
      return {
        id: i.selector,
        kind: i.kind,
        label: i.label,
        png: drawn ?? i.crop?.png ?? null,
        drawn: drawn !== undefined,
      }
    })
  if (c.edits.length > 0) {
    chips.push({
      id: 'edits',
      kind: 'edits',
      label: `${c.edits.length} style ${c.edits.length === 1 ? 'edit' : 'edits'}`,
      png: null,
      drawn: false,
    })
  }
  return chips
}

const signature = (chips: DesignChip[]): string =>
  chips.map((c) => `${c.id}|${c.label}|${c.png?.length ?? 0}|${c.drawn}`).join('\n')

/** Follows `actor` (page `tabId`): its chips, and which chat owns the page once it has any. */
export function publishChips(tabId: string, actor: DesignActor): void {
  let last = ''
  actor.subscribe(() => {
    const chips = chipsOf(actor)
    const sig = signature(chips)
    if (sig === last) return
    last = sig
    if (chips.length === 0) {
      store.setState((s) => {
        if (!(tabId in s.byTab)) return s
        const { [tabId]: _gone, ...rest } = s.byTab
        return { byTab: rest }
      })
      return
    }
    store.setState((s) => ({
      byTab: { ...s.byTab, [tabId]: { owner: s.byTab[tabId]?.owner ?? null, chips } },
    }))
    // The owner can change between selections (an agent took the page), so ask each time.
    void invoke('design.owner', { tabId }).then((r) => {
      if (!r.ok) return
      const owner = ownerKey(r.value.owner)
      store.setState((s) => {
        const e = s.byTab[tabId]
        return e && e.owner !== owner ? { byTab: { ...s.byTab, [tabId]: { ...e, owner } } } : s
      })
    })
  })
}

/** Removing a chip: the element or region leaves the selection; the edits chip puts every value back. */
export function removeChip(actor: DesignActor, chip: DesignChip): void {
  if (chip.kind !== 'edits') return actor.send({ type: 'item.remove', selector: chip.id })
  for (const e of actor.getSnapshot().context.edits) {
    actor.send({ type: 'style.edit', selector: e.selector, property: e.property, value: e.from })
  }
}

/** The chat message for the chips with `text` Isaac typed (the note's header, his words, details). */
export async function composeChips(
  actor: DesignActor,
  tabId: string,
  text: string,
): Promise<{ text: string; images: Array<{ mimeType: 'image/png'; data: string }> }> {
  const c = actor.getSnapshot().context
  const r = await invoke('design.compose', {
    tabId,
    instruction: text,
    items: c.items,
    edits: c.edits,
    drawings: c.drawings,
  })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

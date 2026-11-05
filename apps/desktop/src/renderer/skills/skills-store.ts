import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { notifications } from '@mantine/notifications'
import type { SkillAssistant, SkillDetail, SkillRow } from '@evaos/contract'
import { invoke } from '../ipc'

export interface SkillsState {
  /** Null until the first answer. */
  list: SkillRow[] | null
  assistants: SkillAssistant[]
  /** False without a Relay host on this Mac (or when the list could not be read). */
  available: boolean
  /** Why the list is unavailable, in one line. */
  error: string | null
  loading: boolean
  /** The skill shown in the detail panel. */
  selected: string | null
  /** Details read so far, by name. */
  details: Record<string, SkillDetail>
}

const initial = (): SkillsState => ({
  list: null,
  assistants: [],
  available: true,
  error: null,
  loading: true,
  selected: null,
  details: {},
})

export const skillsStore = createStore<SkillsState>(initial)

export function useSkills<T>(selector: (s: SkillsState) => T): T {
  return useStore(skillsStore, selector)
}

/** How many skills the assistants have, for the sidebar's badge; 0 until read or unavailable. */
export function useSkillCount(): number {
  return useSkills((s) => (s.available ? (s.list?.length ?? 0) : 0))
}

let inflight: Promise<void> | null = null
let queued = false

async function runOnce(): Promise<void> {
  try {
    const r = await invoke('skills.list', {})
    if (r.ok) {
      skillsStore.setState({
        list: r.value.skills,
        assistants: r.value.assistants,
        available: r.value.available,
        error: r.value.available ? null : (r.value.error ?? null),
        loading: false,
      })
    } else {
      skillsStore.setState({ available: false, error: r.error.message, loading: false })
    }
  } catch (e) {
    skillsStore.setState({
      available: false,
      error: e instanceof Error ? e.message : String(e),
      loading: false,
    })
  }
}

/** One request in flight; triggers during flight collapse into exactly one follow-up. */
export function loadSkills(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

let loadedOnce = false

/** Reads the list the first time anything asks (the sidebar badge, the page). */
export function ensureSkillsLoaded(): void {
  if (loadedOnce) return
  loadedOnce = true
  void loadSkills()
}

export function selectSkill(name: string | null): void {
  skillsStore.setState({ selected: name })
  if (name !== null) void loadSkillDetail(name)
}

export async function loadSkillDetail(name: string): Promise<void> {
  try {
    const r = await invoke('skills.detail', { name })
    if (r.ok) skillsStore.setState((s) => ({ details: { ...s.details, [name]: r.value } }))
  } catch {
    // The panel keeps the row's fields; the next select tries again.
  }
}

function patchRow(row: SkillRow): void {
  skillsStore.setState((s) => {
    const detail = s.details[row.name]
    return {
      list: s.list?.map((r) => (r.name === row.name ? row : r)) ?? null,
      details: detail ? { ...s.details, [row.name]: { ...detail, ...row } } : s.details,
    }
  })
}

/**
 * Turns the skill on or off per assistant (`enabled` names only the ones that change). Optimistic:
 * the row's `usedBy` moves at once and the host's answer replaces it; a refusal reverts with a toast.
 */
export async function setSkillAccess(
  name: string,
  enabled: Record<string, boolean>,
): Promise<void> {
  const previous = skillsStore.getState().list?.find((r) => r.name === name)
  if (previous) {
    const on = new Set(previous.usedBy)
    for (const [id, value] of Object.entries(enabled)) {
      if (value) on.add(id)
      else on.delete(id)
    }
    patchRow({ ...previous, usedBy: [...on] })
  }
  let row: SkillRow | null = null
  let message = ''
  try {
    const r = await invoke('skills.access', { name, enabled })
    if (r.ok) row = r.value
    else message = r.error.message
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  if (row) {
    patchRow(row)
    return
  }
  if (previous) patchRow(previous)
  notifications.show({
    color: 'red',
    message: `Could not change who loads ${name}. ${message}`.trim(),
    autoClose: 8000,
  })
}

export function resetSkillsForTests(): void {
  inflight = null
  queued = false
  loadedOnce = false
  skillsStore.setState(initial(), true)
}

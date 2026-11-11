import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

export interface NamesState {
  workspaces: Record<string, string>
  meetings: Record<string, string>
  canvases: Record<string, string>
  /** Chat titles by session file, as the chat pane last showed them. */
  chats: Record<string, string>
  /** Registry agent titles by id (`.omp/assistant/agents.json`). */
  agents: Record<string, string>
  /** Relay host dashboard titles by slug. */
  boards: Record<string, string>
  /** Review item titles by the id after `review:` (`pr:owner/repo#12`), as the queue or detail last showed them. */
  reviews: Record<string, string>
  /** Room titles by id (Assistants > Rooms), as main last sent them. */
  rooms: Record<string, string>
  version: number
}

/** Review item titles outlive the app: a restored review tab is named before the queue is read. */
const REVIEW_TITLES_KEY = 'eva-review-titles'
const MAX_REVIEW_TITLES = 200

function savedReviewTitles(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_TITLES_KEY) ?? '{}') as unknown
    if (typeof raw !== 'object' || raw === null) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string'))
  } catch {
    return {}
  }
}

export const namesStore = createStore<NamesState>(() => ({
  workspaces: {},
  meetings: {},
  canvases: {},
  chats: {},
  agents: {},
  boards: {},
  reviews: savedReviewTitles(),
  rooms: {},
  version: 0,
}))

export function setWorkspaceNames(map: Record<string, string>): void {
  namesStore.setState((s) => ({ workspaces: { ...map }, version: s.version + 1 }))
}

export function setMeetingTitles(map: Record<string, string>): void {
  namesStore.setState((s) => ({ meetings: { ...map }, version: s.version + 1 }))
}

export function setCanvasTitles(map: Record<string, string>): void {
  namesStore.setState((s) => ({ canvases: { ...map }, version: s.version + 1 }))
}

export function setAgentTitles(map: Record<string, string>): void {
  namesStore.setState((s) => ({ agents: { ...map }, version: s.version + 1 }))
}

export function agentTitle(id: string): string | null {
  return Object.hasOwn(namesStore.getState().agents, id) ? namesStore.getState().agents[id]! : null
}

/** A streaming room changes many times a second; only a changed title bumps the names. */
export function setRoomTitles(map: Record<string, string>): void {
  const now = namesStore.getState().rooms
  const keys = Object.keys(map)
  if (keys.length === Object.keys(now).length && keys.every((k) => now[k] === map[k])) return
  namesStore.setState((s) => ({ rooms: { ...map }, version: s.version + 1 }))
}

export function roomTitle(id: string): string | null {
  return Object.hasOwn(namesStore.getState().rooms, id) ? namesStore.getState().rooms[id]! : null
}

export function setBoardTitles(map: Record<string, string>): void {
  namesStore.setState((s) => ({ boards: { ...map }, version: s.version + 1 }))
}

export function boardTitle(slug: string): string | null {
  return Object.hasOwn(namesStore.getState().boards, slug)
    ? namesStore.getState().boards[slug]!
    : null
}

/** Remembers `title` for review item `id`; the newest `MAX_REVIEW_TITLES` stay on disk. */
export function setReviewTitle(id: string, title: string): void {
  if (namesStore.getState().reviews[id] === title) return
  const kept = Object.entries(namesStore.getState().reviews).filter(([k]) => k !== id)
  const reviews = Object.fromEntries([...kept, [id, title]].slice(-MAX_REVIEW_TITLES))
  try {
    localStorage.setItem(REVIEW_TITLES_KEY, JSON.stringify(reviews))
  } catch {
    /* private mode or full: the title stays for this run */
  }
  namesStore.setState((s) => ({ reviews, version: s.version + 1 }))
}

export function reviewTitle(id: string): string | null {
  return Object.hasOwn(namesStore.getState().reviews, id)
    ? namesStore.getState().reviews[id]!
    : null
}

/** The chat pane's title for `file`, so a tab on that chat names it. */
export function setChatTitle(file: string, title: string): void {
  if (namesStore.getState().chats[file] === title) return
  namesStore.setState((s) => ({ chats: { ...s.chats, [file]: title }, version: s.version + 1 }))
}

export function chatTitle(file: string): string | null {
  return Object.hasOwn(namesStore.getState().chats, file)
    ? namesStore.getState().chats[file]!
    : null
}

export function workspaceTitle(id: string): string | null {
  return Object.hasOwn(namesStore.getState().workspaces, id)
    ? namesStore.getState().workspaces[id]!
    : null
}

export function meetingTitle(stem: string): string | null {
  return Object.hasOwn(namesStore.getState().meetings, stem)
    ? namesStore.getState().meetings[stem]!
    : null
}

export function canvasTitle(slug: string): string | null {
  return Object.hasOwn(namesStore.getState().canvases, slug)
    ? namesStore.getState().canvases[slug]!
    : null
}

/** Subscribe a component so titles re-render when names arrive. */
export function useNamesVersion(): number {
  return useStore(namesStore, (s) => s.version)
}

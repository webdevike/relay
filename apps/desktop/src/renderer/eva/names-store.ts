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
  version: number
}

export const namesStore = createStore<NamesState>(() => ({
  workspaces: {},
  meetings: {},
  canvases: {},
  chats: {},
  agents: {},
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

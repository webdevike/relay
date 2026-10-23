import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

export interface NamesState {
  workspaces: Record<string, string>
  meetings: Record<string, string>
  canvases: Record<string, string>
  version: number
}

export const namesStore = createStore<NamesState>(() => ({
  workspaces: {},
  meetings: {},
  canvases: {},
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

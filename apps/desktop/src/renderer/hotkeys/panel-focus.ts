import { createStore } from 'zustand/vanilla'

export const panelFocusStore = createStore<{ focused: boolean }>(() => ({ focused: false }))

export function setPanelFocused(focused: boolean): void {
  panelFocusStore.setState({ focused })
}

export function isPanelFocused(): boolean {
  return panelFocusStore.getState().focused
}

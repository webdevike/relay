/** The pane holding the keyboard focus (DOM focus), if any; kept by the pane frames. */
let current: string | null = null

export function setFocusedPane(id: string | null): void {
  current = id
}

export function focusedPane(): string | null {
  return current
}

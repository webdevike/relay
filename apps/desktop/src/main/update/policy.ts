/**
 * Isaac counts as away after this long without keyboard or mouse input. A restart then costs
 * nothing: tabs, panel, page tabs, window bounds and composer drafts all come back.
 */
export const IDLE_RESTART_SECONDS = 120

export interface AutoRestartInput {
  pending: boolean
  /** powerMonitor.getSystemIdleTime(): seconds since the last input. */
  idleSeconds: number
  /** A chat pane this app runs is mid-reply. */
  chatWorking: boolean
}

/**
 * Whether a pending update restarts the app on its own: Isaac has been away for 2 minutes and
 * no chat this app runs is working.
 */
export function shouldAutoRestart(i: AutoRestartInput): boolean {
  return i.pending && !i.chatWorking && i.idleSeconds >= IDLE_RESTART_SECONDS
}

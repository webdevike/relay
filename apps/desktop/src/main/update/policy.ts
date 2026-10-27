/** Isaac counts as away after this long without keyboard or mouse input. */
export const IDLE_RESTART_SECONDS = 15 * 60
/** Auto-restart only between 23:00 and 07:59 local time. */
export const QUIET_FROM_HOUR = 23
export const QUIET_UNTIL_HOUR = 8

export interface AutoRestartInput {
  pending: boolean
  /** powerMonitor.getSystemIdleTime(): seconds since the last input. */
  idleSeconds: number
  now: Date
  /** A chat pane this app runs is mid-reply. */
  chatWorking: boolean
}

/**
 * Whether a pending update restarts the app on its own: Isaac has been away for 15 minutes,
 * it is night (23:00-07:59 local), and no chat this app runs is working.
 */
export function shouldAutoRestart(i: AutoRestartInput): boolean {
  if (!i.pending || i.chatWorking || i.idleSeconds < IDLE_RESTART_SECONDS) return false
  const hour = i.now.getHours()
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR
}

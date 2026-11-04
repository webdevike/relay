import type { UpdateState } from '@evaos/contract'
import type { SidebarState } from '../shell/layout-store'

/**
 * The footer chip is the fallback for a sidebar that is not on screen (hidden or folded), so a
 * pending update always has one visible Restart. The sidebar card shows whenever `pending` is
 * true, so Later on the toast never hides it.
 */
export function updateChipVisible(update: UpdateState, sidebar: SidebarState): boolean {
  return update.pending && sidebar !== 'open'
}

/** The dimmed line: the update's summary, or its build when it has no summary. */
export function updateCardLine(update: UpdateState): string {
  return update.summary ?? (update.build ? `Build ${update.build}` : 'A new build is ready')
}

/** What a Restart costs: names the chats that are mid-reply and will stop (an empty title reads as "Untitled chat"). */
export function restartTooltip(runningTitles: string[]): string {
  if (runningTitles.length === 0) return 'Restart Relay into the update'
  const shown = runningTitles.slice(0, 3).map((t) => (t.trim() === '' ? 'Untitled chat' : t))
  if (runningTitles.length > 3) shown.push(`and ${runningTitles.length - 3} more`)
  const noun = runningTitles.length === 1 ? 'chat is' : 'chats are'
  return `${runningTitles.length} ${noun} working and will stop: ${shown.join(', ')}. Resume ${runningTitles.length === 1 ? 'it' : 'them'} after the restart.`
}

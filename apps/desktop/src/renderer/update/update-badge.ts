import { shortBuild, type ChangelogEntry, type UpdateState } from '@evaos/contract'
import type { SidebarState } from '../shell/layout-store'

/**
 * The footer chip is the fallback for a sidebar that is not on screen (hidden or folded), so a
 * pending update always has one visible Restart. The sidebar badge shows whenever `pending` is
 * true, so Later on the toast never hides it.
 */
export function updateChipVisible(update: UpdateState, sidebar: SidebarState): boolean {
  return update.pending && sidebar !== 'open'
}

/** The update's summary, or its build when it has no summary. */
export function updateSummaryLine(update: UpdateState): string {
  return update.summary ?? (update.build ? `Build ${update.build}` : 'A new build is ready')
}

/**
 * The commit subjects the update brings: every deploy newer than the running build (history is
 * newest first), or just the pending build's own entry when the running build is not in the
 * history. Empty when the history has neither.
 */
export function changesSince(
  entries: ChangelogEntry[],
  running: string | null,
  pending: string | null,
): string[] {
  const builds = entries.filter((e) => e.kind === 'desktop')
  const mine = shortBuild(running)
  const at = mine === null ? -1 : builds.findIndex((e) => shortBuild(e.build) === mine)
  const newer = at >= 0 ? builds.slice(0, at) : builds.filter((e) => shortBuild(e.build) === shortBuild(pending))
  return newer.flatMap((e) => e.changes)
}

/** What a Restart costs: names the chats that are mid-reply and will stop (an empty title reads as "Untitled chat"). */
export function restartNote(runningTitles: string[]): string | null {
  if (runningTitles.length === 0) return null
  const shown = runningTitles.slice(0, 3).map((t) => (t.trim() === '' ? 'Untitled chat' : t))
  if (runningTitles.length > 3) shown.push(`and ${runningTitles.length - 3} more`)
  const noun = runningTitles.length === 1 ? 'chat is' : 'chats are'
  return `${runningTitles.length} ${noun} working and will stop: ${shown.join(', ')}. Resume ${runningTitles.length === 1 ? 'it' : 'them'} after the restart.`
}

// How a session Relay hears running outside this app shows in the chat list, after the native
// app's Activity::Away (chat_view.rs), order::needs_you / order::replying, look::status and
// alerts::observe_away.
import type { Phase } from '../chat/chat-order'
import type { RelaySession } from './feed'

/** What Relay's status detail says while omp's `ask` tool is blocked on its dialog (alerts::ASK_TOOL). */
export const ASK_TOOL = 'ask'

/** A chat Relay hears running outside this app (native Activity::Away). */
export interface Away {
  /** What the return-time order sees. */
  phase: Exclude<Phase, 'ended'>
  /** Replying right now (order::replying). */
  working: boolean
  /** Waiting on Isaac (order::needs_you): an approval (`confirm`) or a question (`other`). */
  dialog: 'confirm' | 'other' | null
  /** A run Eva's job launcher started. */
  job: boolean
}

/**
 * The session's activity, or null when Relay says it ended (native `away` leaves those out).
 * omp's `ask` tool blocks while Relay still says `working` with the tool `ask` for its detail: the
 * row still says Working (native look::status), but the order sees it blocked (observe_away).
 */
export function awayOf(s: RelaySession | undefined): Away | null {
  if (!s) return null
  const job = s.kind === 'job'
  switch (s.status) {
    case 'ended':
      return null
    case 'working':
      return {
        phase: s.detail === ASK_TOOL ? 'blocked' : 'working',
        working: true,
        dialog: null,
        job,
      }
    case 'needs_permission':
      return { phase: 'blocked', working: false, dialog: 'confirm', job }
    case 'waiting':
      return { phase: 'blocked', working: false, dialog: 'other', job }
    case 'idle':
      return { phase: 'idle', working: false, dialog: null, job }
  }
}

/**
 * What the chat list reads of Relay's sessions, as one string: a change elsewhere (the detail of a
 * running tool, its last activity) does not need a new list.
 */
export function awaySignature(sessions: ReadonlyMap<string, RelaySession> | null): string {
  if (sessions === null) return 'down'
  const parts: string[] = []
  for (const s of sessions.values()) {
    const a = awayOf(s)
    if (a) parts.push(`${s.id}:${a.phase}:${a.working}:${a.dialog}:${a.job}`)
  }
  return parts.sort().join('|')
}

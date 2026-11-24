import { useEffect, useState } from 'react'
import { subagentFinished } from '@evaos/chat-core/jobs'
import type { Subagent } from '@evaos/chat-core/message'
import type { SubagentState } from './Chip'

/** A clock that ticks each minute, so a subagent that goes quiet stops spinning without new files. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** A subagent's state at `now`: failed, done (it finished or went quiet), else running. */
export const subagentState = (s: Subagent, now: number): SubagentState =>
  s.failed ? 'failed' : subagentFinished(s, now) ? 'done' : 'running'

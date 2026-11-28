// Which assistants an @ means: the configured registry's (`assistants.list`, kept by
// assistants-store), custom ones included, plus any built-in one it doesn't list. The composer's @
// list, its "Only you" line and every surface's send (ticket, PR conversation, PR Diff) read the
// same list, so what the box shows as private is what goes private.
import { useMemo } from 'react'
import { useAssistants } from '../assistants/assistants-store'
import { assistantPeople, type Person } from './activity-model'

export function useMentionAssistants(): readonly Person[] {
  const agents = useAssistants((s) => s.data?.agents ?? null)
  return useMemo(() => assistantPeople(agents), [agents])
}

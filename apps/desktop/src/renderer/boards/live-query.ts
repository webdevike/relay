import type { OpenUIQueryClient } from '@evaos/chat-core/openui'
import { invoke } from '../ipc'
import { boardsStore } from './boards-store'

/**
 * Live widgets' data (board tiles, canvas `ui` cards): one read-only host query tool per Query
 * statement, run by main against the Relay host. A host too old to answer flips the boards'
 * `queries` off, so live tiles fall back to the static spec the host rendered at write time.
 */
export const liveQuery: OpenUIQueryClient = {
  async run(tool, args) {
    const r = await invoke('boards.query', { tool, args })
    if (!r.ok) throw new Error(r.error.message)
    const answer = r.value
    if (answer.ok) return answer.data
    if (answer.unsupported) {
      const data = boardsStore.getState().data
      if (data?.queries) boardsStore.setState({ data: { ...data, queries: false } })
    }
    throw new Error(answer.error ?? "Relay couldn't run that query.")
  },
}

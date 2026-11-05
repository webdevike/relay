import type { TurnRow } from '@evaos/chat-core/turns'
import type { LogItem } from '../ChatLog'

/**
 * The log's rows as the navigator reads them (chat-core `buildTurns`): Isaac's messages, the
 * assistant's replies and an ask card nobody answered yet (an `ask` tool row with no result), tool
 * groups opened. Anything else (thinking, notices, canvas rows, typing dots) is left out.
 */
export function* turnRows(items: readonly LogItem[]): Generator<TurnRow> {
  for (let index = 0; index < items.length; index++) {
    const it = items[index]!
    const rows = it.kind === 'message' ? [it.m] : it.kind === 'tools' ? it.tools : []
    for (const m of rows) {
      if (m.role === 'user' || m.role === 'assistant') {
        yield {
          index,
          id: m.id,
          role: m.role,
          text: m.text,
          at: m.at,
          streaming: m.streaming,
          images: m.images.length > 0,
          ref: m,
        }
      } else if (m.role === 'tool' && m.text === 'ask' && m.tool?.result === null) {
        yield { index, id: m.id, role: 'ask', text: '', ref: m }
      }
    }
  }
}

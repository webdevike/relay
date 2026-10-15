import { useEffect, useState } from 'react'
import { invoke } from '../ipc'
import { placeOf } from '@evaos/shell-core'
import { activePlace, replaceActivePlace, tabsStore } from '../tabs/tabs-store'
import { openChatFile } from './open-chat'

interface Item {
  file: string
  title: string
}

export const PANE_ID = 'pane-1'

/** Opens a session from the list; a draft tab then points at that session instead of staying a draft. */
function openFromList(file: string): void {
  void openChatFile(file)
  const here = activePlace(tabsStore.getState())
  if (here.page === 'chat' && here.chat === 'draft') {
    replaceActivePlace(placeOf('chat', { chat: file }))
  }
}

export function SessionList() {
  const [items, setItems] = useState<Item[] | null>(null)
  useEffect(() => {
    void invoke('chat.listSessions', {}).then((r) => {
      setItems(r.ok ? r.value.sessions.slice(0, 10) : [])
    })
  }, [])

  return (
    <div className="eva-session-list" data-testid="session-list">
      {(items ?? []).map((s) => {
        const base = s.file.split('/').pop() ?? s.file
        const id = base.replace(/\.jsonl$/, '')
        return (
          <button
            key={s.file}
            type="button"
            className="eva-session-item"
            data-testid={`session-${id}`}
            onClick={() => openFromList(s.file)}
          >
            <span className="eva-label eva-session-title">{s.title}</span>
            <span className="eva-label eva-dim eva-mono eva-session-file">{base}</span>
          </button>
        )
      })}
    </div>
  )
}

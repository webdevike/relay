import { useEffect, useState } from 'react'
import { invoke } from '../ipc'
import { chatStore } from './chat-store'

interface Item {
  file: string
  title: string
}

export const PANE_ID = 'pane-1'

export function SessionList() {
  const [items, setItems] = useState<Item[] | null>(null)
  useEffect(() => {
    void invoke('chat.listSessions', {}).then((r) => {
      setItems(r.ok ? r.value.sessions.slice(0, 10) : [])
    })
  }, [])

  const open = async (file: string): Promise<void> => {
    const r = await invoke('chat.open', { paneId: PANE_ID, file })
    if (r.ok) chatStore.getState().openPane(PANE_ID, { file, ...r.value })
  }

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
            onClick={() => void open(s.file)}
          >
            <span className="eva-label eva-session-title">{s.title}</span>
            <span className="eva-label eva-dim eva-mono eva-session-file">{base}</span>
          </button>
        )
      })}
    </div>
  )
}

import './strips.css'
import { useEffect, useMemo, useState } from 'react'
import { Scroller, Tooltip } from '@mantine/core'
import { IconAlertCircle, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../../navigation/navigate'
import { listStore, useListStore } from '../list/list-store'

/**
 * The chats assistant `agent` started (auto-work and other delegated sessions), under its thread
 * instead of the Chats list: open ones first, newest first; ones its job closed behind "N done".
 * A chip opens the chat in place, whose header leads back here.
 */
export function OwnedSessions({ agent }: { agent: string }) {
  const rows = useListStore((s) => s.list?.rows ?? null)
  const [showDone, setShowDone] = useState(false)
  // The Chats list loads the rows; with the sidebar folded nothing has yet.
  useEffect(() => {
    if (!listStore.getState().list) void listStore.getState().load()
  }, [])
  const { open, done } = useMemo(() => {
    const mine = (rows ?? [])
      .filter((r) => r.owner?.agent === agent)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return {
      open: mine.filter((r) => !r.owner?.closed),
      done: mine.filter((r) => r.owner?.closed),
    }
  }, [rows, agent])
  if (open.length === 0 && done.length === 0) return null
  const shown = showDone ? [...open, ...done] : open
  return (
    <div
      className="eva-chips eva-owned"
      data-testid="owned-sessions"
      role="group"
      aria-label="Sessions it started"
    >
      <span className="eva-owned-label eva-label">Sessions</span>
      <Scroller
        className="eva-chips-scroller"
        classNames={{ content: 'eva-chips-content' }}
        edgeGradientColor="var(--eva-c-background)"
        controlSize={28}
        scrollAmount={160}
        startControlIcon={<IconChevronLeft size={14} stroke={1.5} />}
        endControlIcon={<IconChevronRight size={14} stroke={1.5} />}
      >
        {shown.length === 0 ? (
          <span className="eva-label eva-dim">None open</span>
        ) : (
          shown.map((r) => {
            const state =
              r.status === 'needs-approval' || r.status === 'has-question'
                ? 'needs'
                : r.running
                  ? 'running'
                  : r.owner?.closed
                    ? 'done'
                    : 'idle'
            return (
              <Tooltip key={r.id} label={r.title} openDelay={400} position="bottom-start">
                <button
                  type="button"
                  className="eva-chip eva-label"
                  data-testid={`owned-session-${r.id}`}
                  data-state={state}
                  onClick={(e) =>
                    openPlace(placeOf('chat', { chat: r.file }), { newTab: e.metaKey })
                  }
                >
                  {state === 'running' ? <span className="eva-spinner" aria-hidden="true" /> : null}
                  {state === 'needs' ? <IconAlertCircle size={12} aria-hidden="true" /> : null}
                  <span className="eva-chip-name">{r.title.replace(/ auto-work$/, '')}</span>
                </button>
              </Tooltip>
            )
          })
        )}
      </Scroller>
      {done.length > 0 ? (
        <button
          type="button"
          className="eva-chips-clear eva-label"
          data-testid="owned-sessions-done"
          aria-pressed={showDone}
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? 'Hide done' : `${done.length} done`}
        </button>
      ) : null}
    </div>
  )
}

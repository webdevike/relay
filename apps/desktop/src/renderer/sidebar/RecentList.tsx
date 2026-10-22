import { IconChevronDown } from '@tabler/icons-react'
import { useState } from 'react'
import { filterRecent, useSidebarData } from './sidebar-store'

export interface RecentListProps {
  query: string
}

export function RecentList({ query }: RecentListProps) {
  const recent = useSidebarData((s) => s.recent)
  const [open, setOpen] = useState(true)
  const rows = filterRecent(recent, query).slice(0, 8)
  return (
    <div className="eva-sb-recent" data-testid="recent">
      <button
        type="button"
        className="eva-sb-recent-toggle"
        data-testid="recent-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="eva-sb-section">Recent</span>
        <IconChevronDown
          size={14}
          aria-hidden
          className="eva-sb-recent-chev"
          style={{ transform: open ? undefined : 'rotate(-90deg)' }}
        />
      </button>
      {open ? (
        <div className="eva-sb-recent-body">
          {rows.length === 0 ? (
            <div className="eva-sb-empty eva-dim">
              {recent.length === 0 ? 'Nothing recent yet' : 'No recent items match your search'}
            </div>
          ) : (
            rows.map((r, i) => (
              <div
                key={`${r.date}-${i}`}
                className="eva-sb-recent-item"
                data-testid="recent-item"
                title={r.title}
              >
                {r.title}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

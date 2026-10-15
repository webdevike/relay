import { ActionIcon, Loader } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'

function label(t: TabState): string {
  if (t.title) return t.title
  if (t.url) return t.url.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')
  return 'New tab'
}

export function TabStrip({ tabs, activeId }: { tabs: TabState[]; activeId: string }) {
  return (
    <div className="eva-tab-strip" data-testid="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`eva-tab${t.id === activeId ? ' is-active' : ''}`}
          data-testid={`tab-${t.id}`}
        >
          {t.loading ? (
            <Loader size={12} />
          ) : t.favicon ? (
            <img className="eva-tab-icon" src={t.favicon} alt="" width={14} height={14} />
          ) : null}
          <span className="eva-label eva-tab-title">{label(t)}</span>
        </div>
      ))}
      <ActionIcon
        variant="subtle"
        size={28}
        disabled
        aria-label="New tab"
        data-testid="tab-new"
        className="eva-tab-new"
      >
        <IconPlus size={16} />
      </ActionIcon>
    </div>
  )
}

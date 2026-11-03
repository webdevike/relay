import { IconChecklist } from '@tabler/icons-react'
import type { DashboardPayload } from '@evaos/contract'

const MAX_ROWS = 6

export function DashboardAside({ data, entrance }: { data: DashboardPayload; entrance: boolean }) {
  const rows = data.todos.slice(0, MAX_ROWS)
  const cue = (name: string): string => (entrance ? ` eva-cue-${name}` : '')
  const stats: Array<[string, number]> = [
    ['Workspaces', data.workspaces.length],
    ['Open todos', data.todos.length],
    ['Updates, 7 days', data.updates7d],
  ]
  return (
    <aside className="eva-dash-aside">
      <section aria-labelledby="dash-todos-title" data-testid="dash-todos">
        <h2 id="dash-todos-title" className={`eva-dash-h2${cue('aside-title')}`}>
          <IconChecklist size={16} />
          Open Todos
        </h2>
        {rows.length === 0 ? (
          <p className="eva-dash-dim eva-dash-body">Nothing open.</p>
        ) : (
          <ul className="eva-dash-todo-list">
            {rows.map((t, i) => (
              <li
                key={t.id}
                className={`eva-dash-todo-row${cue('aside-rows')}`}
                style={{ ['--i' as string]: i }}
                data-testid={`dash-todo-${t.id}`}
              >
                <span className="eva-dash-todo-id">{t.id}</span>
                <span className="eva-dash-ellipsis eva-dash-todo-text" title={t.text}>
                  {t.text}
                </span>
                <span className="eva-dash-ws-chip">{t.tag}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="dash-stats-title" data-testid="dash-stats">
        <h2 id="dash-stats-title" className={`eva-dash-h2${cue('stats-title')}`}>
          Quick Stats
        </h2>
        <div className="eva-dash-stats">
          {stats.map(([label, n], i) => (
            <div
              key={label}
              className={`eva-dash-stat${cue('stat-cards')}`}
              style={{ ['--i' as string]: i }}
            >
              <div className="eva-dash-stat-n">{n}</div>
              <div className="eva-dash-dim eva-dash-label">{label}</div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  )
}

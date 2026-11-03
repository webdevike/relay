import { IconFolder, IconListCheck } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import type { WorkspaceSummary } from '@evaos/contract'
import { filterCounts, type FilterId } from '@evaos/eva-core/model/dashboard'
import { relativeLabel } from '@evaos/eva-core/model/dates'
import { openFromNav } from '../navigation/open-in-app'
import { Segmented } from './Segmented'
import { setFilter } from './dashboard-store'

export interface GridProps {
  all: WorkspaceSummary[]
  filtered: WorkspaceSummary[]
  rest: WorkspaceSummary[]
  filter: FilterId
  today: string
  entrance: boolean
}

export function WorkspaceGrid(p: GridProps) {
  const counts = filterCounts(p.all, p.today)
  return (
    <section
      className="eva-dash-section"
      aria-labelledby="dash-workspaces-title"
      data-testid="dash-grid-section"
    >
      <div className={`eva-dash-section-head${p.entrance ? ' eva-cue-sections' : ''}`}>
        <h2 id="dash-workspaces-title" className="eva-dash-h2">
          <IconFolder size={16} />
          Workspaces
        </h2>
      </div>
      <div className="eva-dash-filter-row">
        <Segmented<FilterId>
          label="Filter workspaces"
          testid="dash-filters"
          value={p.filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', testid: 'filter-all', count: counts.all },
            { value: 'active', label: 'Active', testid: 'filter-active', count: counts.active },
            { value: 'todos', label: 'Has Todos', testid: 'filter-todos', count: counts.todos },
            { value: 'quiet', label: 'Quiet', testid: 'filter-quiet', count: counts.quiet },
          ]}
        />
        <span className="eva-dash-dim eva-dash-shown" data-testid="dash-shown">
          {`${p.rest.length} shown`}
        </span>
      </div>
      {p.filtered.length === 0 ? (
        <p className="eva-dash-empty">No workspaces match this filter.</p>
      ) : (
        <>
          <div className="eva-dash-grid">
            {p.rest.map((ws, i) => (
              <button
                key={ws.id}
                type="button"
                className={`eva-dash-card${p.entrance ? ' eva-cue-grid-cards' : ''}`}
                style={{ ['--i' as string]: Math.min(i, 11) }}
                data-testid={`ws-card-${ws.id}`}
                onClick={(e) => openFromNav(placeOf(`workspace:${ws.id}`), e)}
              >
                <span className="eva-dash-card-name">
                  <span className="eva-dash-ellipsis">{ws.displayName}</span>
                  {ws.builtIn ? <span className="eva-dash-badge">Eva</span> : null}
                </span>
                <span className={`eva-dash-clamp${ws.tagline ? '' : ' eva-dash-dim'}`}>
                  {ws.tagline ?? 'No tagline'}
                </span>
                <span className={`eva-dash-clamp${ws.latest ? '' : ' eva-dash-dim'}`}>
                  {ws.latest ?? 'No updates yet'}
                </span>
                <span className="eva-dash-card-foot">
                  <span className="eva-dash-dim">
                    {ws.lastActive === null
                      ? 'No activity'
                      : `Active ${relativeLabel(ws.lastActive, p.today)}`}
                  </span>
                  {ws.openTodos > 0 ? (
                    <span className="eva-dash-todo-chip" aria-label={`${ws.openTodos} open todos`}>
                      <IconListCheck size={14} />
                      {ws.openTodos}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
          {p.rest.length === 0 ? (
            <p className="eva-dash-dim eva-dash-footer">Every matching workspace is shown above.</p>
          ) : null}
        </>
      )}
    </section>
  )
}

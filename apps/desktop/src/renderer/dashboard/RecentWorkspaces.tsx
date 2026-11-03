import { IconActivity, IconListCheck } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import type { WorkspaceSummary } from '@evaos/contract'
import { activityRows } from '@evaos/eva-core/model/dashboard'
import { relativeLabel } from '@evaos/eva-core/model/dates'
import { openFromNav } from '../navigation/open-in-app'
import { ActivityChart } from '../ui/ActivityChart'
import { Segmented } from './Segmented'
import { setRange, type Range } from './dashboard-store'

const LABEL = { 7: '7 days', 30: '30 days', 90: '90 days' } as const

export interface RecentProps {
  workspaces: WorkspaceSummary[]
  range: Range
  today: string
  compact: boolean
  entrance: boolean
}

export function RecentWorkspaces(p: RecentProps) {
  return (
    <section className="eva-dash-section" aria-labelledby="dash-recent-title">
      <div className={`eva-dash-section-head${p.entrance ? ' eva-cue-sections' : ''}`}>
        <h2 id="dash-recent-title" className="eva-dash-h2">
          <IconActivity size={16} />
          Recent Workspaces
        </h2>
        <Segmented
          label="Chart range"
          testid="dash-range"
          value={String(p.range) as '7' | '30' | '90'}
          onChange={(v) => setRange(Number(v) as Range)}
          options={[
            { value: '7', label: '7D', testid: 'range-7' },
            { value: '30', label: '30D', testid: 'range-30' },
            { value: '90', label: '90D', testid: 'range-90' },
          ]}
        />
      </div>
      <div className="eva-dash-charts">
        {p.workspaces.map((ws, i) => {
          const rows = activityRows(ws.daily, p.range, p.today)
          const cue = i === 0 ? 'first' : 'second'
          return (
            <article
              key={ws.id}
              className={`eva-dash-chart-card${p.entrance ? ` eva-cue-${cue}-card` : ''}`}
              data-testid="dash-chart-card"
            >
              <header className="eva-dash-chart-head">
                <button
                  type="button"
                  className="eva-dash-name-link"
                  onClick={(e) => openFromNav(placeOf(`workspace:${ws.id}`), e)}
                >
                  {ws.displayName}
                </button>
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
              </header>
              <div className={p.entrance ? `eva-cue-${cue}-chart` : undefined}>
                <ActivityChart
                  rows={rows}
                  name={ws.displayName}
                  rangeLabel={LABEL[p.range]}
                  height={p.compact ? 128 : 160}
                  testid={`dash-chart-${ws.id}`}
                />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

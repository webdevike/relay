import { useEffect, useRef, useState } from 'react'
import { Button } from '@mantine/core'
import type { Place } from '@evaos/shell-core'
import { matchesFilter, splitRecent, summaryLine } from '@evaos/eva-core/model/dashboard'
import { runAction } from '../hotkeys/router'
import { refreshSidebar } from '../sidebar/sidebar-store'
import { registerReloader } from '../reload/reload'
import { useEntrance } from '../theme/motion'
import { DashboardAside } from './DashboardAside'
import { Hero } from './Hero'
import { RecentWorkspaces } from './RecentWorkspaces'
import { WorkspaceGrid } from './WorkspaceGrid'
import { loadDashboard, setFilter, useDashboard } from './dashboard-store'
import './dashboard.css'

export const COMPACT_BELOW = 760

function Skeleton() {
  return (
    <div className="eva-dash-col" data-testid="dash-loading" aria-busy="true">
      <div className="eva-dash-skel" style={{ height: 160 }} />
      <div className="eva-dash-skel" style={{ height: 220 }} />
      <div className="eva-dash-skel" style={{ height: 220 }} />
      <div className="eva-dash-skel-grid">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="eva-dash-skel" style={{ height: 120 }} />
        ))}
      </div>
    </div>
  )
}

export function DashboardPage(_props: { place: Place }) {
  const root = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const entrance = useEntrance()
  const data = useDashboard((s) => s.data)
  const loading = useDashboard((s) => s.loading)
  const error = useDashboard((s) => s.error)
  const reloading = useDashboard((s) => s.reloading)
  const filter = useDashboard((s) => s.filter)
  const range = useDashboard((s) => s.range)

  useEffect(() => {
    const off = registerReloader('dashboard', loadDashboard)
    void loadDashboard()
    return off
  }, [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setCompact(w < COMPACT_BELOW)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const refresh = (): void => {
    void loadDashboard()
    void refreshSidebar()
  }

  let body
  if (!data && error) {
    body = (
      <div className="eva-dash-col">
        <div className="eva-dash-error" role="alert">
          <p className="eva-dash-body">
            Could not read the Eva repo. Check that the Eva folder exists and is readable, then
            press the refresh shortcut.
          </p>
          <Button variant="default" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      </div>
    )
  } else if (!data) {
    body = loading ? <Skeleton /> : null
  } else {
    const filtered = data.workspaces.filter((w) => matchesFilter(w, filter, data.today))
    const { recent, rest } = splitRecent(filtered)
    const summary = summaryLine(data.workspaces.length, data.todos.length, data.updates7d)
    body = (
      <div className="eva-dash-col">
        <Hero
          summary={summary}
          updatedAt={data.generatedAt}
          reloading={reloading}
          entrance={entrance}
          onNewTodo={() => runAction('new-todo')}
          onAllWorkspaces={() => {
            setFilter('all')
            document
              .querySelector('[data-testid=dash-grid-section]')
              ?.scrollIntoView?.({ block: 'start' })
          }}
          onRefresh={refresh}
        />
        {data.workspaces.length === 0 ? (
          <div className="eva-dash-empty-state">
            <h2 className="eva-dash-h2">No workspaces yet</h2>
            <p className="eva-dash-dim eva-dash-body">
              Add a workspace file under workspaces/ in the Eva repo and it will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="eva-dash-main">
              <RecentWorkspaces
                workspaces={recent}
                range={range}
                today={data.today}
                compact={compact}
                entrance={entrance}
              />
              <DashboardAside data={data} entrance={entrance} />
            </div>
            <WorkspaceGrid
              all={data.workspaces}
              filtered={filtered}
              rest={rest}
              filter={filter}
              today={data.today}
              entrance={entrance}
            />
          </>
        )}
      </div>
    )
  }

  return (
    <div
      ref={root}
      className="eva-page eva-dash"
      data-testid="page-dashboard"
      data-compact={compact}
      aria-labelledby="dash-hero-title"
    >
      {body}
    </div>
  )
}

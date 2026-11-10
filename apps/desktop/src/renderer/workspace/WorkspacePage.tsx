import { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconMessages,
  IconNotebook,
  IconPlus,
} from '@tabler/icons-react'
import { placeOf, type Place } from '@evaos/shell-core'
import type { WorkspaceDetail } from '@evaos/contract'
import { activityRows, matchesFilter } from '@evaos/eva-core/model/dashboard'
import { relativeLabel, shortDate } from '@evaos/eva-core/model/dates'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { registerReloader } from '../reload/reload'
import { openNewTodo } from '../todo/new-todo-store'
import { ActivityChart } from '../ui/ActivityChart'
import { Segmented } from '../dashboard/Segmented'
import { RANGES, type Range } from '../dashboard/dashboard-store'
import { parseFlags, parseOneOf, usePref } from '../ui-prefs'
import { loadWorkspace, useWorkspace } from './workspace-store'
import '../dashboard/dashboard.css'
import './workspace.css'

const LABEL = { 7: '7 days', 30: '30 days', 90: '90 days' } as const
const COMPACT_BELOW = 760
const TIMELINE_LIMIT = 8
const OPEN_SECTIONS = 3

function dayHeading(date: string, today: string): string {
  const rel = relativeLabel(date, today)
  return rel === 'Today' || rel === 'Yesterday' ? rel : shortDate(date)
}

function Timeline({ data }: { data: WorkspaceDetail }) {
  const [all, setAll] = useState(false)
  const items = all ? data.timeline : data.timeline.slice(0, TIMELINE_LIMIT)
  const groups: Array<{ date: string; rows: typeof items }> = []
  for (const it of items) {
    const g = groups[groups.length - 1]
    if (g && g.date === it.date) g.rows.push(it)
    else groups.push({ date: it.date, rows: [it] })
  }
  return (
    <section className="eva-ws-card" data-testid="ws-timeline" aria-labelledby="ws-timeline-title">
      <h2 id="ws-timeline-title" className="eva-dash-h2">
        Timeline
      </h2>
      {data.timeline.length === 0 ? (
        <p className="eva-dash-dim eva-dash-body">No updates yet</p>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.date} className="eva-ws-day">
              <h3 className="eva-ws-day-h eva-dash-dim">{dayHeading(g.date, data.today)}</h3>
              <ul className="eva-ws-list">
                {g.rows.map((r, i) => (
                  <li key={`${r.date}-${i}`} className="eva-ws-entry" data-testid="ws-timeline-row">
                    {r.kind === 'journal' ? (
                      <IconNotebook size={14} aria-label="Journal" />
                    ) : (
                      <IconMessages size={14} aria-label="Thread" />
                    )}
                    <span className="eva-ws-entry-text">
                      <span className="eva-ws-clamp">{r.title}</span>
                      <span className="eva-dash-dim eva-dash-label">{r.source}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.timeline.length > TIMELINE_LIMIT ? (
            <button
              type="button"
              className="eva-dash-link"
              data-testid="ws-timeline-toggle"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              {all ? 'Show fewer' : `Show all ${data.timeline.length}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

const NO_FLAGS: Record<string, boolean> = {}
const parseRange = parseOneOf(RANGES)

function Sections({ id, sections }: { id: string; sections: WorkspaceDetail['sections'] }) {
  const [open, setOpen] = usePref(`workspace.sections.${id}`, NO_FLAGS, parseFlags)
  return (
    <section data-testid="ws-sections" className="eva-ws-sections">
      {sections.length === 0 ? (
        <p className="eva-dash-dim eva-dash-body">This workspace file has no sections.</p>
      ) : (
        sections.map((s, i) => {
          const on = open[i] ?? i < OPEN_SECTIONS
          return (
            <div key={i} className="eva-ws-section">
              <button
                type="button"
                className="eva-ws-section-head"
                aria-expanded={on}
                onClick={() => setOpen({ ...open, [i]: !on })}
              >
                {on ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                <span className="eva-ws-section-title">{s.title}</span>
              </button>
              {on ? <div className="eva-ws-section-body">{s.body}</div> : null}
            </div>
          )
        })
      )}
    </section>
  )
}

export function WorkspacePage({ place }: { place: Place }) {
  const id = place.page.slice('workspace:'.length)
  const root = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [range, setRange] = usePref<Range>('workspace.range', 7, parseRange)
  const data = useWorkspace((s) => (s.id === id ? s.data : null))
  const loading = useWorkspace((s) => s.id !== id || s.loading)
  const error = useWorkspace((s) => s.id === id && s.error)

  useEffect(() => {
    const off = registerReloader('workspace', () => loadWorkspace(id))
    void loadWorkspace(id)
    return off
  }, [id])

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

  const openFile = async (): Promise<void> => {
    const r = await invoke('eva.workspace.openFile', { id }).catch(() => null)
    if (r && r.ok) return
    const path =
      r && !r.ok && r.error.message ? r.error.message.replace(/^Could not open /, '') : id
    notifications.show({
      message: `Could not open ${path}. Check that the file exists, then try again.`,
      color: 'red',
    })
  }

  const wrap = (children: React.ReactNode) => (
    <div ref={root} className="eva-page eva-ws" data-testid="page-workspace" data-compact={compact}>
      {children}
    </div>
  )

  if (!data) {
    if (loading && !error) {
      return wrap(
        <div className="eva-ws-col" aria-busy="true">
          <div className="eva-dash-skel" style={{ height: 120 }} />
          <div className="eva-dash-skel" style={{ height: 220 }} />
        </div>,
      )
    }
    return wrap(
      <div className="eva-ws-col eva-ws-missing">
        <h2 className="eva-dash-h2">Could not read this workspace</h2>
        <Button variant="default" size="sm" onClick={() => void loadWorkspace(id)}>
          Try again
        </Button>
      </div>,
    )
  }

  const ws = data.workspace
  if (!ws) {
    return wrap(
      <div className="eva-ws-col eva-ws-missing">
        <h2 className="eva-dash-h2">Workspace not found</h2>
        <p className="eva-dash-dim eva-dash-body">
          It may have been removed from the Eva repo. Go back to the Dashboard.
        </p>
        <Button variant="default" size="sm" onClick={() => openPlace(placeOf('dashboard'))}>
          Open Dashboard
        </Button>
      </div>,
    )
  }

  const active = matchesFilter(ws, 'active', data.today)
  const rows = activityRows(ws.daily, range, data.today)
  return wrap(
    <div className="eva-ws-col">
      <header className="eva-ws-header" data-testid="ws-header">
        <h1 className="eva-ws-title" data-page-title>
          {ws.displayName}
          {ws.builtIn ? <span className="eva-ws-badge">Eva</span> : null}
        </h1>
        <p className="eva-dash-dim eva-dash-body">{ws.tagline ?? 'No tagline'}</p>
        <div className="eva-ws-chips">
          <span className="eva-ws-chip">
            <span className="eva-ws-dot" data-active={active} />
            {active ? 'Active' : 'Quiet'}
          </span>
          <span className="eva-ws-chip">{`Last active ${relativeLabel(ws.lastActive, data.today)}`}</span>
          <span className="eva-ws-chip">{`${ws.openTodos} open ${ws.openTodos === 1 ? 'todo' : 'todos'}`}</span>
          {ws.aliases.map((a) => (
            <span key={a} className="eva-ws-chip eva-dash-dim">{`Tags: ${a}`}</span>
          ))}
        </div>
        <div className="eva-ws-actions">
          <Button
            size="sm"
            leftSection={<IconPlus size={16} />}
            data-testid="ws-new-todo"
            onClick={() => openNewTodo({ tag: id })}
          >
            New Todo
          </Button>
          <Tooltip label="No file for this workspace" disabled={ws.hasFile}>
            <span>
              <Button
                size="sm"
                variant="default"
                leftSection={<IconExternalLink size={16} />}
                data-testid="ws-open-file"
                disabled={!ws.hasFile}
                onClick={() => void openFile()}
              >
                Open File
              </Button>
            </span>
          </Tooltip>
        </div>
      </header>
      <section className="eva-ws-card" aria-labelledby="ws-activity-title">
        <div className="eva-dash-section-head">
          <h2 id="ws-activity-title" className="eva-dash-h2">
            Activity
          </h2>
          <Segmented
            label="Chart range"
            testid="ws-range"
            value={String(range) as '7' | '30' | '90'}
            onChange={(v) => setRange(Number(v) as Range)}
            options={[
              { value: '7', label: '7D', testid: 'ws-range-7' },
              { value: '30', label: '30D', testid: 'ws-range-30' },
              { value: '90', label: '90D', testid: 'ws-range-90' },
            ]}
          />
        </div>
        <ActivityChart
          rows={rows}
          name={ws.displayName}
          rangeLabel={LABEL[range]}
          height={160}
          testid="ws-chart"
        />
      </section>
      <div className="eva-ws-two">
        <Timeline data={data} />
        <section className="eva-ws-card" data-testid="ws-todos" aria-labelledby="ws-todos-title">
          <h2 id="ws-todos-title" className="eva-dash-h2">
            Open todos
          </h2>
          {data.todos.length === 0 ? (
            <p className="eva-dash-dim eva-dash-body">Nothing open.</p>
          ) : (
            <ul className="eva-dash-todo-list">
              {data.todos.map((t) => (
                <li key={t.id} className="eva-dash-todo-row">
                  <span className="eva-dash-todo-id">{t.id}</span>
                  <span className="eva-dash-ellipsis eva-dash-todo-text" title={t.text}>
                    {t.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <Sections id={id} sections={data.sections} />
    </div>,
  )
}

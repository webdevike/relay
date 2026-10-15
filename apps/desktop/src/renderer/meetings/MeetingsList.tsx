import { IconChevronDown, IconCircleDot } from '@tabler/icons-react'
import { useMemo, useState, type MouseEvent } from 'react'
import type { MeetingSummary } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { localDate } from '@evaos/eva-core/model/dates'
import { filterByTitle, groupByDay, type Meeting } from '@evaos/eva-core/model/meetings'
import { openPlace } from '../navigation/navigate'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { useMeetings, useMeetingsSurface } from './meetings-store'
import './meetings.css'

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

export function timeLabel(start: string | null): string {
  if (start === null) return ''
  const t = Date.parse(start)
  return Number.isNaN(t) ? '' : TIME.format(new Date(t))
}

/** The pure grouping helpers take full records; the list only needs these fields. */
function asMeeting(m: MeetingSummary): Meeting {
  return {
    stem: m.stem,
    title: m.title,
    start: m.start,
    notes: null,
    skipped: m.skipped,
    skippedReason: m.skippedReason,
    proposals: [],
    memorized: [],
  }
}

function Row({
  m,
  active,
  dim,
}: {
  m: MeetingSummary
  active: boolean
  dim?: boolean
}) {
  const open = (e: MouseEvent): void =>
    openPlace(placeOf('meetings', { meeting: m.stem }), { newTab: e.metaKey })
  return (
    <button
      type="button"
      className="eva-sb-row eva-mt-row"
      data-testid={`meeting-row-${m.stem}`}
      data-active={active ? 'true' : undefined}
      data-dim={dim ? 'true' : undefined}
      onClick={open}
    >
      {m.pending > 0 ? (
        <span
          role="img"
          className="eva-mt-dot"
          aria-label={`Waiting on you, ${m.pending} ${m.pending === 1 ? 'proposal' : 'proposals'}`}
          data-testid={`meeting-waiting-${m.stem}`}
        >
          <IconCircleDot size={14} aria-hidden />
        </span>
      ) : null}
      <span className="eva-mt-row-text">
        <span className="eva-mt-row-title">{m.title}</span>
        <span className="eva-mt-row-meta">{timeLabel(m.start)}</span>
      </span>
    </button>
  )
}

/** Sidebar body for the Meetings sub-page (MEET-01). */
export function MeetingsList({ query }: { query: string }) {
  useMeetingsSurface()
  const list = useMeetings((s) => s.list)
  const now = useMeetings((s) => s.now)
  const error = useMeetings((s) => s.error)
  const here = useTabs(activePlace)
  const [testsOpen, setTestsOpen] = useState(false)

  const byStem = useMemo(() => new Map((list ?? []).map((m) => [m.stem, m])), [list])
  const view = useMemo(() => {
    if (list === null) return null
    const filtered = filterByTitle(list.map(asMeeting), query)
    return {
      ...groupByDay(filtered.meetings, localDate(new Date(now))),
      forceTestsOpen: filtered.forceTestsOpen,
    }
  }, [list, now, query])

  if (view === null) {
    return error ? (
      <div className="eva-sb-empty eva-dim" role="alert" data-testid="sidebar-sub-empty">
        Could not read the meetings folder.
      </div>
    ) : (
      <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
        Loading meetings
      </div>
    )
  }
  if (list!.length === 0) {
    return (
      <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
        No meetings yet.
      </div>
    )
  }
  if (view.groups.length === 0 && view.tests.length === 0) {
    return (
      <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
        No meetings match.
      </div>
    )
  }
  const isActive = (stem: string): boolean => here.page === 'meetings' && here.meeting === stem
  const open = testsOpen || view.forceTestsOpen
  return (
    <div className="eva-mt-list" data-testid="meetings-list">
      {view.groups.map((g) => (
        <section key={g.key ?? 'undated'} aria-label={g.label}>
          <h3 className="eva-mt-day" data-testid="meetings-day">
            {g.label}
          </h3>
          {g.meetings.map((m) => (
            <Row key={m.stem} m={byStem.get(m.stem)!} active={isActive(m.stem)} />
          ))}
        </section>
      ))}
      {view.tests.length > 0 ? (
        <section>
          <button
            type="button"
            className="eva-mt-tests"
            data-testid="meetings-tests"
            aria-expanded={open}
            onClick={() => setTestsOpen(!testsOpen)}
          >
            <span>Test calls ({view.tests.length})</span>
            <IconChevronDown size={14} aria-hidden data-open={open ? 'true' : undefined} />
          </button>
          {open
            ? view.tests.map((m) => (
                <Row key={m.stem} m={byStem.get(m.stem)!} active={isActive(m.stem)} dim />
              ))
            : null}
        </section>
      ) : null}
    </div>
  )
}

import { IconCalendarEvent, IconCircleDot } from '@tabler/icons-react'
import { useMemo } from 'react'
import type { MeetingSummary } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { localDate } from '@evaos/eva-core/model/dates'
import { filterByTitle, groupByDay, type Meeting } from '@evaos/eva-core/model/meetings'
import { openFromNav } from '../navigation/open-in-app'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { ListEmpty, ListRow, ListTime, ListView, type ListGroup } from '../ui/list'
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

/** Sidebar body for the Meetings sub-page (MEET-01): day groups, then the folded test calls. */
export function MeetingsList({ query }: { query: string }) {
  useMeetingsSurface()
  const list = useMeetings((s) => s.list)
  const now = useMeetings((s) => s.now)
  const error = useMeetings((s) => s.error)
  const here = useTabs(activePlace)

  const byStem = useMemo(() => new Map((list ?? []).map((m) => [m.stem, m])), [list])
  const view = useMemo(() => {
    if (list === null) return null
    const filtered = filterByTitle(list.map(asMeeting), query)
    return {
      ...groupByDay(filtered.meetings, localDate(new Date(now))),
      forceTestsOpen: filtered.forceTestsOpen,
    }
  }, [list, now, query])

  const groups: ListGroup<MeetingSummary>[] = view
    ? [
        ...view.groups.map((g) => ({
          id: g.key ?? 'undated',
          label: g.label,
          testid: 'meetings-day',
          items: g.meetings.map((m) => byStem.get(m.stem)!),
        })),
        ...(view.tests.length > 0
          ? [
              {
                id: 'tests',
                label: 'Test calls',
                testid: 'meetings-tests',
                forceOpen: view.forceTestsOpen,
                items: view.tests.map((m) => byStem.get(m.stem)!),
              },
            ]
          : []),
      ]
    : []
  return (
    <ListView<MeetingSummary>
      data-testid="meetings-list"
      density="compact"
      groups={groups}
      defaultCollapsed={['tests']}
      rowKey={(m) => m.stem}
      renderRow={(m, g) => (
        <ListRow
          key={m.stem}
          data-testid={`meeting-row-${m.stem}`}
          active={here.page === 'meetings' && here.meeting === m.stem}
          dim={g.id === 'tests'}
          leading={
            m.pending > 0 ? (
              <span
                role="img"
                className="eva-mt-waiting"
                aria-label={`Waiting on you, ${m.pending} ${m.pending === 1 ? 'proposal' : 'proposals'}`}
                data-testid={`meeting-waiting-${m.stem}`}
              >
                <IconCircleDot size={16} stroke={1.75} aria-hidden />
              </span>
            ) : (
              <IconCalendarEvent size={16} stroke={1.5} aria-hidden />
            )
          }
          title={m.title}
          trailing={<ListTime>{timeLabel(m.start)}</ListTime>}
          onActivate={(e) => openFromNav(placeOf('meetings', { meeting: m.stem }), e)}
          middleClick
        />
      )}
      loading={
        view === null && !error ? { label: 'Loading meetings', testid: 'sidebar-sub-empty' } : false
      }
      error={
        view === null && error ? (
          <ListEmpty role="alert" data-testid="sidebar-sub-empty">
            Could not read the meetings folder.
          </ListEmpty>
        ) : undefined
      }
      empty={
        <ListEmpty data-testid="sidebar-sub-empty">
          {list?.length === 0 ? 'No meetings yet.' : 'No meetings match.'}
        </ListEmpty>
      }
    />
  )
}

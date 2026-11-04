import { IconCalendarEvent, IconCircleDot, IconMicrophone } from '@tabler/icons-react'
import { useMemo } from 'react'
import { MEETING_STAGE_LABEL, meetingClock } from '@relay/protocol'
import type { MeetingSummary, Recording } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { localDate } from '@evaos/eva-core/model/dates'
import { filterByTitle, groupByDay, type Meeting } from '@evaos/eva-core/model/meetings'
import { openFromNav } from '../navigation/open-in-app'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { ListEmpty, ListRow, ListTime, ListView, type ListGroup } from '../ui/list'
import { recordingTitle, useMeetings, useMeetingsSurface, useTicker } from './meetings-store'
import './meetings.css'

type Row = { kind: 'record'; m: MeetingSummary } | { kind: 'recording'; r: Recording }

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

/**
 * Sidebar body for the Meetings sub-page (MEET-01): a Live group while Relay records or writes up a
 * call, the day groups, Relay's finished recordings, then the folded test calls.
 */
export function MeetingsList({ query }: { query: string }) {
  useMeetingsSurface()
  const list = useMeetings((s) => s.list)
  const recordings = useMeetings((s) => s.recordings)
  const now = useMeetings((s) => s.now)
  const error = useMeetings((s) => s.error)
  const here = useTabs(activePlace)
  const recording = recordings.some((r) => r.stage === 'recording')
  const tick = useTicker(recording)

  const byStem = useMemo(() => new Map((list ?? []).map((m) => [m.stem, m])), [list])
  const view = useMemo(() => {
    if (list === null) return null
    const filtered = filterByTitle(list.map(asMeeting), query)
    return {
      ...groupByDay(filtered.meetings, localDate(new Date(now))),
      forceTestsOpen: filtered.forceTestsOpen,
    }
  }, [list, now, query])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return recordings.filter((r) => q === '' || recordingTitle(r).toLowerCase().includes(q))
  }, [recordings, query])
  const liveRecs = shown.filter((r) => r.stage !== 'done' && r.stage !== 'failed')
  const pastRecs = shown.filter((r) => r.stage === 'done' || r.stage === 'failed')

  const record = (m: MeetingSummary): Row => ({ kind: 'record', m })
  const rec = (r: Recording): Row => ({ kind: 'recording', r })
  const groups: ListGroup<Row>[] = view
    ? [
        ...(liveRecs.length > 0
          ? [
              {
                id: 'live',
                label: 'Live',
                testid: 'meetings-live',
                collapsible: false,
                items: liveRecs.map(rec),
              },
            ]
          : []),
        ...view.groups.map((g) => ({
          id: g.key ?? 'undated',
          label: g.label,
          testid: 'meetings-day',
          items: g.meetings.map((m) => record(byStem.get(m.stem)!)),
        })),
        ...(pastRecs.length > 0
          ? [
              {
                id: 'relay',
                label: 'Recorded by Relay',
                testid: 'meetings-relay',
                items: pastRecs.map(rec),
              },
            ]
          : []),
        ...(view.tests.length > 0
          ? [
              {
                id: 'tests',
                label: 'Test calls',
                testid: 'meetings-tests',
                forceOpen: view.forceTestsOpen,
                items: view.tests.map((m) => record(byStem.get(m.stem)!)),
              },
            ]
          : []),
      ]
    : []
  return (
    <ListView<Row>
      data-testid="meetings-list"
      density="compact"
      groups={groups}
      defaultCollapsed={['tests']}
      rowKey={(x) => (x.kind === 'record' ? x.m.stem : x.r.id)}
      renderRow={(x, g) =>
        x.kind === 'recording' ? (
          <ListRow
            key={x.r.id}
            data-testid={`recording-row-${x.r.id}`}
            active={here.page === 'meetings' && here.meeting === x.r.id}
            leading={
              x.r.stage === 'recording' ? (
                <span className="eva-mt-dot" role="img" aria-label="Recording" />
              ) : (
                <IconMicrophone size={16} stroke={1.5} aria-hidden />
              )
            }
            title={recordingTitle(x.r)}
            trailing={
              <ListTime>
                {x.r.stage === 'recording'
                  ? meetingClock(tick - x.r.startedAt)
                  : x.r.stage === 'done'
                    ? TIME.format(new Date(x.r.startedAt))
                    : MEETING_STAGE_LABEL[x.r.stage]}
              </ListTime>
            }
            onActivate={(e) => openFromNav(placeOf('meetings', { meeting: x.r.id }), e)}
            middleClick
          />
        ) : (
          <ListRow
            key={x.m.stem}
            data-testid={`meeting-row-${x.m.stem}`}
            active={here.page === 'meetings' && here.meeting === x.m.stem}
            dim={g.id === 'tests'}
            leading={
              x.m.pending > 0 ? (
                <span
                  role="img"
                  className="eva-mt-waiting"
                  aria-label={`Waiting on you, ${x.m.pending} ${x.m.pending === 1 ? 'proposal' : 'proposals'}`}
                  data-testid={`meeting-waiting-${x.m.stem}`}
                >
                  <IconCircleDot size={16} stroke={1.75} aria-hidden />
                </span>
              ) : (
                <IconCalendarEvent size={16} stroke={1.5} aria-hidden />
              )
            }
            title={x.m.title}
            trailing={<ListTime>{timeLabel(x.m.start)}</ListTime>}
            onActivate={(e) => openFromNav(placeOf('meetings', { meeting: x.m.stem }), e)}
            middleClick
          />
        )
      }
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

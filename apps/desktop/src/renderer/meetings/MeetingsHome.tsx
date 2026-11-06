import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import { IconAlertTriangle, IconCalendarOff, IconGavel } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { localDate } from '@evaos/eva-core/model/dates'
import { dayLabel } from '@evaos/eva-core/model/meetings'
import { ListEmpty, ListRow, ListTime, ListView, rowTip, type ListGroup } from '../ui/list'
import { useMeetings, useMeetingsSurface, type MeetingDigest } from './meetings-store'
import { ProposalRow } from './ProposalRow'
import './meetings.css'

const DECISIONS_SHOWN = 5

type HomeItem =
  | { kind: 'waiting'; w: MeetingDigest['waiting'][number] }
  | { kind: 'out'; o: MeetingDigest['out'][number]; i: number }
  | { kind: 'decision'; d: MeetingDigest['decisions'][number]; i: number }

export function summaryLine(recent: number, waiting: number): string {
  return `${recent} ${recent === 1 ? 'meeting' : 'meetings'} this week, ${waiting} waiting on you`
}

export function MeetingsHome(_props: { place: Place }) {
  useMeetingsSurface()
  const list = useMeetings((s) => s.list)
  const digest = useMeetings((s) => s.digest)
  const now = useMeetings((s) => s.now)
  const error = useMeetings((s) => s.error)
  const [all, setAll] = useState(false)

  const today = localDate(new Date(now))
  const decisions = all ? digest.decisions : digest.decisions.slice(0, DECISIONS_SHOWN)
  const groups: ListGroup<HomeItem>[] = [
    {
      id: 'waiting',
      label: 'Waiting on you',
      testid: 'meetings-waiting',
      items: digest.waiting.map((w) => ({ kind: 'waiting', w })),
      empty: 'Nothing waiting on you.',
    },
  ]
  if (digest.out.length > 0) {
    groups.push({
      id: 'out',
      label: "Who's out",
      testid: 'meetings-out',
      items: digest.out.map((o, i) => ({ kind: 'out', o, i })),
    })
  }
  if (digest.decisions.length > 0) {
    groups.push({
      id: 'decisions',
      label: 'Recent decisions',
      testid: 'meetings-decisions',
      count: digest.decisions.length,
      items: decisions.map((d, i) => ({ kind: 'decision', d, i })),
    })
  }

  return (
    <div className="eva-mt-col" data-testid="page-meetings">
      <div className="eva-mt-head">
        <h1 className="eva-mt-title" data-page-title>
          Meetings
        </h1>
        {list ? (
          <p className="eva-mt-dim" data-testid="meetings-summary">
            {summaryLine(digest.recentCount, digest.waiting.length)}
          </p>
        ) : null}
      </div>
      <ListView<HomeItem>
        groups={list === null ? [] : groups}
        rowKey={(x) =>
          x.kind === 'waiting'
            ? `w:${x.w.proposal.id}`
            : x.kind === 'out'
              ? `o:${x.o.stem}-${x.i}`
              : `d:${x.d.stem}-${x.i}`
        }
        renderRow={(x) => {
          if (x.kind === 'waiting') {
            return (
              <ProposalRow
                key={`w:${x.w.proposal.id}`}
                stem={x.w.stem}
                meetingTitle={x.w.title}
                proposal={x.w.proposal}
              />
            )
          }
          if (x.kind === 'out') {
            return (
              <ListRow
                key={`o:${x.o.stem}-${x.i}`}
                leading={<IconCalendarOff size={16} stroke={1.5} aria-hidden />}
                title={x.o.text}
                multiline
                trailing={
                  <ListTime>{x.o.date ? dayLabel(x.o.date, today, 'rust') : x.o.title}</ListTime>
                }
              />
            )
          }
          return (
            <ListRow
              key={`d:${x.d.stem}-${x.i}`}
              tooltip={rowTip(x.d.text, x.d.title)}
              leading={<IconGavel size={16} stroke={1.5} aria-hidden />}
              title={x.d.text}
              multiline
            />
          )
        }}
        footer={
          list !== null && digest.decisions.length > DECISIONS_SHOWN ? (
            <UnstyledButton
              className="eva-mt-link"
              data-testid="meetings-decisions-toggle"
              onClick={() => setAll(!all)}
            >
              {all ? 'Show fewer' : `Show all ${digest.decisions.length}`}
            </UnstyledButton>
          ) : null
        }
        loading={
          list === null && !error
            ? { label: 'Loading meetings', testid: 'meetings-loading' }
            : false
        }
        error={
          list === null && error ? (
            <ListEmpty
              role="alert"
              data-testid="meetings-error"
              icon={<IconAlertTriangle size={24} stroke={1.5} />}
            >
              Could not read the meetings folder. Check that work/meetings exists in the Eva repo,
              then press the refresh shortcut.
            </ListEmpty>
          ) : undefined
        }
      />
    </div>
  )
}

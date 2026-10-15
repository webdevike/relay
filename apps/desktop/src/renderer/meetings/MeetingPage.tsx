import { useEffect, useMemo, useState } from 'react'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import type { Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { loadMeeting, useMeetings, useMeetingsSurface } from './meetings-store'
import { ProposalRow } from './ProposalRow'
import './meetings.css'

const WHEN = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const MAX_CHIPS = 6

function whenLabel(start: string | null): string {
  const t = start === null ? NaN : Date.parse(start)
  return Number.isNaN(t) ? 'Undated' : WHEN.format(new Date(t))
}

function Paragraphs({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="eva-mt-dim">{empty}</p>
  return (
    <>
      {items.map((t, i) => (
        <p key={i} className="eva-mt-p">
          {t}
        </p>
      ))}
    </>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="eva-mt-ul">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  )
}

export function MeetingPage({ place }: { place: Place }) {
  const stem = place.meeting ?? ''
  useMeetingsSurface()
  const detail = useMeetings((s) => s.details[stem])
  const [tab, setTab] = useState<'overview' | 'transcript'>('overview')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (stem !== '') void loadMeeting(stem)
  }, [stem])

  const lines = useMemo(() => {
    const all = detail?.protocol?.transcript ?? []
    const q = filter.trim().toLowerCase()
    return q === ''
      ? all
      : all.filter((l) => `${l.speaker ?? ''} ${l.text}`.toLowerCase().includes(q))
  }, [detail, filter])

  if (detail === undefined) {
    return (
      <div className="eva-mt-col" data-testid="page-meeting">
        <p className="eva-mt-dim">Loading notes</p>
      </div>
    )
  }
  const m = detail.meeting
  if (m === null) {
    return (
      <div className="eva-mt-col" data-testid="page-meeting">
        <p className="eva-mt-dim">This meeting was not found.</p>
      </div>
    )
  }

  const openNotes = async (): Promise<void> => {
    const r = await invoke('meetings.openNotes', { stem }).catch(() => null)
    if (r && r.ok) return
    const path =
      r && !r.ok && r.error.message ? r.error.message.replace(/^Could not open /, '') : stem
    notifications.show({
      color: 'red',
      message: `Could not open ${path}. Check that the file exists, then try again.`,
      autoClose: 8000,
    })
  }

  const p = detail.protocol
  const attendees = p?.attendees ?? []
  const forYou = m.proposals.filter((x) => x.status === 'proposed')
  const remembered = m.proposals.filter((x) => x.status !== 'proposed')

  let content
  if (m.skipped) {
    content = <p className="eva-mt-p">Eva skipped this as a test call.</p>
  } else if (detail.notes === 'missing') {
    content = <p className="eva-mt-dim">Notes file not found</p>
  } else if (tab === 'overview') {
    content = (
      <>
        <section className="eva-mt-section">
          <h2 className="eva-mt-h2">Summary</h2>
          <Paragraphs items={p?.summary ?? []} empty="The notes have no summary." />
        </section>
        {p && p.decisions.length > 0 ? (
          <section className="eva-mt-section">
            <h2 className="eva-mt-h2">Decisions</h2>
            <Bullets items={p.decisions} />
          </section>
        ) : null}
        {p && p.questions.length > 0 ? (
          <section className="eva-mt-section">
            <h2 className="eva-mt-h2">Open questions</h2>
            <Bullets items={p.questions} />
          </section>
        ) : null}
        {attendees.length > 0 ? (
          <section className="eva-mt-section">
            <h2 className="eva-mt-h2">Attendees</h2>
            <div className="eva-mt-chips">
              {attendees.map((a, i) => (
                <span key={i} className="eva-mt-chip">
                  {a}
                </span>
              ))}
            </div>
          </section>
        ) : null}
        {forYou.length > 0 ? (
          <section className="eva-mt-section" data-testid="meeting-for-you">
            <h2 className="eva-mt-h2">For you</h2>
            {forYou.map((x) => (
              <ProposalRow key={x.id} stem={stem} meetingTitle="" proposal={x} />
            ))}
          </section>
        ) : null}
        {remembered.length > 0 ? (
          <section className="eva-mt-section" data-testid="meeting-remembered">
            <h2 className="eva-mt-h2">Remembered</h2>
            {remembered.map((x) => (
              <ProposalRow key={x.id} stem={stem} meetingTitle="" proposal={x} dim />
            ))}
          </section>
        ) : null}
      </>
    )
  } else {
    const total = p?.transcript.length ?? 0
    content = (
      <section className="eva-mt-section">
        {total === 0 ? (
          <p className="eva-mt-dim">The notes have no transcript.</p>
        ) : (
          <>
            <input
              className="eva-mt-filter"
              data-testid="meeting-transcript-filter"
              placeholder="Filter transcript"
              aria-label="Filter transcript"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {lines.length === 0 ? (
              <p className="eva-mt-dim">No lines match.</p>
            ) : (
              lines.map((l, i) => (
                <div key={i} className="eva-mt-line" data-testid="meeting-line">
                  {l.speaker ? <span className="eva-mt-speaker">{l.speaker}</span> : null}
                  <span>{l.text}</span>
                </div>
              ))
            )}
          </>
        )}
      </section>
    )
  }

  return (
    <div className="eva-mt-col" data-testid="page-meeting">
      <div className="eva-mt-head">
        <h1 className="eva-mt-title" data-testid="meeting-title">
          {m.title}
        </h1>
        <p className="eva-mt-dim" data-testid="meeting-when">
          {whenLabel(m.start)}
        </p>
        {attendees.length > 0 ? (
          <div className="eva-mt-chips" data-testid="meeting-attendees">
            {attendees.slice(0, MAX_CHIPS).map((a, i) => (
              <span key={i} className="eva-mt-chip">
                {a}
              </span>
            ))}
            {attendees.length > MAX_CHIPS ? (
              <span className="eva-mt-chip">+{attendees.length - MAX_CHIPS}</span>
            ) : null}
          </div>
        ) : null}
        {m.hasNotes ? (
          <div>
            <Button
              variant="default"
              size="xs"
              data-testid="meeting-open-notes"
              onClick={() => void openNotes()}
            >
              Open Notes
            </Button>
          </div>
        ) : null}
      </div>
      {m.skipped ? null : (
        <div className="eva-mt-tabs" role="tablist">
          {(['overview', 'transcript'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className="eva-mt-tab"
              aria-selected={tab === t}
              data-testid={`meeting-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {t === 'overview' ? 'Overview' : 'Transcript'}
            </button>
          ))}
        </div>
      )}
      {content}
    </div>
  )
}

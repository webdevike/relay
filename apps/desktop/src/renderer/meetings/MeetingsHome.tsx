import { useState } from 'react'
import type { Place } from '@evaos/shell-core'
import { localDate } from '@evaos/eva-core/model/dates'
import { dayLabel } from '@evaos/eva-core/model/meetings'
import { useMeetings, useMeetingsSurface } from './meetings-store'
import { ProposalRow } from './ProposalRow'
import './meetings.css'

const DECISIONS_SHOWN = 5

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

  let body
  if (list === null) {
    body = error ? (
      <p className="eva-mt-dim" role="alert" data-testid="meetings-error">
        Could not read the meetings folder. Check that work/meetings exists in the Eva repo, then
        press the refresh shortcut.
      </p>
    ) : (
      <p className="eva-mt-dim" data-testid="meetings-loading">
        Loading meetings
      </p>
    )
  } else {
    const today = localDate(new Date(now))
    const decisions = all ? digest.decisions : digest.decisions.slice(0, DECISIONS_SHOWN)
    body = (
      <>
        <section className="eva-mt-section" data-testid="meetings-waiting">
          <h2 className="eva-mt-h2">Waiting on you</h2>
          {digest.waiting.length === 0 ? (
            <p className="eva-mt-dim">Nothing waiting on you.</p>
          ) : (
            digest.waiting.map((w) => (
              <ProposalRow
                key={w.proposal.id}
                stem={w.stem}
                meetingTitle={w.title}
                proposal={w.proposal}
              />
            ))
          )}
        </section>
        {digest.out.length > 0 ? (
          <section className="eva-mt-section" data-testid="meetings-out">
            <h2 className="eva-mt-h2">Who&apos;s out</h2>
            {digest.out.map((o, i) => (
              <div key={`${o.stem}-${i}`} className="eva-mt-out">
                <span>{o.text}</span>
                <span className="eva-mt-label">
                  {o.date ? dayLabel(o.date, today, 'rust') : o.title}
                </span>
              </div>
            ))}
          </section>
        ) : null}
        {digest.decisions.length > 0 ? (
          <section className="eva-mt-section" data-testid="meetings-decisions">
            <h2 className="eva-mt-h2">Recent decisions</h2>
            {decisions.map((d, i) => (
              <div key={`${d.stem}-${i}`} className="eva-mt-out">
                <span>{d.text}</span>
                <span className="eva-mt-label">{d.title}</span>
              </div>
            ))}
            {digest.decisions.length > DECISIONS_SHOWN ? (
              <button
                type="button"
                className="eva-mt-link"
                data-testid="meetings-decisions-toggle"
                onClick={() => setAll(!all)}
              >
                {all ? 'Show fewer' : `Show all ${digest.decisions.length}`}
              </button>
            ) : null}
          </section>
        ) : null}
      </>
    )
  }

  return (
    <div className="eva-mt-col" data-testid="page-meetings">
      <div className="eva-mt-head">
        <h1 className="eva-mt-title">Meetings</h1>
        {list ? (
          <p className="eva-mt-dim" data-testid="meetings-summary">
            {summaryLine(digest.recentCount, digest.waiting.length)}
          </p>
        ) : null}
      </div>
      {body}
    </div>
  )
}

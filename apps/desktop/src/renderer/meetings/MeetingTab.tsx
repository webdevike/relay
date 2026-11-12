import './meeting-tab.css'
import '../chat/strips/meeting-cards.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconCalendarEvent } from '@tabler/icons-react'
import {
  MEETING_QUICK_ASKS,
  MEETING_STAGE_LABEL,
  meetingClock,
  meetingIsLive,
  meetingRows,
} from '@relay/protocol'
import { placeOf } from '@evaos/shell-core'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { clockLabel } from '../context/format'
import { navigateTo } from '../tabs/tabs-store'
import { askInChat } from './meeting-chat'
import {
  loadRecording,
  recordingTitle,
  useMeetings,
  useMeetingsSurface,
  useTicker,
} from './meetings-store'

/** Whether more of a horizontal row hides before its start or past its end. */
function edges(el: HTMLElement): { start: boolean; end: boolean } {
  return { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
}

/** Isaac's own track reads "You". */
const who = (speaker: string, track: string): string => (track === 'mic' ? 'You' : speaker)

/**
 * A meeting beside the assistant's chat it is in: who is speaking, the rolling transcript and
 * one-tap asks that post into that chat while the call runs; the notes' summary after.
 */
export function MeetingTab({ id }: { id: string }) {
  useMeetingsSurface()
  const view = useMeetings((s) => s.views[id])
  const listed = useMeetings((s) => s.recordings.find((r) => r.id === id))
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    void loadRecording(id).then(setError)
  }, [id])

  // The list's copy follows the host's pushes even before the page loads.
  const r = listed ?? view?.recording
  const live = r !== undefined && meetingIsLive(r)
  const now = useTicker(live)
  const known = useAssistants((s) => (r?.assistant ? agentOf(s, r.assistant) : null))
  const owner = r?.assistant ? (known ?? { id: r.assistant, title: r.assistant }) : null
  const rows = useMemo(() => meetingRows(view?.lines ?? []), [view?.lines])
  const pills = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ start: false, end: false })

  // The pill row fades on the side(s) more pills scroll in from.
  useEffect(() => {
    const el = pills.current
    if (!el) return
    const ro = new ResizeObserver(() => setFade(edges(el)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [live])

  // Sticks to the newest line unless Isaac scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rows])

  if (r === undefined) {
    return (
      <div className="eva-meeting-tab" data-testid="meeting-tab">
        <p className="eva-meeting-tab-dim">{error ?? 'Loading the meeting'}</p>
      </div>
    )
  }

  const title = recordingTitle(r)
  // The card beside it ticks the elapsed time; here the call's start, and its length once over.
  const min = Math.max(1, Math.round(((r.endedAt ?? r.startedAt) - r.startedAt) / 60_000))
  const when = live
    ? `Started ${clockLabel(r.startedAt, now)}`
    : `${clockLabel(r.startedAt, now)} · ${min} min`
  const newest = rows[rows.length - 1]
  const notes = view?.notes ?? null
  const ask = async (q: string): Promise<void> => {
    if (owner === null) return
    setAsked(q)
    await askInChat(owner.id, q)
    setAsked(null)
  }

  return (
    <div className="eva-meeting-tab" data-testid="meeting-tab" data-live={live}>
      <div className="eva-meeting-tab-head">
        {live ? (
          <span className="eva-meeting-dot" role="img" aria-label="Live" />
        ) : (
          <IconCalendarEvent size={16} stroke={1.8} aria-hidden className="eva-meeting-tab-cal" />
        )}
        <div className="eva-meeting-tab-name">
          <div className="eva-meeting-tab-title" title={title}>
            {title}
          </div>
          <div className="eva-meeting-tab-sub">
            <span data-testid="meeting-tab-when">{when}</span>
            <span>·</span>
            <span>{r.app}</span>
          </div>
        </div>
      </div>
      <div className="eva-meeting-tab-state" data-testid="meeting-speaker">
        {live ? (
          newest === undefined ? (
            <span className="eva-meeting-tab-dim">Listening</span>
          ) : (
            <span>
              <b>{who(newest.speaker, newest.track)}</b>{' '}
              {newest.track === 'mic' ? 'are speaking' : 'is speaking'}
            </span>
          )
        ) : (
          <span>{MEETING_STAGE_LABEL[r.stage]}</span>
        )}
      </div>
      {!live && r.stage === 'done' && notes !== null && notes.summary.length > 0 ? (
        <div className="eva-meeting-tab-notes" data-testid="meeting-tab-summary">
          <ul>
            {notes.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <button
            type="button"
            className="eva-meeting-tab-link"
            onClick={() => navigateTo(placeOf('meetings', { meeting: id }))}
          >
            Open notes
          </button>
        </div>
      ) : null}
      <div
        ref={scroller}
        className="eva-meeting-tab-tx"
        data-testid="meeting-transcript"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {rows.map((row) => (
          <div key={row.id} className="eva-meeting-tab-line" data-draft={row.draft}>
            <span className="eva-meeting-tab-time">{meetingClock(row.startMs)}</span>
            <div>
              <div className="eva-meeting-tab-speaker" data-track={row.track}>
                {who(row.speaker, row.track)}
              </div>
              <div className="eva-meeting-tab-text">{row.text}</div>
            </div>
          </div>
        ))}
      </div>
      {live && owner !== null ? (
        <div className="eva-meeting-tab-asks">
          <div className="eva-meeting-tab-asks-head">Ask {owner.title} in the chat</div>
          <div
            ref={pills}
            className="eva-meeting-tab-ask-row"
            data-more-start={fade.start}
            data-more-end={fade.end}
            onScroll={(e) => setFade(edges(e.currentTarget))}
          >
            {MEETING_QUICK_ASKS.map((q) => (
              <button
                key={q}
                type="button"
                className="eva-meeting-tab-ask"
                data-testid="meeting-quick-ask"
                disabled={asked !== null}
                onClick={() => void ask(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, Textarea, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { MEETING_STAGE_LABEL, meetingClock, meetingRows } from '@relay/protocol'
import type { Place } from '@evaos/shell-core'
import { Markdown } from '../chat/markdown/Markdown'
import { invoke } from '../ipc'
import {
  askAboutMeeting,
  loadRecording,
  recordingTitle,
  useMeetings,
  useMeetingsSurface,
  useTicker,
} from './meetings-store'
import './meetings.css'

const WHEN = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** One of Relay's recordings: the live transcript and Ask while the call runs, its notes after. */
export function RecordingPage({ place }: { place: Place }) {
  const id = place.meeting ?? ''
  useMeetingsSurface()
  const view = useMeetings((s) => s.views[id])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (id !== '') void loadRecording(id).then(setError)
  }, [id])

  const r = view?.recording
  const live = r?.stage === 'recording'
  const now = useTicker(live)
  const rows = useMemo(() => {
    const all = meetingRows(view?.lines ?? [])
    const q = filter.trim().toLowerCase()
    return q === ''
      ? all
      : all.filter((x) => x.text.toLowerCase().includes(q) || x.speaker.toLowerCase().includes(q))
  }, [view?.lines, filter])

  // Sticks to the newest line unless Isaac scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rows])

  if (view === undefined || r === undefined) {
    return (
      <div className="eva-mt-col" data-testid="page-recording">
        <p className="eva-mt-dim" data-testid="recording-loading">
          {error ?? 'Loading the meeting'}
        </p>
      </div>
    )
  }

  const elapsed = live ? now - r.startedAt : (r.endedAt ?? r.startedAt) - r.startedAt
  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (q === '' || asking) return
    setAsking(true)
    const failed = await askAboutMeeting(id, q)
    setAsking(false)
    if (failed === null) setQuestion('')
    else notifications.show({ message: failed, color: 'red', autoClose: 6000 })
  }
  const act = async (kind: 'meetings.stop' | 'meetings.discard'): Promise<void> => {
    const res = await invoke(kind, { id }).catch(() => null)
    if (res === null || !res.ok) {
      notifications.show({
        message: res?.ok === false ? res.error.message : 'The Relay Host did not answer.',
        color: 'red',
        autoClose: 6000,
      })
    }
  }
  const turns = view.astra?.turns.filter((t) => t.role !== 'tool') ?? []

  return (
    <div className="eva-mt-col eva-mt-live" data-testid="page-recording">
      <div className="eva-mt-head">
        <h1 className="eva-mt-title">{recordingTitle(r)}</h1>
        <p className="eva-mt-dim" data-testid="recording-meta">
          {live ? <span className="eva-mt-dot" role="img" aria-label="Recording" /> : null}
          {r.app} · {r.device} · {WHEN.format(new Date(r.startedAt))} · {meetingClock(elapsed)}
        </p>
        <p
          className={r.health === 'ok' ? 'eva-mt-dim' : 'eva-mt-warn'}
          data-testid="recording-stage"
          role={r.stage === 'failed' || r.health !== 'ok' ? 'alert' : undefined}
        >
          {live
            ? r.healthDetail
            : r.stage === 'failed'
              ? `Failed: ${r.error ?? 'no reason given'}`
              : MEETING_STAGE_LABEL[r.stage]}
        </p>
        {r.shadow ? (
          <p className="eva-mt-dim" data-testid="recording-shadow">
            Trial run: MeetingTranscriber still writes the notes Eva files. These notes stay here.
          </p>
        ) : null}
        <div className="eva-mt-actions">
          {live ? (
            <Button
              size="xs"
              variant="default"
              data-testid="recording-stop"
              onClick={() => void act('meetings.stop')}
            >
              Stop recording
            </Button>
          ) : null}
          {confirmDiscard ? (
            <Button
              size="xs"
              color="red"
              data-testid="recording-discard-confirm"
              onClick={() => void act('meetings.discard')}
            >
              Delete audio, transcript and notes
            </Button>
          ) : (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              data-testid="recording-discard"
              onClick={() => setConfirmDiscard(true)}
            >
              Discard
            </Button>
          )}
        </div>
      </div>

      {view.notes ? (
        <section className="eva-mt-section" data-testid="recording-notes">
          <h2 className="eva-mt-h2">Summary</h2>
          {view.notes.summary.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {view.notes.decisions.length > 0 ? (
            <>
              <h2 className="eva-mt-h2">Decisions</h2>
              <ul className="eva-mt-ul">
                {view.notes.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          ) : null}
          {view.notes.questions.length > 0 ? (
            <>
              <h2 className="eva-mt-h2">Open questions</h2>
              <ul className="eva-mt-ul">
                {view.notes.questions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="eva-mt-section">
        <div className="eva-mt-transcript-head">
          <h2 className="eva-mt-h2">Transcript</h2>
          <TextInput
            size="xs"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            data-testid="recording-filter"
            aria-label="Filter the transcript"
          />
        </div>
        <div
          ref={scroller}
          className="eva-mt-transcript"
          data-testid="recording-transcript"
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {rows.length === 0 ? (
            <p className="eva-mt-dim">
              {live
                ? 'Listening. Lines show up a moment after someone speaks.'
                : 'Nothing was transcribed.'}
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="eva-mt-line"
                data-draft={row.draft || undefined}
                data-testid="recording-line"
              >
                <span className="eva-mt-time">{meetingClock(row.startMs)}</span>
                <span className="eva-mt-speaker" data-track={row.track}>
                  {row.speaker}
                </span>
                <span className="eva-mt-text">{row.text}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="eva-mt-ask" data-testid="recording-ask">
        {turns.map((t) =>
          t.role === 'user' ? (
            <p key={t.id} className="eva-mt-question">
              {t.text}
            </p>
          ) : (
            <div key={t.id} className="eva-mt-answer">
              <Markdown text={t.text} />
            </div>
          ),
        )}
        {view.astra?.working ? <p className="eva-mt-dim">Astra is thinking</p> : null}
        {view.astra?.waiting ? <p className="eva-mt-warn">{view.astra.waiting}</p> : null}
        {view.astra?.error ? <p className="eva-mt-warn">{view.astra.error}</p> : null}
        <Textarea
          autosize
          minRows={1}
          maxRows={5}
          placeholder="Ask Astra about this meeting"
          value={question}
          disabled={asking}
          data-testid="recording-question"
          aria-label="Ask Astra about this meeting"
          onChange={(e) => setQuestion(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask()
            }
          }}
        />
      </section>
    </div>
  )
}

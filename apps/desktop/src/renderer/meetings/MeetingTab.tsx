import './meeting-tab.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconPhoto } from '@tabler/icons-react'
import {
  MEETING_ASKS,
  MEETING_STAGE_LABEL,
  meetingClock,
  meetingIsLive,
  meetingRows,
  momentRowId,
  momentStamp,
  nowMoments,
  type KeyMoment,
  type MeetingRow,
} from '@relay/protocol'
import type { RecordingView } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { clockLabel } from '../context/format'
import { invoke } from '../ipc'
import { mediaUrl } from '../chat/widgets/media-url'
import { EvaMenu, EvaModal } from '../overlay'
import { navigateTo } from '../tabs/tabs-store'
import { askInChat } from './meeting-chat'
import {
  endedSections,
  jumpTop,
  meetingWhen,
  momentLabel,
  nearBottom,
  openAsks,
} from './meeting-panel'
import {
  loadRecording,
  recordingTitle,
  useMeetings,
  useMeetingsSurface,
  useTicker,
} from './meetings-store'

/** `lead` is Now on the call and Summary after it. */
type View = 'lead' | 'transcript' | 'moments'

/** How long a jumped-to transcript row stays highlighted. */
const LIT_MS = 2200

/** Isaac's own track reads "You". */
const who = (row: MeetingRow): string => (row.track === 'mic' ? 'You' : row.speaker)

const NO_SCREEN_RECORDING =
  'Screen snapshots are off: allow Screen Recording for Relay in System Settings.'

type MeetingShot = RecordingView['shots'][number]

const EMPTY_MOMENTS: KeyMoment[] = []
const EMPTY_SHOTS: MeetingShot[] = []

/**
 * A meeting beside the assistant's chat it is in. On the call: Now (the host's latest key moments
 * and the shared screen's snapshots), the transcript that follows the newest line, every key
 * moment. After it: Summary first (what needs Isaac, actions, what was decided, the snapshots).
 * One Ask menu posts a question into that chat as Isaac; answers land there, never here.
 */
export function MeetingTab({ id }: { id: string }) {
  useMeetingsSurface()
  const view = useMeetings((s) => s.views[id])
  const listed = useMeetings((s) => s.recordings.find((r) => r.id === id))
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<View>('lead')
  const [follow, setFollow] = useState(true)
  const [lit, setLit] = useState<{ row: string } | null>(null)
  const [menu, setMenu] = useState(false)
  const [asking, setAsking] = useState(false)
  const [ending, setEnding] = useState(false)
  const [opened, setOpened] = useState<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // A moment's row to scroll to once the transcript shows, and the scroll event that jump causes.
  const pendingJump = useRef<string | null>(null)
  const quiet = useRef(false)

  useEffect(() => {
    void loadRecording(id).then(setError)
  }, [id])

  // The list's copy follows the host's pushes even before the page loads.
  const r = listed ?? view?.recording
  const live = r !== undefined && meetingIsLive(r)
  const now = useTicker(live)
  const known = useAssistants((s) => (r?.assistant ? agentOf(s, r.assistant) : null))
  const owner = r?.assistant ? (known ?? { id: r.assistant, title: r.assistant }) : null
  const lines = view?.lines
  const rows = useMemo(() => meetingRows(lines ?? []), [lines])
  const moments = view?.moments ?? EMPTY_MOMENTS
  const shots = view?.shots ?? EMPTY_SHOTS
  const open = useMemo(() => openAsks(moments, lines ?? []), [moments, lines])
  // Rows that put something to Isaac read in the accent, like his own.
  const youRows = useMemo(
    () =>
      new Set(
        moments
          .filter((m) => m.kind === 'ask')
          .map((m) => momentRowId(rows, m.atMs))
          .filter((id) => id !== null),
      ),
    [moments, rows],
  )

  // The call ending puts the Summary in front.
  useEffect(() => {
    if (!live) setTab('lead')
  }, [live])

  useEffect(() => {
    if (lit === null) return
    const t = setTimeout(() => setLit(null), LIT_MS)
    return () => clearTimeout(t)
  }, [lit])

  // The transcript sticks to the newest line while following; a moment's jump puts its row a
  // third of the way down; the other views open at their top.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null) return
    if (tab !== 'transcript') {
      el.scrollTop = 0
      return
    }
    const target = pendingJump.current
    if (target !== null) {
      pendingJump.current = null
      const row = [...el.querySelectorAll<HTMLElement>('[data-row-id]')].find(
        (n) => n.dataset.rowId === target,
      )
      if (row === undefined) return
      const top = Math.min(
        jumpTop(row.offsetTop, el.clientHeight),
        el.scrollHeight - el.clientHeight,
      )
      if (Math.abs(el.scrollTop - top) >= 1) {
        quiet.current = true
        el.scrollTop = top
      }
      return
    }
    if (follow) el.scrollTop = el.scrollHeight
  }, [tab, rows, follow, lit])

  if (r === undefined) {
    return (
      <div className="eva-meeting-tab" data-testid="meeting-tab">
        <p className="eva-meeting-tab-dim eva-meeting-tab-pad">{error ?? 'Loading the meeting'}</p>
      </div>
    )
  }

  const title = recordingTitle(r)
  const notes = view?.notes ?? null
  const show = (v: View): void => {
    setTab(v)
    setFollow(true)
    setLit(null)
  }
  const openMoment = (m: KeyMoment): void => {
    const row = momentRowId(rows, m.atMs)
    if (row === null) return
    pendingJump.current = row
    setTab('transcript')
    setFollow(false)
    setLit({ row })
  }
  const ask = async (text: string): Promise<void> => {
    if (owner === null) return
    setAsking(true)
    await askInChat(owner.id, text)
    setAsking(false)
  }
  const end = async (): Promise<void> => {
    setEnding(true)
    const res = await invoke('meetings.stop', { id }).catch(() => null)
    setEnding(false)
    if (res === null || !res.ok) {
      notifications.show({
        message: res?.ok === false ? res.error.message : 'The Relay Host did not answer.',
        color: 'red',
        autoClose: 6000,
      })
    }
  }

  const moment = (m: KeyMoment) => (
    <div key={m.id} className="eva-meeting-moment-row">
      <button
        type="button"
        className="eva-meeting-moment"
        data-testid="meeting-moment"
        data-kind={m.kind}
        data-open={open.has(m.id)}
        onClick={() => openMoment(m)}
      >
        <span className="eva-meeting-tab-stamp">{meetingClock(m.atMs)}</span>
        <span>
          <span className="eva-meeting-moment-text">{m.text}</span>
          <span className="eva-meeting-moment-by">{momentLabel(m, open.has(m.id))}</span>
        </span>
      </button>
      {m.shot !== null && shots.some((s) => s.n === m.shot) ? (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="var(--eva-kit-control-sm)"
          className="eva-meeting-moment-shot"
          aria-label={`Screen at ${meetingClock(m.atMs)}`}
          data-testid="meeting-moment-shot"
          onClick={() => setOpened(m.shot)}
        >
          <IconPhoto size="calc(var(--eva-font-size) * .875)" stroke={1.5} />
        </ActionIcon>
      ) : null}
    </div>
  )

  const strip =
    shots.length > 0 ? (
      <section className="eva-meeting-tab-section">
        <div className="eva-meeting-tab-label">Shared screen</div>
        <ShotStrip shots={shots} onOpen={setOpened} />
      </section>
    ) : null

  // On the call the shared screen leads (it is what everyone is looking at), the moments follow.
  const shown = nowMoments(moments)
  const nowView = (
    <>
      {r.share === 'no-permission' ? (
        <p className="eva-meeting-tab-note" data-testid="meeting-share-off">
          {NO_SCREEN_RECORDING}
        </p>
      ) : null}
      {shots.length > 0 ? (
        <section className="eva-meeting-now-shots">
          <div className="eva-meeting-tab-label">Shared screen</div>
          <ShotStrip shots={shots} onOpen={setOpened} />
        </section>
      ) : null}
      {shown.length === 0 ? (
        <p className="eva-meeting-tab-dim" data-testid="meeting-now-empty">
          Key moments show up here as the call goes.
        </p>
      ) : (
        <section data-testid="meeting-now">
          {shots.length > 0 ? <div className="eva-meeting-tab-label">Key moments</div> : null}
          {shown.map(moment)}
        </section>
      )}
    </>
  )

  const { forYou, actions, decided } = endedSections(moments, open, notes?.decisions ?? [])
  const gist = notes !== null && notes.summary.length > 0 ? notes.summary.join(' ') : null
  const summaryView = (
    <div className="eva-meeting-recap" data-testid="meeting-recap">
      {gist !== null ? (
        <p className="eva-meeting-recap-gist">{gist}</p>
      ) : (
        <p className="eva-meeting-tab-dim">
          {r.stage === 'done' ? 'The notes have no summary.' : MEETING_STAGE_LABEL[r.stage]}
        </p>
      )}
      {forYou.length > 0 ? (
        <section className="eva-meeting-tab-section">
          <div className="eva-meeting-tab-label">For you</div>
          {forYou.map((m) => (
            <div key={m.id} className="eva-meeting-recap-you" data-testid="meeting-for-you">
              {m.text}
              <small>
                {m.speaker} asked at {meetingClock(m.atMs)}, no reply yet
              </small>
            </div>
          ))}
        </section>
      ) : null}
      {actions.length > 0 ? (
        <section className="eva-meeting-tab-section">
          <div className="eva-meeting-tab-label">Actions</div>
          {actions.map((m) => (
            <div key={m.id} className="eva-meeting-recap-item">
              <span>{m.text}</span>
              <span className="eva-meeting-recap-who">{m.speaker}</span>
            </div>
          ))}
        </section>
      ) : null}
      {decided.length > 0 ? (
        <section className="eva-meeting-tab-section">
          <div className="eva-meeting-tab-label">Decided</div>
          {decided.map((d, i) => (
            <div key={i} className="eva-meeting-recap-item">
              {d}
            </div>
          ))}
        </section>
      ) : null}
      {strip}
      {r.stage === 'done' ? (
        <button
          type="button"
          className="eva-meeting-tab-link"
          onClick={() => navigateTo(placeOf('meetings', { meeting: id }))}
        >
          Open notes
        </button>
      ) : null}
    </div>
  )

  const transcriptView = (
    <div data-testid="meeting-transcript">
      {rows.map((row) => (
        <div
          key={row.id}
          className="eva-meeting-row"
          data-testid="meeting-row"
          data-row-id={row.id}
          data-draft={row.draft}
          data-lit={lit?.row === row.id}
        >
          <span className="eva-meeting-tab-stamp">{momentStamp(row.startMs)}</span>
          <div>
            <div
              className="eva-meeting-row-who"
              data-you={row.track === 'mic' || youRows.has(row.id)}
            >
              {who(row)}
            </div>
            <div className="eva-meeting-row-text">{row.text}</div>
          </div>
        </div>
      ))}
    </div>
  )

  const tabs: Array<[View, string, string]> = [
    ['lead', live ? 'now' : 'summary', live ? 'Now' : 'Summary'],
    ['transcript', 'transcript', 'Transcript'],
    ['moments', 'moments', 'Moments'],
  ]

  return (
    <div className="eva-meeting-tab" data-testid="meeting-tab" data-live={live}>
      <header className="eva-meeting-tab-head">
        <h2 className="eva-meeting-tab-title">{title}</h2>
        <div className="eva-meeting-tab-meta">
          <span>{r.app}</span>
          {live ? (
            <>
              <span>·</span>
              <span className="eva-meeting-tab-live">Live</span>
            </>
          ) : null}
          <span>·</span>
          <span data-testid="meeting-tab-when" title={`Started ${clockLabel(r.startedAt, now)}`}>
            {meetingWhen(r, live, now)}
          </span>
          {live && r.stage === 'recording' ? (
            <button
              type="button"
              className="eva-meeting-tab-end"
              data-testid="meeting-end"
              disabled={ending}
              onClick={() => void end()}
            >
              End meeting
            </button>
          ) : null}
        </div>
      </header>
      <div className="eva-meeting-tabs" role="tablist" data-testid="meeting-tabs">
        {tabs.map(([v, key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === v}
            className="eva-meeting-tabs-tab"
            data-testid={`meeting-tab-${key}`}
            onClick={() => show(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="eva-meeting-tab-body">
        <div
          ref={scroller}
          className="eva-meeting-tab-view"
          data-testid="meeting-tab-view"
          data-view={tab}
          onScroll={(e) => {
            if (tab !== 'transcript') return
            if (quiet.current) {
              quiet.current = false
              return
            }
            const bottom = nearBottom(e.currentTarget)
            if (bottom !== follow) setFollow(bottom)
          }}
        >
          {tab === 'transcript' ? (
            transcriptView
          ) : tab === 'moments' ? (
            moments.length === 0 ? (
              <p className="eva-meeting-tab-label">Nothing yet.</p>
            ) : (
              moments.slice().reverse().map(moment)
            )
          ) : live ? (
            nowView
          ) : (
            summaryView
          )}
        </div>
        {live && tab === 'transcript' && !follow ? (
          <button
            type="button"
            className="eva-meeting-jump"
            data-testid="meeting-jump-live"
            onClick={() => setFollow(true)}
          >
            Jump to live
          </button>
        ) : null}
      </div>
      {owner !== null ? (
        <div className="eva-meeting-ask">
          <EvaMenu opened={menu} onChange={setMenu} position="top-start" width={220}>
            <EvaMenu.Target>
              <button type="button" className="eva-meeting-ask-open" data-testid="meeting-ask">
                Ask {owner.title}…
              </button>
            </EvaMenu.Target>
            <EvaMenu.Dropdown data-testid="meeting-ask-menu">
              {MEETING_ASKS.map((a) => (
                <EvaMenu.Item
                  key={a.label}
                  data-testid="meeting-ask-item"
                  disabled={asking}
                  onClick={() => void ask(a.text)}
                >
                  {a.label}
                </EvaMenu.Item>
              ))}
            </EvaMenu.Dropdown>
          </EvaMenu>
        </div>
      ) : null}
      <ShotView
        shot={opened === null ? null : (shots.find((s) => s.n === opened) ?? null)}
        onClose={() => setOpened(null)}
      />
    </div>
  )
}

/** The shared screen's snapshots as small thumbnails, oldest first, kept scrolled to the newest. */
function ShotStrip({
  shots,
  onOpen,
}: {
  shots: readonly MeetingShot[]
  onOpen: (n: number) => void
}) {
  const strip = useRef<HTMLDivElement>(null)
  const newest = shots[shots.length - 1]?.n
  useLayoutEffect(() => {
    const el = strip.current
    if (el !== null) el.scrollLeft = el.scrollWidth
  }, [newest])
  return (
    <div ref={strip} className="eva-meeting-shots" data-testid="meeting-shots">
      {shots.map((s) => (
        <button
          key={s.n}
          type="button"
          className="eva-meeting-shot"
          data-testid="meeting-shot"
          data-n={s.n}
          aria-label={`Screen at ${meetingClock(s.atMs)}`}
          onClick={() => onOpen(s.n)}
        >
          <img src={mediaUrl(s.src)} alt="" loading="lazy" draggable={false} />
          <span className="eva-meeting-tab-stamp">{meetingClock(s.atMs)}</span>
        </button>
      ))}
    </div>
  )
}

/** One snapshot larger: the image, when it was, what was being said, the text on it. */
function ShotView({ shot, onClose }: { shot: MeetingShot | null; onClose: () => void }) {
  return (
    <EvaModal
      opened={shot !== null}
      onClose={onClose}
      title={shot === null ? null : `Shared screen at ${meetingClock(shot.atMs)}`}
      size={760}
      testid="meeting-shot-view"
    >
      {shot === null ? null : (
        <div className="eva-meeting-shot-view">
          <img
            src={mediaUrl(shot.src)}
            alt=""
            width={shot.w}
            height={shot.h}
            data-testid="meeting-shot-image"
          />
          {shot.line !== '' ? <p className="eva-meeting-shot-line">{shot.line}</p> : null}
          {shot.ocr !== '' ? (
            <div className="eva-meeting-shot-ocr" data-testid="meeting-shot-ocr">
              {shot.ocr}
            </div>
          ) : null}
        </div>
      )}
    </EvaModal>
  )
}

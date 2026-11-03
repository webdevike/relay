import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button, Progress, Textarea } from '@mantine/core'
import { IconLock, IconPhoto, IconPlayerSkipForward } from '@tabler/icons-react'
import { formatCountdown, pickItems } from '@evaos/eva-core/model/gate'
import { invoke } from '../ipc'
import { setChordLock } from '../hotkeys/router'
import { useOccludeBrowser } from '../overlay/overlay-store'
import { runHabit, useHabits } from './habit-store'
import './gate-overlay.css'

const MIN_REASON = 3
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), [tabindex="0"]'

const allowQuitOnly = (chord: string): boolean => chord === 'cmd+q'

function parseMs(text: string): number | null {
  const t = Date.parse(text)
  return Number.isNaN(t) ? null : t
}

function Gate() {
  const status = useHabits((s) => s.status)
  const busy = useHabits((s) => s.busy)
  const headingId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [photo, setPhoto] = useState<{ token: string; name: string } | null>(null)
  const [overriding, setOverriding] = useState(false)
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  useOccludeBrowser(true)
  useEffect(() => {
    setChordLock(allowQuitOnly)
    return () => setChordLock(null)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const active = status?.active ?? null
  const activeId = active?.id ?? ''
  useEffect(() => {
    setPhoto(null)
    setFailure(null)
  }, [activeId])

  // Initial focus on the primary action, again when the view changes.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const target =
      root.querySelector<HTMLElement>('[data-testid=gate-start]') ??
      root.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
  }, [active === null])

  const items = pickItems(status?.habits ?? [], status?.tasks ?? [])
  const sel = Math.min(selected, Math.max(0, items.length - 1))
  const habit = active ? status?.habits.find((h) => h.id === active.id) : undefined
  const needsPhoto = habit?.photo === true

  const endMs = active ? parseMs(active.endsAt) : null
  const startMs = active ? parseMs(active.startedAt) : null
  const remaining =
    endMs !== null ? Math.max(0, Math.ceil((endMs - now) / 1000)) : (status?.remainingSeconds ?? 0)
  const total = endMs !== null && startMs !== null ? Math.max(1, (endMs - startMs) / 1000) : 0
  const progress = total > 0 ? Math.min(100, Math.max(0, ((total - remaining) / total) * 100)) : 0
  const ended = remaining <= 0
  const doneReady = ended && (!needsPhoto || photo !== null)

  const act = async (action: Parameters<typeof runHabit>[0]): Promise<void> => {
    setFailure(null)
    const r = await runHabit(action)
    if (!r.ok) {
      setFailure(r.message)
      // The main side no longer knows this photo: make the user choose again.
      if (r.code === 'invalid-input') setPhoto(null)
    } else setOverriding(false)
  }

  const choosePhoto = async (): Promise<void> => {
    let r
    try {
      r = await invoke('habit.choosePhoto', {})
    } catch {
      r = null
    }
    if (r?.ok && r.value.token !== null) {
      setPhoto({ token: r.value.token, name: r.value.name ?? 'photo' })
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (nodes.length === 0) {
      e.preventDefault()
      return
    }
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || !rootRef.current?.contains(cur))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (cur === last || !rootRef.current?.contains(cur))) {
      e.preventDefault()
      first.focus()
    }
  }

  const onPickKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (items.length === 0) return
    let next = sel
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (sel + 1) % items.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = (sel - 1 + items.length) % items.length
    else return
    e.preventDefault()
    setSelected(next)
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-testid=gate-pick-${items[next]!.id}]`)
      ?.focus()
  }

  const reasonTrim = reason.trim()
  const reasonValid = reasonTrim.length >= MIN_REASON

  return (
    <div className="eva-gate" data-testid="gate-overlay">
      <div
        ref={rootRef}
        className="eva-gate-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
      >
        <IconLock size={28} aria-hidden />
        <h2 id={headingId} className="eva-gate-heading">
          Time for a break
        </h2>
        <p className="eva-gate-body">Eva&apos;s AI tools are locked until you finish a habit.</p>

        {active ? (
          <div className="eva-gate-timer">
            <div className="eva-gate-countdown" data-testid="gate-countdown">
              {formatCountdown(remaining)}
            </div>
            <Progress value={progress} size={4} aria-label="Break progress" />
            <p className="eva-gate-line" data-ended={ended}>
              {ended
                ? "Time's up. Mark break done to unlock."
                : 'Go do it. Mark break done unlocks when the timer ends.'}
            </p>
            {needsPhoto && (
              <div className="eva-gate-photo">
                <Button
                  variant="default"
                  leftSection={<IconPhoto size={16} />}
                  data-testid="gate-photo"
                  disabled={busy}
                  onClick={() => void choosePhoto()}
                >
                  {photo ? 'Change photo' : 'Choose photo'}
                </Button>
                {photo && (
                  <span className="eva-gate-chip" data-testid="gate-photo-name">
                    {photo.name}
                  </span>
                )}
              </div>
            )}
            {failure !== null && <GateError message={failure} />}
            <Button
              data-testid="gate-done"
              disabled={!doneReady || busy}
              onClick={() =>
                void act({ action: 'done', id: active.id, photoToken: photo?.token ?? null })
              }
            >
              Mark break done
            </Button>
            {needsPhoto && !photo && <p className="eva-gate-help">Photo proof required</p>}
          </div>
        ) : (
          <div className="eva-gate-pick">
            <div role="radiogroup" aria-label="Choose a break" className="eva-gate-list">
              {items.map((it, i) => (
                <button
                  key={`${it.kind}-${it.id}`}
                  type="button"
                  role="radio"
                  aria-checked={i === sel}
                  tabIndex={i === sel ? 0 : -1}
                  className="eva-gate-row"
                  data-testid={`gate-pick-${it.id}`}
                  onClick={() => setSelected(i)}
                  onKeyDown={onPickKey}
                >
                  <span className="eva-gate-row-name">{it.name}</span>
                  <span className="eva-gate-row-meta">{it.meta}</span>
                  {it.kind === 'habit' && (
                    <span className="eva-gate-chip">{it.photo ? 'Photo' : 'Honor'}</span>
                  )}
                </button>
              ))}
            </div>
            {failure !== null && <GateError message={failure} />}
            <Button
              data-testid="gate-start"
              disabled={items.length === 0 || busy}
              onClick={() => {
                const it = items[sel]
                if (it) void act({ action: 'start', id: it.id })
              }}
            >
              Start break
            </Button>
          </div>
        )}

        {overriding ? (
          <div className="eva-gate-override">
            <Textarea
              label="Why skip this break?"
              placeholder="Why skip this break?"
              data-testid="gate-override-reason"
              value={reason}
              autosize
              minRows={2}
              onChange={(e) => setReason(e.currentTarget.value)}
              error={reason !== '' && !reasonValid ? 'Give a reason to override.' : undefined}
            />
            <div className="eva-gate-actions">
              <Button
                variant="default"
                onClick={() => {
                  setOverriding(false)
                  setReason('')
                }}
              >
                Keep gate locked
              </Button>
              <Button
                color="red"
                data-testid="gate-override-submit"
                disabled={!reasonValid || busy}
                onClick={() => void act({ action: 'override', reason: reasonTrim })}
              >
                Override gate
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconPlayerSkipForward size={16} />}
            data-testid="gate-override"
            disabled={busy}
            onClick={() => setOverriding(true)}
          >
            Override
          </Button>
        )}
      </div>
    </div>
  )
}

function GateError({ message }: { message: string }) {
  return (
    <div role="alert" className="eva-gate-error">
      {`Could not update the gate. The habit gate said: ${message}. Try again.`}
    </div>
  )
}

/** Mounted once at the shell root; a locked gate turns the app into a break screen. */
export function GateOverlay() {
  const locked = useHabits((s) => s.status?.locked === true)
  return locked ? <Gate /> : null
}

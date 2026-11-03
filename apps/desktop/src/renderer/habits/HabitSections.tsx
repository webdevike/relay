import { useState } from 'react'
import { ActionIcon, Button, TextInput, Tooltip } from '@mantine/core'
import {
  IconActivity,
  IconCircleCheck,
  IconClock,
  IconListCheck,
  IconPhoto,
  IconX,
} from '@tabler/icons-react'
import type { GateHistory } from '@evaos/eva-core/model/gate'
import { MAX_MINUTES, historyRows, streak, todaysBreaks } from '@evaos/eva-core/model/gate'
import { localDate } from '@evaos/eva-core/model/dates'
import type { GateStatus } from '@evaos/contract'
import { invoke } from '../ipc'
import { runHabit } from './habit-store'

export const MINUTES_ERROR = `Minutes must be a whole number from 1 to ${MAX_MINUTES}.`

export function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Earlier'
  const day = localDate(d)
  if (day === localDate(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (day === localDate(y)) return 'Yesterday'
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export function parseMinutes(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= MAX_MINUTES ? n : null
}

function Section({
  icon,
  title,
  testid,
  children,
}: {
  icon: React.ReactNode
  title: string
  testid?: string
  children: React.ReactNode
}) {
  return (
    <section className="eva-habits-section" data-testid={testid}>
      <h2 className="eva-habits-h2">
        {icon}
        {title}
      </h2>
      <div className="eva-habits-card">{children}</div>
    </section>
  )
}

export function HabitsTable({
  status,
  now,
  onOpen,
}: {
  status: GateStatus
  now: Date
  onOpen: (id: string) => void
}) {
  const today = localDate(now)
  return (
    <Section icon={<IconActivity size={18} />} title="Habits" testid="habits-section">
      {status.habits.length === 0 ? (
        <p className="eva-habits-empty">
          No habits yet. Add one to have something to pick at a break.
        </p>
      ) : (
        <>
          <div className="eva-habits-grid eva-habits-header" role="presentation">
            <span>Habit</span>
            <span>Minutes</span>
            <span>Proof</span>
            <span>Streak</span>
          </div>
          {status.habits.map((h) => {
            const n = streak(status.history as GateHistory[], h.id, today)
            return (
              <div
                key={h.id}
                role="button"
                tabIndex={0}
                className="eva-habits-grid eva-habits-row"
                data-testid={`habit-row-${h.id}`}
                onClick={() => onOpen(h.id)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    onOpen(h.id)
                  }
                }}
              >
                <span className="eva-habits-name">{h.name}</span>
                <span>{h.minutes}</span>
                <span>
                  <span className="eva-habits-chip">{h.photo ? 'Photo' : 'Honor'}</span>
                </span>
                <span className={n === 0 ? 'eva-habits-dim' : undefined}>
                  {n === 0 ? 'None yet' : `${n} ${n === 1 ? 'day' : 'days'}`}
                </span>
              </div>
            )
          })}
        </>
      )}
    </Section>
  )
}

export function TasksSection({ status }: { status: GateStatus }) {
  const [name, setName] = useState('')
  const [minutes, setMinutes] = useState('')
  const [errors, setErrors] = useState<{ name?: string; minutes?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const open = status.tasks.filter((t) => !t.done)

  const add = async (): Promise<void> => {
    const e: { name?: string; minutes?: string } = {}
    if (name.trim() === '') e.name = 'Say what the task is.'
    const m = minutes.trim() === '' ? null : parseMinutes(minutes)
    if (minutes.trim() !== '' && m === null) e.minutes = MINUTES_ERROR
    setErrors(e)
    if (e.name || e.minutes) return
    const r = await runHabit({ action: 'task-add', name: name.trim(), minutes: m })
    if (r.ok) {
      setName('')
      setMinutes('')
      setFailure(null)
    } else {
      setFailure(r.message)
    }
  }
  const remove = async (id: string): Promise<void> => {
    const r = await runHabit({ action: 'task-rm', id })
    setFailure(r.ok ? null : r.message)
  }

  return (
    <Section icon={<IconListCheck size={18} />} title="One-time tasks" testid="tasks-section">
      <form
        className="eva-habits-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <TextInput
          placeholder="Something you keep putting off"
          aria-label="Task"
          data-testid="task-name"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <TextInput
          placeholder="Minutes (optional)"
          aria-label="Task minutes"
          data-testid="task-minutes"
          value={minutes}
          error={errors.minutes}
          onChange={(e) => setMinutes(e.currentTarget.value)}
          style={{ width: 160 }}
        />
        <Button type="submit" variant="default" data-testid="task-add">
          Add task
        </Button>
      </form>
      {failure ? (
        <p className="eva-habits-alert" role="alert" data-testid="task-error">
          {`Could not change the task. The habit gate said: ${failure}. Try again.`}
        </p>
      ) : null}
      {open.length === 0 ? (
        <p className="eva-habits-empty">No open tasks.</p>
      ) : (
        open.map((t) => (
          <div key={t.id} className="eva-habits-task" data-testid={`task-row-${t.id}`}>
            <span className="eva-habits-name">{t.name}</span>
            <span className="eva-habits-dim">{t.minutes === null ? '' : `${t.minutes} min`}</span>
            <Tooltip label="Remove task" openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Remove task"
                data-testid={`task-remove-${t.id}`}
                onClick={() => void remove(t.id)}
              >
                <IconX size={16} />
              </ActionIcon>
            </Tooltip>
          </div>
        ))
      )}
    </Section>
  )
}

const BREAK_LABEL = { done: 'Done', due: 'Due', upcoming: 'Upcoming' } as const

export function BreaksToday({ status, now }: { status: GateStatus; now: Date }) {
  const rows = todaysBreaks(status.plan, now)
  return (
    <Section icon={<IconClock size={18} />} title="Today's breaks" testid="breaks-today">
      {rows.length === 0 ? (
        <p className="eva-habits-empty">No breaks planned for today yet.</p>
      ) : (
        rows.map((b, i) => (
          <div
            key={`${b.at}-${i}`}
            className="eva-habits-line"
            data-testid={`break-${i}`}
            data-state={b.state}
          >
            <span className="eva-habits-state" data-state={b.state}>
              {b.state === 'done' ? <IconCircleCheck size={16} /> : <IconClock size={16} />}
              {BREAK_LABEL[b.state]}
            </span>
            <span>{timeLabel(b.at)}</span>
          </div>
        ))
      )}
    </Section>
  )
}

export function HistorySection({ status, now }: { status: GateStatus; now: Date }) {
  const rows = historyRows(status.history as GateHistory[])
  const groups: Array<{ label: string; items: typeof rows }> = []
  for (const r of rows) {
    const label = dayLabel(r.entry.doneAt, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(r)
    else groups.push({ label, items: [r] })
  }
  const openPhoto = (path: string): void => {
    void invoke('habit.openPhoto', { path })
  }
  return (
    <Section icon={<IconClock size={18} />} title="History" testid="habit-history">
      {rows.length === 0 ? (
        <p className="eva-habits-empty">Nothing finished yet.</p>
      ) : (
        groups.map((g) => (
          <div key={g.label} data-testid={`history-day-${g.label}`}>
            <div className="eva-habits-day">{g.label}</div>
            {g.items.map((r, i) => (
              <div
                key={`${r.entry.doneAt}-${r.entry.id}-${i}`}
                className="eva-habits-line"
                data-testid="history-row"
              >
                <span className="eva-habits-name">{r.name}</span>
                {r.entry.kind === 'task' ? <span className="eva-habits-chip">Task</span> : null}
                <span className="eva-habits-dim">{timeLabel(r.entry.doneAt)}</span>
                <span className="eva-habits-dim eva-habits-grow">{r.label}</span>
                {r.entry.photo ? (
                  <Tooltip label="Open the proof photo" openDelay={300}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Open the proof photo"
                      data-testid="history-photo"
                      onClick={() => openPhoto(r.entry.photo!)}
                    >
                      <IconPhoto size={16} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </div>
            ))}
          </div>
        ))
      )}
    </Section>
  )
}

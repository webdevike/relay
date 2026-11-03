import { useState, type ReactNode } from 'react'
import { ActionIcon, Button, TextInput, Tooltip } from '@mantine/core'
import {
  IconActivity,
  IconAlertTriangle,
  IconCircleCheck,
  IconClock,
  IconListCheck,
  IconPhoto,
  IconX,
} from '@tabler/icons-react'
import type { BreakRow, GateHistory, HistoryRow } from '@evaos/eva-core/model/gate'
import { MAX_MINUTES, historyRows, streak, todaysBreaks } from '@evaos/eva-core/model/gate'
import { localDate } from '@evaos/eva-core/model/dates'
import type { GateStatus } from '@evaos/contract'
import { invoke } from '../ipc'
import { ListRow, ListStatus, ListTime, rowTip, type ListGroup } from '../ui/list'
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

/** One row of the Habits page: a habit, an open task, one of today's breaks, or a finished one. */
export type HabitItem =
  | { kind: 'habit'; habit: GateStatus['habits'][number]; streak: number }
  | { kind: 'task'; task: GateStatus['tasks'][number] }
  | { kind: 'break'; row: BreakRow; index: number }
  | { kind: 'history'; row: HistoryRow; index: number }

export function habitItemKey(item: HabitItem): string {
  switch (item.kind) {
    case 'habit':
      return `habit:${item.habit.id}`
    case 'task':
      return `task:${item.task.id}`
    case 'break':
      return `break:${item.row.at}-${item.index}`
    case 'history':
      return `history:${item.row.entry.doneAt}-${item.row.entry.id}-${item.index}`
  }
}

const BREAK_LABEL = { done: 'Done', due: 'Due', upcoming: 'Upcoming' } as const
const BREAK_TONE = { done: 'ok', due: 'warn', upcoming: 'dim' } as const

/**
 * The page's groups, in reading order: habits, open tasks (with the add form), today's breaks,
 * then what was finished, one group per day.
 */
export function habitGroups(
  status: GateStatus,
  now: Date,
  taskForm: ReactNode,
): ListGroup<HabitItem>[] {
  const today = localDate(now)
  const history = status.history as GateHistory[]
  const days: Array<{ label: string; items: HabitItem[] }> = []
  historyRows(history).forEach((row, index) => {
    const label = dayLabel(row.entry.doneAt, now)
    const last = days[days.length - 1]
    const item: HabitItem = { kind: 'history', row, index }
    if (last && last.label === label) last.items.push(item)
    else days.push({ label, items: [item] })
  })
  const groups: ListGroup<HabitItem>[] = [
    {
      id: 'habits',
      label: 'Habits',
      testid: 'habits-section',
      items: status.habits.map((habit) => ({
        kind: 'habit',
        habit,
        streak: streak(history, habit.id, today),
      })),
      empty: 'No habits yet. Add one to have something to pick at a break.',
    },
    {
      id: 'tasks',
      label: 'One-time tasks',
      testid: 'tasks-section',
      intro: taskForm,
      items: status.tasks.filter((t) => !t.done).map((task) => ({ kind: 'task', task })),
      empty: 'No open tasks.',
    },
    {
      id: 'breaks',
      label: "Today's breaks",
      testid: 'breaks-today',
      items: todaysBreaks(status.plan, now).map((row, index) => ({ kind: 'break', row, index })),
      empty: 'No breaks planned for today yet.',
    },
  ]
  if (days.length === 0) {
    groups.push({
      id: 'history',
      label: 'Done',
      testid: 'habit-history',
      items: [],
      empty: 'Nothing finished yet.',
    })
  } else {
    for (const d of days) {
      groups.push({
        id: `history-${d.label}`,
        label: `Done ${d.label === 'Today' || d.label === 'Yesterday' ? d.label.toLowerCase() : d.label}`,
        testid: `history-day-${d.label}`,
        items: d.items,
      })
    }
  }
  return groups
}

/** A habit, task, break or finished entry as a row of the page's list. */
export function HabitRow({
  item,
  onOpen,
  onRemoveTask,
}: {
  item: HabitItem
  onOpen: (id: string) => void
  onRemoveTask: (id: string) => void
}) {
  switch (item.kind) {
    case 'habit': {
      const { habit: h, streak: n } = item
      return (
        <ListRow
          data-testid={`habit-row-${h.id}`}
          tooltip={rowTip(h.name, `${h.minutes} min · ${h.photo ? 'Photo proof' : 'Honor system'}`)}
          leading={<IconActivity size={16} stroke={1.5} aria-hidden />}
          title={h.name}
          onActivate={() => onOpen(h.id)}
          trailing={
            <ListTime>{n === 0 ? 'None yet' : `${n} ${n === 1 ? 'day' : 'days'}`}</ListTime>
          }
        />
      )
    }
    case 'task': {
      const t = item.task
      return (
        <ListRow
          data-testid={`task-row-${t.id}`}
          tooltip={rowTip(t.name, t.minutes === null ? null : `${t.minutes} min`)}
          leading={<IconListCheck size={16} stroke={1.5} aria-hidden />}
          title={t.name}
          trailing={
            <Tooltip label="Remove task" openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Remove task"
                data-testid={`task-remove-${t.id}`}
                onClick={() => onRemoveTask(t.id)}
              >
                <IconX size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          }
        />
      )
    }
    case 'break': {
      const b = item.row
      return (
        <ListRow
          data-testid={`break-${item.index}`}
          data-state={b.state}
          dim={b.state === 'upcoming'}
          leading={<IconClock size={16} stroke={1.5} aria-hidden />}
          title={timeLabel(b.at)}
          trailing={
            <ListStatus items={[{ label: BREAK_LABEL[b.state], tone: BREAK_TONE[b.state] }]} />
          }
        />
      )
    }
    case 'history': {
      const r = item.row
      const photo = r.entry.photo
      return (
        <ListRow
          data-testid="history-row"
          tooltip={rowTip(r.name, r.label, r.entry.kind === 'task' ? 'Task' : null)}
          leading={
            r.overridden ? (
              <IconAlertTriangle size={16} stroke={1.5} aria-hidden />
            ) : (
              <IconCircleCheck size={16} stroke={1.5} aria-hidden />
            )
          }
          title={r.name}
          trailing={
            <>
              {photo ? (
                <Tooltip label="Open the proof photo" openDelay={300}>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Open the proof photo"
                    data-testid="history-photo"
                    onClick={() => void invoke('habit.openPhoto', { path: photo })}
                  >
                    <IconPhoto size={16} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              <ListTime>{timeLabel(r.entry.doneAt)}</ListTime>
            </>
          }
        />
      )
    }
  }
}

/** The add form above the open tasks, and the gate's refusal when a change fails. */
export function TaskAdd({
  failure,
  onFailure,
}: {
  failure: string | null
  onFailure: (message: string | null) => void
}) {
  const [name, setName] = useState('')
  const [minutes, setMinutes] = useState('')
  const [errors, setErrors] = useState<{ name?: string; minutes?: string }>({})

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
      onFailure(null)
    } else {
      onFailure(r.message)
    }
  }

  return (
    <>
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
    </>
  )
}

import { useEffect, useState } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconLock, IconLockOpen, IconPlus, IconRefresh } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { nextBreakAt, planSourceLabel } from '@evaos/eva-core/model/gate'
import { HabitForm, type HabitFormTarget } from './HabitForm'
import { BreaksToday, HabitsTable, HistorySection, TasksSection, timeLabel } from './HabitSections'
import { pollHabits, useHabits } from './habit-store'
import './habits.css'

export function HabitsPage(_props: { place: Place }) {
  const status = useHabits((s) => s.status)
  const error = useHabits((s) => s.error)
  const stale = useHabits((s) => s.stale)
  const [form, setForm] = useState<HabitFormTarget | null>(null)

  useEffect(() => {
    void pollHabits()
  }, [])

  const now = new Date()
  let body
  if (!status && error) {
    body = (
      <div className="eva-habits-card eva-habits-error" role="alert" data-testid="habits-error">
        <h2 className="eva-habits-h2">Could not read the habit gate</h2>
        <p className="eva-habits-dim">
          Check that .omp/tools/habit-gate.ts runs in the Eva repo, then try again.
        </p>
        <Button variant="default" data-testid="habits-retry" onClick={() => void pollHabits()}>
          Try again
        </Button>
      </div>
    )
  } else if (!status) {
    body = (
      <p className="eva-habits-dim" data-testid="habits-loading">
        Loading habits
      </p>
    )
  } else {
    const next = nextBreakAt(status.plan, now)
    body = (
      <>
        <div
          className="eva-habits-strip"
          data-testid="habit-gate-strip"
          data-locked={status.locked ? 'true' : 'false'}
        >
          {status.locked ? <IconLock size={18} /> : <IconLockOpen size={18} />}
          <span>
            {status.locked
              ? 'Locked: finish a habit to unlock AI tools.'
              : `Unlocked. ${next ? `Next break at ${timeLabel(next)}.` : 'No more breaks today.'}`}
          </span>
          {status.plan ? (
            <span className="eva-habits-chip eva-habits-source">
              {planSourceLabel(status.plan.source)}
            </span>
          ) : null}
        </div>
        {stale ? (
          <p className="eva-habits-stale" data-testid="habits-stale">
            Showing the last status. Retrying.
          </p>
        ) : null}
        <HabitsTable status={status} now={now} onOpen={(id) => setForm({ mode: 'edit', id })} />
        <TasksSection status={status} />
        <BreaksToday status={status} now={now} />
        <HistorySection status={status} now={now} />
      </>
    )
  }

  const editing =
    form?.mode === 'edit' ? (status?.habits.find((h) => h.id === form.id) ?? null) : null
  return (
    <div className="eva-habits-col" data-testid="page-habits">
      <div className="eva-habits-head">
        <h1 className="eva-habits-title">Habits</h1>
        <span className="eva-habits-spacer" />
        <Tooltip label="Refresh" openDelay={300}>
          <ActionIcon
            variant="default"
            aria-label="Refresh habits"
            data-testid="habits-refresh"
            onClick={() => void pollHabits()}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
        <Button
          leftSection={<IconPlus size={16} />}
          data-testid="habits-add"
          onClick={() => setForm({ mode: 'create' })}
        >
          Add habit
        </Button>
      </div>
      {body}
      <HabitForm target={form} habit={editing} onClose={() => setForm(null)} />
    </div>
  )
}

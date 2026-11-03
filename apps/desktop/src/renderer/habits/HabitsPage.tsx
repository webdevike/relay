import { useEffect, useState } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconPlus, IconRefresh } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import type { GateHistory } from '@evaos/eva-core/model/gate'
import { nextBreakAt, planSourceLabel, streak, todaysBreaks } from '@evaos/eva-core/model/gate'
import { localDate } from '@evaos/eva-core/model/dates'
import type { GateStatus } from '@evaos/contract'
import { ListEmpty, ListKpis, ListView, type ListKpi } from '../ui/list'
import { HabitForm, type HabitFormTarget } from './HabitForm'
import {
  HabitRow,
  TaskAdd,
  habitGroups,
  habitItemKey,
  timeLabel,
  type HabitItem,
} from './HabitSections'
import { pollHabits, runHabit, useHabits } from './habit-store'
import './habits.css'

/** The gate, the next break, today's breaks and the best streak, as option D's KPI strip. */
function gateKpis(status: GateStatus, now: Date): ListKpi[] {
  const next = nextBreakAt(status.plan, now)
  const breaks = todaysBreaks(status.plan, now)
  const today = localDate(now)
  const best = Math.max(
    0,
    ...status.habits.map((h) => streak(status.history as GateHistory[], h.id, today)),
  )
  return [
    {
      label: status.locked ? 'Finish a habit to unlock AI tools' : 'AI tools are on',
      value: status.locked ? 'Locked' : 'Unlocked',
      'data-testid': 'habit-gate',
    },
    {
      label: next ? 'Next break' : 'No more breaks today',
      value: next ? timeLabel(next) : 'None',
      'data-testid': 'habit-next-break',
    },
    {
      label: 'Breaks today',
      value: `${breaks.filter((b) => b.state === 'done').length} of ${breaks.length}`,
      pill: status.plan ? { tone: 'dim', label: planSourceLabel(status.plan.source) } : undefined,
    },
    { label: 'Best streak', value: `${best} ${best === 1 ? 'day' : 'days'}` },
  ]
}

export function HabitsPage(_props: { place: Place }) {
  const status = useHabits((s) => s.status)
  const error = useHabits((s) => s.error)
  const stale = useHabits((s) => s.stale)
  const [form, setForm] = useState<HabitFormTarget | null>(null)
  const [taskFailure, setTaskFailure] = useState<string | null>(null)

  useEffect(() => {
    void pollHabits()
  }, [])

  const removeTask = async (id: string): Promise<void> => {
    const r = await runHabit({ action: 'task-rm', id })
    setTaskFailure(r.ok ? null : r.message)
  }

  const now = new Date()
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
      <ListView<HabitItem>
        header={
          status ? (
            <>
              <ListKpis
                items={gateKpis(status, now)}
                data-testid="habit-gate-strip"
                data-locked={status.locked ? 'true' : 'false'}
              />
              {stale ? (
                <p className="eva-habits-stale" data-testid="habits-stale">
                  Showing the last status. Retrying.
                </p>
              ) : null}
            </>
          ) : null
        }
        groups={
          status
            ? habitGroups(status, now, <TaskAdd failure={taskFailure} onFailure={setTaskFailure} />)
            : []
        }
        rowKey={habitItemKey}
        renderRow={(item) => (
          <HabitRow
            key={habitItemKey(item)}
            item={item}
            onOpen={(id) => setForm({ mode: 'edit', id })}
            onRemoveTask={(id) => void removeTask(id)}
          />
        )}
        loading={!status && !error ? { label: 'Loading habits', testid: 'habits-loading' } : false}
        error={
          !status && error ? (
            <ListEmpty
              role="alert"
              data-testid="habits-error"
              icon={<IconAlertTriangle size={24} stroke={1.5} />}
              title="Could not read the habit gate"
              action={
                <Button
                  variant="default"
                  data-testid="habits-retry"
                  onClick={() => void pollHabits()}
                >
                  Try again
                </Button>
              }
            >
              Check that .omp/tools/habit-gate.ts runs in the Eva repo, then try again.
            </ListEmpty>
          ) : undefined
        }
      />
      <HabitForm target={form} habit={editing} onClose={() => setForm(null)} />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Button, Switch, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import type { GateStatus } from '@evaos/contract'
import { EvaModal } from '../overlay'
import { runHabit } from './habit-store'
import { MINUTES_ERROR, parseMinutes } from './HabitSections'

export type HabitFormTarget = { mode: 'create' } | { mode: 'edit'; id: string }

type Habit = GateStatus['habits'][number]

function Form({
  target,
  habit,
  onClose,
}: {
  target: HabitFormTarget
  habit: Habit | null
  onClose: () => void
}) {
  const [name, setName] = useState(habit?.name ?? '')
  const [minutes, setMinutes] = useState(habit ? String(habit.minutes) : '')
  const [photo, setPhoto] = useState(habit?.photo ?? false)
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) keepRef.current?.focus()
  }, [confirming])

  const nameErr = name.trim() === '' ? 'Give the habit a name.' : undefined
  const mins = parseMinutes(minutes)
  const minErr = mins === null ? MINUTES_ERROR : undefined
  const show = touched
  const title = habit?.name ?? 'this habit'

  const save = async (): Promise<void> => {
    setTouched(true)
    if (nameErr || mins === null || pending) return
    setPending(true)
    const n = name.trim()
    const r =
      target.mode === 'create'
        ? await runHabit({ action: 'habit-add', name: n, minutes: mins, photo })
        : await runHabit({ action: 'habit-edit', id: target.id, name: n, minutes: mins, photo })
    setPending(false)
    if (r.ok) {
      notifications.show({ color: 'green', message: `Saved ${n}.`, autoClose: 4000 })
      onClose()
    } else {
      setFailure(r.message)
    }
  }
  const remove = async (): Promise<void> => {
    if (target.mode !== 'edit') return
    const r = await runHabit({ action: 'habit-rm', id: target.id })
    if (r.ok) {
      notifications.show({ color: 'green', message: `Removed ${title}.`, autoClose: 4000 })
      onClose()
    } else {
      setConfirming(false)
      setFailure(r.message)
    }
  }

  return (
    <div
      className="eva-habit-form"
      data-testid="habit-form-body"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.metaKey) {
          e.preventDefault()
          void save()
        }
      }}
    >
      <TextInput
        label="Name"
        placeholder="Stretch"
        data-autofocus
        data-testid="habit-name"
        value={name}
        error={show ? nameErr : undefined}
        onChange={(e) => {
          setFailure(null)
          setName(e.currentTarget.value)
        }}
      />
      <TextInput
        label="Minutes"
        placeholder="10"
        data-testid="habit-minutes"
        value={minutes}
        error={show ? minErr : undefined}
        onChange={(e) => {
          setFailure(null)
          setMinutes(e.currentTarget.value)
        }}
      />
      <div className="eva-habit-switch">
        <Text size="sm" fw={500} id="habit-photo-label">
          Photo proof
        </Text>
        <Switch
          aria-labelledby="habit-photo-label"
          label="Ask for a photo when this break is done"
          data-testid="habit-photo"
          checked={photo}
          onChange={(e) => setPhoto(e.currentTarget.checked)}
        />
      </div>
      {failure ? (
        <p className="eva-habits-alert" role="alert" data-testid="habit-form-error">
          {`Could not save the habit change. The habit gate said: ${failure}. Fix it and try again.`}
        </p>
      ) : null}
      {confirming ? (
        <div className="eva-habit-confirm" data-testid="habit-remove-panel">
          <Text fw={600}>{`Remove ${title}? Its history stays.`}</Text>
          <div className="eva-habit-footer">
            <Button
              variant="default"
              ref={keepRef}
              data-testid="habit-remove-keep"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
            <Button color="red" data-testid="habit-remove-confirm" onClick={() => void remove()}>
              Remove habit
            </Button>
          </div>
        </div>
      ) : (
        <div className="eva-habit-footer">
          {target.mode === 'edit' ? (
            <Button
              variant="outline"
              color="red"
              data-testid="habit-remove"
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          ) : (
            <span />
          )}
          <span className="eva-habit-footer-right">
            <Button variant="default" data-testid="habit-discard" onClick={onClose}>
              Discard changes
            </Button>
            <Button data-testid="habit-save" disabled={pending} onClick={() => void save()}>
              {target.mode === 'create' ? 'Add habit' : 'Save habit'}
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}

export function HabitForm({
  target,
  habit,
  onClose,
}: {
  target: HabitFormTarget | null
  habit: Habit | null
  onClose: () => void
}) {
  if (!target) return null
  return (
    <EvaModal
      opened
      onClose={onClose}
      size={480}
      testid="habit-form"
      title={target.mode === 'create' ? 'New habit' : (habit?.name ?? 'Habit')}
    >
      <Form
        key={target.mode === 'edit' ? target.id : 'new'}
        target={target}
        habit={habit}
        onClose={onClose}
      />
    </EvaModal>
  )
}

// One tested argv builder per habit-gate subcommand. Pure, no fs.
import { MAX_MINUTES } from './gate'

export type GateAction =
  | { action: 'status' }
  | { action: 'start'; id: string }
  | { action: 'done'; id: string; photo: string | null }
  | { action: 'override'; reason: string }
  | { action: 'habit-add'; name: string; minutes: number; photo: boolean }
  | { action: 'habit-edit'; id: string; name: string; minutes: number; photo: boolean }
  | { action: 'habit-rm'; id: string }
  | { action: 'task-add'; name: string; minutes: number | null }
  | { action: 'task-rm'; id: string }

export class GateArgError extends Error {
  readonly code = 'invalid-input'
  constructor(message: string) {
    super(message)
    this.name = 'GateArgError'
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const MAX_TEXT = 200

function text(label: string, value: string): string {
  const t = value.trim()
  if (t === '') throw new GateArgError(`${label} can't be empty.`)
  if (t.startsWith('-')) throw new GateArgError(`${label} can't start with a dash.`)
  if (t.includes('\0')) throw new GateArgError(`${label} has an invalid character.`)
  if (t.length > MAX_TEXT) throw new GateArgError(`${label} is too long.`)
  return t
}

function id(value: string): string {
  if (!ID_RE.test(value)) throw new GateArgError('Invalid id.')
  return value
}

function minutes(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MINUTES) {
    throw new GateArgError(`Minutes must be a whole number from 1 to ${MAX_MINUTES}.`)
  }
  return String(value)
}

function photoPath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new GateArgError('The photo path must be absolute.')
  }
  return value
}

/** argv before the trailing '--json'. */
export function gateArgs(a: GateAction): string[] {
  switch (a.action) {
    case 'status':
      return ['status']
    case 'start':
      return ['start', id(a.id)]
    case 'done':
      return a.photo === null
        ? ['done', id(a.id)]
        : ['done', id(a.id), '--photo', photoPath(a.photo)]
    case 'override':
      return ['override', text('Reason', a.reason)]
    case 'habit-add':
      return [
        'habit',
        'add',
        text('Name', a.name),
        '--minutes',
        minutes(a.minutes),
        ...(a.photo ? ['--photo'] : []),
      ]
    case 'habit-edit':
      return [
        'habit',
        'edit',
        id(a.id),
        `--name=${text('Name', a.name)}`,
        '--minutes',
        minutes(a.minutes),
        a.photo ? '--photo' : '--no-photo',
      ]
    case 'habit-rm':
      return ['habit', 'rm', id(a.id)]
    case 'task-add':
      return [
        'task',
        'add',
        text('Name', a.name),
        ...(a.minutes === null ? [] : ['--minutes', minutes(a.minutes)]),
      ]
    case 'task-rm':
      return ['task', 'rm', id(a.id)]
  }
}

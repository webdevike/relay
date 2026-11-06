import type { Control, Step } from './desktop'

/**
 * The code half of `@computer`'s safety rules (SPEC.md "Safety"); the prompt is the other half.
 * `gate` sorts one step into: fine, needs Isaac's OK first, or never.
 */
export type Verdict =
  { kind: 'ok' } | { kind: 'ask'; why: string } | { kind: 'refuse'; why: string }

const OK: Verdict = { kind: 'ok' }

/** Controls whose press commits something outside this Mac or loses data. */
const RISKY =
  /\b(send|post|reply all|delete|remove|trash|erase|discard|buy|purchase|order|checkout|check out|pay|payment|subscribe|unsubscribe|submit|publish|share|invite|accept|approve|merge|deploy|transfer|sign out|log out|empty)\b/i

/** Apps where keys land in a composer and Return sends (skill computer-use, 2026-10-27/30 incidents). */
const MESSAGING =
  /^(messages|slack|microsoft teams|teams|outlook|microsoft outlook|mail|discord|whatsapp|signal|telegram|messenger)$/i

const CHANGE_VERB =
  /\b(?:turn|enable|disable|allow|grant|revoke|deny|uncheck|untick|tick|flip|change|switch)\b/i

export const isMessagingApp = (app: string): boolean => MESSAGING.test(app.trim())

/** Chords that send or delete in most apps (Cmd+Return sends mail, Cmd+Delete trashes). */
function riskyChord(keys: readonly string[]): boolean {
  const k = keys.map((s) => s.toLowerCase())
  const cmd = k.includes('cmd') || k.includes('command')
  return cmd && k.some((s) => ['return', 'enter', 'delete', 'backspace'].includes(s))
}

/**
 * One step, judged against the control it targets (from the latest read), the app and the task.
 * - refuse: typing into a password field; a System Settings switch the task does not name with a
 *   change verb (2026-11-03, an inspect goal flipped a Relay privacy toggle).
 * - ask: risky control labels and menu items, risky chords, and any typing or keys in messaging apps.
 */
export function gate(step: Step, control: Control | undefined, app: string, task: string): Verdict {
  const label = control ? `${control.label} ${control.line}` : ''
  const role = control?.role ?? ''
  const messaging = isMessagingApp(app)
  switch (step.type) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      if (
        /^system (settings|preferences)$/i.test(app.trim()) &&
        /AX(CheckBox|Switch|ToggleButton)/.test(role)
      ) {
        const name = (control?.label ?? '').toLowerCase()
        if (!(CHANGE_VERB.test(task) && name !== '' && task.toLowerCase().includes(name))) {
          return {
            kind: 'refuse',
            why: `the task does not say to change “${control?.label ?? 'this switch'}”`,
          }
        }
      }
      const m = RISKY.exec(label)
      return m
        ? { kind: 'ask', why: `${step.type.replace('_', ' ')} “${control?.label || m[0]}”` }
        : OK
    }
    case 'type':
    case 'set_value':
      if (/AXSecureTextField/.test(role) || /secure|password/i.test(label)) {
        return { kind: 'refuse', why: 'it is a password field; I never type secrets' }
      }
      return messaging ? { kind: 'ask', why: `type into ${app}` } : OK
    case 'key':
      if (messaging) return { kind: 'ask', why: `press ${step.key ?? 'a key'} in ${app}` }
      return riskyChord([...(step.modifiers ?? []), step.key ?? ''])
        ? { kind: 'ask', why: `press ${[...(step.modifiers ?? []), step.key].join('+')}` }
        : OK
    case 'hotkey':
      if (messaging) return { kind: 'ask', why: `press ${(step.keys ?? []).join('+')} in ${app}` }
      return riskyChord(step.keys ?? [])
        ? { kind: 'ask', why: `press ${(step.keys ?? []).join('+')}` }
        : OK
    case 'menu': {
      const item = (step.path ?? []).at(-1) ?? ''
      return RISKY.test(item) ? { kind: 'ask', why: `choose ${(step.path ?? []).join(' > ')}` } : OK
    }
    case 'scroll':
    case 'wait':
      return OK
  }
}

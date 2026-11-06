/** How an `@computer` run shows itself (SPEC.md): in the background, with a live cursor, or as a walkthrough. */
export type ComputerMode = 'headless' | 'live' | 'walk'

export type ComputerCommand =
  | { kind: 'run'; mode: ComputerMode; task: string }
  | { kind: 'control'; op: 'stop' | 'next' | 'skip' }
  | { kind: 'help' }

const HEAD = /^\s*@computer(?![\w-])[\s,:]*/i

/**
 * `@computer [live|walk] <task>` at the very start of a message, or `@computer stop|next|skip|help`.
 * Null for anything else: the message goes to the chat's agent as usual. The mode keyword must be the
 * first word (`@computer liven up the doc` is a headless task; `background` says headless outright, which
 * the composer's chip uses so a task that starts with "live" stays headless); `walk me through X` keeps only `X`.
 */
export function parseComputer(text: string): ComputerCommand | null {
  const head = HEAD.exec(text)
  if (!head) return null
  const rest = text.slice(head[0].length).trim()
  if (rest === '' || /^help[.!?]?$/i.test(rest)) return { kind: 'help' }
  const control = /^(stop|next|skip)[.!]?$/i.exec(rest)
  if (control) return { kind: 'control', op: control[1]!.toLowerCase() as 'stop' | 'next' | 'skip' }
  const mode = /^(live|walk|background)\b[\s,:]*/i.exec(rest)
  if (!mode) return { kind: 'run', mode: 'headless', task: rest }
  const kw = mode[1]!.toLowerCase() as 'live' | 'walk' | 'background'
  let task = rest.slice(mode[0].length).trim()
  if (kw === 'walk') task = task.replace(/^(?:me\s+)?through\b[\s,:]*/i, '').trim()
  if (task === '') return { kind: 'help' }
  return { kind: 'run', mode: kw === 'background' ? 'headless' : kw, task }
}

export const HELP_TEXT = [
  '**@computer** drives this Mac for you.',
  '',
  '- `@computer <task>`: in the background, without touching your mouse or the app in front.',
  '- `@computer live <task>`: the same, with my cursor clicking where you can watch.',
  '- `@computer walk <task>`: I point at each step and say it; you do it and I move on when the app shows it done.',
  '- `@computer stop` ends a run; `next` and `skip` move a walkthrough on.',
  '',
  'I ask you here before anything that sends, deletes, buys or submits. Say "screenshot" for pictures.',
].join('\n')

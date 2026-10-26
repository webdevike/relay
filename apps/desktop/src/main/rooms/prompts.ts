import {
  ROOM_ISAAC,
  ROOM_JUDGE,
  ROOM_SYSTEM,
  type Room,
  type RoomAgent,
  type RoomMessage,
} from '@evaos/contract'

/** Replies are Slack-short; anything longer is cut at a sentence boundary when one is near. */
export const REPLY_MAX = 400

export const firstName = (name: string): string => name.split(' ')[0] ?? name

/** What the room calls an author in transcript lines. */
export function authorName(room: Room, id: string): string {
  if (id === ROOM_ISAAC) return 'Isaac'
  if (id === ROOM_JUDGE) return 'Judge'
  if (id === ROOM_SYSTEM) return 'Room'
  const a = room.agents.find((x) => x.id === id)
  return a ? firstName(a.name) : id
}

const ROOM_RULES = `Room rules:
- This is a Slack thread, not an essay. Reply in 1 to 3 sentences, never more than ${REPLY_MAX} characters. Emoji and light markdown are fine.
- Address people by first name. Disagree when you disagree; say why in one line.
- Do not repeat what was already said. If you have nothing new to add, reply with the single word PASS and nothing else.
- To react to a message, put lines of the form \`react: <msgId> <emoji>\` before your text (for example \`react: m12 👍\`). React only to messages you have actually seen.
- When the room is wrapping up, state your final position in one line. You may reply AGREE alone to signal you are done.
- Isaac is the lead engineer and the person who asked; when he posts, treat it as the most important message in the delta.
- Messages are shown to you as \`[m12] Mara: text\`. Never prefix your own reply with your name or an id.`

/** The system prompt a persona process starts with. */
export function personaPrompt(agent: RoomAgent, others: readonly RoomAgent[]): string {
  const peers = others
    .filter((a) => a.id !== agent.id)
    .map((a) => `- ${a.name}, ${a.title} (${a.role})`)
    .join('\n')
  return `You are ${agent.name}, ${agent.title}. In this room you are the ${agent.role}.

${agent.brief}

You are in a room with Isaac (Lead Software Engineer, the person who asked the question) and:
${peers}

${ROOM_RULES}`
}

export const JUDGE_PROMPT = `You judge whether a short team discussion has converged on a decision.
You will get the question, the transcript (messages as [m12] Name: text), reaction counts, elapsed time and whether the soft time limit has passed.
Converged means: the group has a clear answer to the question and no open objection is still being argued. Replies of PASS or AGREE and matching reactions are agreement signals.
Once the soft limit has passed, push for closure: if the positions are known and only restating remains, call it converged.
Answer with JSON only, on one line: {"verdict":"continue"|"converged","note":"one sentence on where the room stands"}`

export const NUDGE_TEXT = 'Anyone want to push back or are we done?'

/** `[m12] Mara: text` lines for a slice of the transcript. */
export function transcriptLines(room: Room, messages: readonly RoomMessage[]): string {
  return messages
    .map((m) => {
      const re =
        m.reactions.length > 0
          ? `  (${m.reactions.map((r) => `${r.emoji} ${r.by.map((b) => authorName(room, b)).join(', ')}`).join('; ')})`
          : ''
      return `[${m.id}] ${authorName(room, m.author)}: ${m.text}${re}`
    })
    .join('\n')
}

/** The first turn: the question and whatever is already on the thread. */
export function openingPrompt(room: Room): string {
  const so =
    room.messages.length > 0 ? `\n\nThread so far:\n${transcriptLines(room, room.messages)}` : ''
  return `Isaac asked the room:\n${room.prompt}${so}\n\nYour reply (or PASS):`
}

/** A later turn: only what this agent has not seen. */
export function deltaPrompt(room: Room, delta: readonly RoomMessage[], wrapping: boolean): string {
  const head = wrapping ? '(wrapping up: state your final position in one line)\n\n' : ''
  return `${head}New messages:\n${transcriptLines(room, delta)}\n\nYour reply (or PASS):`
}

export function judgePrompt(room: Room, elapsedMs: number, softPassed: boolean): string {
  const reactions = room.messages.reduce(
    (n, m) => n + m.reactions.reduce((k, r) => k + r.by.length, 0),
    0,
  )
  return `Question: ${room.prompt}

Transcript:
${transcriptLines(room, room.messages)}

Reactions in total: ${reactions}
Rounds: ${room.rounds}
Elapsed: ${Math.round(elapsedMs / 1000)} s
Soft limit passed: ${softPassed ? 'yes' : 'no'}

JSON verdict:`
}

export function summaryPrompt(room: Room, forced: boolean): string {
  const why = forced
    ? ' The room ran out of time, so summarize what exists; do not invent agreement.'
    : ''
  return `Write the pinned summary that closes this room.${why} Use exactly this markdown shape, plain and fair, no preamble:

**Decision**
<one or two sentences>

**Dissent**
<who still disagrees and why, or "None">

**Next steps**
- <owner>: <step>

Question: ${room.prompt}

Transcript:
${transcriptLines(room, room.messages)}`
}

export interface ParsedReply {
  pass: boolean
  reactions: { messageId: string; emoji: string }[]
  text: string
}

const REACT_LINE = /^\s*react:\s*(\S+)\s+(\S+)\s*$/i
/** `react: m12 👍` lines come first; the rest is the reply. PASS alone means nothing to add. */
export function parseReply(raw: string): ParsedReply {
  const reactions: ParsedReply['reactions'] = []
  const rest: string[] = []
  let inText = false
  for (const line of raw.split('\n')) {
    const m = inText ? null : REACT_LINE.exec(line)
    if (m) {
      reactions.push({ messageId: m[1]!, emoji: m[2]! })
      continue
    }
    if (line.trim() !== '' || inText) {
      inText = true
      rest.push(line)
    }
  }
  const text = trimReply(rest.join('\n').trim())
  const pass = /^\**\s*pass\s*\**[.!]?$/i.test(text)
  return { pass, reactions, text: pass ? '' : text }
}

/** Cuts at REPLY_MAX, at the last sentence end past the halfway mark when there is one. */
export function trimReply(text: string): string {
  if (text.length <= REPLY_MAX) return text
  const head = text.slice(0, REPLY_MAX)
  let cut = -1
  for (const re of [/[.!?]["')\]]?\s/g]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(head)) !== null) cut = m.index + m[0].length - 1
  }
  if (cut >= REPLY_MAX / 2) return head.slice(0, cut).trimEnd()
  const space = head.lastIndexOf(' ')
  return `${(space > REPLY_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

export interface JudgeVerdict {
  verdict: 'continue' | 'converged'
  note: string
}

/** The judge's JSON, found anywhere in the reply; anything unreadable counts as continue. */
export function parseVerdict(raw: string): JudgeVerdict {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (m) {
    try {
      const v: unknown = JSON.parse(m[0])
      if (v && typeof v === 'object' && 'verdict' in v) {
        const verdict = v.verdict === 'converged' ? 'converged' : 'continue'
        const note = 'note' in v && typeof v.note === 'string' ? v.note : ''
        return { verdict, note }
      }
    } catch {
      /* fall through */
    }
  }
  return { verdict: 'continue', note: raw.trim().slice(0, 200) }
}

/** `should-relay-auto-archive-idle-chats`: the file name part of a saved room. */
export function slugOf(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s === '' ? 'room' : s
}

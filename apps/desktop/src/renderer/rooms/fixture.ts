/**
 * The scripted room slice 1 replays. A beat is one message with how long its author types and
 * when that typing starts relative to the previous post (negative overlaps the previous author).
 * compileBeats turns beats into the timed steps the player runs.
 */
export interface BeatReaction {
  emoji: string
  by: string
  /** ms after the message posts. */
  after: number
}

export interface Beat {
  key: string
  author: string
  text: string
  /** ms the author types before posting. */
  typing: number
  /** ms after the previous post that typing starts; negative starts while the previous author types. */
  lead: number
  reactions?: BeatReaction[]
  /** The closing summary that resolves the room. */
  summary?: boolean
}

export type StepOp =
  | { type: 'typing'; agent: string; on: boolean }
  | { type: 'message'; key: string; author: string; text: string }
  | { type: 'reaction'; key: string; emoji: string; by: string }
  | { type: 'resolve'; key: string; author: string; text: string }

export interface Step {
  /** ms from the start of the script. */
  at: number
  op: StepOp
}

/** Expands beats into steps sorted by time; `offset` shifts the whole script. */
export function compileBeats(beats: readonly Beat[], offset = 0): Step[] {
  const steps: Step[] = []
  let lastPost = 0
  for (const b of beats) {
    const start = Math.max(0, lastPost + b.lead)
    const at = start + b.typing
    steps.push({ at: start, op: { type: 'typing', agent: b.author, on: true } })
    steps.push({
      at,
      op: b.summary
        ? { type: 'resolve', key: b.key, author: b.author, text: b.text }
        : { type: 'message', key: b.key, author: b.author, text: b.text },
    })
    for (const r of b.reactions ?? []) {
      steps.push({
        at: at + r.after,
        op: { type: 'reaction', key: b.key, emoji: r.emoji, by: r.by },
      })
    }
    lastPost = at
  }
  steps.sort((a, b) => a.at - b.at)
  if (offset !== 0) for (const s of steps) s.at += offset
  return steps
}

export const TOPIC = 'Should Relay auto-archive idle chats after N days?'

export const BEATS: readonly Beat[] = [
  {
    key: 'm1',
    author: 'pm',
    lead: 900,
    typing: 2400,
    text: 'Kicking this off. Question on the table: **should Relay auto-archive chats after N days idle?** Looking for a yes/no plus a number by the end. 🧵',
  },
  {
    key: 'm2',
    author: 'builder',
    lead: 700,
    typing: 2600,
    text: 'Easy yes from me. The sidebar is at 340 chats on my machine and Recent is useless past the first screen.',
  },
  {
    key: 'm3',
    author: 'skeptic',
    lead: -1500,
    typing: 3400,
    text: 'Hard no on *auto*. Archiving something I did not touch is Relay deciding what matters to me. Idle is not the same as done.',
    reactions: [{ emoji: '👀', by: 'advocate', after: 1200 }],
  },
  {
    key: 'm4',
    author: 'advocate',
    lead: 500,
    typing: 3000,
    text: 'Agree with Mara on the feeling. The chats I care about most are the long-running ones I open once a month. Those are exactly the ones an idle rule hides first. 😬',
  },
  {
    key: 'm5',
    author: 'ops',
    lead: -900,
    typing: 2600,
    text: "From my side: 340 sessions means 340 JSONL files chokidar watches on startup. We are at about 1.8 s cold start on Isaac's machine and that number only goes up.",
    reactions: [{ emoji: '💯', by: 'builder', after: 900 }],
  },
  {
    key: 'm6',
    author: 'builder',
    lead: 400,
    typing: 2000,
    text: 'So two problems hiding in one: sidebar noise and startup cost. Do we need to solve both with the same lever?',
  },
  {
    key: 'm7',
    author: 'pm',
    lead: 600,
    typing: 2600,
    text: 'Good split. Restating:\n- **Noise**: too many rows in Recent\n- **Cost**: watching every file forever\n\nMara, which one are you objecting to?',
  },
  {
    key: 'm8',
    author: 'skeptic',
    lead: 800,
    typing: 3200,
    text: 'The noise fix. Cost is a plumbing problem whether we archive or not. Lazy-watch the files you have not opened in a week and you get most of the win without touching the UI.',
    reactions: [
      { emoji: '🤔', by: 'ops', after: 1500 },
      { emoji: '👍', by: 'builder', after: 2200 },
    ],
  },
  {
    key: 'm9',
    author: 'ops',
    lead: 1000,
    typing: 2600,
    text: 'Lazy watch works. `chokidar` can take the N most recent and the rest get read on open. Half a day of work.',
  },
  {
    key: 'm10',
    author: 'advocate',
    lead: -600,
    typing: 2200,
    text: 'Then the UI question stands on its own: do idle chats *disappear* or just *move down*?',
  },
  {
    key: 'm11',
    author: 'builder',
    lead: 400,
    typing: 1800,
    text: 'Move down is just sorting by last activity, which we already do 🙂',
  },
  {
    key: 'm12',
    author: 'advocate',
    lead: 700,
    typing: 2800,
    text: 'Right, and it is not enough. Sorting still shows all 340. What Isaac wants is a shorter list, not a differently ordered long one.',
    reactions: [{ emoji: '🔥', by: 'pm', after: 1000 }],
  },
  {
    key: 'm13',
    author: 'skeptic',
    lead: 900,
    typing: 3600,
    text: 'OK, here is where I land: **fold, do not archive.** An Older section at the bottom of Recent, collapsed by default, holding everything past N days. Nothing leaves. Nothing needs undo.',
    reactions: [
      { emoji: '👍', by: 'builder', after: 800 },
      { emoji: '👍', by: 'advocate', after: 1400 },
      { emoji: '🎉', by: 'pm', after: 2000 },
    ],
  },
  {
    key: 'm14',
    author: 'pm',
    lead: 600,
    typing: 2000,
    text: 'I like that it has no undo story. What is N?',
  },
  {
    key: 'm15',
    author: 'ops',
    lead: -1200,
    typing: 2600,
    text: '14 days matches the lazy-watch window, so one constant drives both: `IDLE_DAYS = 14`.',
  },
  {
    key: 'm16',
    author: 'builder',
    lead: 400,
    typing: 2400,
    text: 'Search still has to hit the folded ones though. Otherwise "where did my chat go" is back as a support question.',
    reactions: [{ emoji: '✅', by: 'advocate', after: 700 }],
  },
  {
    key: 'm17',
    author: 'skeptic',
    lead: 600,
    typing: 1600,
    text: 'Agreed, search stays global. The fold is a display thing only.',
  },
  {
    key: 'm18',
    author: 'advocate',
    lead: 1100,
    typing: 2800,
    text: 'One ask: a pinned chat never folds, even if idle for months. That covers the monthly ones I mentioned. 🙏',
    reactions: [
      { emoji: '👍', by: 'skeptic', after: 600 },
      { emoji: '👍', by: 'pm', after: 900 },
    ],
  },
  {
    key: 'm19',
    author: 'builder',
    lead: 400,
    typing: 1500,
    text: 'Pinned is already a flag on the tab, so that is free.',
  },
  {
    key: 'm20',
    author: 'ops',
    lead: 800,
    typing: 2800,
    text: 'Dissent for the record: I still want a real archive for the **cost** side eventually. Folding does nothing for disk or for the 2k-session case. Not blocking today.',
    reactions: [{ emoji: '👀', by: 'pm', after: 800 }],
  },
  {
    key: 'm21',
    author: 'pm',
    lead: 600,
    typing: 2200,
    text: 'Logged as dissent. Fair to park it until lazy-watch ships and we re-measure?',
  },
  {
    key: 'm22',
    author: 'ops',
    lead: 500,
    typing: 1200,
    text: 'Fair. 👍',
  },
  {
    key: 'm23',
    author: 'skeptic',
    lead: 1000,
    typing: 2000,
    text: 'Last check. Is anyone proposing anything that *deletes* or *hides* data? No? Then I am a yes.',
    reactions: [{ emoji: '😂', by: 'builder', after: 700 }],
  },
  {
    key: 'm24',
    author: 'builder',
    lead: 400,
    typing: 1400,
    text: 'Nope. Fold only. Sort plus fold in one PR, lazy-watch in a second.',
  },
  {
    key: 'm25',
    author: 'pm',
    lead: 1300,
    typing: 4000,
    summary: true,
    text: '**Decision**\nNo auto-archive. Chats idle 14+ days fold into a collapsed Older section at the bottom of Recent. Pinned chats never fold. Search stays global.\n\n**Dissent**\nSam still wants a true archive for disk and startup cost once sessions pass a few thousand. Parked until lazy-watch ships and we re-measure.\n\n**Next steps**\n- Theo: sort plus fold behind `IDLE_DAYS = 14`, one PR\n- Sam: lazy file watching for sessions older than 14 days\n- Jonah: re-measure cold start in two weeks',
    reactions: [
      { emoji: '🎉', by: 'builder', after: 600 },
      { emoji: '🎉', by: 'advocate', after: 900 },
      { emoji: '🎉', by: 'skeptic', after: 1300 },
      { emoji: '🙏', by: 'ops', after: 1600 },
    ],
  },
]

export const SCRIPT: readonly Step[] = compileBeats(BEATS)

/** Short replies the player injects when Isaac posts, cycled in order. */
export const REPLIES_TO_ISAAC: readonly (readonly Beat[])[] = [
  [
    {
      key: 'r-pm',
      author: 'pm',
      lead: 900,
      typing: 1800,
      text: 'Taking that in, Isaac. Adjusting the framing before we go further.',
    },
    {
      key: 'r-skeptic',
      author: 'skeptic',
      lead: -500,
      typing: 2400,
      text: '+1 to Isaac. That is the constraint I was circling, said plainer. 👍',
    },
  ],
  [
    {
      key: 'r-advocate',
      author: 'advocate',
      lead: 1000,
      typing: 2200,
      text: 'That is the user voice we needed, thanks Isaac. I will hold the group to it.',
    },
  ],
  [
    {
      key: 'r-builder',
      author: 'builder',
      lead: 800,
      typing: 2000,
      text: 'Noted, Isaac. That is cheap to do, I will fold it into the first PR.',
    },
    {
      key: 'r-ops',
      author: 'ops',
      lead: -300,
      typing: 1800,
      text: 'Works for me as long as it does not add a watcher per chat. 👍',
    },
  ],
]

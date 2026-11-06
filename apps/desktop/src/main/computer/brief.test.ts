import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Brain, InputItem } from './brain'
import { chatTurns, mentionsIn, planFromSession, planRun, type PlanOptions } from './brief'

// A Nova thread where she built a Studio prototype: tools, thinking, a heartbeat, a quiet reply,
// reply chips, a reaction and an old run's plan block around the parts a brief needs.
const STUDIO = fs.readFileSync(
  path.join(__dirname, '../../../../../fixtures/computer/studio-chat.jsonl'),
  'utf8',
)

const planReply = (id: string, parent: string, run: string, said: string): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: parent,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `${said}\n\n\`\`\`computer-plan\n${JSON.stringify({
            run,
            brief:
              'Open the Studio prototype at http://127.0.0.1:5390 and point at the three changes.',
            url: 'http://127.0.0.1:5390',
            steps: [
              { instruction: 'Here is the new Studio header', target: 'Studio', done_when: '' },
            ],
          })}\n\`\`\``,
        },
      ],
      stopReason: 'stop',
    },
  })

describe('chatTurns', () => {
  it('keeps what Isaac and the assistant said, without tools, thinking, background lines, quiet replies, tokens or plan blocks', () => {
    expect(chatTurns(STUDIO)).toEqual([
      {
        role: 'user',
        text: "Let's prototype the Studio redesign: a new header and a bigger Generate button.",
      },
      { role: 'assistant', text: 'On it, scaffolding it in work/studio-proto.' },
      {
        role: 'assistant',
        text: expect.stringMatching(
          /^Done\. The prototype runs at http:\/\/127\.0\.0\.1:5390[\s\S]*App\.tsx\.$/,
        ),
      },
      {
        role: 'user',
        text: 'Also keep the meeting notes from today in mind, meeting-notes.txt',
      },
      {
        role: 'assistant',
        text: 'Got it: meeting-notes.txt is on your Desktop (~/Desktop/meeting-notes.txt).',
      },
    ])
  })

  it('reads only the last turns', () => {
    expect(chatTurns(STUDIO, 2).map((t) => t.role)).toEqual(['user', 'assistant'])
  })
})

describe('mentionsIn', () => {
  it('finds URLs, local servers and files, newest first and each once', () => {
    const m = mentionsIn([
      ...chatTurns(STUDIO),
      { role: 'user', text: 'the old one was on localhost:3000, and the api on port 8787.' },
    ])
    expect(m.urls).toEqual([
      'http://127.0.0.1:3000',
      'http://127.0.0.1:8787',
      'http://127.0.0.1:5390',
    ])
    expect(m.files).toEqual([
      '~/Desktop/meeting-notes.txt',
      'meeting-notes.txt',
      '/Users/ike/Eva/work/studio-proto/src/App.tsx',
    ])
  })
})

describe('planFromSession', () => {
  it("takes the block of this run only, and the assistant's words around it", () => {
    expect(planFromSession(STUDIO, 'c-1')).toBeNull()
    const text = `${STUDIO}${planReply('p1', 'c1', 'c-1', 'Opening it now, three changes.')}\n`
    const plan = planFromSession(text, 'c-1')
    expect(plan).toMatchObject({
      by: 'assistant',
      said: 'Opening it now, three changes.',
      url: 'http://127.0.0.1:5390',
      app: '',
      steps: [{ instruction: 'Here is the new Studio header', done_when: '' }],
    })
  })
})

describe('planRun', () => {
  const planner = (seen: string[]): Brain => ({
    async turn(items: InputItem[]) {
      for (const i of items)
        if ('role' in i) for (const c of i.content) if (c.type === 'input_text') seen.push(c.text)
      return {
        text: '',
        calls: [
          {
            callId: 'p',
            name: 'plan_run',
            args: { brief: 'Open ~/Desktop/meeting-notes.txt in TextEdit.', steps: [] },
          },
        ],
      }
    },
  })
  const base = (seen: string[], own: PlanOptions['own']): PlanOptions => ({
    runId: 'c-1',
    task: 'walk me through the changes you made in the prototype',
    mode: 'walk',
    assistant: { title: 'Nova', profile: 'personal' },
    own,
    chat: STUDIO,
    planner: planner(seen),
    windows: 'Arc: Studio',
    ticket: null,
    signal: new AbortController().signal,
    waitMs: 200,
    pollMs: 5,
  })

  it("uses the assistant's own plan when its thread answers, without a planner call", async () => {
    const seen: string[] = []
    const asked: string[] = []
    let reads = 0
    const answered = `${STUDIO}${planReply('p1', 'c1', 'c-1', 'Opening it now.')}\n`
    const plan = await planRun(
      base(seen, {
        ask: async (text) => (asked.push(text), true),
        // Its reply is not in the session at the first look, only at the next one.
        read: () => (++reads > 1 ? answered : STUDIO),
      }),
    )
    expect(reads).toBe(2)
    expect(plan?.by).toBe('assistant')
    expect(seen).toEqual([])
    expect(asked[0]).toMatch(/^\[From Nova's background jobs\] @computer: /)
    expect(asked[0]).toContain('"run":"c-1"')
    expect(asked[0]).toContain('Arc: Studio')
  })

  it('writes the plan from the chat when the assistant is busy', async () => {
    const seen: string[] = []
    const plan = await planRun(base(seen, { ask: async () => false, read: () => STUDIO }))
    expect(plan).toMatchObject({
      by: 'chat',
      brief: 'Open ~/Desktop/meeting-notes.txt in TextEdit.',
    })
    // The brief's input: the task, the chat's words and the places it named, the windows.
    expect(seen[0]).toContain('Task from Isaac: walk me through the changes')
    expect(seen[0]).toContain('Nova: Done. The prototype runs at http://127.0.0.1:5390')
    expect(seen[0]).toContain('URLs and local servers: http://127.0.0.1:5390')
    expect(seen[0]).not.toContain('TOOL NOISE')
    expect(seen[0]).toContain('Arc: Studio')
  })

  it('falls back to the planner when the assistant does not answer in time', async () => {
    const seen: string[] = []
    const plan = await planRun(base(seen, { ask: async () => true, read: () => STUDIO }))
    expect(plan?.by).toBe('chat')
    expect(seen).toHaveLength(1)
  })
})

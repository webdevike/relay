import { describe, expect, it } from 'vitest'
import type { RunIO } from './agent'
import type { Brain } from './brain'
import type { Desktop, Snapshot, WindowInfo } from './desktop'
import type { Judge } from './judge'
import type { Presenter, Shown } from './presenter'
import { runWalk } from './walk'

const WIN: WindowInfo = {
  windowId: 1,
  pid: 9,
  app: 'Calculator',
  title: 'Calculator',
  bounds: { x: 0, y: 0, w: 300, h: 400 },
}

function world(display: { value: string }) {
  const snap = (): Snapshot => ({
    windowId: 1,
    pid: 9,
    app: 'Calculator',
    title: 'Calculator',
    tree: `AXStaticText = "${display.value}"\n[1] AXButton (4)`,
    controls: new Map([
      [
        1,
        {
          ref: 1,
          token: 't1',
          role: 'AXButton',
          label: '4',
          line: 'AXButton (4)',
          frame: { x: 10, y: 10, w: 40, h: 40 },
        },
      ],
    ]),
    truncated: false,
    image: null,
  })
  const desktop = {
    windows: async () => [WIN],
    openApp: async () => ({ pid: 9, windows: [WIN] }),
    front: async () => {},
    read: async () => snap(),
  } as unknown as Desktop
  const shown = (): Shown => ({ landed: Promise.resolve(), spoken: Promise.resolve() })
  const pointed: string[] = []
  const presenter: Presenter = {
    assistant() {},
    point: (_r, caption) => (pointed.push(caption), shown()),
    click: () => shown(),
    caption: () => shown(),
    hide() {},
    onEsc() {},
    close() {},
  }
  const planner: Brain = {
    turn: async () => ({
      text: '',
      calls: [
        {
          callId: 'c',
          name: 'plan_walk',
          args: {
            app: 'Calculator',
            intro: '',
            outro: 'Done.',
            steps: [{ instruction: 'Press 4', target: '4', done_when: 'display shows 4' }],
          },
        },
      ],
    }),
  }
  const judge: Judge = {
    name: 'jev',
    pick: async () => ({ choice: 'r1', p: 0.9 }),
    holds: async () => (display.value === '4' ? 0.95 : 0.05),
  }
  return { desktop, presenter, planner, judge, pointed }
}

function chat(answers: string[]) {
  const asked: string[] = []
  const progress: string[] = []
  const io: RunIO = {
    signal: new AbortController().signal,
    stop() {},
    progress: (l) => void progress.push(l),
    image() {},
    ask: async (q) => (asked.push(q), answers.shift() ?? 'Cancel'),
  }
  return { io, asked, progress }
}

describe('runWalk', () => {
  it('keeps waiting on the same step when Isaac says so, then finishes once the app shows it done', async () => {
    const display = { value: '0' }
    const w = world(display)
    const c = chat(['Keep waiting'])
    // He does the step only after the first wait ran out and he chose to keep going.
    const origAsk = c.io.ask
    c.io.ask = async (q, o, img) => {
      const a = await origAsk(q, o, img)
      display.value = '4'
      return a
    }
    const r = await runWalk({
      task: 'press 4',
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: c.io,
      control: () => {},
      ticket: null,
      pollMs: 5,
      stepTimeoutMs: 40,
    })
    expect(c.asked).toHaveLength(1)
    expect(c.progress).toContain('Step 1/1 done')
    expect(r.summary).toContain('1 showed done')
    expect(w.pointed).toEqual(['Press 4'])
  })

  it('stops when Isaac picks Stop after a wait', async () => {
    const w = world({ value: '0' })
    const c = chat(['Stop'])
    const r = await runWalk({
      task: 'press 4',
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: c.io,
      control: () => {},
      ticket: null,
      pollMs: 5,
      stepTimeoutMs: 30,
    })
    expect(r.outcome).toBe('stopped')
  })
})

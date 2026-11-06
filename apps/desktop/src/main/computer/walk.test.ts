import { describe, expect, it } from 'vitest'
import type { RunIO } from './agent'
import type { RunPlan } from './brief'
import type { Desktop, Snapshot, WindowInfo } from './desktop'
import type { Judge } from './judge'
import type { Presenter, Shown } from './presenter'
import { runWalk } from './walk'

const plan = (over: Partial<RunPlan> = {}): RunPlan => ({
  brief: '',
  app: 'Calculator',
  url: '',
  file: '',
  intro: '',
  outro: 'Done.',
  steps: [{ instruction: 'Press 4', target: '4', done_when: 'display shows 4' }],
  by: 'assistant',
  said: '',
  ...over,
})

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
  const opened: string[] = []
  const desktop = {
    windows: async () => [WIN],
    openApp: async (app: string) => (opened.push(`app:${app}`), { pid: 9, windows: [WIN] }),
    openUrl: async (url: string) => (opened.push(`url:${url}`), { windows: [WIN], landed: WIN }),
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
  const judge: Judge = {
    name: 'jev',
    pick: async () => ({ choice: 'r1', p: 0.9 }),
    holds: async () => (display.value === '4' ? 0.95 : 0.05),
  }
  return { desktop, presenter, judge, pointed, opened }
}

function chat(answers: string[]) {
  const asked: string[] = []
  const progress: string[] = []
  const io: RunIO = {
    signal: new AbortController().signal,
    stop() {},
    plan() {},
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
      plan: plan(),
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: c.io,
      control: () => {},
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
      plan: plan(),
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: c.io,
      control: () => {},
      pollMs: 5,
      stepTimeoutMs: 30,
    })
    expect(r.outcome).toBe('stopped')
  })

  it("opens the plan's URL and points at each change in order, moving on without waiting for Isaac", async () => {
    const w = world({ value: '0' })
    const c = chat([])
    const r = await runWalk({
      plan: plan({
        app: 'Arc',
        url: 'http://127.0.0.1:5390',
        steps: [
          { instruction: 'Here is the new header', target: 'Header', done_when: '' },
          { instruction: 'And the bigger button', target: 'Generate', done_when: '' },
        ],
      }),
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: c.io,
      control: () => {},
      pollMs: 5,
      stepTimeoutMs: 30,
    })
    expect(w.opened).toEqual(['url:http://127.0.0.1:5390'])
    expect(w.pointed).toEqual(['Here is the new header', 'And the bigger button'])
    expect(c.asked).toEqual([])
    expect(r.outcome).toBe('done')
  })

  it('fails without opening anything when the plan has no steps', async () => {
    const w = world({ value: '0' })
    const r = await runWalk({
      plan: plan({ steps: [] }),
      assistant: { id: 'nova', title: 'Nova' },
      ...w,
      io: chat([]).io,
      control: () => {},
    })
    expect(r.outcome).toBe('failed')
    expect(w.opened).toEqual([])
  })
})

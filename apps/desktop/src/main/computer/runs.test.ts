import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@evaos/chat-core/message'
import { runAgent, type AgentResult } from './agent'
import type { Brain, InputItem, Turn } from './brain'
import { Desktop } from './desktop'
import type { Driver, Reply } from './driver'
import { parseWidget } from '@evaos/chat-core/widget'
import { ComputerRuns, fileRowStore, type RunsDeps } from './runs'

const NOVA = { id: 'nova', title: 'Nova', profile: 'personal' }

/** A Mail window with a Send button; records every tool call the agent makes. */
function fakeDriver(calls: string[]): Driver {
  const ok = (structuredContent: Record<string, unknown> = {}): Reply => ({
    result: { content: [], structuredContent },
  })
  return {
    backend: 'direct',
    close() {},
    async call(name) {
      calls.push(name)
      if (name === 'list_windows')
        return ok({
          windows: [
            {
              app_name: 'Mail',
              title: 'Re: lunch',
              pid: 7,
              window_id: 70,
              is_on_screen: true,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
            },
          ],
        })
      if (name === 'launch_app') return ok({ pid: 7 })
      if (name === 'get_window_state')
        return ok({
          app_name: 'Mail',
          window_title: 'Re: lunch',
          tree_markdown: '- [0] AXWindow "Re: lunch"\n  - [1] AXButton (Send) [actions=[press]]',
          elements: [
            {
              element_index: 1,
              element_token: 's:1',
              role: 'AXButton',
              label: 'Send',
              frame: { x: 10, y: 10, w: 40, h: 20 },
            },
          ],
        })
      return ok()
    },
  }
}

/** Opens Mail, presses Send, then finishes with whatever the act answered. */
function scriptedBrain(): Brain {
  let n = 0
  return {
    async turn(items: InputItem[]): Promise<Turn> {
      n++
      if (n === 1)
        return { text: '', calls: [{ callId: 'c1', name: 'open_app', args: { app: 'Mail' } }] }
      if (n === 2)
        return {
          text: '',
          calls: [
            {
              callId: 'c2',
              name: 'act',
              args: {
                window_id: 70,
                reason: 'Sending the reply',
                steps: [{ type: 'click', ref: 1 }],
              },
            },
          ],
        }
      const out = items.find(
        (i): i is Extract<InputItem, { type: 'function_call_output' }> => 'type' in i,
      )
      return {
        text: '',
        calls: [
          { callId: 'c3', name: 'finish', args: { summary: out?.output.split('\n')[0] ?? '' } },
        ],
      }
    },
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface Harness {
  runs: ComputerRuns
  rows: () => ChatMessage[]
  calls: string[]
  /** Resolves on the first emit whose rows hold a row matching `pred`. */
  row: (pred: (r: ChatMessage) => boolean) => Promise<ChatMessage>
  /** How the agent ended, once the chat has its summary row. */
  done: Promise<AgentResult>
}

function harness(brain: () => Brain = scriptedBrain): Harness {
  const calls: string[] = []
  let rows: ChatMessage[] = []
  const waiting: Array<{ pred: (r: ChatMessage) => boolean; resolve: (r: ChatMessage) => void }> =
    []
  const row = (pred: (r: ChatMessage) => boolean): Promise<ChatMessage> => {
    const hit = rows.find(pred)
    if (hit) return Promise.resolve(hit)
    const { promise, resolve } = Promise.withResolvers<ChatMessage>()
    waiting.push({ pred, resolve })
    return promise
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-'))
  dirs.push(dir)
  const result = Promise.withResolvers<AgentResult>()
  const deps: RunsDeps = {
    emit: (_pane, _file, r) => {
      rows = r
      for (const w of waiting.splice(0)) {
        const hit = r.find(w.pred)
        if (hit) w.resolve(hit)
        else waiting.push(w)
      }
    },
    fileOf: () => null,
    chatAgentOf: () => null,
    route: (task) => ({ assistant: NOVA, task, reason: 'default' }),
    remote: false,
    launch: async (spec, io) => {
      const r = await runAgent({
        task: spec.task,
        mode: 'headless',
        assistant: NOVA,
        desktop: new Desktop(fakeDriver(calls), async () => {}),
        brain: brain(),
        presenter: null,
        io,
        shots: { dir, want: 'none' },
      })
      result.resolve(r)
      return r
    },
  }
  const done = row((r) => r.id.endsWith(':done')).then(() => result.promise)
  return { runs: new ComputerRuns(deps), rows: () => rows, calls, row, done }
}

const asked = (r: ChatMessage): boolean => r.text.includes('[[replies: Approve | Cancel]]')

describe('ComputerRuns + runAgent', () => {
  it('leaves ordinary messages to the chat agent', () => {
    const { runs, rows } = harness()
    expect(runs.intercept('p1', 'what is @computer?')).toBe(false)
    expect(rows()).toEqual([])
  })

  it('asks before Send and nothing is clicked when Isaac cancels', async () => {
    const h = harness()
    expect(h.runs.intercept('p1', '@computer reply to the lunch mail with yes')).toBe(true)
    await h.row(asked)
    expect(h.calls).not.toContain('click')
    // The chip's tap comes back through chat.send and never reaches omp.
    expect(h.runs.intercept('p1', 'Cancel')).toBe(true)
    const result = await h.done
    expect(h.calls).not.toContain('click')
    expect(result.summary).toMatch(/declined/i)
    // Finished: the ask and the progress fold into the one run row, which keeps the answer.
    expect(h.rows().some((r) => r.id.includes(':ask:') || r.id.endsWith(':progress'))).toBe(false)
    expect(h.rows().find((r) => r.id.endsWith(':done'))?.text).toContain('You said no to')
  })

  it('runs the step once Isaac approves', async () => {
    const h = harness()
    h.runs.intercept('p1', '@computer reply to the lunch mail with yes')
    await h.row(asked)
    expect(h.runs.intercept('p1', 'approve')).toBe(true)
    await h.done
    expect(h.calls.filter((c) => c === 'click')).toHaveLength(1)
    expect(h.rows().at(-1)?.id).toMatch(/:done$/)
    expect(h.rows().map((r) => r.role)).toEqual(['user', 'assistant'])
  })

  it('a plain message while the run waits answers it; with nothing waiting or a command it does not', async () => {
    const h = harness()
    expect(h.runs.intercept('p1', 'yes please')).toBe(false)
    h.runs.intercept('p1', '@computer reply to the lunch mail with yes')
    await h.row(asked)
    // Another pane's chat is not the run's chat.
    expect(h.runs.intercept('p2', 'yes please')).toBe(false)
    // A slash command goes to omp.
    expect(h.runs.intercept('p1', '/compact')).toBe(false)
    expect(h.runs.intercept('p1', 'yes')).toBe(true)
    await h.done
    expect(h.calls.filter((c) => c === 'click')).toHaveLength(1)
    // Folded into the finished row; nothing left over.
    expect(h.rows().map((r) => r.role)).toEqual(['user', 'assistant'])
  })

  it('ask_isaac posts a free-form question; his typed answer reaches the brain and shows under it', async () => {
    const asking = (): Brain => {
      let n = 0
      return {
        async turn(items) {
          n++
          if (n === 1)
            return {
              text: '',
              calls: [{ callId: 'q', name: 'ask_isaac', args: { question: 'Which prototype?' } }],
            }
          const out = items.find(
            (i): i is Extract<InputItem, { type: 'function_call_output' }> => 'type' in i,
          )
          return {
            text: '',
            calls: [{ callId: 'f', name: 'finish', args: { summary: out?.output ?? '' } }],
          }
        },
      }
    }
    const h = harness(asking)
    h.runs.intercept('p1', '@computer walk me through the prototype')
    const q = await h.row((r) => r.text.includes('Which prototype?'))
    expect(q.text).not.toContain('[[replies')
    expect(h.runs.intercept('p1', 'the blue one')).toBe(true)
    const shown = h.rows().find((r) => r.id.endsWith(':reply'))
    expect(shown).toMatchObject({ role: 'user', text: 'the blue one' })
    expect(h.rows().find((r) => r.id === q.id)?.text).toContain('You answered: the blue one')
    const result = await h.done
    expect(result.summary).toBe('Isaac answered: the blue one')
  })

  it('stop cancels a pending ask; a second run waits for the first', async () => {
    const h = harness()
    h.runs.intercept('p1', '@computer reply to the lunch mail with yes')
    await h.row(asked)
    h.runs.intercept('p1', '@computer open Calculator')
    expect(h.rows().some((r) => r.text.includes('Already working on'))).toBe(true)
    h.runs.intercept('p1', '@computer stop')
    const result = await h.done
    expect(['stopped', 'done']).toContain(result.outcome)
    expect(h.calls).not.toContain('click')
  })

  it('a thin client refuses: @computer runs on the Mini only', () => {
    let rows: ChatMessage[] = []
    const runs = new ComputerRuns({
      emit: (_p, _f, r) => {
        rows = r
      },
      fileOf: () => null,
      chatAgentOf: () => null,
      route: (task) => ({ assistant: NOVA, task, reason: 'default' }),
      remote: true,
      launch: () => Promise.reject(new Error('must not launch')),
    })
    expect(runs.intercept('p1', '@computer open Calculator')).toBe(true)
    expect(rows.at(-1)?.text).toMatch(/Mac Mini only/)
  })

  it('a finished run is one collapsible line: who, the answer, then its steps inside', async () => {
    const h = harness()
    h.runs.intercept('p1', '@computer reply to the lunch mail with yes')
    await h.row(asked)
    h.runs.intercept('p1', 'Approve')
    await h.done
    const done = h.rows().find((r) => r.id.endsWith(':done'))!
    const json = /```ui\n([\s\S]*)\n```/.exec(done.text)?.[1]
    const widget = parseWidget(json ?? '')
    expect(widget?.widget).toBe('collapse')
    if (widget?.widget !== 'collapse') return
    expect(widget.open).toBe(false)
    expect(widget.title).toMatch(/^Nova · @computer: /)
    expect(JSON.stringify(widget.children)).toContain('You approved')
    // Every row of the run carries the time Isaac sent it, which places it in the chat.
    const at = h.rows()[0]!.at
    expect(at).toBeTypeOf('number')
    expect(h.rows().every((r) => r.at === at)).toBe(true)
  })

  it('a session keeps its runs across a restart, and a draft hands its runs to its new file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-rows-'))
    dirs.push(dir)
    const store = fileRowStore(dir)
    let file: string | null = null
    const make = (): ComputerRuns =>
      new ComputerRuns({
        emit: () => {},
        fileOf: () => file,
        chatAgentOf: () => null,
        route: (task) => ({ assistant: NOVA, task, reason: 'default' }),
        remote: false,
        store,
        launch: () => Promise.reject(new Error('unused')),
      })
    const first = make()
    first.intercept('draft', '@computer help')
    expect(store.load('/s/a.jsonl')).toEqual([])
    // The draft's first normal message created its session file; the chat asks again with it.
    file = '/s/a.jsonl'
    expect(first.rowsFor('draft', file)).toHaveLength(2)
    expect(store.load(file)).toHaveLength(2)
    // Relay restarted: a new pane on the same session sees them, and a new run adds to them.
    const second = make()
    expect(second.rowsFor('p9', file).map((r) => r.text)).toContain('@computer help')
    second.intercept('p9', '@computer stop')
    expect(store.load(file).map((r) => r.text)).toEqual(
      expect.arrayContaining(['@computer help', '@computer stop', 'Nothing is running.']),
    )
    expect(store.load(file)).toHaveLength(4)
  })
})

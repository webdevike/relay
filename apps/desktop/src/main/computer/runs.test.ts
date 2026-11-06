import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@evaos/chat-core/message'
import { runAgent, type AgentResult } from './agent'
import type { Brain, InputItem, Turn } from './brain'
import { Desktop } from './desktop'
import type { Driver, Reply } from './driver'
import { ComputerRuns, type RunsDeps } from './runs'

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

function harness(): Harness {
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
        brain: scriptedBrain(),
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
    expect(h.rows().find((r) => r.id.includes(':ask:'))?.text).toContain('_You chose: Cancel_')
  })

  it('runs the step once Isaac approves', async () => {
    const h = harness()
    h.runs.intercept('p1', '@computer reply to the lunch mail with yes')
    await h.row(asked)
    expect(h.runs.intercept('p1', 'approve')).toBe(true)
    await h.done
    expect(h.calls.filter((c) => c === 'click')).toHaveLength(1)
    expect(h.rows().at(-1)?.id).toMatch(/:done$/)
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
})

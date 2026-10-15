import { describe, expect, it } from 'vitest'
import type { Extras } from '@evaos/contract'
import { ExtrasService, lastAssistantLine } from './extras'

const asst = (t: string): string =>
  JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: t }] },
  })
const user = JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } })
const started = (id: string): string =>
  JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 'c',
      details: { async: { state: 'running', jobId: id, type: 'bash' } },
    },
  })

function setup(panes: Array<{ paneId: string; file: string; live: boolean }>) {
  const texts: Record<string, string> = {}
  const dirs: Record<string, Array<{ name: string; mtimeMs: number }>> = {}
  const out: Extras[] = []
  const svc = new ExtrasService({
    manager: { paneFiles: () => panes },
    emit: (e) => out.push(e),
    readText: (f) => {
      if (texts[f] === undefined) throw new Error('ENOENT')
      return texts[f]
    },
    readDir: (d) => {
      const r = dirs[d]
      if (!r) throw new Error('ENOENT')
      return r
    },
  })
  return { svc, texts, dirs, out }
}

describe('ExtrasService', () => {
  it('emits subagents newest first with lastLine, no jobs when not live', () => {
    const { svc, texts, dirs, out } = setup([{ paneId: 'pane-1', file: '/s/x.jsonl', live: false }])
    dirs['/s/x'] = [
      { name: 'a.jsonl', mtimeMs: 1 },
      { name: 'a.md', mtimeMs: 2 },
      { name: 'b.jsonl', mtimeMs: 5 },
    ]
    texts['/s/x/b.jsonl'] = [user, asst('Working   on it')].join('\n')
    texts['/s/x.jsonl'] = started('bg_1')
    svc.refresh()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ paneId: 'pane-1', running: false, jobs: [] })
    expect(out[0]!.subagents.map((s) => [s.name, s.done, s.lastLine, s.failed])).toEqual([
      ['b', false, 'Working on it', false],
      ['a', true, '', false],
    ])
  })

  it('a live pane lists unfinished jobs', () => {
    const { svc, texts, out } = setup([{ paneId: 'pane-1', file: '/s/x.jsonl', live: true }])
    texts['/s/x.jsonl'] = started('bg_1')
    svc.refresh('pane-1')
    expect(out[0]!.running).toBe(true)
    expect(out[0]!.jobs.map((j) => j.id)).toEqual(['bg_1'])
  })

  it('an unchanged result emits nothing, a change emits again', () => {
    const { svc, texts, out } = setup([{ paneId: 'pane-1', file: '/s/x.jsonl', live: true }])
    texts['/s/x.jsonl'] = started('bg_1')
    svc.refresh()
    svc.refresh()
    expect(out).toHaveLength(1)
    texts['/s/x.jsonl'] = ''
    svc.refresh()
    expect(out).toHaveLength(2)
    expect(out[1]!.jobs).toEqual([])
  })

  it('the first refresh of a pane emits even when empty, then stays quiet', () => {
    const { svc, out } = setup([{ paneId: 'pane-1', file: '/s/x.jsonl', live: false }])
    svc.refresh()
    svc.refresh()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ running: false, subagents: [], jobs: [] })
  })

  it('onFilesChanged refreshes only the pane whose file or folder changed', () => {
    const { svc, texts, dirs, out } = setup([
      { paneId: 'pane-1', file: '/s/x.jsonl', live: false },
      { paneId: 'pane-2', file: '/s/y.jsonl', live: false },
    ])
    dirs['/s/x'] = [{ name: 'b.jsonl', mtimeMs: 5 }]
    dirs['/s/y'] = [{ name: 'c.jsonl', mtimeMs: 5 }]
    texts['/s/x/b.jsonl'] = ''
    texts['/s/y/c.jsonl'] = ''
    svc.onFilesChanged(['/s/x'])
    expect(out.map((e) => e.paneId)).toEqual(['pane-1'])
    svc.onFilesChanged(['/s/y.jsonl'])
    expect(out.map((e) => e.paneId)).toEqual(['pane-1', 'pane-2'])
    svc.onFilesChanged(['/s/zzz.jsonl'])
    expect(out).toHaveLength(2)
  })

  it('reset makes the next identical result emit again', () => {
    const { svc, dirs, out } = setup([{ paneId: 'pane-1', file: '/s/x.jsonl', live: false }])
    dirs['/s/x'] = [{ name: 'b.jsonl', mtimeMs: 5 }]
    svc.refresh()
    svc.reset('pane-1')
    svc.refresh()
    expect(out).toHaveLength(2)
  })

  it('lastAssistantLine cuts to 160 characters and skips non-text', () => {
    expect(lastAssistantLine('')).toBe('')
    const long = lastAssistantLine(asst('x'.repeat(400)))
    expect(Array.from(long)).toHaveLength(160)
    expect(lastAssistantLine([asst('older'), user].join('\n'))).toBe('older')
  })
})

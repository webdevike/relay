import { describe, expect, it } from 'vitest'
import type { ActivityEta } from '@relay/protocol'
import type { ActivityItem } from '@evaos/chat-core/activity'
import {
  ETA_LINGER_MS,
  etaFill,
  etaItem,
  etaProps,
  etaTrailing,
  helperActivityId,
  lingerStart,
  lingerStep,
  subagentTranscriptFile,
} from './eta'

const MIN = 60_000
const NOW = 1_000_000_000

const eta = (over: Partial<ActivityEta> = {}): ActivityEta => ({
  from: NOW - 10 * MIN,
  totalMs: 20 * MIN,
  lowMs: 15 * MIN,
  highMs: 30 * MIN,
  typicalMs: 18 * MIN,
  runs: 34,
  confidence: 'confident',
  overrunning: false,
  ...over,
})

const item = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: 'helper',
  owner: 'assistant:nova',
  title: id,
  status: 'working',
  intent: '',
  startedAt: 1,
  updatedAt: 1,
  open: { to: 'subagent', file: id, name: id },
  ...over,
})

describe('etaFill', () => {
  it('picks the tone from the estimate: solid when sure, striped when rough, amber when overrunning', () => {
    expect(etaFill(eta(), NOW).tone).toBe('solid')
    expect(etaFill(eta({ confidence: 'rough' }), NOW).tone).toBe('striped')
    expect(etaFill(eta({ overrunning: true }), NOW).tone).toBe('overrunning')
    // Past the upper bound the badge is amber even if the host has not said so.
    expect(etaFill(eta({ from: NOW - 40 * MIN }), NOW).tone).toBe('overrunning')
  })

  it('fills to the run so far, and to full once the run is leaving', () => {
    expect(etaFill(eta(), NOW).fraction).toBeCloseTo(0.5)
    expect(etaFill(eta(), NOW, 'chip').fraction).toBe(1)
    expect(etaFill(eta(), NOW, 'fill').leaving).toBe('fill')
  })

  it('writes the fraction and the owner color as custom properties, and marks a leaving fill', () => {
    const props = etaProps(etaFill(eta(), NOW), '#ff8800')
    expect(props['data-eta']).toBe('solid')
    expect(props['data-eta-leaving']).toBeUndefined()
    expect(props.style).toMatchObject({ '--eta-fraction': '0.5', '--eva-eta-agent-c': '#ff8800' })
    const done = etaProps(etaFill(eta(), NOW, 'chip'))
    expect(done['data-eta-leaving']).toBe('chip')
    expect(done.style).not.toHaveProperty('--eva-eta-agent-c')
  })

  it('shows the time left on a row only while the run is on track', () => {
    expect(etaTrailing(etaFill(eta(), NOW).view)).toBe('10m left')
    expect(etaTrailing(etaFill(eta({ overrunning: true }), NOW).view)).toBeNull()
  })
})

describe('etaItem', () => {
  it('finds a running item with an estimate by id, and nothing else', () => {
    const items = [
      item('helper:/s/a.jsonl', { eta: eta() }),
      item('helper:/s/b.jsonl'),
      item('helper:/s/c.jsonl', { eta: eta(), status: 'done' }),
    ]
    expect(etaItem(items, 'helper:/s/a.jsonl')?.id).toBe('helper:/s/a.jsonl')
    expect(etaItem(items, 'helper:/s/b.jsonl')).toBeUndefined()
    expect(etaItem(items, 'helper:/s/c.jsonl')).toBeUndefined()
    expect(etaItem(items, 'helper:/s/none.jsonl')).toBeUndefined()
  })

  it("names a subagent chip's run the way the host does", () => {
    const file = subagentTranscriptFile('/s/proj/chat1.jsonl', 'Layouts.jsonl')
    expect(file).toBe('/s/proj/chat1/Layouts.jsonl')
    expect(helperActivityId(file)).toBe('helper:/s/proj/chat1/Layouts.jsonl')
  })
})

describe('lingerStep', () => {
  const a = item('a', { eta: eta() })
  const b = item('b', { eta: eta() })

  it('keeps a run that left for the linger time, then lets it go', () => {
    let s = lingerStep(lingerStart, [a, b], NOW)
    expect(s.leaving).toEqual([])
    s = lingerStep(s, [b], NOW + 5_000)
    expect(s.leaving.map((l) => l.item.id)).toEqual(['a'])
    // Still there just before the time is up, with its first moment kept.
    s = lingerStep(s, [b], NOW + 5_000 + ETA_LINGER_MS - 1)
    expect(s.leaving).toEqual([{ item: a, since: NOW + 5_000 }])
    s = lingerStep(s, [b], NOW + 5_000 + ETA_LINGER_MS)
    expect(s.leaving).toEqual([])
  })

  it('stops lingering a run that is running again', () => {
    let s = lingerStep(lingerStart, [a], NOW)
    s = lingerStep(s, [], NOW + 1)
    expect(s.leaving).toHaveLength(1)
    s = lingerStep(s, [a], NOW + 2)
    expect(s.leaving).toEqual([])
  })

  it('lingers each run once, however many pushes follow its going', () => {
    let s = lingerStep(lingerStart, [a], NOW)
    s = lingerStep(s, [], NOW + 100)
    s = lingerStep(s, [], NOW + 200)
    expect(s.leaving).toEqual([{ item: a, since: NOW + 100 }])
  })
})

import { describe, expect, it } from 'vitest'
import { etaView, type ActivityEta } from '@relay/protocol'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { etaItem, etaTrailing, helperActivityId, subagentTranscriptFile } from './eta'

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

describe('etaTrailing', () => {
  it('shows the time left on a row only while the run is on track', () => {
    expect(etaTrailing(etaView(eta(), NOW))).toBe('10m left')
    expect(etaTrailing(etaView(eta({ overrunning: true }), NOW))).toBeNull()
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

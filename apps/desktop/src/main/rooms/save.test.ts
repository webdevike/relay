import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_PEOPLE, type Room } from '@evaos/contract'
import { dateStamp, journalEntry, roomRecord, saveRoom } from './save'

const t0 = new Date(2026, 9, 26, 14, 5).getTime()
const room = (): Room => ({
  id: 'room-1',
  title: 'Should Relay auto-archive idle chats?',
  prompt: 'Should Relay auto-archive idle chats?\nContext line.',
  agents: ROOM_PEOPLE.slice(0, 2).map((a, i) => (i === 1 ? { ...a, failed: true } : a)),
  messages: [
    {
      id: 'm1',
      author: 'skeptic',
      text: 'What breaks?',
      ts: t0 + 1000,
      reactions: [{ emoji: '👍', by: ['isaac', 'builder'] }],
      kind: 'message',
    },
    {
      id: 'm2',
      author: 'isaac',
      text: 'Nothing, hopefully.',
      ts: t0 + 2000,
      reactions: [],
      kind: 'message',
    },
    {
      id: 'm3',
      author: 'system',
      text: 'Theo dropped out of the room (gone).',
      ts: t0 + 3000,
      reactions: [],
      kind: 'message',
    },
    {
      id: 'm4',
      author: 'judge',
      text: '**Decision**\nFold idle chats; never delete.\n\n**Dissent**\nNone\n\n**Next steps**\n- Theo: fold',
      ts: t0 + 120_000,
      reactions: [],
      kind: 'summary',
    },
  ],
  typing: [],
  phase: 'resolved',
  rounds: 3,
  judge: { verdict: 'converged', note: 'all agree', at: t0 + 100_000 },
  startedAt: t0,
  resolvedAt: t0 + 120_000,
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('roomRecord', () => {
  it('leads with the summary, lists people and the thread with reactions', () => {
    const md = roomRecord(room())
    expect(md.startsWith('# Room: Should Relay auto-archive idle chats?\n')).toBe(true)
    expect(md).toContain('- Date: 2026-10-26 14:05, 2 min, 3 rounds')
    expect(md).toContain('- Summary by: Judge')
    expect(md).toContain('- Judge: converged: all agree')
    expect(md).toContain('## Summary\n\n**Decision**\nFold idle chats; never delete.')
    expect(md).toContain(
      '- Theo Lindqvist, Senior Engineer (Builder, openai-codex/gpt-5.6-luna), dropped out',
    )
    expect(md).toContain('- 14:05 **Mara**: What breaks?\n  👍 Isaac, Theo')
    expect(md).toContain('**Isaac**: Nothing, hopefully.')
    expect(md).toContain('**Room**: Theo dropped out')
    // The summary is not repeated in the thread.
    expect(md.split('Fold idle chats').length).toBe(2)
  })
})

describe('journalEntry', () => {
  it('is the eva-interface heading with the decision and the file', () => {
    expect(journalEntry(room(), '/eva/memory/rooms/x.md')).toEqual({
      heading: '2026-10-26 [eva-interface] Room: Should Relay auto-archive idle chats?',
      bullets: ['Decision: Fold idle chats; never delete.', 'Record: /eva/memory/rooms/x.md'],
    })
  })
})

describe('saveRoom', () => {
  it('writes memory/rooms/<date>-<slug>.md, never clobbers, then journals', async () => {
    const evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'))
    dirs.push(evaRoot)
    const calls: [string, string[]][] = []
    const journal = async (h: string, b: string[]): Promise<void> => {
      calls.push([h, b])
    }
    const a = await saveRoom(room(), { evaRoot, journal })
    expect(a).toBe(
      path.join(evaRoot, 'memory/rooms/2026-10-26-should-relay-auto-archive-idle-chats.md'),
    )
    expect(fs.readFileSync(a, 'utf8')).toContain('## Thread')
    const b = await saveRoom(room(), { evaRoot, journal })
    expect(b).toBe(
      path.join(evaRoot, 'memory/rooms/2026-10-26-should-relay-auto-archive-idle-chats-2.md'),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]![1][1]).toBe(`Record: ${a}`)
    expect(dateStamp(t0)).toBe('2026-10-26')
  })

  it('reports a failed journal after the file is written', async () => {
    const evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'))
    dirs.push(evaRoot)
    await expect(
      saveRoom(room(), {
        evaRoot,
        journal: async () => {
          throw new Error('journal-add exited 1')
        },
      }),
    ).rejects.toThrow('journal-add exited 1')
    expect(fs.readdirSync(path.join(evaRoot, 'memory/rooms'))).toHaveLength(1)
  })
})

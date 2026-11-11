import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Room, RoomAgent } from '@evaos/contract'
import { createEvaFs, installWriteTrap, type EvaFs } from '@evaos/eva-core'
import { dateStamp, journalEntry, roomRecord, saveRoom } from './save'

const t0 = new Date(2026, 9, 26, 14, 5).getTime()
const person = (
  id: string,
  name: string,
  title: string,
  role: string,
  model: string,
): RoomAgent => ({
  id,
  name,
  title,
  role,
  brief: '',
  model,
  tools: 'none',
  color: 'blue',
})
const room = (): Room => ({
  id: 'room-1',
  kind: 'council',
  title: 'Should Relay auto-archive idle chats?',
  prompt: 'Should Relay auto-archive idle chats?\nContext line.',
  agents: [
    person('skeptic', 'Mara Voss', 'Principal Engineer', 'Skeptic', 'anthropic/claude-opus-5-5'),
    {
      ...person(
        'builder',
        'Theo Lindqvist',
        'Senior Engineer',
        'Builder',
        'openai-codex/gpt-6.1-sol',
      ),
      failed: true,
    },
  ],
  messages: [
    {
      id: 'm1',
      author: 'skeptic',
      text: 'What breaks?',
      ts: t0 + 1000,
      reactions: [{ emoji: '👍', by: ['isaac', 'builder'] }],
      mentions: [],
      kind: 'message',
    },
    {
      id: 'm2',
      author: 'isaac',
      text: 'Nothing, hopefully.',
      ts: t0 + 2000,
      reactions: [],
      mentions: [],
      kind: 'message',
    },
    {
      id: 'm3',
      author: 'system',
      text: 'Theo dropped out of the room (gone).',
      ts: t0 + 3000,
      reactions: [],
      mentions: [],
      kind: 'message',
    },
    {
      id: 'm4',
      author: 'judge',
      text: '**Decision**\nFold idle chats; never delete.\n\n**Dissent**\nNone\n\n**Next steps**\n- Theo: fold',
      ts: t0 + 120_000,
      reactions: [],
      mentions: [],
      kind: 'summary',
    },
  ],
  presence: {},
  phase: 'resolved',
  rounds: 3,
  judge: { verdict: 'converged', note: 'all agree', at: t0 + 100_000 },
  startedAt: t0,
  resolvedAt: t0 + 120_000,
})

const dirs: string[] = []
const traps: (() => void)[] = []
afterEach(() => {
  for (const off of traps.splice(0)) off()
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
      '- Theo Lindqvist, Senior Engineer (Builder, openai-codex/gpt-6.1-sol), dropped out',
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
  /** A protected Eva root: unmarked writes under it throw, exactly as in the app. */
  const trapped = (): { evaRoot: string; evaFs: EvaFs; hits: string[] } => {
    const evaRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-')))
    dirs.push(evaRoot)
    const hits: string[] = []
    const off = installWriteTrap({
      protectedRoots: [evaRoot],
      allowRoots: [],
      onBlock: (p) => hits.push(p),
    })
    traps.push(off)
    return { evaRoot, evaFs: createEvaFs({ root: evaRoot }), hits }
  }

  it('writes memory/rooms/<date>-<slug>.md through EvaFs under the trap, never clobbers, then journals', async () => {
    const { evaRoot, evaFs, hits } = trapped()
    expect(() => fs.writeFileSync(path.join(evaRoot, 'memory/x.md'), 'x')).toThrow('write trap')
    const calls: [string, string[]][] = []
    const journal = async (h: string, b: string[]): Promise<void> => {
      calls.push([h, b])
    }
    const a = await saveRoom(room(), { evaRoot, evaFs, journal })
    expect(a).toBe(
      path.join(evaRoot, 'memory/rooms/2026-10-26-should-relay-auto-archive-idle-chats.md'),
    )
    expect(fs.readFileSync(a, 'utf8')).toContain('## Thread')
    const b = await saveRoom(room(), { evaRoot, evaFs, journal })
    expect(b).toBe(
      path.join(evaRoot, 'memory/rooms/2026-10-26-should-relay-auto-archive-idle-chats-2.md'),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]![1][1]).toBe(`Record: ${a}`)
    expect(hits).toEqual([path.join(evaRoot, 'memory/x.md')])
    expect(dateStamp(t0)).toBe('2026-10-26')
  })

  it('the journal child process is outside the trap', async () => {
    const { evaRoot, evaFs, hits } = trapped()
    const journalFile = path.join(evaRoot, 'memory/journal.md')
    // Stands in for `bun journal-add.ts`: another process appending to memory/journal.md.
    const journal = (h: string, b: string[]): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      execFile(
        process.execPath,
        [
          '-e',
          'require("fs").appendFileSync(process.argv[1], process.argv.slice(2).join("\\n") + "\\n")',
          journalFile,
          h,
          ...b,
        ],
        (e) => (e ? reject(e) : resolve()),
      )
      return promise
    }
    await saveRoom(room(), { evaRoot, evaFs, journal })
    expect(fs.readFileSync(journalFile, 'utf8')).toContain('[eva-interface] Room:')
    expect(hits).toEqual([])
  })

  it('reports a failed journal after the file is written', async () => {
    const { evaRoot, evaFs } = trapped()
    await expect(
      saveRoom(room(), {
        evaRoot,
        evaFs,
        journal: async () => {
          throw new Error('journal-add exited 1')
        },
      }),
    ).rejects.toThrow('journal-add exited 1')
    expect(fs.readdirSync(path.join(evaRoot, 'memory/rooms'))).toHaveLength(1)
  })
})

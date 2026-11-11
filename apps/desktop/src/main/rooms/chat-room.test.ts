import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRoomSetup, Room } from '@evaos/contract'
import { ChatRoom } from './chat-room'
import { readRoomStates } from './council/state'

const SETUP: ChatRoomSetup = {
  template: 'debate',
  members: [
    {
      id: 'nova',
      assistant: 'nova',
      name: 'Nova',
      model: 'anthropic/claude-opus-5-5',
      thinking: 'high',
      role: 'Judge',
    },
    {
      id: 'builder',
      name: 'Builder',
      model: 'openai-codex/gpt-6-sol',
      thinking: 'medium',
      role: 'Argue for',
    },
  ],
  effort: 3,
  budget: 3,
  folder: 'work/src',
  refs: ['/tmp/ref.png'],
  draft: 'Start with the weapons.',
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function deps() {
  const roomsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rooms-'))
  dirs.push(roomsDir)
  const changes: Room[] = []
  return { roomsDir, changes, onChange: (r: Room) => changes.push(r), log: () => undefined }
}

/** What a new app run lists from disk. */
const reload = (roomsDir: string): Room[] =>
  readRoomStates(roomsDir, () => undefined).flatMap((s) =>
    'kind' in s
      ? [ChatRoom.restore(s, { roomsDir, onChange: () => undefined, log: () => undefined }).room]
      : [],
  )

describe('ChatRoom', () => {
  it('is saved idle at once and comes back after a restart with the same setup', () => {
    const d = deps()
    const r = ChatRoom.create('room-a', SETUP, 1000, d)
    expect(r.room).toMatchObject({ kind: 'chat', phase: 'idle', title: 'New room', messages: [] })
    const [back] = reload(d.roomsDir)
    expect(back).toMatchObject({ id: 'room-a', kind: 'chat', phase: 'idle', startedAt: 1000 })
    expect(back!.chat).toEqual({ setup: SETUP, rev: 0 })
    expect(back!.agents.map((a) => [a.id, a.model, a.role])).toEqual([
      ['nova', 'anthropic/claude-opus-5-5', 'Judge'],
      ['builder', 'openai-codex/gpt-6-sol', 'Argue for'],
    ])
  })

  it("Isaac's first message is kept and names the room; the room stays idle until the engine runs", () => {
    const d = deps()
    const r = ChatRoom.create('room-b', SETUP, 1000, d)
    r.post('Should @Nova pick Postgres?\nDetails follow.')
    r.post('And a second thought.')
    expect(r.room.title).toBe('Should @Nova pick Postgres?')
    expect(r.room.phase).toBe('idle')
    expect(r.room.messages.map((m) => [m.id, m.author, m.mentions])).toEqual([
      ['m1', 'isaac', ['nova']],
      ['m2', 'isaac', []],
    ])
    const [back] = reload(d.roomsDir)
    expect(back!.title).toBe('Should @Nova pick Postgres?')
    expect(back!.chat!.setup.title).toBe('Should @Nova pick Postgres?')
    expect(back!.messages).toHaveLength(2)
  })

  it('rename and update are saved; members are replaced whole and null clears a field', () => {
    const d = deps()
    const r = ChatRoom.create('room-c', SETUP, 1000, d)
    r.rename('Boxhead weapons')
    const rev = r.update({ members: [SETUP.members[1]!], folder: null, budget: 5 })
    expect(rev).toBe(1)
    const [back] = reload(d.roomsDir)
    expect(back!.title).toBe('Boxhead weapons')
    expect(back!.chat!.rev).toBe(1)
    expect(back!.chat!.setup.members.map((m) => m.id)).toEqual(['builder'])
    expect(back!.chat!.setup.folder).toBeUndefined()
    expect(back!.chat!.setup.budget).toBe(5)
    expect(back!.agents.map((a) => a.id)).toEqual(['builder'])
    expect(() => r.update({ members: [] })).toThrow()
    expect(d.changes.length).toBeGreaterThanOrEqual(2)
  })
})

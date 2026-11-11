import { describe, expect, it } from 'vitest'
import {
  ChatRoomSetupPatchSchema,
  ChatRoomSetupSchema,
  autoTitle,
  fitThinking,
  memberProblem,
  templateMembers,
  type CatalogModel,
} from './rooms-chat'
import { roomRunAction, roomsInvoke } from './rooms'

const member = {
  id: 'astra',
  assistant: 'astra',
  name: 'Astra',
  model: 'anthropic/claude-opus-5-5',
  thinking: 'high',
  role: 'Argue for',
} as const
const setup = { template: 'debate', members: [member], effort: 3, budget: 3, refs: [] }
const CATALOG: CatalogModel[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', levels: ['off', 'low', 'medium', 'high'] },
  { provider: 'apple', id: 'on-device', levels: [] },
]

describe('chat room setup', () => {
  it('takes a valid setup and refuses bad models, levels, budgets and repeated members', () => {
    expect(ChatRoomSetupSchema.safeParse(setup).success).toBe(true)
    const bad = (patch: Record<string, unknown>): boolean =>
      ChatRoomSetupSchema.safeParse({ ...setup, ...patch }).success
    expect(bad({ members: [{ ...member, model: 'claude-opus-5-5' }] })).toBe(false)
    expect(bad({ members: [{ ...member, thinking: 'ultra' }] })).toBe(false)
    expect(bad({ members: [] })).toBe(false)
    expect(bad({ members: [member, member] })).toBe(false)
    expect(bad({ budget: 0 })).toBe(false)
    expect(bad({ effort: 6 })).toBe(false)
    expect(bad({ refs: Array.from({ length: 13 }, (_, i) => `/r${i}`) })).toBe(false)
    expect(roomsInvoke['rooms.open'].input.safeParse({ setup }).success).toBe(true)
  })

  it('a patch may clear the folder and draft, and still refuses repeated members', () => {
    expect(ChatRoomSetupPatchSchema.safeParse({ folder: null, draft: null }).success).toBe(true)
    expect(ChatRoomSetupPatchSchema.safeParse({ members: [member, member] }).success).toBe(false)
  })

  it("checks members against omp's catalog: the model must be listed and take the level", () => {
    expect(memberProblem([{ ...member, thinking: 'high' }], CATALOG)).toBeNull()
    expect(memberProblem([{ ...member, model: 'anthropic/nope' }], CATALOG)).toContain(
      'not a model omp lists',
    )
    expect(
      memberProblem(
        [{ ...member, model: 'anthropic/claude-sonnet-4-6', thinking: 'max' }],
        CATALOG,
      ),
    ).toContain('not max')
    expect(
      memberProblem([{ ...member, model: 'apple/on-device', thinking: 'off' }], CATALOG),
    ).toBeNull()
  })

  it('fits a thinking level to what the model takes', () => {
    expect(fitThinking('max', ['off', 'low', 'medium', 'high'])).toBe('high')
    expect(fitThinking('medium', ['off', 'low', 'medium', 'high'])).toBe('medium')
    expect(fitThinking('high', [])).toBe('off')
  })

  it('templates fill assistant slots in order, the rest as custom agents with role instructions', () => {
    const opus = CATALOG[0]!
    const debate = templateMembers('debate', [{ id: 'nova', title: 'Nova' }], () => opus)
    expect(debate.map((m) => [m.id, m.assistant, m.name, m.role, m.thinking])).toEqual([
      ['nova', 'nova', 'Nova', 'Argue for', 'high'],
      ['agent-2', undefined, 'Agent 2', 'Argue against', 'high'],
      ['agent-3', undefined, 'Agent 3', 'Judge', 'medium'],
    ])
    expect(debate[2]!.instructions).toBe('Summarise each round, pin the decision.')
    const build = templateMembers('build', [], () => CATALOG[1]!)
    expect(build.map((m) => m.name)).toEqual(['Agent 1', 'Builder', 'Reviewer'])
    expect(build.every((m) => m.model === 'anthropic/claude-sonnet-4-6')).toBe(true)
    expect(ChatRoomSetupSchema.safeParse({ ...setup, members: build }).success).toBe(true)
  })

  it('names a room from the first line of the first message', () => {
    expect(autoTitle('\n  Should we move   storage to Postgres?\nmore')).toBe(
      'Should we move storage to Postgres?',
    )
    const long = autoTitle('word '.repeat(30))
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
    expect(autoTitle('   ')).toBe('New room')
  })

  it('offers Pause only while a council room runs and Resume once it stopped', () => {
    const council = { pauseRequested: false } as never
    expect(roomRunAction({ phase: 'idle' })).toBeNull()
    expect(roomRunAction({ phase: 'open', council })).toBe('pause')
    expect(roomRunAction({ phase: 'paused', council })).toBe('resume')
    expect(roomRunAction({ phase: 'open', council: { pauseRequested: true } as never })).toBeNull()
  })
})

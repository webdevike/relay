import { describe, expect, it } from 'vitest'
import { agentActions } from './agent'
import {
  ASSISTANT_ROOM_LIMITS,
  assistantCeiling,
  boundsProblem,
  changeMembers,
  isaacLimits,
  resolveMembers,
  roomCardToken,
} from './rooms-agent'
import type { ChatRoomSetup } from './rooms-chat'

const OPUS = 'anthropic/claude-opus-5-5'
const SOL = 'openai/gpt-6-sol'
const ASSISTANTS = [{ id: 'astra', title: 'Astra' }]
const CATALOG = [
  { provider: 'anthropic', id: 'claude-opus-5-5', levels: ['off', 'low', 'high'] },
  { provider: 'openai', id: 'gpt-6-sol', levels: ['off', 'medium'] },
]

const members = resolveMembers(
  [
    { assistant: 'astra', model: OPUS, thinking: 'low', role: 'Builder' },
    { custom: 'Sol', model: SOL, thinking: 'medium', role: 'Critic', instructions: 'Cut scope.' },
  ],
  ASSISTANTS,
)

describe('rooms.create / rooms.update params', () => {
  const create = agentActions['rooms.create'].params
  const ok = {
    members: [{ custom: 'Sol', model: SOL, thinking: 'medium', role: '' }],
    effort: 2,
    budget: 3,
  }

  it('takes members, effort and budget; a proposal needs its question', () => {
    expect(create.safeParse(ok).success).toBe(true)
    expect(create.safeParse({ ...ok, proposal: true }).success).toBe(false)
    expect(create.safeParse({ ...ok, proposal: true, draft: 'Godot or Unreal?' }).success).toBe(
      true,
    )
    expect(create.safeParse({ ...ok, effort: 6 }).success).toBe(false)
    expect(create.safeParse({ ...ok, members: [{ ...ok.members[0], model: 'gpt' }] }).success).toBe(
      false,
    )
    expect(create.safeParse({ ...ok, members: [] }).success).toBe(false)
    expect(create.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })

  it('update takes a full list or add / remove / replace', () => {
    const update = agentActions['rooms.update'].params
    expect(update.safeParse({ roomId: 'r', members: ok.members }).success).toBe(true)
    expect(
      update.safeParse({ roomId: 'r', members: { replace: { from: 'Sol', to: { model: OPUS } } } })
        .success,
    ).toBe(true)
    expect(update.safeParse({ roomId: 'r', folder: null, draft: null }).success).toBe(true)
    expect(update.safeParse({ roomId: 'r', members: { swap: 1 } }).success).toBe(false)
  })
})

describe('members', () => {
  it('an assistant keeps its id and registry name; a custom agent gets a slug', () => {
    expect(members.map((m) => [m.id, m.name, m.assistant])).toEqual([
      ['astra', 'Astra', 'astra'],
      ['sol', 'Sol', undefined],
    ])
    expect(() =>
      resolveMembers([{ assistant: 'nope', model: OPUS, thinking: 'low', role: '' }], ASSISTANTS),
    ).toThrow(/No assistant nope/)
  })

  it('replace keeps the role, instructions and place; thinking fits the new model', () => {
    const next = changeMembers(
      members,
      { replace: { from: 'sol', to: { custom: 'Opus', model: OPUS } } },
      ASSISTANTS,
      CATALOG,
    )
    expect(next.map((m) => m.name)).toEqual(['Astra', 'Opus'])
    expect(next[1]).toMatchObject({
      id: 'opus',
      model: OPUS,
      role: 'Critic',
      instructions: 'Cut scope.',
      thinking: 'high',
    })
    const sameName = changeMembers(
      members,
      { replace: { from: 'Sol', to: { model: OPUS, thinking: 'low' } } },
      ASSISTANTS,
      CATALOG,
    )
    expect(sameName[1]).toMatchObject({
      id: 'sol',
      name: 'Sol',
      model: OPUS,
      thinking: 'low',
      role: 'Critic',
    })
  })

  it('remove then add; unknown names and an empty room are refused', () => {
    const next = changeMembers(
      members,
      {
        remove: ['Astra'],
        add: [{ custom: 'Fable', model: OPUS, thinking: 'low', role: 'Builder' }],
      },
      ASSISTANTS,
      CATALOG,
    )
    expect(next.map((m) => m.id)).toEqual(['sol', 'fable'])
    expect(() => changeMembers(members, { remove: ['Iris'] }, ASSISTANTS, CATALOG)).toThrow(
      /No member Iris/,
    )
    expect(() => changeMembers(members, { remove: ['astra', 'sol'] }, ASSISTANTS, CATALOG)).toThrow(
      /at least one/,
    )
    expect(() => changeMembers(members, {}, ASSISTANTS, CATALOG)).toThrow()
  })
})

describe('limits for assistant-made rooms', () => {
  const setup: ChatRoomSetup = { template: 'blank', members, effort: 2, budget: 3, refs: [] }

  it('caps budget and effort; Isaac lifts them for his room', () => {
    expect(ASSISTANT_ROOM_LIMITS).toEqual({ budget: 10, effort: 4 })
    expect(boundsProblem({ budget: 10, effort: 4 }, ASSISTANT_ROOM_LIMITS)).toBeNull()
    expect(boundsProblem({ budget: 12 }, ASSISTANT_ROOM_LIMITS)).toMatch(/budget \$12 is over \$10/)
    expect(boundsProblem({ effort: 5 }, ASSISTANT_ROOM_LIMITS)).toMatch(
      /effort 5 is over 4 \(Deep\)/,
    )
    const raised = isaacLimits(ASSISTANT_ROOM_LIMITS, { budget: 30, effort: 5 })
    expect(raised).toEqual({ budget: 30, effort: 5 })
    expect(
      boundsProblem({ budget: 25, effort: 5 }, assistantCeiling({ setup, limits: raised })),
    ).toBeNull()
    // Isaac's own room: the default, or what he set when that is higher.
    expect(assistantCeiling({ setup: { ...setup, budget: 40 } })).toEqual({ budget: 40, effort: 4 })
  })

  it('names the card token with the title', () => {
    expect(roomCardToken('room-1')).toBe('[[room:room-1]]')
    expect(roomCardToken('room-1', 'Boxhead | weapons')).toBe('[[room:room-1 | Boxhead weapons]]')
  })
})

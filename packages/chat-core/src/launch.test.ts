import { describe, expect, it } from 'vitest'
import {
  APPROVAL_LABEL,
  claudeArgs,
  contextPercent,
  foldModels,
  goalCommand,
  IMAGE_MIME,
  isHandoff,
  MAX_IMAGE_BYTES,
  ompArgs,
  parseCommands,
  parseModels,
  readApproval,
  readThinking,
  renameArgs,
  slashMatches,
} from './launch'

describe('slash commands', () => {
  const cmd = (name: string, source?: string) => ({ name, description: name, source })
  const commands = parseCommands({
    commands: [
      cmd('skill:adhd', 'skill'),
      cmd('model', 'builtin'),
      cmd('review', 'file'),
      cmd('goal', 'builtin'),
      cmd('handoff', 'builtin'),
      cmd('skill:blender'),
      cmd('compact', 'builtin'),
    ],
  })

  it('orders goal, then builtins, then other commands, then skills, keeping omp order', () => {
    expect(commands.map((c) => c.name)).toEqual([
      'goal',
      'model',
      'handoff',
      'compact',
      'review',
      'skill:adhd',
      'skill:blender',
    ])
  })

  it('offers the goal subcommands after `/goal `', () => {
    expect(slashMatches(commands, '/').hits[0]!.name).toBe('goal')
    expect(slashMatches(commands, '/goal ')).toMatchObject({ prefix: '/goal ' })
    expect(slashMatches(commands, '/goal ').hits.map((c) => c.name)).toEqual([
      'set',
      'status',
      'pause',
      'resume',
      'drop',
    ])
  })

  it('maps /goal text onto the RPC goal command', () => {
    const g = (op: string, objective?: string) =>
      objective === undefined ? { type: 'goal', op } : { type: 'goal', op, objective }
    expect(goalCommand('/goal')).toEqual(g('get'))
    expect(goalCommand('  /goal status ')).toEqual(g('get'))
    expect(goalCommand('/goal get')).toEqual(g('get'))
    expect(goalCommand('/goal pause')).toEqual(g('pause'))
    expect(goalCommand('/goal resume')).toEqual(g('resume'))
    expect(goalCommand('/goal drop')).toEqual(g('drop'))
    expect(goalCommand('/goal clear')).toEqual(g('drop'))
    expect(goalCommand('/goal set  ship it ')).toEqual(g('create', 'ship it'))
    expect(goalCommand('/goal create x')).toEqual(g('create', 'x'))
    expect(goalCommand('/goal ship it')).toEqual(g('create', 'ship it'))
    expect(goalCommand('/goal pause now')).toEqual(g('create', 'pause now'))
    expect(goalCommand('/goals')).toBeNull()
    expect(goalCommand('hi /goal')).toBeNull()
  })

  it('knows a /handoff prompt', () => {
    expect(isHandoff('/handoff')).toBe(true)
    expect(isHandoff(' /handoff keep the API notes')).toBe(true)
    expect(isHandoff('/handoffs')).toBe(false)
  })
})

describe('argv', () => {
  it('passes only approval by default', () => {
    expect(ompArgs({ approval: 'yolo', profile: null })).toEqual(['--approval-mode', 'yolo'])
  })
  it('orders profile, model, thinking, approval', () => {
    expect(
      ompArgs({
        approval: 'always-ask',
        profile: 'work',
        model: ['anthropic', 'claude-x'],
        thinking: 'high',
      }),
    ).toEqual([
      '--profile',
      'work',
      '--model',
      'anthropic/claude-x',
      '--thinking',
      'high',
      '--approval-mode',
      'always-ask',
    ])
  })
  it('claude flags drop the profile', () => {
    expect(
      claudeArgs({
        approval: 'write',
        profile: 'work',
        model: ['anthropic', 'opus'],
        thinking: 'off',
      }),
    ).toEqual(['--model', 'anthropic/opus', '--thinking', 'off', '--approval-mode', 'write'])
  })
  it('rename short resume argv', () => {
    expect(renameArgs('omp', '/f')).toEqual([
      '--mode',
      'rpc',
      '--resume',
      '/f',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--no-title',
    ])
    expect(renameArgs('claude', '/f')).toEqual(['--rpc', '--no-relay', '--resume', '/f'])
  })
})

describe('models', () => {
  it('parses levels, images and skips malformed', () => {
    const m = parseModels({
      models: [
        {
          provider: 'anthropic',
          id: 'o',
          name: 'Opus',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 1000,
          thinking: { efforts: ['low', 'high'] },
        },
        {
          provider: 'p',
          id: 'x',
          reasoning: false,
          input: ['text'],
          thinking: { efforts: ['low'] },
        },
        { id: 'broken' },
        'junk',
      ],
    })
    expect(m).toHaveLength(2)
    expect(m[0]).toMatchObject({
      levels: ['off', 'low', 'high'],
      images: true,
      contextWindow: 1000,
    })
    expect(m[1]).toMatchObject({ levels: [], images: false, name: 'x', contextWindow: null })
  })
  it('folds dated aliases newest first', () => {
    const mk = (id: string, name: string, provider = 'a') => ({
      provider,
      id,
      name,
      contextWindow: null,
      images: false,
      levels: [],
    })
    const out = foldModels([
      mk('claude-haiku-4-5-20251001', 'Haiku'),
      mk('claude-haiku-4-5', 'Haiku'),
      mk('gpt', 'GPT', 'b'),
    ])
    expect(out.map((x) => x.id)).toEqual(['gpt', 'claude-haiku-4-5'])
  })
})

describe('contextPercent', () => {
  it('reads percent, tokens or unavailable', () => {
    expect(contextPercent(50_000, 200_000)).toEqual({ kind: 'percent', value: 25 })
    expect(contextPercent(50_000, null)).toEqual({ kind: 'tokens', value: 50_000 })
    expect(contextPercent(null, 1)).toEqual({ kind: 'unavailable' })
  })
})

describe('approval and constants', () => {
  it('reads project then global then default', () => {
    expect(
      readApproval('tools:\n  approvalMode: "write" # ask\n', 'approvalMode: always-ask'),
    ).toBe('write')
    expect(readApproval(null, 'approvalMode: always-ask')).toBe('always-ask')
    expect(readApproval('approvalMode: bogus', 'approvalMode: write')).toBe('write')
    expect(readApproval(null, null)).toBe('yolo')
  })
  it('reads the top-level default thinking level, project then global', () => {
    expect(readThinking('defaultThinkingLevel: "high" # x\n', 'defaultThinkingLevel: low')).toBe(
      'high',
    )
    expect(readThinking('foo:\n  defaultThinkingLevel: high\n', 'defaultThinkingLevel: low')).toBe(
      'low',
    )
    expect(readThinking(null, null)).toBeNull()
  })
  it('exposes labels and limits', () => {
    expect(APPROVAL_LABEL.yolo).toBe('Full access')
    expect(IMAGE_MIME).toHaveLength(4)
    expect(MAX_IMAGE_BYTES).toBe(20971520)
  })
})

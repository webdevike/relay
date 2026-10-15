import { describe, expect, it } from 'vitest'
import {
  APPROVAL_LABEL,
  claudeArgs,
  contextPercent,
  foldModels,
  IMAGE_MIME,
  MAX_IMAGE_BYTES,
  ompArgs,
  parseModels,
  readApproval,
  renameArgs,
} from './launch'

describe('argv', () => {
  it('passes only approval by default', () => {
    expect(ompArgs({ approval: 'yolo', profile: null })).toEqual(['--approval-mode', 'yolo'])
  })
  it('orders profile, model, thinking, approval', () => {
    expect(
      ompArgs({ approval: 'always-ask', profile: 'work', model: ['anthropic', 'claude-x'], thinking: 'high' }),
    ).toEqual(['--profile', 'work', '--model', 'anthropic/claude-x', '--thinking', 'high', '--approval-mode', 'always-ask'])
  })
  it('claude flags drop the profile', () => {
    expect(claudeArgs({ approval: 'write', profile: 'work', model: ['anthropic', 'opus'], thinking: 'off' })).toEqual([
      '--model',
      'anthropic/opus',
      '--thinking',
      'off',
      '--approval-mode',
      'write',
    ])
  })
  it('rename short resume argv', () => {
    expect(renameArgs('omp', '/f')).toEqual(['--mode', 'rpc', '--resume', '/f', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-title'])
    expect(renameArgs('claude', '/f')).toEqual(['--rpc', '--no-relay', '--resume', '/f'])
  })
})

describe('models', () => {
  it('parses levels, images and skips malformed', () => {
    const m = parseModels({
      models: [
        { provider: 'anthropic', id: 'o', name: 'Opus', reasoning: true, input: ['text', 'image'], contextWindow: 1000, thinking: { efforts: ['low', 'high'] } },
        { provider: 'p', id: 'x', reasoning: false, input: ['text'], thinking: { efforts: ['low'] } },
        { id: 'broken' },
        'junk',
      ],
    })
    expect(m).toHaveLength(2)
    expect(m[0]).toMatchObject({ levels: ['off', 'low', 'high'], images: true, contextWindow: 1000 })
    expect(m[1]).toMatchObject({ levels: [], images: false, name: 'x', contextWindow: null })
  })
  it('folds dated aliases newest first', () => {
    const mk = (id: string, name: string, provider = 'a') => ({ provider, id, name, contextWindow: null, images: false, levels: [] })
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
    expect(readApproval('tools:\n  approvalMode: "write" # ask\n', 'approvalMode: always-ask')).toBe('write')
    expect(readApproval(null, 'approvalMode: always-ask')).toBe('always-ask')
    expect(readApproval('approvalMode: bogus', 'approvalMode: write')).toBe('write')
    expect(readApproval(null, null)).toBe('yolo')
  })
  it('exposes labels and limits', () => {
    expect(APPROVAL_LABEL.yolo).toBe('Full access')
    expect(IMAGE_MIME).toHaveLength(4)
    expect(MAX_IMAGE_BYTES).toBe(20971520)
  })
})

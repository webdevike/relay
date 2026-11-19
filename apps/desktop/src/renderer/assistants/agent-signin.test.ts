import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Assistant, ProfileAuth, TurnFailure } from '@evaos/contract'
import { fixOf, loginCommand, profileSignins, signinPlan, troubleOf } from './agent-signin'

const agent = (id: string, title: string, over: Partial<Assistant> = {}): Assistant => ({
  id,
  title,
  scope: '',
  avatar: { style: 'notionists', seed: id },
  status: 'idle',
  background: 0,
  turn: false,
  tool: null,
  file: `/s/${id}.jsonl`,
  reply: null,
  ...over,
})

const expired: ProfileAuth = {
  profile: 'personal',
  provider: 'anthropic',
  state: 'signed_out',
  detail: 'oauth refresh failed: 400 invalid_grant, Refresh token expired',
  account: 'isaac@example.com',
}
const failure: TurnFailure = {
  at: 1,
  kind: 'auth',
  title: "Nova couldn't reply",
  text: 'No API key found for anthropic. Sign in again under the personal profile.',
  fix: { kind: 'signin', provider: 'anthropic', profile: 'personal' },
}

describe('troubleOf and fixOf', () => {
  it('says nothing for an agent whose sign-in is fine and whose turns went through', () => {
    const a = agent('nova', 'Nova', { auth: { provider: 'anthropic', state: 'ok' } })
    expect(troubleOf(a)).toBeNull()
    expect(fixOf(a)).toBeNull()
    expect(troubleOf(agent('iris', 'Iris'))).toBeNull()
  })

  it("leads with the failed turn in the host's words, and its fix", () => {
    const a = agent('nova', 'Nova', { profile: 'personal', auth: expired, failure })
    expect(troubleOf(a)).toEqual({ title: failure.title, text: failure.text, tone: 'danger' })
    expect(fixOf(a)).toEqual(failure.fix)
  })

  it('flags a broken profile sign-in before a turn fails, fixed by signing that profile in', () => {
    const a = agent('nova', 'Nova', { profile: 'personal', auth: expired })
    expect(troubleOf(a)).toEqual({
      title: 'Claude, personal profile: signed out',
      text: expired.detail,
      tone: 'warn',
    })
    expect(fixOf(a)).toEqual({ kind: 'signin', provider: 'anthropic', profile: 'personal' })
    // No detail from the host: a plain sentence for the state; the default profile has no name.
    const missing = agent('astra', 'Astra', {
      auth: { provider: 'openai-codex', state: 'missing' },
    })
    expect(troubleOf(missing)?.title).toBe('ChatGPT, default profile: not signed in')
    expect(troubleOf(missing)?.text).toMatch(/never signed in/)
    expect(fixOf(missing)).toEqual({ kind: 'signin', provider: 'openai-codex' })
  })

  it('has no fix for a failure signing in does not cure', () => {
    const limit = agent('nova', 'Nova', {
      failure: { at: 1, kind: 'rate_limit', title: "Nova couldn't reply", text: 'Usage limit.' },
    })
    expect(troubleOf(limit)?.tone).toBe('danger')
    expect(fixOf(limit)).toBeNull()
  })
})

describe('signinPlan', () => {
  it("runs setup's browser sign-in for Claude and ChatGPT under the profile", () => {
    expect(
      signinPlan({ kind: 'signin', provider: 'anthropic', profile: 'personal' }, undefined),
    ).toEqual({ kind: 'run', provider: 'anthropic' })
    expect(signinPlan({ kind: 'signin', provider: 'openai-codex' }, undefined)).toEqual({
      kind: 'run',
      provider: 'openai',
    })
  })

  it('gives the command for a provider setup cannot sign in', () => {
    const fix = { kind: 'signin' as const, provider: 'google-gemini-cli', profile: 'work' }
    expect(signinPlan(fix, undefined)).toEqual({
      kind: 'command',
      command: 'omp --profile work login google-gemini-cli',
    })
    expect(loginCommand({ kind: 'signin', provider: 'anthropic' })).toBe('omp login anthropic')
  })

  it("sends a thin client to the host's Mac instead of signing in this one's omp", () => {
    expect(
      signinPlan({ kind: 'signin', provider: 'anthropic', profile: 'personal' }, 'Mac mini'),
    ).toEqual({
      kind: 'elsewhere',
      mac: 'Mac mini',
    })
  })
})

describe('profileSignins', () => {
  it('lists each (profile, provider) once with every assistant on it, a problem marking it', () => {
    const rows = profileSignins([
      agent('astra', 'Astra', { auth: { provider: 'anthropic', state: 'ok', account: 'a@x.com' } }),
      // Nova's turns went through before the refresh token expired: Penny's report marks the row.
      agent('nova', 'Nova', {
        profile: 'personal',
        auth: {
          profile: 'personal',
          provider: 'anthropic',
          state: 'ok',
          account: 'isaac@example.com',
        },
      }),
      agent('penny', 'Penny', { profile: 'personal', auth: expired }),
      agent('polaris', 'Polaris', {
        profile: 'personal',
        auth: { profile: 'personal', provider: 'openai-codex', state: 'shared' },
      }),
      // No word from the host on its sign-in: not listed.
      agent('iris', 'Iris'),
    ])
    expect(rows.map((r) => [r.key, r.title, r.state, r.usedBy])).toEqual([
      ['default:anthropic', 'Claude, default profile', 'ok', ['Astra']],
      ['personal:anthropic', 'Claude, personal profile', 'signed_out', ['Nova', 'Penny']],
      ['personal:openai-codex', 'ChatGPT, personal profile', 'shared', ['Polaris']],
    ])
    expect(rows[0]).toMatchObject({
      account: 'a@x.com',
      fix: { kind: 'signin', provider: 'anthropic' },
    })
    expect(rows[0]?.detail).toBeUndefined()
    expect(rows[1]).toMatchObject({
      detail: expired.detail,
      account: 'isaac@example.com',
      fix: { kind: 'signin', provider: 'anthropic', profile: 'personal' },
    })
    expect(rows[2]?.detail).toMatch(/shares a sign-in/)
  })
})

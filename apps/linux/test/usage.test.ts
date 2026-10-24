/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageAccount } from '@relay/protocol'
import {
  discoverProfiles,
  failureReason,
  mergeProfile,
  parseUsageOutput,
  profileLabel,
  type ProfileUsage,
} from '../src/usage/usage'

const fixture = (profile: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures/omp-usage', `${profile}.json`), 'utf8')

describe('parseUsageOutput', () => {
  it('reads both providers from a captured work profile', () => {
    const u = parseUsageOutput(fixture('work'))!
    expect(u.missing).toEqual({})
    expect(u.providers.anthropic!.email).toBe('work@example.org')
    expect(u.providers.anthropic!.windows.map((w) => [w.id, w.label, w.usedFraction])).toEqual([
      ['anthropic:5h', '5 hours', 0.08],
      ['anthropic:7d', '7 days', 0.82],
      ['anthropic:7d:fable', '7 days (Fable)', 0.31],
    ])
    expect(u.providers['openai-codex']!.windows.map((w) => [w.label, w.usedFraction])).toEqual([
      ['5 hours', 0.94],
      ['7 days', 0.37],
    ])
    const w = u.providers.anthropic!.windows[0]!
    expect(w.status).toBe('ok')
    expect(typeof w.resetsAt).toBe('number')
    expect(u.providers.anthropic!.fetchedAt).toBeGreaterThan(0)
  })

  it('keeps a profile whose Codex account reports only the 7-day window', () => {
    const u = parseUsageOutput(fixture('personal'))!
    expect(u.providers['openai-codex']!.windows.map((w) => w.label)).toEqual(['7 days'])
    expect(u.providers['openai-codex']!.email).toBe('personal@example.com')
  })

  it('tolerates extra fields, skips unreadable limits and derives a fraction from used/limit', () => {
    const doc = {
      generatedAt: 5,
      extra: { anything: true },
      reports: [
        {
          provider: 'anthropic',
          limits: [
            { id: 'bad' },
            {
              id: 'anthropic:x',
              label: 'Claude Odd',
              window: { durationMs: 90 * 60_000, resetsAt: null, future: 1 },
              amount: { used: 3, limit: 4 },
              status: 'limited',
              novel: [1, 2],
            },
          ],
        },
        { provider: 'someone-else', limits: [] },
        'not a report',
      ],
    }
    const u = parseUsageOutput(JSON.stringify(doc))!
    expect(u.providers.anthropic).toEqual({
      email: null,
      fetchedAt: 5,
      windows: [
        {
          id: 'anthropic:x',
          label: 'Claude Odd',
          usedFraction: 0.75,
          resetsAt: null,
          status: 'limited',
        },
      ],
    })
    expect(u.missing['openai-codex']).toBe('No Codex account in this profile')
  })

  it('names disabled credentials and accounts without usage', () => {
    const u = parseUsageOutput(
      JSON.stringify({
        reports: [],
        disabledCredentials: [{ provider: 'anthropic', reason: 'x' }],
        accountsWithoutUsage: ['openai-codex:acct'],
      }),
    )!
    expect(u.missing).toEqual({
      anthropic: 'omp has the Claude credential disabled',
      'openai-codex': 'omp reports no Codex usage for this account',
    })
  })

  it('rejects output that is not the usage document', () => {
    expect(parseUsageOutput('not json')).toBeNull()
    expect(parseUsageOutput('{"hello":1}')).toBeNull()
  })
})

describe('discoverProfiles', () => {
  let dir = ''
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lists profile folders sorted, skipping files, dot folders and odd names', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-profiles-'))
    for (const d of ['work', 'personal', '.hidden', 'bad name']) fs.mkdirSync(path.join(dir, d))
    fs.writeFileSync(path.join(dir, 'notes.txt'), '')
    fs.mkdirSync(path.join(dir, '..', path.basename(dir) + '-target'), { recursive: true })
    fs.symlinkSync(path.join(dir, '..', path.basename(dir) + '-target'), path.join(dir, 'linked'))
    expect(discoverProfiles(dir)).toEqual(['linked', 'personal', 'work'])
    fs.rmSync(path.join(dir, '..', path.basename(dir) + '-target'), { recursive: true })
  })

  it('is empty when the folder is missing', () => {
    expect(discoverProfiles('/nonexistent/evaos-profiles')).toEqual([])
  })

  it('labels a profile by capitalizing it', () => {
    expect(profileLabel('work')).toBe('Work')
  })
})

describe('mergeProfile', () => {
  const work = parseUsageOutput(fixture('work'))!

  it('builds one account per provider from a good fetch', () => {
    const out = mergeProfile([], 'work', { ok: true, usage: work })
    expect(out.map((a) => [a.key, a.profileLabel, a.stale, a.error, a.windows.length])).toEqual([
      ['work:anthropic', 'Work', false, null, 3],
      ['work:openai-codex', 'Work', false, null, 2],
    ])
  })

  it('keeps the last good windows, marked stale, when a fetch fails', () => {
    const before = mergeProfile([], 'work', { ok: true, usage: work })
    const out = mergeProfile(before, 'work', {
      ok: false,
      reason: 'omp usage timed out after 20 s',
    })
    expect(out[0]).toEqual({ ...before[0], stale: true, error: 'omp usage timed out after 20 s' })
    // A later good fetch clears the mark.
    expect(mergeProfile(out, 'work', { ok: true, usage: work })[0]).toEqual(before[0])
  })

  it('shows no data, never invented numbers, when a failure has nothing to keep', () => {
    const out = mergeProfile([], 'work', { ok: false, reason: 'boom' })
    expect(out[0]).toMatchObject({ windows: [], fetchedAt: null, stale: false, error: 'boom' })
  })

  it('treats a provider missing from a good fetch like a failure for that account', () => {
    const before = mergeProfile([], 'work', { ok: true, usage: work })
    const onlyClaude: ProfileUsage = {
      providers: { anthropic: work.providers.anthropic! },
      missing: { 'openai-codex': 'omp reports no Codex usage for this account' },
    }
    const out: UsageAccount[] = mergeProfile(before, 'work', { ok: true, usage: onlyClaude })
    expect(out[0]!.stale).toBe(false)
    expect(out[1]).toMatchObject({
      stale: true,
      error: 'omp reports no Codex usage for this account',
      windows: before[1]!.windows,
    })
  })
})

describe('failureReason', () => {
  it('prefers a timeout, then the last stderr line, then the exit code', () => {
    expect(failureReason({ code: null, stderr: '', timedOut: true }, 20_000)).toBe(
      'omp usage timed out after 20 s',
    )
    expect(failureReason({ code: 1, stderr: 'a\nno credentials\n', timedOut: false }, 1)).toBe(
      'no credentials',
    )
    expect(failureReason({ code: 2, stderr: '', timedOut: false }, 1)).toBe(
      'omp usage exited with code 2',
    )
    expect(failureReason({ code: null, stderr: '', timedOut: false }, 1)).toBe(
      'omp usage could not start',
    )
  })
})

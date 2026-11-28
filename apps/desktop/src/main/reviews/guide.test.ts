import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewGuideSchema } from '@evaos/contract'
import { ReviewGuide as ProtocolReviewGuide } from '@relay/protocol'
import { folderSections } from '@relay/protocol/review-guide'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import { createConfigStore, type ConfigStore } from '../config-store'
import { GUIDES_FILE, HEAD_CHANGED, claudeWriter, guideCache } from './guide'

const runCapture = vi.fn(async (..._args: unknown[]) => ({
  code: 0,
  stdout: JSON.stringify({ result: 'answer' }),
  stderr: '',
  timedOut: false,
}))
vi.mock('../eva/spawn', () => ({
  buildCommand: (file: string, argv: string[]) => ({ file, argv, env: {} }),
  childPathFor: async () => '/usr/bin',
  runCapture: (...args: unknown[]) => runCapture(...args),
}))

const input = { ...fixture.input, headRefOid: fixture.headSha, baseRefOid: 'base1' }
const pin = { headSha: fixture.headSha, baseSha: 'base1' }
const PATHS = input.files.map((f) => f.path)

let dir: string
let config: ConfigStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'))
  config = createConfigStore(dir)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reviews guide runner', () => {
  it("writes the shared fixture's v2 Guide (same as the host's) once per base and head", async () => {
    const write = vi.fn<(prompt: string) => Promise<string>>(async () => fixture.answer)
    const read = guideCache(config, write)
    const [a, b] = await Promise.all([read(fixture.key, pin, input), read(fixture.key, pin, input)])
    expect(a).toEqual(fixture.expected)
    expect(b).toEqual(a)
    expect(await read(fixture.key, pin, input)).toEqual(fixture.expected)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toContain('HUNK src/policy.ts#3,3')
    expect(Object.keys(config.readJson<Record<string, unknown>>(GUIDES_FILE, {}))).toEqual([
      'o/r#7@base1...head1@v3',
    ])
    // Same head on a moved base: another comparison, written again.
    await read(
      fixture.key,
      { headSha: 'head1', baseSha: 'base2' },
      { ...input, baseRefOid: 'base2' },
    )
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('refuses a snapshot read at another head or base without asking the model', async () => {
    const write = vi.fn(async () => fixture.answer)
    const read = guideCache(config, write)
    await expect(read(fixture.key, { headSha: 'head2' }, input)).rejects.toThrow(HEAD_CHANGED)
    await expect(read(fixture.key, { headSha: 'head1', baseSha: 'b0' }, input)).rejects.toThrow(
      HEAD_CHANGED,
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('falls back to folders with the reason and keeps nothing', async () => {
    const failing = guideCache(config, async () => {
      throw new Error('Claude took too long')
    })
    expect(await failing(fixture.key, pin, input)).toEqual({
      headSha: 'head1',
      source: 'folders',
      error: 'Claude took too long',
      sections: folderSections(PATHS),
    })
    const proseless = guideCache(config, async () =>
      fixture.answer.replace(/"overview":"[^"]*"/, '"overview":""'),
    )
    expect(await proseless(fixture.key, pin, input)).toMatchObject({
      source: 'folders',
      error: 'Claude answered in the wrong shape',
    })
    expect(config.readJson<Record<string, unknown>>(GUIDES_FILE, {})).toEqual({})
  })

  it('sends the prompt to claude on stdin, never in argv', async () => {
    const prompt = `HUNK x#1,1\n${'y'.repeat(300_000)}`
    expect(await claudeWriter('claude', false)(prompt)).toBe('answer')
    const [cmd, , , stdin] = runCapture.mock.calls[0]! as [
      { argv: string[] },
      string,
      number,
      string,
    ]
    expect(stdin).toBe(prompt)
    expect(cmd.argv[0]).toBe('-p')
    expect(cmd.argv.some((a) => a.includes('HUNK'))).toBe(false)
  })
})

describe('review guide schema parity', () => {
  const v1 = {
    headSha: 'h',
    source: 'folders',
    error: 'Claude took too long',
    sections: [{ title: 'src', why: '', files: ['src/a.ts'] }],
  }

  it('accepts the same v1 and v2 records in contract and protocol', () => {
    for (const record of [v1, fixture.expected]) {
      expect(ReviewGuideSchema.parse(record)).toEqual(record)
      expect(ProtocolReviewGuide.parse(record)).toEqual(record)
    }
  })

  it('rejects the same broken records in both', () => {
    const bad = [
      { ...fixture.expected, version: 3 },
      { ...fixture.expected, risk: 'huge' },
      {
        ...fixture.expected,
        sections: [{ ...fixture.expected.sections[0], hunks: [{ id: 'x', side: 'both' }] }],
      },
    ]
    for (const record of bad) {
      expect(ReviewGuideSchema.safeParse(record).success).toBe(false)
      expect(ProtocolReviewGuide.safeParse(record).success).toBe(false)
    }
  })
})
